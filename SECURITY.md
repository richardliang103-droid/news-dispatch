# 安全性強化：Supabase 欄位級授權

## 背景

前端使用 anon public key 直接對 `news` 表執行 `UPDATE`（見
[js/db.js](js/db.js) 的 `setRead` / `setStarred` / `markAllReadRemote`），
目的只是寫入 `read` / `starred` 兩個欄位。

anon key 本來就是公開金鑰、寫死在前端是正常做法，但如果 Supabase 的
Row Level Security policy 目前允許 anon 角色 UPDATE 整列（而非限定欄位），
任何取得這把 key 的人都能一併竄改 `title`、`url` 等欄位——例如把某篇文章
的 `url` 換成釣魚連結。使用者每天早上點的都是同一批連結，這個風險不小。

## 修法：欄位級 GRANT

需要在 Supabase SQL Editor 用 owner／service_role 權限執行一次
（anon key 沒有權限做這件事，此 repo 也不含 service_role key，
所以這步無法由 PR 自動套用，請手動執行）：

```sql
-- 撤銷 anon 對 news 表的全欄位 UPDATE 權限
REVOKE UPDATE ON public.news FROM anon;

-- 只授權 read / starred 兩個欄位可寫
GRANT UPDATE (read, starred) ON public.news TO anon;
```

## 驗證

執行後可在瀏覽器 console（前端頁面已載入 anon client）驗證：

```js
// 預期失敗（42501 insufficient_privilege）
await supabase.from("news").update({ title: "test" }).eq("id", 1);

// 預期成功
await supabase.from("news").update({ read: true }).eq("id", 1);
```

若第一個呼叫仍然成功，代表 policy 尚未生效，需要重新檢查 RLS 設定。

## 附註

這次盤點只涵蓋 `news` 表的 UPDATE，範圍限定在前端程式碼實際會寫入的
路徑。若日後要更全面檢查 INSERT / DELETE 或其他表的 policy，建議另外
盤點，此文件不涵蓋。
