export const config = { runtime: 'edge' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function errorResponse(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

// 共通：SSEストリームからテキストチャンクだけを抽出して転送
function toPlainStream(res, extractText) {
  const stream = new ReadableStream({
    async start(controller) {
      const reader = res.body.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const text = extractText(JSON.parse(data));
              if (text) controller.enqueue(encoder.encode(text));
            } catch(e) {}
          }
        }
      } catch(e) { controller.error(e); }
      finally { controller.close(); }
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ── Claude Sonnet 4.6 (Anthropic) ──────────────────────────────────────
async function callClaude(finalSystem, messages, imageData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return errorResponse('ANTHROPIC_API_KEYが設定されていません');

  const claudeMessages = messages.map((m, idx) => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (imageData && idx === messages.length - 1 && role === 'user') {
      return {
        role,
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 } },
          { type: 'text', text: m.content }
        ]
      };
    }
    return { role, content: m.content };
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      stream: true,
      system: [{ type: 'text', text: finalSystem, cache_control: { type: 'ephemeral' } }],
      messages: claudeMessages
    })
  });

  if (!res.ok) {
    const err = await res.json();
    return errorResponse(err.error?.message || 'Claude APIエラー', res.status);
  }

  return toPlainStream(res, d =>
    d.type === 'content_block_delta' && d.delta?.type === 'text_delta' ? d.delta.text : null
  );
}

// ── GPT-4o (OpenAI) ─────────────────────────────────────────────────
async function callOpenAI(finalSystem, messages, imageData) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return errorResponse('OPENAI_API_KEYが設定されていません');

  const openaiMessages = [
    { role: 'system', content: finalSystem },
    ...messages.map((m, idx) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (imageData && idx === messages.length - 1 && role === 'user') {
        return {
          role,
          content: [
            { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } },
            { type: 'text', text: m.content }
          ]
        };
      }
      return { role, content: m.content };
    })
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4000,
      stream: true,
      messages: openaiMessages
    })
  });

  if (!res.ok) {
    const err = await res.json();
    return errorResponse(err.error?.message || 'OpenAI APIエラー', res.status);
  }

  return toPlainStream(res, d => d.choices?.[0]?.delta?.content || null);
}

// ── Gemini 2.5 Flash (Google) ─────────────────────────────────────────
async function callGemini(finalSystem, messages, imageData) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return errorResponse('GOOGLE_API_KEYが設定されていません');

  const contents = messages.map((m, idx) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (imageData && idx === messages.length - 1 && role === 'user') {
      return {
        role,
        parts: [
          { inlineData: { mimeType: imageData.mimeType, data: imageData.base64 } },
          { text: m.content }
        ]
      };
    }
    return { role, parts: [{ text: m.content }] };
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${apiKey}&alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: finalSystem }] },
        contents,
        generationConfig: { maxOutputTokens: 4000 }
      })
    }
  );

  if (!res.ok) {
    const err = await res.json();
    return errorResponse(err.error?.message || 'Gemini APIエラー', res.status);
  }

  return toPlainStream(res, d => d.candidates?.[0]?.content?.parts?.[0]?.text || null);
}

