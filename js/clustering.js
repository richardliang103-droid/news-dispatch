// ── 事件字典（基於關鍵字的確定性分類） ──
const EVENT_DICT = {
  "衝突":     { words: ["肢體衝突","互毆","痛毆","毆打","打人","徒手攻擊","攻擊","爆爭執","爭執","衝突","打架","鬥毆","拉扯","揮拳","全武行","械鬥","動手","打臉","口角","警方"], label: "衝突" },
  "配息":     { words: ["配息","股利","除息","殖利率","股息"], label: "配息" },
  "財報":     { words: ["獲利","EPS","淨利","法說","財報","營收"], label: "財報" },
  "法人籌碼": { words: ["外資","買超","賣超","投信","自營商","籌碼","大戶"], label: "法人籌碼" },
  "重大訊息": { words: ["重訊","子公司","處分","取得","公告","董事會決議"], label: "重大訊息" },
};

export function normalizeTitle(t) {
  return t
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/[【\[][^\]】]*[\]】]/g, '')
    .replace(/[─–—\-・•·。，,！!？?　\s]+/g, ' ')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff ]/g, '')
    .trim();
}

export function ngrams(s, n) {
  const r = [];
  for (let i = 0; i <= s.length - n; i++) r.push(s.substring(i, i + n));
  return r;
}

export function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

export function eventCategories(title) {
  const cats = [];
  for (const [cat, info] of Object.entries(EVENT_DICT)) {
    for (const w of info.words) { if (title.includes(w)) { cats.push(cat); break; } }
  }
  return cats;
}

function findContextWords(titles) {
  const ctx = [];
  const contextChecks = [
    { words: ["高層"], label: "高層" },
    { words: ["董座", "董事長"], label: "董座" },
    { words: ["警方", "警察", "警員"], label: "警方到場" },
    { words: ["股東會", "股東大會", "股臨會"], label: "股東會" },
  ];
  for (const c of contextChecks) {
    for (const t of titles) {
      for (const w of c.words) {
        if (t.includes(w)) { ctx.push(c.label); break; }
      }
      if (ctx[ctx.length - 1] === c.label) break;
    }
  }
  return ctx;
}

function eventLabel(rows, tickerNames) {
  if (!rows || rows.length === 0) return "";
  const cats = rows.map(r => eventCategories(r.title)).flat();
  const freq = {};
  for (const c of cats) freq[c] = (freq[c] || 0) + 1;
  let bestCat = "", bestCount = 0;
  for (const [c, n] of Object.entries(freq)) { if (n > bestCount) { bestCount = n; bestCat = c; } }
  if (bestCat) {
    const name = tickerNames[rows[0].ticker] || rows[0].ticker;
    const titles = rows.map(r => r.title);
    const ctx = findContextWords(titles);
    const ctxStr = ctx.length > 0 ? ctx.join("") : "";
    return name + ctxStr + EVENT_DICT[bestCat].label;
  }
  // fallback: 取最短標題
  let shortest = rows[0].title;
  for (const r of rows) {
    if (r.title.length < shortest.length) shortest = r.title;
  }
  return shortest.length > 24 ? shortest.substring(0, 24) + "…" : shortest;
}

function entityFromTitle(title, ticker, tickerNames) {
  const entities = [];
  const name = tickerNames[ticker];
  if (name && title.includes(name)) entities.push(name);
  for (const [tk, nm] of Object.entries(tickerNames)) {
    if (nm.length > 1 && title.includes(nm)) entities.push(nm);
  }
  return entities;
}

// ── 主題分組（按 theme 欄位） ──
export function groupByTheme(articles, tickerNames) {
  const byTheme = {};
  for (const a of articles) {
    const th = a.theme || "其他";
    if (!byTheme[th]) byTheme[th] = [];
    byTheme[th].push(a);
  }
  const result = [];
  for (const [theme, rows] of Object.entries(byTheme)) {
    const tickers = [...new Set(rows.map(r => r.ticker))];
    const tickerLabels = tickers.map(t => tickerNames[t] || t).join("、");
    result.push({ topic: theme, rows, tickerString: tickerLabels });
  }
  result.sort((a, b) => b.rows.length - a.rows.length);
  return result;
}

