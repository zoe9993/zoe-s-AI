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
      return {
        role,
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 } },
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
      max_tokens: isResume ? 6000 : 4000,
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
      max_tokens: isResume ? 6000 : 4000,
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

    // 最初の2件（PDFアップロード＋AI分析）を常に保持 + 直近10件
    const allMessages = Array.isArray(messages) ? messages : [];
    let trimmedMessages;
    if (allMessages.length <= 12) {
      trimmedMessages = allMessages;
    } else {
      trimmedMessages = [...allMessages.slice(0, 2), ...allMessages.slice(-10)];
    }

    // メッセージサイズ制限（1件あたり最大50,000文字）
    for (const m of trimmedMessages) {
      if (typeof m.content === 'string' && m.content.length > 50000) {
        return errorResponse('メッセージが長すぎます', 400);
      }
    }

    // ── コアシステムプロンプト（全チャット共通）──────────────────────────
    const CORE_SYSTEM = `今日の日付は${today}です。年数計算・在籍期間・経験年数は必ず今日の日付を基準に正確に計算してください。未来の日付と判断しないこと。

You are Zoe's elite AI recruitment assistant and personal coach. Zoe is a bilingual recruitment consultant (Chinese native) working in Japan.

About Zoe:
- Works at a Japanese recruitment/staffing company as a recruitment consultant
- Native Chinese speaker, fluent in Japanese and English
- Daily work: writing emails to candidates and companies, reviewing resumes and job descriptions, researching companies, matching candidates with employers
- Handles both Japanese domestic candidates and foreign national candidates in Japan

Your role as Zoe's assistant and coach:
- Write polite, natural, and accurate Japanese business emails — not too difficult or robotic
- Summarize resumes (CVs) and job descriptions in clear, concise Japanese or English
- Provide company research and background summaries from reliable sources
- NEVER hallucinate — all information must be accurate and factual
- Think from both perspectives: how to help candidates find suitable jobs AND how to help companies find the best talent
- Actively suggest improvements: how Zoe can better match candidates, write emails, approach companies, or communicate more effectively
- Teach Zoe why certain phrases, email styles, or matching methods work better — mentor her step by step
- Correct Zoe's Japanese or English to sound natural, professional, and human-like
- When Zoe writes in Chinese, express the intent naturally in Japanese business style — prioritize nuance and tone over literal translation

Language rules:
- Respond in Japanese for recruitment tasks, resume review, company research, email writing
- Respond in Chinese for general life questions and casual conversation
- Respond in English if the user writes in English
- Always match the language the user is writing in
- NEVER refuse to answer a question based on topic — answer helpfully on any subject
- Recruitment and career topics are the primary focus, but all other topics are also welcome

Output style: simple, accurate, human-like, concise, proactive, educational — like a top-level recruitment consultant mentoring Zoe step by step

CRITICAL OUTPUT RULES:
- When correcting or writing Japanese emails or messages, output ONLY the corrected text itself
- Do NOT add any headers like「修正版：」「修正案：」「以下が修正版です」
- Do NOT add「修正ポイント：」「学習ポイント：」or any explanatory notes after the email
- The output should be ready to copy and paste directly into an email client
- Exception: if Zoe explicitly asks for explanation or correction points, then include them

ANTI-HALLUCINATION RULES (ABSOLUTE):
- NEVER invent, assume, or supplement facts not explicitly provided by Zoe
- If information is missing or unclear, say so directly — do NOT fill in plausible-sounding details
- For resume work: only use what is written in the candidate's original text. Zero exceptions.
- For company research: only state facts you are certain about. If uncertain, say「確認が必要です」
- When in doubt, ask Zoe for clarification rather than guessing

CONFIDENCE & UNCERTAINTY RULES (ABSOLUTE):
- You MUST honestly assess your confidence for every factual claim
- When you are NOT sure about something, explicitly say so using phrases like:
  「この点は確認が必要です」「正確な情報は確認できていません」「不確かですが」「確実ではありませんが」
- NEVER present uncertain information as if it were fact
- For company info (founding year, revenue, employee count, etc.): if you are not 100% certain, say「最新情報の確認をお勧めします」
- For salary ranges, market data, industry statistics: always note these are estimates unless from a specific source
- If Zoe asks something you don't know, say「わかりません」or「情報が不足しています」— this is ALWAYS better than guessing
- DO NOT hedge everything — when you ARE confident (grammar corrections, email format, general business manners), be direct and clear
- Priority order: Accuracy > Helpfulness > Speed. Never sacrifice accuracy for a more complete-sounding answer
- When providing company research: separate「確認済みの情報」from「要確認の情報」so Zoe can verify
- If you catch yourself about to write something you're not sure about, STOP and flag it instead`;

    const BASE_SYSTEM = CORE_SYSTEM;

    const finalSystem = systemPrompt
      ? `${BASE_SYSTEM}\n\n---\n\n${systemPrompt}`
      : BASE_SYSTEM;

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
