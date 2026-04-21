export const config = { runtime: 'edge' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function errorResponse(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

// 共通：SSEストリームからテキストチャンクだけを抽出して転送
function toPlainStream(res, extractText) {
  const stream = new ReadableStream({
    async start(controller) {
      const reader = res.body.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const text = extractText(JSON.parse(data));
              if (text) controller.enqueue(encoder.encode(text));
            } catch(e) {}
          }
        }
      } catch(e) { controller.error(e); }
      finally { controller.close(); }
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ── Claude Sonnet 4.6 (Anthropic) ──────────────────────────────────────
async function callClaude(finalSystem, messages, imageData, isResume) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return errorResponse('ANTHROPIC_API_KEYが設定されていません');

  const claudeMessages = messages.map((m, idx) => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (imageData && idx === messages.length - 1 && role === 'user') {
      const isPdf = imageData.mimeType === 'application/pdf';
      return {
        role,
        content: [
          isPdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageData.base64 } }
            : { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 } },
          { type: 'text', text: m.content }
        ]
      };
    }
    return { role, content: m.content };
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: isResume ? 8000 : 4000,
      temperature: isResume ? 0.3 : 0.5,
      stream: true,
      system: [{ type: 'text', text: finalSystem, cache_control: { type: 'ephemeral' } }],
      messages: claudeMessages
    })
  });

  if (!res.ok) {
    const err = await res.json();
    return errorResponse(err.error?.message || 'Claude APIエラー', res.status);
  }

  return toPlainStream(res, d =>
    d.type === 'content_block_delta' && d.delta?.type === 'text_delta' ? d.delta.text : null
  );
}

// ── GPT-4o (OpenAI) ─────────────────────────────────────────────────
async function callOpenAI(finalSystem, messages, imageData, isResume) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return errorResponse('OPENAI_API_KEYが設定されていません');

  const openaiMessages = [
    { role: 'system', content: finalSystem },
    ...messages.map((m, idx) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (imageData && idx === messages.length - 1 && role === 'user') {
        return {
          role,
          content: [
            { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } },
            { type: 'text', text: m.content }
          ]
        };
      }
      return { role, content: m.content };
    })
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: isResume ? 8000 : 4000,
      temperature: isResume ? 0.3 : 0.5,
      stream: true,
      messages: openaiMessages
    })
  });

  if (!res.ok) {
    const err = await res.json();
    return errorResponse(err.error?.message || 'OpenAI APIエラー', res.status);
  }

  return toPlainStream(res, d => d.choices?.[0]?.delta?.content || null);
}

// ── Gemini 2.5 Flash (Google) ─────────────────────────────────────────
async function callGemini(finalSystem, messages, imageData, isResume) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return errorResponse('GOOGLE_API_KEYが設定されていません');

  const contents = messages.map((m, idx) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (imageData && idx === messages.length - 1 && role === 'user') {
      return {
        role,
        parts: [
          { inlineData: { mimeType: imageData.mimeType, data: imageData.base64 } },
          { text: m.content }
        ]
      };
    }
    return { role, parts: [{ text: m.content }] };
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${apiKey}&alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: finalSystem }] },
        contents,
        generationConfig: { maxOutputTokens: isResume ? 6000 : 4000, temperature: isResume ? 0.3 : 0.5 }
      })
    }
  );

  if (!res.ok) {
    const err = await res.json();
    return errorResponse(err.error?.message || 'Gemini APIエラー', res.status);
  }

  return toPlainStream(res, d => d.candidates?.[0]?.content?.parts?.[0]?.text || null);
}

// ── メインハンドラー ───────────────────────────────────────────────────
function checkAuth(req) {
  const token = req.headers.get('X-Auth-Token') || '';
  const expected = process.env.SITE_PASSWORD || '';
  if (!expected) return false;
  // 恒定时间比较（防止时序攻击）
  const enc = new TextEncoder();
  const bufA = enc.encode(token);
  const bufB = enc.encode(expected);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!checkAuth(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { systemPrompt, messages, model = 'claude-sonnet-4', imageData = null, project_id = null } = await req.json();

    // 日本時間で今日の日付を取得
    const today = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    // 簡歴プロジェクト（project_id あり）→ 最初の2件＋直近8件（4往復）
    // 一般チャット（project_id なし）→ 直近4件（2往復）
    const allMessages = Array.isArray(messages) ? messages : [];
    let trimmedMessages;
    if (project_id) {
      if (allMessages.length <= 10) {
        trimmedMessages = allMessages;
      } else {
        trimmedMessages = [...allMessages.slice(0, 2), ...allMessages.slice(-8)];
      }
    } else {
      trimmedMessages = allMessages.slice(-4);
    }

    // メッセージサイズ制限（1件あたり最大50,000文字）
    for (const m of trimmedMessages) {
      if (typeof m.content === 'string' && m.content.length > 50000) {
        return errorResponse('メッセージが長すぎます', 400);
      }
    }

    // ── コアシステムプロンプト（全チャット共通）──────────────────────────
    const CORE_SYSTEM = `今日の日付は${today}です。年数計算・在籍期間・経験年数は必ず今日の日付を基準に正確に計算してください。

あなたはZoeの採用アシスタントです。
・日本語で簡潔・正確・自然に回答してください
・情報の創作・補完は絶対禁止
・不明点は確認すること
・ハルシネーション禁止`;

    const finalSystem = systemPrompt
      ? `${CORE_SYSTEM}\n\n---\n\n${systemPrompt}`
      : CORE_SYSTEM;

    const isResume = !!project_id;
    if (model === 'gpt-4o')           return await callOpenAI(finalSystem, trimmedMessages, imageData, isResume);
    if (model === 'gemini-2.5-flash') return await callGemini(finalSystem, trimmedMessages, imageData, isResume);
    return await callClaude(finalSystem, trimmedMessages, imageData, isResume);

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
