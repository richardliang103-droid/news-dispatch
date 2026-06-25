// ── Supabase 初始化 ──
const SUPABASE_URL = "https://xrlboexuvgegdahfqegg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mBWmYim24FPVM2INU6KjKQ_ZbEl2wrn";
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── 股票名稱對照表 ──
export const TICKER_NAMES = {
  "2881":"富邦金","2882":"國泰金","2884":"玉山金",
  "2886":"兆豐金","2887":"台新新光金","2890":"永豐金","2891":"中信金",
  "2330":"台積電","2454":"聯發科","NVDA":"輝達","AAPL":"蘋果","AMD":"超微",
  "TECH":"科技",
};

// ── Ticker 調色盤 ──
export const TICKER_PALETTE = [
  {bg:"rgba(37,99,235,.11)", name:"#2563EB", code:"#9A3412"},
  {bg:"rgba(5,150,105,.12)", name:"#047857", code:"#B45309"},
  {bg:"rgba(217,119,6,.13)", name:"#B45309", code:"#1D4ED8"},
  {bg:"rgba(190,24,93,.11)", name:"#BE185D", code:"#047857"},
  {bg:"rgba(14,116,144,.12)", name:"#0E7490", code:"#A16207"},
  {bg:"rgba(124,58,237,.10)", name:"#6D28D9", code:"#0F766E"},
  {bg:"rgba(180,83,9,.12)", name:"#92400E", code:"#1E40AF"},
];

export function tickerPalette(ticker) {
  const key = String(ticker || "");
  let n = 0;
  for (let i = 0; i < key.length; i++) n = (n * 31 + key.charCodeAt(i)) >>> 0;
  return TICKER_PALETTE[n % TICKER_PALETTE.length];
}

export function tickerStyle(ticker) {
  const p = tickerPalette(ticker);
  return `--ticker-bg:${p.bg};--ticker-name:${p.name};--ticker-code:${p.code}`;
}

// ── 時間格式化 ──
export function fmtTime(ts) {
  if (!ts) return "";
  const raw = String(ts);
  const hasClock = /T\d{2}:\d{2}/.test(raw) || /\d{2}:\d{2}:\d{2}/.test(raw);
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const dm = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = dm.getTime() === today.getTime() ? "今日"
    : (dm.getTime() === yesterday.getTime() ? "昨" : `${d.getMonth()+1}/${d.getDate()}`);
  if (!hasClock) return day;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

// ── 從 Supabase 載入新聞 ──
export async function fetchNews(category) {
  const srcType = category === "tech" ? "tech" : "stock";
  const { data, error } = await supabase
    .from("news")
    .select("*")
    .eq("source_type", srcType)
    .order("published", { ascending: false })
    .limit(200);

  if (error) throw error;

  return (data || []).map(r => ({
    id: r.id,
    ticker: r.ticker,
    title: r.title,
    url: r.url,
    source: r.source || "",
    theme: r.theme || "其他",
    time: fmtTime(r.published),
    ts: r.published ? new Date(r.published).getTime() : 0,
    read: r.read || false,
    starred: r.starred || false,
  }));
}

// ── 從 Supabase 載入事件分類（取代 events.json） ──
export async function fetchEvents() {
  try {
    const { data, error } = await supabase
      .from("news_events")
      .select("article_id, event_key, event_label, summary, confidence")
      .order("confidence", { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return null;

    // 結構化：{ [article_id]: { event_key, event_label, summary, confidence } }
    const map = {};
    for (const ev of data) {
      const aid = String(ev.article_id);
      // 保留最高 confidence 的事件
      if (!map[aid] || ev.confidence > map[aid].confidence) {
        map[aid] = {
          event_key: ev.event_key,
          event_label: ev.event_label,
          summary: ev.summary || null,
          confidence: ev.confidence || 0,
        };
      }
    }
    return map;
  } catch (e) {
    console.warn("news_events 載入失敗，嘗試 fallback", e);
    return null;
  }
}

// ── local JSON fallback（Supabase 不可用時） ──
export async function fetchEventsFallback() {
  try {
    const resp = await fetch("events.json?v=" + Date.now());
    if (!resp.ok) return null;
    const events = await resp.json();
    if (events && events.items) {
      const map = {};
      for (const [aid, ev] of Object.entries(events.items)) {
        map[aid] = {
          event_key: ev.event_key,
          event_label: ev.event_label,
          summary: ev.summary || null,
          confidence: ev.confidence || 0,
        };
      }
      return map;
    }
    return null;
  } catch (e) {
    console.warn("events.json fallback 載入失敗", e);
    return null;
  }
}

// ── Supabase 寫入操作 ──
export async function setRead(id, value) {
  const { error } = await supabase.from("news").update({ read: value }).eq("id", id);
  if (error) console.warn("setRead Supabase 寫入失敗:", error);
}

export async function setStarred(id, value) {
  const { error } = await supabase.from("news").update({ starred: value }).eq("id", id);
  if (error) console.warn("setStarred Supabase 寫入失敗:", error);
}

export async function markAllReadRemote(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from("news").update({ read: true }).in("id", ids);
  if (error) console.warn("markAllRead Supabase 寫入失敗:", error);
}

// ── localStorage 本地持久化（Supabase 寫入失敗時的備援） ──
const LS_READ = "ns-read-ids";
const LS_STAR = "ns-star-ids";

function storedIdSet(key) {
  try { return new Set((JSON.parse(localStorage.getItem(key) || "[]") || []).map(String)); }
  catch (e) { return new Set(); }
}

function writeIdSet(key, ids) {
  try { localStorage.setItem(key, JSON.stringify([...ids])); } catch (e) {}
}

export function persistReadState(data) {
  const ids = storedIdSet(LS_READ);
  for (const d of data) {
    const k = String(d.id);
    if (d.read) ids.add(k); else ids.delete(k);
  }
  writeIdSet(LS_READ, ids);
}

export function persistStarredState(data) {
  const ids = storedIdSet(LS_STAR);
  for (const d of data) {
    const k = String(d.id);
    if (d.starred) ids.add(k); else ids.delete(k);
  }
  writeIdSet(LS_STAR, ids);
}

export function applyLocalState(data) {
  const readIds = storedIdSet(LS_READ);
  const starIds = storedIdSet(LS_STAR);
  data.forEach(d => {
    const k = String(d.id);
    if (readIds.has(k)) d.read = true;
    if (starIds.has(k)) d.starred = true;
  });
}
