# Supabase 事件分類遷移指引

## 背景

目前 `events.json` 由後端 Metis 產出後，經 cron job 直接 commit/push 回 GitHub。這導致：
- Git 歷史充滿大量 `chore: update semantic event classification overlay` 記錄
- 資料與程式碼混雜

## 目標

將事件分類資料從 Git 移出，改存至 Supabase `news_events` 資料表。

---

## 步驟 1：建立 Supabase 資料表

在 Supabase SQL Editor 執行：

```sql
-- 建立事件分類表
CREATE TABLE IF NOT EXISTS news_events (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  article_id BIGINT NOT NULL,
  event_key TEXT NOT NULL,
  event_label TEXT NOT NULL,
  summary TEXT,           -- AI 生成的事件一句話摘要
  confidence REAL DEFAULT 0.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_news_events_event_key ON news_events(event_key);
CREATE INDEX IF NOT EXISTS idx_news_events_article_id ON news_events(article_id);

-- RLS 政策（允許 anon 讀取）
ALTER TABLE news_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "允許匿名讀取" ON news_events
  FOR SELECT USING (true);
```

## 步驟 2：遷移現有 events.json 資料

執行一次性遷移腳本（需要 service_role key）：

```python
# migrate_events.py
import json, os
from supabase import create_client

SUPABASE_URL = "https://xrlboexuvgegdahfqegg.supabase.co"
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

with open("events.json") as f:
    data = json.load(f)

rows = []
for article_id, ev in data.get("items", {}).items():
    rows.append({
        "article_id": int(article_id),
        "event_key": ev["event_key"],
        "event_label": ev["event_label"],
        "confidence": ev.get("confidence", 0),
        "summary": ev.get("summary"),  # 未來欄位
    })

# 批次寫入（upsert 避免重複）
result = supabase.table("news_events").upsert(rows, on_conflict="article_id").execute()
print(f"已寫入 {len(rows)} 筆事件關聯")
```

## 步驟 3：修改後端 cron job

將原本「寫 events.json → git commit/push」的流程改為「寫 Supabase news_events 表」：

```python
# 舊流程（要移除的）
# write_json("events.json", data)
# git add events.json && git commit -m "chore: update events" && git push

# 新流程
def push_events_to_supabase(events_map):
    """將事件分類寫入 Supabase"""
    rows = []
    for article_id, ev in events_map.items():
        rows.append({
            "article_id": int(article_id),
            "event_key": ev["event_key"],
            "event_label": ev["event_label"],
            "summary": ev.get("summary", ""),
            "confidence": ev.get("confidence", 0),
        })
    # 每日全量替換：先刪除舊資料再寫入
    supabase.table("news_events").delete().neq("id", 0).execute()
    supabase.table("news_events").insert(rows).execute()
```

## 步驟 4：從 Git 移除 events.json

```bash
# 從 Git 追蹤移除（保留本地檔案作為 fallback）
git rm --cached events.json
echo "events.json" >> .gitignore
git commit -m "chore: 將事件分類移入 Supabase，events.json 改為前端 fallback 用"
git push
```

## 步驟 5：測試前端

前端已實作雙重 fallback 邏輯（`db.js` 中的 `fetchEvents()` → `fetchEventsFallback()`）：
1. 優先查詢 `news_events` 表
2. 若不可用，fallback 到本地 `events.json`

確保 Supabase `news_events` 表有資料後，前端會自動使用新來源。

---

## AI 摘要擴充

當後端 Metis 分析事件群組時，可為每個 `event_key` 生成一句話摘要，寫入 `summary` 欄位。前端會在收合區塊標頭右側顯示：

```
▼ 國泰高層肢體衝突  「國泰金高層在股東會後爆發肢體衝突，警方介入處理」  0/14 則
                                         ╰── summary ──╯
```

若 `summary` 為空，前端只顯示事件標籤（維持原有行為）。
