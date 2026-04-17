export const config = { runtime: 'edge' };

function checkAuth(req) {
  const token = req.headers.get('X-Auth-Token') || '';
  const expected = process.env.SITE_PASSWORD || '';
  if (!expected) return false;
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

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase環境変数が設定されていません' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!ANTHROPIC_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEYが設定されていません' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { scope, project_id } = await req.json();

    if (!scope || (scope === 'project' && !project_id)) {
      return new Response(JSON.stringify({ error: 'scope（globalまたはproject）と、projectの場合はproject_idが必要です' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const sbHeaders = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    };

    // 1. 対象の記憶を全件取得
    let query = `${SUPABASE_URL}/rest/v1/memories?select=*&order=created_at.asc`;
    if (scope === 'global') {
      query += '&scope=eq.global';
    } else {
      query += `&scope=eq.project&project_id=eq.${project_id}`;
    }

    const memRes = await fetch(query, { method: 'GET', headers: sbHeaders });
    const memories = await memRes.json();

    if (!Array.isArray(memories) || memories.length === 0) {
      return new Response(JSON.stringify({ error: '蒸留する記憶がありません' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. 記憶をテキストに整形
    const positiveLines = memories
      .filter(m => m.type === 'positive')
      .map(m => `・${m.content}`)
      .join('\n');
    const negativeLines = memories
      .filter(m => m.type === 'negative')
      .map(m => `・${m.content}`)
      .join('\n');

    const memoryText = [
      positiveLines ? `【好きな表現・パターン】\n${positiveLines}` : '',
      negativeLines ? `【避けるべき表現・パターン】\n${negativeLines}` : '',
    ].filter(Boolean).join('\n\n');

    // 3. Claudeで蒸留
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `以下はZoe（バイリンガル採用コンサルタント）のAIアシスタントへの学習記憶リストです。
これを分析して、Zoeの表現パターン・好み・癖を簡潔にまとめてください。
重複するルールは統合し、曖昧なものは削除して、本質的なルールだけを残してください。

出力形式（この形式を厳守すること）：
【好きな表現・パターン】
・（1項目ずつ箇条書き）

【避けるべき表現・パターン】
・（1項目ずつ箇条書き）

---
${memoryText}`
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      return new Response(JSON.stringify({ error: err.error?.message || 'Claude APIエラー' }), {
        status: claudeRes.status, headers: { 'Content-Type': 'application/json' }
      });
    }

    const claudeData = await claudeRes.json();
    const distilledText = claudeData.content?.[0]?.text || '';

    // 4. 蒸留結果をpositive/negativeに分類
    const distilled = { positive: [], negative: [] };
    let currentType = null;
    for (const line of distilledText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.includes('好きな表現') || trimmed.includes('好きなパターン')) {
        currentType = 'positive';
      } else if (trimmed.includes('避けるべき')) {
        currentType = 'negative';
      } else if (trimmed.startsWith('・') && currentType) {
        const content = trimmed.replace(/^・/, '').trim();
        if (content) distilled[currentType].push(content);
      }
    }

    // 5. 元の記憶IDリストも返す（UI側で確認後に削除させるため）
    return new Response(JSON.stringify({
      distilledText,
      distilled,
      originalCount: memories.length,
      originalIds: memories.map(m => m.id)
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
