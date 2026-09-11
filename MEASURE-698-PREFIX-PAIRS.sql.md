# Issue #698 — 共通前置を複数ペアで測る SQL（読み取り専用）

**使い捨ての PostgreSQL 18.3（PGlite 0.5.4）で、合成データ2組に撃って検証済み。**
- データA（前置が伸びる形）→ 9行すべて `prev_is_complete_prefix = true`
- データB（毎回まるごと別物）→ 9行すべて `false`（⚠ データBも長さは伸びているが騙されない）
- 実行の前後で行数・合計バイト・`removed_at` の数は不変

⛔ `SELECT` のみ。上位3セッションについて、鎖の先頭・中間・末尾の3ペアを標本する。
⚠ `length()` / `substr()` / `md5()` は本文を展開するので重い。上位3セッション×3ペアに絞ってある。
⛔ 本文そのものは返らない（返るのは長さと真偽だけ）。

```sql
WITH ranked AS (
  SELECT session_id, id, at, body,
         row_number() OVER (PARTITION BY session_id ORDER BY at, id) AS rn,
         count(*)     OVER (PARTITION BY session_id)                 AS n,
         sum(pg_column_size(body)) OVER (PARTITION BY session_id)    AS sess_bytes
  FROM archive
  WHERE removed_at IS NULL
), top_sessions AS (
  SELECT session_id FROM ranked WHERE rn = 1 AND n > 1 ORDER BY sess_bytes DESC LIMIT 3
), sampled AS (
  SELECT r.session_id, r.rn
  FROM ranked r JOIN top_sessions t USING (session_id)
  WHERE r.rn IN (1, greatest(1, r.n / 2), greatest(1, r.n - 1))
), pairs AS (
  SELECT a.session_id, a.rn AS rn_prev, b.rn AS rn_next, a.body AS prev_body, b.body AS next_body
  FROM ranked a
  JOIN sampled s ON s.session_id = a.session_id AND s.rn = a.rn
  JOIN ranked b ON b.session_id = a.session_id AND b.rn = a.rn + 1
)
SELECT session_id, rn_prev, rn_next,
       length(prev_body) AS prev_chars,
       length(next_body) AS next_chars,
       length(next_body) - length(prev_body) AS grew_chars,
       md5(substr(next_body, 1, length(prev_body))) = md5(prev_body) AS prev_is_complete_prefix
FROM pairs ORDER BY session_id, rn_prev;
```
