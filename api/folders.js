// Required Supabase SQL (run once in Supabase dashboard):
//
//   CREATE TABLE IF NOT EXISTS folders (
//     id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//     name TEXT NOT NULL,
//     position INTEGER DEFAULT 0,
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );
//
//   ALTER TABLE projects ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;

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
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  const sbHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  try {
    if (req.method === 'GET') {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/folders?order=position.asc,created_at.asc`,
        { method: 'GET', headers: sbHeaders }
      );
      const data = await res.json();
      return new Response(JSON.stringify(Array.isArray(data) ? data : []), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const res = await fetch(`${SUPABASE_URL}/rest/v1/folders`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return new Response(JSON.stringify(Array.isArray(data) ? data[0] : data), {
        status: 201, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'PATCH' && id) {
      const body = await req.json();
      await fetch(`${SUPABASE_URL}/rest/v1/folders?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify(body)
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (req.method === 'DELETE' && id) {
      // Move all projects in this folder to uncategorized first
      await fetch(`${SUPABASE_URL}/rest/v1/projects?folder_id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ folder_id: null })
      });
      await fetch(`${SUPABASE_URL}/rest/v1/folders?id=eq.${id}`, {
        method: 'DELETE',
        headers: sbHeaders
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
