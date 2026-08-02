import Fuse from "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.mjs";
import { TICKER_NAMES, tickerStyle, fetchNews, fetchEvents, fetchEventsFallback, fetchDigests,
         setRead as dbSetRead, setStarred as dbSetStarred, markAllReadRemote,
         persistReadState, persistStarredState, applyLocalState, pruneReadState } from "./db.js";
import { groupByTheme, groupByOverlayWithFallback } from "./clustering.js";

// ── Icon SVGs ──
const ICONS = {
  star: '<svg viewBox="0 0 20 20"><path d="M9.05 2.93c.3-.92 1.6-.92 1.9 0l1.52 4.67a1 1 0 0 0 .95.69h4.91c.97 0 1.37 1.24.59 1.81l-3.98 2.89a1 1 0 0 0-.36 1.12l1.52 4.67c.3.92-.76 1.69-1.54 1.12l-3.98-2.89a1 1 0 0 0-1.18 0l-3.97 2.89c-.79.57-1.84-.2-1.54-1.12l1.52-4.67a1 1 0 0 0-.36-1.12L2.05 10.1c-.78-.57-.38-1.81.59-1.81h4.91a1 1 0 0 0 .95-.69L9.05 2.93Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
};

// ── 全域狀態 ──
const state = { ticker: "all", view: "all", sort: "time", search: "", loading: true, error: false, category: "stock" };
let DATA = [];
let TICKERS = [];
let DIGESTS = {}; // { ticker: { summary, date } } — 每日 AI 摘要
let fuseInstance = null; // Fuse.js 實例

// ── Fuse.js 模糊搜尋初始化 ──
// 索引固定為「完整 DATA」，絕不用過濾後的子集重建，避免搜尋結果隨輸入單調收斂、無法復原。
function initFuse() {
  const enriched = DATA.map(r => ({ ...r, tickerName: TICKER_NAMES[r.ticker] || "" }));
  fuseInstance = new Fuse(enriched, {
    keys: [
      { name: "title", weight: 2 },
      { name: "source", weight: 1 },
      { name: "ticker", weight: 0.5 },
      { name: "tickerName", weight: 1 },
    ],
    threshold: 0.4,
    distance: 100,
    minMatchCharLength: 1,
  });
}

// 每次過濾前只呼叫一次 Fuse.search（而非對每一列各呼叫一次），回傳命中 id 集合。
function searchHitSet() {
  if (!state.search || !fuseInstance) return null;
  return new Set(fuseInstance.search(state.search).map(x => x.item.id));
}

// ── 輔助函數 ──
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function tickerBadge(ticker) {
  const name = TICKER_NAMES[ticker] || ticker;
  return `<span class="rtk" style="${tickerStyle(ticker)}"><span class="rtk-name">${esc(name)}</span><span class="rtk-code">${esc(ticker)}</span></span>`;
}

function nameOf(t) { return (TICKERS.find(x => x.ticker === t) || {}).name || t; }
const unreadOf = t => DATA.filter(d => d.ticker === t && !d.read).length;
const totalUnread = () => DATA.filter(d => !d.read).length;
const totalStar = () => DATA.filter(d => d.starred).length;

// ── 搜尋過濾 ── hits 為 searchHitSet() 的結果，由呼叫端算好一次傳入
function matches(r, hits) {
  if (state.ticker !== "all" && r.ticker !== state.ticker) return false;
  if (state.view === "unread" && r.read) return false;
  if (state.view === "starred" && !r.starred) return false;
  if (state.search) {
    if (hits) return hits.has(r.id);
    // 降級：substring
    const hay = (r.title + " " + r.source + " " + r.ticker + " " + r.theme).toLowerCase();
    if (!hay.includes(state.search)) return false;
  }
  return true;
}

// ── 行 HTML ──
function rowHTML(r) {
  const meta = [tickerBadge(r.ticker), `<span>${esc(r.source)}</span>`];
  if (r.time) meta.push(`<span class="sep">·</span><span>${esc(r.time)}</span>`);
  meta.push(`<span class="chip">${esc(r.theme)}</span>`);
  return `<article class="row ${r.read ? "" : "unread"} ${r.starred ? "starred" : ""}" role="button" tabindex="0" data-id="${r.id}">
    <div class="r-main">
      <div class="title">${esc(r.title)}</div>
      <div class="meta">${meta.join("")}</div>
    </div>
    <button class="star" data-star="${r.id}" aria-label="收藏" title="收藏">${ICONS.star}</button>
  </article>`;
}

