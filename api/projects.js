export const config = { runtime: 'edge' };

export default async function handler(req) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase環境変数が設定されていません' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  try {
    if (req.method === 'GET') {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?order=created_at.asc`, {
        method: 'GET',
        headers
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const res = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return new Response(JSON.stringify(Array.isArray(data) ? data[0] : data), {
        status: 201, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'PATCH' && id) {
      const body = await req.json();
      await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify(body)
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'DELETE' && id) {
      await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${id}`, {
        method: 'DELETE',
        headers
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Method not allowed', { status: 405 });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
