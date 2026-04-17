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

// SSRF 防护：屏蔽内网/保留 IP 地址
function isPrivateHost(hostname) {
  // 屏蔽 localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  // 屏蔽私有 IP 段
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => !isNaN(n))) {
    if (parts[0] === 10) return true;                                         // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;    // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;                    // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;                    // 169.254.0.0/16 (link-local / cloud metadata)
    if (parts[0] === 0) return true;                                          // 0.0.0.0/8
    if (parts[0] === 127) return true;                                        // 127.0.0.0/8
  }
  return false;
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
    const { url } = await req.json();
    if (!url) {
      return new Response(JSON.stringify({ error: 'URLが必要です' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // URL検証
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return new Response(JSON.stringify({ error: '無効なURLです' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return new Response(JSON.stringify({ error: 'HTTPまたはHTTPSのURLのみ対応しています' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // SSRF 防护：禁止访问内网地址
    if (isPrivateHost(parsedUrl.hostname)) {
      return new Response(JSON.stringify({ error: '内部ネットワークへのアクセスは許可されていません' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }

    // ページ取得
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    if (!pageRes.ok) {
      return new Response(JSON.stringify({
        error: `ページの取得に失敗しました（HTTP ${pageRes.status}）。サイトがアクセスをブロックしている可能性があります。`
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    const contentType = pageRes.headers.get('content-type') || '';
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return new Response(JSON.stringify({ error: 'HTMLページのみ対応しています' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const html = await pageRes.text();
    const text = htmlToText(html);
    const MAX = 40000;
    const truncated = text.length > MAX;

    return new Response(JSON.stringify({
      url,
      domain: parsedUrl.hostname,
      text: text.slice(0, MAX),
      charCount: Math.min(text.length, MAX),
      truncated
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

function htmlToText(html) {
  return html
    // 不要なブロックを丸ごと削除
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // ブロック要素を改行に
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|section|article|blockquote|header|main|aside|footer|nav)[^>]*>/gi, '\n')
    // 残りのタグを除去
    .replace(/<[^>]+>/g, ' ')
    // HTMLエンティティのデコード
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&yen;/g, '¥')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // 空白整理
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
