import { TICKER_NAMES, tickerStyle, fetchNews, fetchEvents, fetchEventsFallback,
         setRead as dbSetRead, setStarred as dbSetStarred, markAllReadRemote,
         persistReadState, persistStarredState, applyLocalState } from "./db.js";
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
let fuseInstance = null; // Fuse.js 實例

// ── Fuse.js 模糊搜尋初始化 ──
function initFuse() {
  if (typeof Fuse === "undefined") {
    console.warn("Fuse.js 未載入，降級為 substring 搜尋");
    return;
  }
  fuseInstance = new Fuse(DATA, {
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

// ── 搜尋過濾 ──
function matches(r) {
  if (state.ticker !== "all" && r.ticker !== state.ticker) return false;
  if (state.view === "unread" && r.read) return false;
  if (state.view === "starred" && !r.starred) return false;
  if (state.search) {
    if (fuseInstance) {
      // Fuse.js 模糊搜尋
      const enriched = { ...r, tickerName: TICKER_NAMES[r.ticker] || "" };
      const results = fuseInstance.search(state.search);
      return results.some(result => result.item.id === r.id);
    } else {
      // 降級：substring
      const hay = (r.title + " " + r.source + " " + r.ticker + " " + r.theme).toLowerCase();
      if (!hay.includes(state.search)) return false;
    }
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

// ── 使用 DocumentFragment 批次渲染 ──
function renderToFragment(htmlFn) {
  const frag = document.createDocumentFragment();
  const tmp = document.createElement("div");
  tmp.innerHTML = htmlFn();
  while (tmp.firstChild) frag.appendChild(tmp.firstChild);
  return frag;
}

// ── 主渲染 ──
function render() {
  if (state.loading) return;
  const wrap = document.getElementById("groups");
  const empty = document.getElementById("empty");
  const items = DATA.filter(matches);

  // 每次搜尋條件變更時重建 Fuse 索引（只索引當前過濾後的資料）
  if (fuseInstance && state.search) {
    const enriched = items.map(r => ({ ...r, tickerName: TICKER_NAMES[r.ticker] || "" }));
    fuseInstance.setCollection(enriched);
  }

  if (items.length === 0) {
    wrap.innerHTML = "";
    let mk = "✓", big = "今天的新聞都看完了", small = "明早 07:30 會有新的一批";
    if (state.search) { mk = "⌕"; big = `找不到符合「${state.search}」的新聞`; small = "換個關鍵字試試"; }
    else if (state.view === "starred") { mk = "☆"; big = "還沒有收藏"; small = "點任一則右側的星號加入"; }
    empty.innerHTML = `<div class="mk">${mk}</div><div class="big">${big}</div><div class="small">${small}</div>`;
    empty.classList.add("show");
    return;
  }
  empty.classList.remove("show");

  // 使用 DocumentFragment 批次建構 DOM
  const frag = document.createDocumentFragment();
  const container = document.createElement("div");

  if (state.sort === "ticker") {
    const order = TICKERS.map(t => t.ticker);
    container.innerHTML = order.filter(tk => items.some(i => i.ticker === tk)).map(tk => {
      const rows = items.filter(i => i.ticker === tk).sort((a, b) => b.ts - a.ts);
      const unread = rows.filter(r => !r.read).length;
      const nm = TICKER_NAMES[tk] || tk;
      return `<section class="group topic-cluster ticker-cluster collapsed" style="${tickerStyle(tk)}">
        <div class="topic-head" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle">▼</span>
          <span class="topic-label"><span class="rtk-name">${esc(nm)}</span><span class="rtk-code">${esc(tk)}</span></span>
          <span class="topic-meta">${unread}/${rows.length} 則</span>
        </div>
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

    container.innerHTML = dateGroups.map(dg => {
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
          return `<div class="topic-cluster collapsed">
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
        return `<div class="topic-cluster">
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

  while (container.firstChild) frag.appendChild(container.firstChild);
  wrap.innerHTML = "";
  wrap.appendChild(frag);
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
  renderRail();
  render();
  updateCounts();
}

// ── 計數更新 ──
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

// ── 互動處理 ──
function openRow(el) {
  const r = DATA.find(d => d.id === +el.dataset.id);
  if (!r) return;
  window.open(r.url, "_blank");
  if (r.read) return;
  r.read = true;
  persistReadState(DATA);
  dbSetRead(r.id, true);
  renderAll();
}

function toggleStar(id) {
  const r = DATA.find(d => d.id === id);
  if (!r) return;
  r.starred = !r.starred;
  persistStarredState(DATA);
  dbSetStarred(id, r.starred);
  renderAll();
}

function selectTicker(tk) { state.ticker = tk; renderAll(); }

async function markAllRead() {
  const ids = DATA.filter(matches).map(r => r.id);
  if (!ids.length) return;
  ids.forEach(id => { const r = DATA.find(d => d.id === id); if (r) r.read = true; });
  persistReadState(DATA);
  renderAll();
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

  document.getElementById("search").addEventListener("input", e => {
    state.search = e.target.value.trim().toLowerCase();
    renderAll();
  });
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
  };
}

// ── 主要載入流程 ──
async function loadNews() {
  state.loading = true;
  state.error = false;
  document.getElementById("errBanner").classList.remove("show");
  renderSkeleton();

  try {
    DATA = await fetchNews(state.category);
    applyLocalState(DATA);

    // 載入事件分類（優先 Supabase news_events 表，fallback 到 events.json）
    const eventsMap = await fetchEvents() || await fetchEventsFallback();
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