// ── 事件分群（確定性演算法） ──
export function groupByEvent(rows, tickerNames) {
  if (rows.length <= 1) return [{ eventRows: rows, eventLabel: eventLabel(rows, tickerNames) }];

  const n = rows.length, assigned = Array(n).fill(false), clusters = [];

  // Pass 1: 同 ticker + 共享事件類別
  for (let i = 0; i < n; i++) {
    if (assigned[i]) continue;
    const group = [rows[i]]; assigned[i] = true;
    const ci = eventCategories(rows[i].title), ti = rows[i].ticker;
    for (let j = i + 1; j < n; j++) {
      if (assigned[j]) continue;
      const cj = eventCategories(rows[j].title);
      if (ti === rows[j].ticker && ci.length > 0 && cj.length > 0 && ci.some(c => cj.includes(c))) {
        group.push(rows[j]); assigned[j] = true;
      }
    }
    clusters.push({ eventRows: group, eventLabel: eventLabel(group, tickerNames) });
  }

  // Pass 2: 跨 ticker — 相同事件類別 + 標題含相同實體名稱
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i].eventRows.length !== 1) continue;
    const a = clusters[i].eventRows[0];
    const ci = eventCategories(a.title);
    if (ci.length === 0) continue;
    const ai = entityFromTitle(a.title, a.ticker, tickerNames);
    if (ai.length === 0) continue;
    for (let k = 0; k < clusters.length; k++) {
      if (k === i || clusters[k].eventRows.length === 0) continue;
      const bi = clusters[k].eventRows.some(br => {
        const bc = eventCategories(br.title);
        if (!bc.some(c => ci.includes(c))) return false;
        const be = entityFromTitle(br.title, br.ticker, tickerNames);
        return be.some(e => ai.includes(e));
      });
      if (bi) {
        for (const br of clusters[k].eventRows) clusters[i].eventRows.push(br);
        clusters[k].eventRows = [];
        break;
      }
    }
  }

  // Pass 3: n-gram Jaccard — 將單篇合併到既有多篇群組
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i].eventRows.length !== 1) continue;
    const a = clusters[i].eventRows[0];
    const normA = normalizeTitle(a.title);
    let merged = false;
    for (let k = 0; k < clusters.length && !merged; k++) {
      if (k === i || clusters[k].eventRows.length < 2) continue;
      for (const bRow of clusters[k].eventRows) {
        const normB = normalizeTitle(bRow.title);
        const sim2 = jaccard(ngrams(normA, 2), ngrams(normB, 2));
        const sim3 = jaccard(ngrams(normA, 3), ngrams(normB, 3));
        if ((sim2 > 0.4 && sim3 > 0.2) || sim3 > 0.35) {
          clusters[k].eventRows.push(a);
          clusters[i].eventRows = [];
          merged = true;
          break;
        }
      }
    }
  }

  return clusters.filter(c => c.eventRows.length > 0);
}

// ── 混合分群（overlay event_key 優先，其餘走確定性演算法） ──
export function groupByOverlayWithFallback(rows, tickerNames) {
  const hasEvent = rows.filter(r => r.event_key);
  const noEvent = rows.filter(r => !r.event_key);
  const result = [];

  if (hasEvent.length > 0) {
    const byKey = {};
    for (const r of hasEvent) {
      const k = r.event_key;
      if (!byKey[k]) byKey[k] = { eventLabel: r.event_label || k, eventRows: [], eventKey: k, summary: r.event_summary || null };
      byKey[k].eventRows.push(r);
    }
    for (const [, g] of Object.entries(byKey)) {
      result.push({ eventRows: g.eventRows, eventLabel: g.eventLabel, summary: g.summary, _overlay: true });
    }
  }

  if (noEvent.length > 0) {
    const fallback = groupByEvent(noEvent, tickerNames);
    result.push(...fallback);
  }

  return result;
}
