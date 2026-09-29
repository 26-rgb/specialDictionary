// [コード, 日本語名, 英語版Wiktionaryでの言語名]（話者数の多い順に近い並び。増減はここを編集）
const LANGS = [
  ["en","英語","English"],["zh-CN","中国語（簡体）","Chinese"],["hi","ヒンディー語","Hindi"],["es","スペイン語","Spanish"],
  ["fr","フランス語","French"],["ar","アラビア語","Arabic"],["bn","ベンガル語","Bengali"],["pt","ポルトガル語","Portuguese"],
  ["ru","ロシア語","Russian"],["ur","ウルドゥー語","Urdu"],["id","インドネシア語","Indonesian"],["de","ドイツ語","German"],
  ["sw","スワヒリ語","Swahili"],["mr","マラーティー語","Marathi"],["te","テルグ語","Telugu"],["tr","トルコ語","Turkish"],
  ["ta","タミル語","Tamil"],["vi","ベトナム語","Vietnamese"],["ko","韓国語","Korean"],["it","イタリア語","Italian"],
  ["th","タイ語","Thai"],["fa","ペルシア語","Persian"],["pl","ポーランド語","Polish"],["uk","ウクライナ語","Ukrainian"]
];
const MAX_CANDIDATES = 3;   // 1言語あたりの訳語候補の上限
const MAX_DEFS = 2;         // 1候補あたりの語釈の上限
const CONCURRENCY = 8;      // 同時に処理する言語数

const POS_JA = {noun:"名詞",verb:"動詞",adjective:"形容詞",adverb:"副詞",pronoun:"代名詞",
  preposition:"前置詞",conjunction:"接続詞",interjection:"感動詞",particle:"助詞",abbreviation:"略語"};
// 文字種が近く言語判定が揺れやすい言語は同じグループとして許容
const GRP = {ar:"a",fa:"a",ur:"a",hi:"h",mr:"h",id:"i",ms:"i"};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = c => String(c || "").split("-")[0];
const compat = (det, tl) => base(det) === base(tl) || (GRP[base(det)] && GRP[base(det)] === GRP[base(tl)]);

let results = {}, runId = 0;
const cache = new Map();
const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn().catch(() => null)); return cache.get(key); };

// ---- 1) 日本語 → 各言語の訳語候補（Google翻訳の非公式エンドポイント。差し替え可） ----
async function lookup(word, tl) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=" + tl +
    "&dt=t&dt=bd&dt=rm&q=" + encodeURIComponent(word);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      const main = (d[0] || []).filter(x => x && x[0]).map(x => x[0]).join("");
      const tr = (d[0] || []).find(x => x && x[0] == null && typeof x[2] === "string");
      const cands = [{ w: main, pos: "", back: [] }];
      const dict = (d[1] || []).flatMap(g => (g[2] || []).map(e => ({
        w: e[0], pos: g[0], back: (e[1] || []).slice(0, 3), score: e[3] || 0
      }))).sort((a, b) => b.score - a.score);
      const seen = new Set([main.toLowerCase()]);
      for (const c of dict) {
        if (cands.length >= MAX_CANDIDATES) break;
        if (seen.has(c.w.toLowerCase())) continue;
        seen.add(c.w.toLowerCase());
        cands.push(c);
      }
      const m = dict.find(c => c.w.toLowerCase() === main.toLowerCase());
      if (m) { cands[0].pos = m.pos; cands[0].back = m.back; }
      return { cands: cands.filter(c => c.w), translit: tr ? tr[2] : "" };
    } catch (e) { lastErr = e; await sleep(400); }
  }
  throw lastErr;
}

// ---- 2) Wiktionaryのページから語釈を取得（MediaWiki API、CORS対応・キー不要） ----
function getSections(wl, title) {
  return memo("wt|" + wl + "|" + title, async () => {
    const url = `https://${wl}.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2&prop=text` +
      `&redirects=1&disableeditsection=1&origin=*&page=${encodeURIComponent(title)}`;
    const res = await fetch(url);
    const j = await res.json();
    if (!j.parse) return [];
    const doc = new DOMParser().parseFromString(j.parse.text, "text/html");
    const root = doc.querySelector(".mw-parser-output") || doc.body;
    const out = []; let cur = null;
    for (const el of root.children) {
      const h = el.matches("h2") ? el : el.querySelector(":scope > h2");
      if (h) { cur = { id: h.id || "", name: h.textContent.trim(), defs: [] }; out.push(cur); continue; }
      if (!cur || !el.matches("ol")) continue;
      for (const li of el.children) {
        if (li.tagName !== "LI") continue;
        const c = li.cloneNode(true);
        c.querySelectorAll("ul,ol,dl,sup,style,.h-usage-example,.citation-whole,.nyms").forEach(n => n.remove());
        const t = c.textContent.replace(/\s+/g, " ").trim();
        if (t.length > 1) cur.defs.push(t.slice(0, 220));
      }
    }
    return out.filter(s => s.defs.length);
  });
}

// ---- 3) 語釈を日本語へ翻訳（言語自動判定つき） ----
function toJa(texts, sl) {
  return memo("ja|" + sl + "|" + texts.join("\n"), async () => {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + sl +
      "&tl=ja&dt=t&q=" + encodeURIComponent(texts.join("\n"));
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    const all = (d[0] || []).filter(x => x && x[0]).map(x => x[0]).join("");
    let ja = all.split("\n").map(s => s.trim()).filter(Boolean);
    if (ja.length !== texts.length) ja = [ja.join(" ")];
    return { ja, lang: d[2] || "" };
  });
}