// ── メインハンドラー ───────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { systemPrompt, messages, model = 'claude-sonnet-4', imageData = null, project_id = null } = await req.json();

    // 日本時間で今日の日付を取得
    const today = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    // 直近10件だけ使用（トークン節約）
    const trimmedMessages = Array.isArray(messages) ? messages.slice(-10) : [];

    // ── RAG: 記憶の取得とキーワードマッチング ──────────────────────────────
    let memoriesText = '';
    try {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
      if (SUPABASE_URL && SUPABASE_KEY) {
        let memQuery = `${SUPABASE_URL}/rest/v1/memories?select=*&order=created_at.asc`;
        if (project_id) {
          memQuery += `&or=(scope.eq.global,and(scope.eq.project,project_id.eq.${encodeURIComponent(project_id)}))`;
        } else {
          memQuery += `&scope=eq.global`;
        }
        const memRes = await fetch(memQuery, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (memRes.ok) {
          const allMemories = await memRes.json();
          if (allMemories.length > 0) {
            // 直近5件の会話からキーワード抽出
            const contextText = trimmedMessages.slice(-5).map(m => m.content).join(' ').toLowerCase();
            const words = contextText.match(/[\p{L}\p{N}]{2,}/gu) || [];
            const keywords = [...new Set(words)];

            // シーンタグのマッピング（会話コンテキストに含まれるシーンを検出）
            const SCENE_KEYWORDS = {
              '書類不採用': ['書類不採用', '書類選考', '不採用', '書類落ち', '書類で', '書類ng'],
              '書類通過': ['書類通過', '書類選考通過', '書類ok', '書類合格'],
              '面接通過': ['面接通過', '面接合格', '面接ok', '次の選考', '次回選考'],
              '最終不採用': ['最終不採用', '最終選考', '最終面接不採用', '残念ながら'],
              '内定': ['内定', 'オファー', '採用', '合格', 'offer'],
              '面接日程調整': ['面接日程', '日程調整', '面接の日程', 'スケジュール調整', '面接設定'],
              'スカウト': ['スカウト', 'スカウトメール', 'アプローチ', '候補者へのご連絡', 'ダイレクト'],
              '一般': [],
            };

            // 会話中に該当するシーンを特定
            const activeScenes = Object.entries(SCENE_KEYWORDS)
              .filter(([, kws]) => kws.some(kw => contextText.includes(kw)))
              .map(([scene]) => scene);

            // キーワードマッチングでスコアリング（シーンタグ一致でボーナス）
            function scoreAndPick(list, limit) {
              const scored = list.map(mem => {
                const memLower = mem.content.toLowerCase();
                let score = keywords.filter(kw => memLower.includes(kw)).length;
                // シーンタグが一致する記憶には+10ボーナス（優先的に選ばれる）
                const sceneMatch = activeScenes.some(s => mem.content.startsWith(`[${s}]`));
                if (sceneMatch) score += 10;
                // シーンタグなし（一般ルール）も常に有効
                return { ...mem, score };
              });
              // スコア降順 → 新しい順でソート
              scored.sort((a, b) => b.score - a.score || new Date(b.created_at) - new Date(a.created_at));
              return scored.slice(0, limit);
            }

            // GlobalとProjectを枠を分けて取得（競合させない）
            const globals  = scoreAndPick(allMemories.filter(m => m.scope === 'global'), 5);
            const projects = scoreAndPick(allMemories.filter(m => m.scope === 'project'), 5);
            const selected = [...globals, ...projects];

            const positives = selected.filter(m => m.type === 'positive').map(m => `・${m.content}`).join('\n');
            const negatives = selected.filter(m => m.type === 'negative').map(m => `・${m.content}`).join('\n');

            if (positives || negatives) {
              memoriesText = '\n\n---\n【Zoeの指示・好みルール（必ず守ること）】\n\n';
              if (positives) memoriesText += `✅ 必ずこうしてほしい：\n${positives}\n\n`;
              if (negatives) memoriesText += `❌ 絶対にやってはいけない：\n${negatives}`;
              memoriesText += '\n---';
            }
          }
        }
      }
    } catch(_e) { /* 記憶取得失敗は既存機能に影響させない */ }

    // ── コアシステムプロンプト（全チャット共通）──────────────────────────
    const CORE_SYSTEM = `今日の日付は${today}です。年数計算・在籍期間・経験年数は必ず今日の日付を基準に正確に計算してください。未来の日付と判断しないこと。

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
- Respond in Japanese for recruitment tasks, resume review, company research, email writing
- Respond in Chinese for general life questions and casual conversation
- Respond in English if the user writes in English
- Always match the language the user is writing in
- NEVER refuse to answer a question based on topic — answer helpfully on any subject
- Recruitment and career topics are the primary focus, but all other topics are also welcome

Output style: simple, accurate, human-like, concise, proactive, educational — like a top-level recruitment consultant mentoring Zoe step by step

CRITICAL OUTPUT RULES:
- When correcting or writing Japanese emails or messages, output ONLY the corrected text itself
- Do NOT add any headers like「修正版：」「修正案：」「以下が修正版です」
- Do NOT add「修正ポイント：」「学習ポイント：」or any explanatory notes after the email
- The output should be ready to copy and paste directly into an email client
- Exception: if Zoe explicitly asks for explanation or correction points, then include them`;

    // ── 履歴書ルール（プロジェクットチャットのみ追加）─────────────────────
    const RESUME_RULES = `

---

## 職務経歴書・履歴書ブラッシュアップ ルール＆例文

### 【絶対厳守：例文の使い方】
⚠️ 以下の例文は「文体・構成・リズム」の参考のみ。内容を流用することは厳禁。
⚠️ 例文に登場する業務内容・技術名・社名・数字・フレーズを候補者の履歴書にそのまま入れてはいけない。
⚠️ 書く内容は100%候補者の原文から。例文は「どう書くか」の参考であって「何を書くか」は候補者の経験のみ。
⚠️ 例文と候補者の経験が似ていても、必ず候補者の言葉・数字・技術名に置き換えること。

---

### 【最重要ルール】
- 原文に記載のない情報は一切追加しない。推測・創作・補完は絶対禁止
- 不明・未確認の情報は末尾に【要確認事項】としてリストアップする
- 正式なリーダー職でない場合、「リーダーとして」と書かない。事実ベースで表現する
- 客先・ユーザーに失礼な表現を避ける（例：「顧客の理解度に合わせた説明」など自然な表現を使う）
- 重複内容は先に指摘し、統合案を提示してから編集する
- 修正した箇所は末尾に【修正ポイント】として簡潔にまとめる
- 埋められない項目は空欄のままにし、候補者への確認を促す

### 【期間・日付に関するルール】
- 在籍期間とプロジェクト期間は別物として扱う。プロジェクト期間が在籍期間と一致しない場合も、客先常駐・引き継ぎ・複数社にまたがるケース等があるため、矛盾と断定せず、必ず【要確認事項】に記載して候補者に確認を促すこと。独自に期間を修正・変更しないこと
- 期間の計算ミスを避けるため、原文の日付をそのまま使用し、独自に計算・変換しないこと

---

### 【セクション別ルール】

#### ■ 職務要約
- 文字数：200〜250字
- 採用担当が30秒で「この人は何者か」を把握できる内容
- 書くべき内容：経歴の流れ／主な技術・業務領域／直近で何をしていたか
- 書いてはいけない内容：強み・アピール・意欲・感情表現
- 語尾：「〜した」「〜を担当」体に統一
- 現職の場合は現在形（「〜している」）可

【文体の参考例】
2016年、○○株式会社に入社後、証券業界にてシステム開発・保守・統合プロジェクトに約9年間従事。COBOLを中心としたバッチ開発からキャリアをスタートし、勘定系・納税・譲渡益税などの業務系システム開発を複数経験。特に2019年以降は大規模な基幹システム移行・統合案件において、要件定義・設計・テスト・本番移行・ベンダーコントロールを一貫して担当。

---

#### ■ 活かせる経験・知識・技術
- 経験が豊富な候補者 → 箇条書き形式
- 経験が浅い候補者 → 見出し＋段落形式
- 箇条書きの場合：語尾は「〜の経験」「〜の知識」「〜のスキル」で統一（体言止め）
- 1行30〜40字以内、4〜8項目に厳選
- 具体的なツール名・技術名・業務領域名を必ず入れる

【文体の参考例】
・要件定義〜本番移行までのSDLC全工程を一通り経験
・大型基幹システム統合プロジェクトにて、ユーザー折衝・ベンダーコントロールの経験
・上流工程（要件定義・仕様調整・基本設計）の豊富な経験
・金融業界特有の厳格な品質・スケジュール管理下でのプロジェクト遂行力

---

#### ■ プロジェクト
- 以下の4項目で整理する：【プロジェクト概要】【担当フェーズ】【業務内容】【実績・取り組み】
- 担当フェーズ：「担当工程」ではなく「担当フェーズ」と表記し、横並び形式で記載
  例）要件定義、基本設計、詳細設計、開発、結合テスト、本番リリース
- 業務内容：体言止め、具体的な固有名詞・ツール名を入れる、動詞を変化させて単調にならないようにする
- 実績・取り組み：数字・割合・規模感で具体化、「〜を実現」「〜を完遂」「〜に貢献」など結果動詞で締める

【業務内容の文体参考例】
・○○システムの領域を主担当として対応
・ユーザーおよびベンダーと折衝しながらデータ変換仕様の要件定義・基本設計を実施
・協力会社○名とチームを組み、ベンダーコントロールを担当
・テストケース作成、進捗・品質管理、レビュー対応、リリース計画の策定・実行

【実績・取り組みの文体参考例】
・ユーザー業務を正確に理解したうえで精度の高いデータ連携を実現
・仕様変更・要望変更にも柔軟に対応し、ユーザー満足度の高い納品を実現
・ウォーターフォール型SDLCを全工程にわたり推進し、予定通り本番移行を完遂
・協力会社○名を管理し、スケジュール通りのテスト完遂に貢献

---

#### ■ 自己PR（職務経歴書用）
- 形式：＜見出し＞＋段落形式（見出し2〜3個）
- 見出し：候補者の強みを体言止めで表現
- 各段落100字前後、合計200〜350字
- 語尾：「〜しました」「〜てきました」体（丁寧体）に統一
- 汎用版の場合、特定企業名への言及は避ける
- 正式なリーダー職でない場合は「リーダーとして」と書かず事実ベースで表現

#### ■ 自己PR（履歴書用）
- 形式：段落形式（見出しなし）
- 文字数：200〜300字程度
- 構成：経歴の要約 → 強み → 締めの一文（意欲・展望）
- 語尾：「〜しました」「〜てきました」体（丁寧体）に統一
- 締めの一文：前向きな意欲・展望で終わる
- 特定業界・企業への限定表現は避ける

---

### 【全セクション共通ルール】
- 英語技術用語は正式表記に統一（例：Spring Boot / MySQL / Oracle / PostgreSQL / GitHub Actions / Jenkins）
- 「担当工程」→「担当フェーズ」に統一
- AI的・機械的な表現は使わない
- 文法・助詞の誤りは必ず修正する
- 日本企業の中途採用書類の水準に準拠する`;

    // 一般チャット（project_id なし）: CORE_SYSTEM のみ
    // プロジェクットチャット: CORE_SYSTEM + RESUME_RULES
    const BASE_SYSTEM = project_id ? CORE_SYSTEM + RESUME_RULES : CORE_SYSTEM;

    const finalSystem = systemPrompt
      ? `${BASE_SYSTEM}${memoriesText}\n\n---\n\n${systemPrompt}`
      : `${BASE_SYSTEM}${memoriesText}`;

    if (model === 'gpt-4o')           return await callOpenAI(finalSystem, trimmedMessages, imageData);
    if (model === 'gemini-2.5-flash') return await callGemini(finalSystem, trimmedMessages, imageData);
    return await callClaude(finalSystem, trimmedMessages, imageData);

  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
