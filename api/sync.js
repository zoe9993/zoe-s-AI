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
  if (!checkAuth(req)) {
    // デバッグ用：トークン長と環境変数の設定状況を返す（パスワード自体は返さない）
    const token = req.headers.get('X-Auth-Token') || '';
    const expected = process.env.SITE_PASSWORD || '';
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      debug: { tokenLen: token.length, expectedLen: expected.length, hasEnv: !!expected }
    }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.log('KEY_PREFIX:', process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 50));

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase未設定' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(req.url);
  const convId = url.searchParams.get('conv_id');

  const sbHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  try {
    // GET: conv_id指定 → 1件取得 / 未指定 → 全件一覧
    if (req.method === 'GET') {
      if (convId) {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/synced_chats?conv_id=eq.${encodeURIComponent(convId)}&select=conv_id,name,messages,updated_at`,
          { headers: sbHeaders }
        );
        const data = await res.json();
        return new Response(JSON.stringify(data[0] || null), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      } else {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/synced_chats?select=conv_id,name,updated_at`,
          { headers: sbHeaders }
        );
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // PUT: upsert（作成 or 更新）
    if (req.method === 'PUT') {
      const body = await req.json();
      if (!body.conv_id) {
        return new Response(JSON.stringify({ error: 'conv_id required' }), { status: 400 });
      }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/synced_chats`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          conv_id: body.conv_id,
          name: body.name || '',
          messages: body.messages || [],
          updated_at: new Date().toISOString()
        })
      });
      if (!res.ok) {
        const err = await res.json();
        return new Response(JSON.stringify({ error: err }), { status: res.status });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // DELETE
    if (req.method === 'DELETE' && convId) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/synced_chats?conv_id=eq.${encodeURIComponent(convId)}`,
        { method: 'DELETE', headers: sbHeaders }
      );
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Method not allowed', { status: 405 });

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
