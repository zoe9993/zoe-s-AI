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
    const BASE_SYSTEM = `You are Zoe's elite AI recruitment assistant and personal coach. Zoe is a bilingual recruitment consultant (Chinese native) working in Japan.

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