// ---- 4) 各言語版Wikipediaの冒頭要約（概念の説明。語釈が乏しい言語の主力） ----
function getWiki(wl, title) {
  return memo("wp|" + wl + "|" + title, async () => {
    const url = `https://${wl}.wikipedia.org/w/api.php?action=query&prop=extracts|pageprops&ppprop=disambiguation` +
      `&exintro=1&explaintext=1&exsentences=2&redirects=1&converttitles=1&format=json&formatversion=2&origin=*` +
      `&titles=${encodeURIComponent(title)}`;
    const j = await (await fetch(url)).json();
    const p = (j.query?.pages || [])[0];
    if (!p || p.missing || p.pageprops?.disambiguation || !p.extract) return null;
    const t = p.extract.replace(/\s*[（(][^()（）]{0,80}[)）]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
    return t.length >= 20 ? t : null;
  });
}

// 語釈の探索順: ①自言語版Wiktionary（十分な長さのもの）→ ②自言語版Wikipedia要約 → ③英語版Wiktionary
async function define(word, tl, enName) {
  const wl = base(tl), n = ["zh-CN", "ko", "th"].includes(tl) ? 12 : 30;   // 「情報量あり」とみなす最小文字数
  const titles = [...new Set([word, word.toLowerCase()])];
  for (const t of titles) {
    const secs = (await getSections(wl, t)) || [];
    const list = wl === "en" ? secs.filter(s => s.id === enName) : secs.slice(0, 2);
    for (const s of list) {
      const defs = s.defs.filter(d => d.length >= n).slice(0, MAX_DEFS);
      if (!defs.length) continue;
      const tr = await toJa(defs, wl === "en" ? "en" : "auto");
      if (tr && (wl === "en" || compat(tr.lang, tl))) return { orig: defs, ja: tr.ja, src: wl, kind: "wt" };
    }
  }
  for (const t of titles) {
    const ex = await getWiki(wl, t);
    if (ex) { const tr = await toJa([ex], "auto"); if (tr) return { orig: [ex], ja: tr.ja, src: wl, kind: "wp" }; }
  }
  if (wl !== "en") for (const t of titles) {
    const s = ((await getSections("en", t)) || []).find(x => x.id === enName || x.name === enName);
    if (s) { const defs = s.defs.slice(0, MAX_DEFS), tr = await toJa(defs, "en"); if (tr) return { orig: defs, ja: tr.ja, src: "en", kind: "en" }; }
  }
  return null;
}

function render() {
  $("grid").innerHTML = LANGS.map(([code, name]) => {
    const r = results[code];
    let body;
    if (!r) body = '<div class="sk" style="width:70%"></div><div class="sk" style="width:40%"></div>';
    else if (r.error) body = '<div class="err">取得できませんでした</div>';
    else if (!r.cands.length) body = '<div class="err">該当なし</div>';
    else body = r.cands.map((c, i) => {
      const head = i === 0
        ? `<div class="w" dir="auto">${esc(c.w)}</div>` + (r.translit ? `<div class="r" dir="auto">${esc(r.translit)}</div>` : "") +
          (c.pos ? `<span class="pos">${esc(POS_JA[c.pos] || c.pos)}</span>` : "")
        : `<div class="alt" dir="auto">${c.pos ? `<span class="pos">${esc(POS_JA[c.pos] || c.pos)}</span>` : ""}<b>${esc(c.w)}</b>` +
          (c.back.length ? `<span class="back">≒ ${esc(c.back.join("、"))}</span>` : "") + `</div>`;
      const d = c.def;
      const def = d
        ? `<div class="def"><ol class="jp">${d.ja.map(t => `<li>${esc(t)}</li>`).join("")}</ol>` +
          `<div class="orig" dir="auto">${d.orig.map(esc).join(" / ")}</div>` +
          `<span class="src${d.kind === "en" ? " fb" : ""}">${d.kind === "en" ? "英語版Wiktionaryの英語の語釈で補足" : d.kind === "wp" ? "Wikipedia（" + esc(d.src) + "）の概要" : "Wiktionary（" + esc(d.src) + "）"}</span></div>`
        : '<div class="err def">語釈が見つかりませんでした</div>';
      return `<div class="cand">${head}${def}</div>`;
    }).join("");
    return `<div class="card"><div class="lang">${name}</div>${body}</div>`;
  }).join("");
}

async function search(word) {
  const id = ++runId;
  results = {};
  $("btn").disabled = true;
  $("status").textContent = "翻訳・語釈を取得中…";
  render();
  const queue = LANGS.map(l => l.slice());
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const [code, , enName] = queue.shift();
      try {
        const r = await lookup(word, code);
        await Promise.all(r.cands.map(async c => { c.def = await define(c.w, code, enName).catch(() => null); }));
        results[code] = r;
      } catch (e) { results[code] = { error: true }; }
      if (id !== runId) return;
      done++;
      render();
      $("status").textContent = `取得中… ${done}/${LANGS.length}`;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (id !== runId) return;
  $("status").textContent = `「${word}」の各言語での意味`;
  $("btn").disabled = false;
}

$("form").addEventListener("submit", e => {
  e.preventDefault();
  const w = $("q").value.trim();
  if (w) search(w);
});
