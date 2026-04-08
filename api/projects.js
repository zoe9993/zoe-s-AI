export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (method === 'DELETE' || (method === 'PATCH' && res.status === 204)) return null;
  return res.json();
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  try {
    if (req.method === 'GET') {
      const data = await supabase('GET', '/projects?order=created_at.asc');
      return new Response(JSON.stringify(data), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const data = await supabase('POST', '/projects', body);
      return new Response(JSON.stringify(data[0]), {
        status: 201, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'PATCH' && id) {
      const body = await req.json();
      await supabase('PATCH', `/projects?id=eq.${id}`, body);
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'DELETE' && id) {
      await supabase('DELETE', `/projects?id=eq.${id}`);
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
