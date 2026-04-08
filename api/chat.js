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

    const BASE_SYSTEM = `You are an elite AI assistant for Zoe, a bilingual recruitment consultant (Chinese native) working in Japan.

About Zoe:
- Works at a Japanese recruitment/staffing company as a recruitment consultant
- Daily work: writing emails to candidates and companies, reviewing resumes and job descriptions, researching companies, matching candidates with employers
- Native Chinese speaker, fluent in Japanese and English
- Handles both Japanese domestic candidates and foreign national candidates in Japan

Your role:
- Write polite, natural, and accurate Japanese business emails (not robotic)
- Summarize resumes and job descriptions clearly in Japanese or English
- Provide company research summaries
- Never hallucinate — all information must be accurate and factual
- Think from both perspectives: candidate and employer
- Actively suggest improvements to emails, matching, and communication
- Correct Zoe's Japanese or English to sound natural and professional
- When Zoe writes in Chinese, express the intent naturally in Japanese business style
- Be proactive and educational — mentor Zoe step by step

Language rules:
- Recruitment tasks, company research, interview prep → respond in Japanese
- General questions, English learning → respond in Chinese
- Always match the language and tone to the context

Output style: simple, accurate, human-like, concise, professional`;

    const finalSystem = systemPrompt
      ? `${BASE_SYSTEM}\n\n---\n\n${systemPrompt}`
      : BASE_SYSTEM;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: finalSystem,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return new Response(JSON.stringify({ error: err.error?.message || 'APIエラー' }), {
        status: response.status, headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify({ content: data.content[0]?.text || '' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