// ── 每日摘要卡片 ──
function digestCardHTML(tk, isTop = false) {
  const d = DIGESTS[tk];
  if (!d || !d.summary) return "";
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dd = new Date(d.date + "T00:00:00");
  const label = d.date === todayStr ? "今日摘要" : `${dd.getMonth() + 1}/${dd.getDate()} 摘要`;
  return `<div class="digest-card${isTop ? " top" : ""}">
    <span class="digest-icon">✦</span>
    <div class="digest-body">
      <span class="digest-label">${esc(label)}</span>
      <p class="digest-text">${esc(d.summary)}</p>
    </div>
  </div>`;
}

// ── 主渲染 ──
function render() {
  if (state.loading) return;
  const wrap = document.getElementById("groups");
  const empty = document.getElementById("empty");
  const hits = searchHitSet();
  const items = DATA.filter(r => matches(r, hits));

  if (items.length === 0) {
    wrap.innerHTML = "";
    let mk = "✓", big = "今天的新聞都看完了", small = "明早 07:50 會有新的一批";
    if (state.search) { mk = "⌕"; big = `找不到符合「${esc(state.search)}」的新聞`; small = "換個關鍵字試試"; }
    else if (state.view === "starred") { mk = "☆"; big = "還沒有收藏"; small = "點任一則右側的星號加入"; }
    empty.innerHTML = `<div class="mk">${mk}</div><div class="big">${big}</div><div class="small">${small}</div>`;
    empty.classList.add("show");
    return;
  }
  empty.classList.remove("show");

  // 單一 ticker 篩選時，把該檔的每日摘要固定在最上方（各種排序皆同）
  const topDigest = (state.category === "stock" && state.ticker !== "all" && !state.search)
    ? digestCardHTML(state.ticker, true) : "";

  let html;
  if (state.sort === "ticker") {
    const order = TICKERS.map(t => t.ticker);
    html = topDigest + order.filter(tk => items.some(i => i.ticker === tk)).map(tk => {
      const rows = items.filter(i => i.ticker === tk).sort((a, b) => b.ts - a.ts);
      const unread = rows.filter(r => !r.read).length;
      const nm = TICKER_NAMES[tk] || tk;
      // ticker 分組標題列下方的每日摘要卡片（收合時也保持可見）
      const digest = state.ticker === "all" ? digestCardHTML(tk) : "";
      return `<section class="group topic-cluster ticker-cluster collapsed" data-key="ticker:${esc(tk)}" style="${tickerStyle(tk)}">
        <div class="topic-head" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle">▼</span>
          <span class="topic-label"><span class="rtk-name">${esc(nm)}</span><span class="rtk-code">${esc(tk)}</span></span>
          <span class="topic-meta">${unread}/${rows.length} 則</span>
        </div>
        ${digest}
        ${rows.map(rowHTML).join("")}
      </section>`;
    }).join("");
  } else {
    // 依時間排序：日期分組 → 主題聚類 → 事件分群
    const sorted = [...items].sort((a, b) => b.ts - a.ts);
    const weekMap = ["日", "一", "二", "三", "四", "五", "六"];
    const dateLabel = ts => {
      const d = new Date(ts);
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${weekMap[d.getDay()]})`;
    };

    const dateGroups = [];
    let curDate = "";
    for (const r of sorted) {
      const lbl = dateLabel(r.ts);
      if (lbl !== curDate) { curDate = lbl; dateGroups.push({ label: lbl, rows: [] }); }
      dateGroups[dateGroups.length - 1].rows.push(r);
    }

    html = topDigest + dateGroups.map(dg => {
      const clusters = state.category === "tech"
        ? dg.rows.map(r => ({ ticker: r.ticker, topic: "", rows: [r], tickerString: "" }))
        : groupByTheme(dg.rows, TICKER_NAMES);

      const clusterHTML = clusters.map(cl => {
        if (cl.rows.length === 1) return rowHTML(cl.rows[0]);

        const eventClusters = groupByOverlayWithFallback(cl.rows, TICKER_NAMES);
        const eventHTML = eventClusters.map(ec => {
          if (ec.eventRows.length === 1) return rowHTML(ec.eventRows[0]);
          const unread = ec.eventRows.filter(r => !r.read).length;
          // AI 摘要（若有）
          const summaryHTML = ec.summary
            ? `<span class="topic-summary">${esc(ec.summary)}</span>`
            : "";
          const eventKey = ec.eventKey || ec.eventLabel;
          return `<div class="topic-cluster collapsed" data-key="event:${esc(dg.label)}:${esc(cl.topic)}:${esc(eventKey)}">
            <div class="topic-head" onclick="this.parentElement.classList.toggle('collapsed')">
              <span class="toggle">▼</span>
              <span class="topic-label">${esc(ec.eventLabel)}</span>
              ${summaryHTML}
              <span class="topic-meta">${unread}/${ec.eventRows.length} 則</span>
            </div>
            ${ec.eventRows.map(rowHTML).join("")}
          </div>`;
        }).join("");

        const unread = cl.rows.filter(r => !r.read).length;
        return `<div class="topic-cluster" data-key="theme:${esc(dg.label)}:${esc(cl.topic)}">
          <div class="topic-head" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="toggle">▼</span>
            <span class="topic-label">${esc(cl.topic)}</span>
            <span class="topic-meta">${cl.tickerString || ''} · ${unread}/${cl.rows.length} 則</span>
          </div>
          ${eventHTML}
        </div>`;
      }).join("");

      return `<section class="group">
        <div class="group-head"><span class="gnm">${dg.label}</span><span class="gline"></span><span class="gcount">${dg.rows.length} 則</span></div>
        ${clusterHTML}
      </section>`;
    }).join("");
  }

  wrap.innerHTML = html;
}

// ── Rail + mobile chips ──
function renderRail() {
  const items = [{ ticker: "all", name: "全部" }, ...TICKERS];
  const wl = items.map(it => {
    const n = it.ticker === "all" ? totalUnread() : unreadOf(it.ticker);
    const cls = (it.ticker === "all" ? "all " : "") + (it.ticker === state.ticker ? "active" : "");
    const label = it.ticker === "all" ? "全部" : (it.name !== it.ticker ? it.name : it.ticker);
    const tickerTag = it.ticker !== "all" && it.name !== it.ticker ? `<span class="nm">${it.ticker}</span>` : "";
    return `<button class="wl-item ${cls}" data-ticker="${it.ticker}">
      <span class="tk">${label}</span>${tickerTag}
      <span class="badge ${n === 0 ? "zero" : ""}">${n}</span></button>`;
  }).join("");
  document.getElementById("watchlist").innerHTML = wl;

  const cb = items.map(it => {
    const n = it.ticker === "all" ? totalUnread() : unreadOf(it.ticker);
    const cls = (it.ticker === "all" ? "all " : "") + (it.ticker === state.ticker ? "active" : "");
    const chipLabel = it.ticker === "all" ? "全部" : (it.name !== it.ticker ? it.name : it.ticker);
    const chipCode = it.ticker !== "all" && it.name !== it.ticker ? `<span class="code">${it.ticker}</span>` : "";
    return `<button class="chip-tk ${cls}" data-ticker="${it.ticker}">
      <span class="tk">${chipLabel}</span>${chipCode}
      <span class="badge ${n === 0 ? "zero" : ""}">${n}</span></button>`;
  }).join("");
  document.getElementById("chipbar").innerHTML = cb;
}

function renderAll() {
  render();
  updateCounts();
}

// ── 計數更新（含 rail/chip 徽章，兩者都要跟著已讀/收藏狀態變動）──
function updateCounts() {
  renderRail();
  document.getElementById("cnt-unread").textContent = totalUnread();
  document.getElementById("cnt-star").textContent = totalStar();
}

// ── 骨架屏 ──
function renderSkeleton() {
  const wrap = document.getElementById("groups");
  wrap.innerHTML = Array.from({ length: 6 }, () =>
    `<div class="sk-row"><div class="skeleton sk-title"></div><div class="skeleton sk-meta"></div></div>`
  ).join("");
  document.getElementById("empty").classList.remove("show");
}

// ── 空白狀態 ──
function showEmpty(mk, big, small) {
  const el = document.getElementById("empty");
  el.innerHTML = `<div class="mk">${mk}</div><div class="big">${big}</div><div class="small">${small}</div>`;
  el.classList.add("show");
}

// ── 重繪時保留捲動位置與 cluster 展開狀態 ──
// 單篇已讀/收藏不該讓使用者失去正在看的捲動位置、也不該把展開中的事件群收合回去；
// 篩選條件變更（搜尋/排序/切標的）則維持原本「跳回頂部」的行為，不套用這層保留。
function captureClusterStates() {
  const map = {};
  document.querySelectorAll(".topic-cluster[data-key]").forEach(el => {
    map[el.dataset.key] = el.classList.contains("collapsed");
  });
  return map;
}

function restoreClusterStates(states) {
  document.querySelectorAll(".topic-cluster[data-key]").forEach(el => {
    const key = el.dataset.key;
    if (key in states) el.classList.toggle("collapsed", states[key]);
  });
}

function renderPreservingViewState(fn) {
  const feedEl = document.querySelector(".feed");
  const scrollTop = feedEl ? feedEl.scrollTop : 0;
  const states = captureClusterStates();
  fn();
  restoreClusterStates(states);
  if (feedEl) feedEl.scrollTop = scrollTop;
}

// ── 互動處理 ──
function openRow(el) {
  const r = DATA.find(d => d.id === +el.dataset.id);
  if (!r) return;
  window.open(r.url, "_blank", "noopener,noreferrer");
  if (r.read) return;
  r.read = true;
  persistReadState(DATA);
  dbSetRead(r.id, true);
  renderPreservingViewState(renderAll);
}

function toggleStar(id) {
  const r = DATA.find(d => d.id === id);
  if (!r) return;
  r.starred = !r.starred;
  persistStarredState(DATA);
  dbSetStarred(id, r.starred);
  renderPreservingViewState(renderAll);
  const btn = document.querySelector(`[data-star="${id}"]`);
  if (btn) {
    btn.classList.add("spin");
    const clearSpin = () => btn.classList.remove("spin");
    btn.addEventListener("animationend", clearSpin, { once: true });
    setTimeout(clearSpin, 400); // 防呆：animationend 極少數情況下不觸發也要清掉 class
  }
}

function selectTicker(tk) { state.ticker = tk; renderAll(); }

async function markAllRead() {
  const hits = searchHitSet();
  const ids = DATA.filter(r => matches(r, hits)).map(r => r.id);
  if (!ids.length) return;
  ids.forEach(id => { const r = DATA.find(d => d.id === id); if (r) r.read = true; });
  persistReadState(DATA);
  renderPreservingViewState(renderAll);
  await markAllReadRemote(ids);
}

// ── 事件綁定 ──
function bindEvents() {
  document.getElementById("groups").addEventListener("click", e => {
    const s = e.target.closest(".star");
    if (s) { e.stopPropagation(); toggleStar(+s.dataset.star); return; }
    const row = e.target.closest(".row");
    if (row) { e.stopPropagation(); openRow(row); }
  });
  document.getElementById("groups").addEventListener("keydown", e => {
    const row = e.target.closest(".row");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRow(row); }
  });
  document.addEventListener("click", e => {
    const w = e.target.closest("[data-ticker]");
    if (w) selectTicker(w.dataset.ticker);
  });

  document.getElementById("viewSeg").querySelectorAll("button").forEach(b => {
    b.onclick = () => { state.view = b.dataset.view; b.parentElement.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b)); renderAll(); };
  });
  document.getElementById("sortSeg").querySelectorAll("button").forEach(b => {
    b.onclick = () => { state.sort = b.dataset.sort; b.parentElement.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b)); renderAll(); };
  });

  // 類別切換
  document.querySelectorAll(".cat-tab").forEach(b => {
    b.onclick = () => {
      state.category = b.dataset.cat;
      state.ticker = "all";
      document.querySelectorAll(".cat-tab").forEach(x => x.classList.toggle("active", x === b));
      loadNews();
    };
  });

  // debounce 150ms 避免每個鍵都全量重繪；組字（注音/拼音）過程中 input 事件不觸發搜尋，
  // 等 compositionend 才算數，否則組字中的半成品字元會先跑一次無意義的搜尋。
  const searchInput = document.getElementById("search");
  let searchTimer = null, composing = false;
  const applySearch = value => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = value.trim().toLowerCase();
      renderAll();
    }, 150);
  };
  searchInput.addEventListener("compositionstart", () => { composing = true; });
  searchInput.addEventListener("compositionend", e => { composing = false; applySearch(e.target.value); });
  searchInput.addEventListener("input", e => { if (!composing) applySearch(e.target.value); });
  document.getElementById("markAll").onclick = markAllRead;
  document.getElementById("retryBtn").onclick = loadNews;

  // 主題切換
  const themeBtn = document.getElementById("themeBtn");
  const setThemeIcon = () => { themeBtn.innerHTML = document.documentElement.dataset.theme === "dark" ? ICONS.sun : ICONS.moon; };
  setThemeIcon();
  themeBtn.onclick = () => {
    if (document.documentElement.dataset.theme === "dark") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = "dark";
    setThemeIcon();
    saveThemePreference();
    // ticker 配色（inline style）依 data-theme 決定深淺兩組，切換後要重繪才會套用
    if (!state.loading) renderAll();
  };
}

// ── 主題記憶（localStorage）──
// index.html <head> 有一段同步 inline script 會在首次繪製前套用同一把 key，避免深色模式下先閃一下淺色。
function saveThemePreference() {
  try { localStorage.setItem("ns-theme", document.documentElement.dataset.theme === "dark" ? "dark" : "light"); }
  catch (e) {}
}

// ── 主要載入流程 ──
// loadSeq 防止快速切分類時，先發出但後回來的舊請求覆蓋掉新請求已渲染的畫面
let loadSeq = 0;
async function loadNews() {
  const seq = ++loadSeq;
  state.loading = true;
  state.error = false;
  document.getElementById("errBanner").classList.remove("show");
  renderSkeleton();

  try {
    // 三個查詢互不依賴，平行發出取代原本序列 await（首屏少兩次往返）
    const [newsData, digests, eventsMap] = await Promise.all([
      fetchNews(state.category),
      state.category === "stock" ? fetchDigests() : Promise.resolve({}),
      fetchEvents().then(m => m || fetchEventsFallback()),
    ]);
    if (seq !== loadSeq) return; // 已有更新的載入請求，這批結果作廢

    DATA = newsData;
    applyLocalState(DATA);
    pruneReadState(DATA);
    DIGESTS = digests;

    if (eventsMap) {
      for (const r of DATA) {
        const ev = eventsMap[String(r.id)];
        if (ev) {
          r.event_key = ev.event_key;
          r.event_label = ev.event_label;
          r.event_summary = ev.summary || null;
          r.event_confidence = ev.confidence || 0;
        }
      }
    }

    // 提取 ticker 列表
    const seen = new Set();
    TICKERS = [];
    for (const r of DATA) {
      if (!seen.has(r.ticker)) {
        seen.add(r.ticker);
        TICKERS.push({ ticker: r.ticker, name: TICKER_NAMES[r.ticker] || r.ticker });
      }
    }

    // 初始化 Fuse.js
    initFuse();

    // 更新時間
    const now = new Date();
    document.getElementById("update-time").textContent =
      `更新於 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    document.getElementById("date-sub").textContent =
      `${now.getMonth() + 1}/${now.getDate()} 週${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]}`;
    document.getElementById("date-when").textContent =
      `${now.getMonth() + 1}/${now.getDate()} ${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]}`;

    state.loading = false;
    renderAll();
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error("Supabase fetch error:", e);
    state.loading = false;
    state.error = true;
    document.getElementById("errBanner").classList.add("show");
    document.getElementById("groups").innerHTML = "";
    showEmpty("⚠", "載入新聞失敗", "請檢查網路後點擊重試");
  }
}

// ── 啟動 ──
bindEvents();
loadNews();
