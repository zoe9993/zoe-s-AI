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
  const id         = url.searchParams.get('id');
  const scope      = url.searchParams.get('scope');
  const project_id = url.searchParams.get('project_id');

  const sbHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  try {

    // ── GET ─────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      let query = `${SUPABASE_URL}/rest/v1/memories?select=*&order=created_at.asc`;

      if (scope === 'global') {
        // グローバル記憶のみ
        query += '&scope=eq.global';
      } else if (scope === 'project' && project_id) {
        // 指定プロジェクットの記憶のみ
        query += `&scope=eq.project&project_id=eq.${project_id}`;
      } else if (project_id) {
        // グローバル + 指定プロジェクットの両方（chat.js RAG用）
        query += `&or=(scope.eq.global,and(scope.eq.project,project_id.eq.${project_id}))`;
      }
      // パラメータなしの場合は全件返す

      const res = await fetch(query, { method: 'GET', headers: sbHeaders });
      if (!res.ok) {
        const err = await res.json();
        return new Response(JSON.stringify({ error: err }), {
          status: res.status, headers: { 'Content-Type': 'application/json' }
        });
      }
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── POST ─────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json();
      const { project_id: bProjectId, scope: bScope, type, content } = body;

      if (!bScope || !type || !content) {
        return new Response(JSON.stringify({ error: 'scope・type・contentは必須です' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      if (!['global', 'project'].includes(bScope)) {
        return new Response(JSON.stringify({ error: 'scopeはglobalまたはprojectのみ有効です' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      if (!['positive', 'negative'].includes(type)) {
        return new Response(JSON.stringify({ error: 'typeはpositiveまたはnegativeのみ有効です' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      const insertBody = { scope: bScope, type, content };
      if (bProjectId) insertBody.project_id = bProjectId;

      const res = await fetch(`${SUPABASE_URL}/rest/v1/memories`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify(insertBody)
      });
      const data = await res.json();
      return new Response(JSON.stringify(Array.isArray(data) ? data[0] : data), {
        status: 201, headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── DELETE ───────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (id) {
        // 1件削除
        await fetch(`${SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
          method: 'DELETE', headers: sbHeaders
        });
        return new Response(JSON.stringify({ success: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      // 蒸留後の一括削除（scope単位）
      if (scope === 'global') {
        await fetch(`${SUPABASE_URL}/rest/v1/memories?scope=eq.global`, {
          method: 'DELETE', headers: sbHeaders
        });
      } else if (scope === 'project' && project_id) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/memories?scope=eq.project&project_id=eq.${project_id}`,
          { method: 'DELETE', headers: sbHeaders }
        );
      } else {
        return new Response(JSON.stringify({ error: 'idまたはscope/project_idが必要です' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

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
