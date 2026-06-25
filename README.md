# 晨報 Dispatch — 個人股市新聞

每日 07:50 自動從 Google News / Yahoo Finance / FinMind / MOPS 抓取台股金融股新聞，推送至 Supabase，前端即時顯示。

## 技術
- 靜態 HTML + Supabase JS（CDN）
- 後端：Hermes cron job → Python → Supabase REST API
- 前端 anon key 為公開金鑰，service_role 僅存於伺服器端

## 部署
GitHub Pages 或 Vercel 靜態部署，無 build step。
