export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'APIキーが設定されていません' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { systemPrompt, messages } = await req.json();

    // 日本時間で今日の日付を取得
    const today = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    const BASE_SYSTEM = `今日の日付は${today}です。年数計算・在籍期間・経験年数は必ず今日の日付を基準に正確に計算してください。未来の日付と判断しないこと。

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
- Recruitment tasks, company research, interview prep, resume review → respond in Japanese
- General life questions, English learning → respond in Chinese
- Always match the language and tone to the context

Output style: simple, accurate, human-like, concise, proactive, educational — like a top-level recruitment consultant mentoring Zoe step by step`;

    const finalSystem = systemPrompt
      ? `${BASE_SYSTEM}\n\n---\n\n${systemPrompt}`
      : BASE_SYSTEM;

    // Anthropic APIにストリーミングで接続
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'messages-2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        stream: true,
        system: finalSystem,
        messages
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      return new Response(JSON.stringify({ error: err.error?.message || 'APIエラー' }), {
        status: anthropicRes.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SSEストリームをクライアントに転送
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // バックグラウンドでストリームを処理
    (async () => {
      let fullText = '';
      const reader = anthropicRes.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  fullText += parsed.delta.text;
                  // テキストをチャンクとして送信
                  const payload = JSON.stringify({ chunk: parsed.delta.text }) + '\n';
                  await writer.write(encoder.encode(payload));
                }
                if (parsed.type === 'message_stop') {
                  // 完了シグナルを送信
                  await writer.write(encoder.encode(JSON.stringify({ done: true, content: fullText }) + '\n'));
                }
              } catch(e) {
                // JSONパースエラーは無視
              }
            }
          }
        }
      } catch(e) {
        await writer.write(encoder.encode(JSON.stringify({ error: e.message }) + '\n'));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'X-Content-Type-Options': 'nosniff',
      }
    });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
