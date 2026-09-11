# Issue #698 段0 — 本番へ流す測定 SQL（読み取り専用）

**使い捨ての PostgreSQL 18.3（PGlite 0.5.4）で、合成データ2組に対して検証済み。** 検証の要点は STAGE0-698-MECHANISM.md 末尾を参照。

⛔ この5本はすべて `SELECT` のみ。`DELETE`/`UPDATE`/`INSERT`/`TRUNCATE`/`DROP` を含まない。実行前後で行数・合計バイト数・`removed_at` の数が変わらないことを検証で確認している。

```sql
-- ===== Q1 =====
WITH sized AS (
  SELECT session_id, id, at, pg_column_size(body) AS body_bytes,
         lag(pg_column_size(body)) OVER (PARTITION BY session_id ORDER BY at) AS prev_bytes
  FROM archive WHERE removed_at IS NULL
), per_session AS (
  SELECT session_id, count(*) AS n_rows, min(at) AS first_at, max(at) AS last_at,
         sum(body_bytes) AS total_bytes, max(body_bytes) AS max_row_bytes,
         sum(body_bytes) - max(body_bytes) AS redundant_bytes,
         bool_and(prev_bytes IS NULL OR body_bytes >= prev_bytes) AS nondecreasing
  FROM sized GROUP BY session_id)
SELECT session_id, n_rows, total_bytes, max_row_bytes, redundant_bytes,
       round(total_bytes::numeric / NULLIF(max_row_bytes,0), 2) AS bloat_ratio,
       nondecreasing, session_id LIKE 'mgr-%' AS looks_manager_origin
FROM per_session ORDER BY total_bytes DESC LIMIT 25;

-- ===== Q1T =====
WITH sized AS (
  SELECT session_id, pg_column_size(body) AS body_bytes FROM archive WHERE removed_at IS NULL
), per_session AS (
  SELECT session_id, sum(body_bytes) AS total_bytes, max(body_bytes) AS max_row_bytes
  FROM sized GROUP BY session_id)
SELECT sum(total_bytes) AS all_bytes, sum(max_row_bytes) AS keep_newest_bytes,
       sum(total_bytes - max_row_bytes) AS recoverable_bytes,
       round(100.0 * sum(total_bytes - max_row_bytes) / NULLIF(sum(total_bytes),0), 1) AS recoverable_pct
FROM per_session;

-- ===== Q2 =====
SELECT date_trunc('day', at)::date AS day,
  count(*) FILTER (WHERE session_id LIKE 'mgr-%') AS mgr_rows,
  sum(pg_column_size(body)) FILTER (WHERE session_id LIKE 'mgr-%') AS mgr_bytes,
  count(*) FILTER (WHERE session_id NOT LIKE 'mgr-%') AS other_rows,
  sum(pg_column_size(body)) FILTER (WHERE session_id NOT LIKE 'mgr-%') AS other_bytes
FROM archive WHERE removed_at IS NULL GROUP BY 1 ORDER BY 1;

-- ===== Q3A =====
WITH multi AS (
  SELECT session_id FROM archive WHERE removed_at IS NULL GROUP BY session_id HAVING count(*) > 1
), h AS (
  SELECT a.session_id, pg_column_size(a.body) AS body_bytes,
         md5(substr(a.body, 1, 4096))     AS head_md5,
         md5(substr(a.body, 20001, 4096)) AS deep_md5
  FROM archive a JOIN multi m USING (session_id) WHERE a.removed_at IS NULL)
SELECT session_id, count(*) AS n_rows,
       count(DISTINCT head_md5) AS distinct_heads,
       count(DISTINCT deep_md5) AS distinct_deep,
       sum(body_bytes) AS total_bytes
FROM h GROUP BY session_id ORDER BY total_bytes DESC LIMIT 25;

-- ===== Q3B =====
WITH ranked AS (
  SELECT session_id, body,
         row_number() OVER (PARTITION BY session_id ORDER BY pg_column_size(body) DESC) AS rk,
         sum(pg_column_size(body)) OVER (PARTITION BY session_id) AS sess_bytes
  FROM archive WHERE removed_at IS NULL
), top_sessions AS (
  SELECT session_id FROM ranked WHERE rk = 1 ORDER BY sess_bytes DESC LIMIT 3
), pair AS (
  SELECT r.session_id,
         max(CASE WHEN rk = 1 THEN r.body END) AS big,
         max(CASE WHEN rk = 2 THEN r.body END) AS small
  FROM ranked r JOIN top_sessions t USING (session_id) WHERE rk <= 2 GROUP BY r.session_id)
SELECT session_id, length(small) AS small_chars, length(big) AS big_chars,
       md5(substr(big, 1, length(small))) = md5(small) AS small_is_prefix_of_big
FROM pair WHERE small IS NOT NULL;
```
