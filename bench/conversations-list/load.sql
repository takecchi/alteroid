-- 本番に近い日誌を作る（#5140 の会話一覧の測り用）。`psql -v ON_ERROR_STOP=1 -f load.sql` で流す。
-- 前提: 表は `migrate` 済み（seed.bench.ts の `migrate` 段）で、journal は空。
-- 調整つまみ: :n（行数）, :bodyMu / :bodySigma（tool_use の本文長の対数正規）。
-- 行の形は `journalEntrySchema`（packages/core/src/schema.ts）に合わせてある。合っているかは `verify`（seed.bench.ts）が本物のストアで読み戻して確かめる。

\if :{?n}
\else
\set n 500000
\endif
\if :{?bodyMu}
\else
\set bodyMu 6.3
\endif
\if :{?bodySigma}
\else
\set bodySigma 1.2
\endif

SELECT setseed(0.42);

DROP TABLE IF EXISTS bench_pool;
DROP TABLE IF EXISTS bench_stage;
DROP TABLE IF EXISTS bench_tomb;

-- 本文の素: 圧縮しにくい擬似文章の塊 400 本（各 60,000 字）。STORAGE EXTERNAL にして substr が必要な部分だけ読めるようにする
CREATE TABLE bench_pool (i int primary key, t text);
ALTER TABLE bench_pool ALTER COLUMN t SET STORAGE EXTERNAL;
INSERT INTO bench_pool
SELECT g, (SELECT string_agg(substr(md5(random()::text || g::text || w::text), 1, 3 + (random() * 6)::int), ' ') FROM generate_series(1, 9000) w)
FROM generate_series(1, 400) g;

CREATE OR REPLACE FUNCTION bench_body(k bigint, len int) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT substr(t, 1 + (k * 7919 % (60000 - least(len, 59000)))::int, least(len, 59000)) FROM bench_pool WHERE i = 1 + (k % 400)::int
$$;

-- 対数正規の長さ
CREATE OR REPLACE FUNCTION bench_lognorm(mu float8, sigma float8, lo int, hi int) RETURNS int LANGUAGE sql VOLATILE AS $$
  SELECT greatest(lo, least(hi, exp(mu + sigma * sqrt(-2 * ln(1 - random())) * cos(2 * pi() * random()))::int))
$$;

-- 段1: 行ごとの種別・時刻・id
CREATE TABLE bench_stage AS
SELECT i,
  -- ミリ秒に丸める: 本物の行は JS の Date（ミリ秒）で書かれる。マイクロ秒が残ると `at = $2` の錨の引き直し（#anchorSeq）が当たらず、頁送りが落ちる
  date_trunc('milliseconds', '2026-07-01T00:00:00Z'::timestamptz + (i * interval '20 seconds') + (random() * 15000) * interval '1 millisecond') AS at,
  gen_random_uuid()::text AS id,
  CASE
    WHEN u < 0.50 THEN 'tool_use'
    WHEN u < 0.62 THEN 'exchange_manager'
    WHEN u < 0.70 THEN 'exchange_self'
    WHEN u < 0.74 THEN 'exchange_human'
    WHEN u < 0.80 THEN 'memory_update'
    WHEN u < 0.85 THEN 'http_timing'
    WHEN u < 0.91 THEN 'turn_timing'
    WHEN u < 0.97 THEN 'decision'
    WHEN u < 0.985 THEN 'daily_report'
    ELSE 'escalation'
  END AS cat,
  random() AS r1, random() AS r2, random() AS r3,
  CAST(NULL AS int) AS conv, CAST(NULL AS text) AS role, CAST(NULL AS text) AS conv_id
FROM (SELECT g AS i, random() AS u FROM generate_series(1, :n) g) s;

-- 人間との往復: 会話は時間の近い順に並べ、近傍に重ねる（新しい会話ほど後ろ）。15% は寿命の長い 20 会話へ
WITH human AS (
  SELECT i, row_number() OVER (ORDER BY i) AS hk, count(*) OVER () AS total, r1, r2 FROM bench_stage WHERE cat = 'exchange_human'
), conv AS (
  SELECT i,
    CASE WHEN r1 < 0.15 THEN 1 + floor(r2 * 20)::int
         ELSE greatest(21, least(1500, floor(hk::float8 / total * 1500 + (r2 - 0.5) * 80)::int)) END AS conv
  FROM human
), roles AS (
  SELECT i, conv, CASE WHEN row_number() OVER (PARTITION BY conv ORDER BY i) % 2 = 1 THEN 'inbound' ELSE 'outbound' END AS role FROM conv
)
UPDATE bench_stage s SET conv = roles.conv, role = roles.role,
  conv_id = (md5('conv' || roles.conv::text))::uuid::text
FROM roles WHERE s.i = roles.i;

-- self の内部ターン: 40% は人間の会話に紐づく
UPDATE bench_stage SET role = CASE WHEN r1 < 0.5 THEN 'inbound' ELSE 'outbound' END,
  conv = CASE WHEN r2 < 0.4 THEN 21 + floor(r3 * 1479)::int END
WHERE cat = 'exchange_self';
UPDATE bench_stage SET conv_id = (md5('conv' || conv::text))::uuid::text WHERE cat = 'exchange_self' AND conv IS NOT NULL;
UPDATE bench_stage SET role = CASE WHEN r1 < 0.5 THEN 'inbound' ELSE 'outbound' END WHERE cat = 'exchange_manager';

-- 墓標 300 本: 最後の発言から 1〜8 日後に積む。会話 id は 21〜1500 から無作為に（人間との往復が在る会話だけ）
CREATE TABLE bench_tomb AS
SELECT row_number() OVER () + 10000000 AS i,
  date_trunc('milliseconds', least(last_at + (1 + random() * 7) * interval '1 day', '2026-10-24T00:00:00Z'::timestamptz)) AS at,
  gen_random_uuid()::text AS id, 'conversation_deleted'::text AS cat, random() AS r1, random() AS r2, random() AS r3,
  conv, CAST(NULL AS text) AS role, conv_id
FROM (
  SELECT conv, conv_id, max(at) AS last_at, count(*) AS n FROM bench_stage WHERE cat = 'exchange_human' AND conv > 20 GROUP BY conv, conv_id
  ORDER BY random() LIMIT 300
) t;
INSERT INTO bench_stage SELECT * FROM bench_tomb;

CREATE INDEX ON bench_stage (cat);
ANALYZE bench_stage;
ANALYZE bench_pool;

-- 本体の挿入。時刻順に並べて seq を払い出す
INSERT INTO journal (id, at, type, entry)
SELECT s.id, s.at,
  CASE s.cat WHEN 'exchange_manager' THEN 'exchange' WHEN 'exchange_self' THEN 'exchange' WHEN 'exchange_human' THEN 'exchange' ELSE s.cat END,
  jsonb_strip_nulls(CASE s.cat
    WHEN 'tool_use' THEN jsonb_build_object(
      'actor', (ARRAY['clone', 'clone', 'clone', 'manager:mgr-1', 'manager:mgr-2', 'worker:w-1'])[1 + floor(s.r1 * 6)::int],
      'tool', (ARRAY['Bash', 'Read', 'Edit', 'Grep', 'Write', 'mcp__github__get_pull_request'])[1 + floor(s.r2 * 6)::int],
      'input', CASE WHEN s.r3 < 0.5 THEN jsonb_build_object('command', bench_body(s.i, bench_lognorm(:bodyMu, :bodySigma, 20, 40000)))
                    ELSE jsonb_build_object('file_path', '/work/repo/src/file-' || (s.i % 997) || '.ts', 'old_string', bench_body(s.i + 1, bench_lognorm(:bodyMu - 0.6, :bodySigma, 10, 20000)), 'new_string', bench_body(s.i + 2, bench_lognorm(:bodyMu - 0.6, :bodySigma, 10, 20000))) END,
      'outcome', CASE WHEN s.r3 > 0.985 THEN 'failed' END,
      'error', CASE WHEN s.r3 > 0.985 THEN bench_body(s.i, 100 + (s.r1 * 400)::int) END)
    WHEN 'exchange_manager' THEN jsonb_build_object('with', 'manager', 'role', s.role,
      'text', bench_body(s.i, bench_lognorm(6.0, 0.8, 100, 3000)), 'managerId', 'mgr-' || (1 + floor(s.r2 * 6)::int))
    WHEN 'exchange_self' THEN jsonb_build_object('with', 'self', 'role', s.role,
      'text', bench_body(s.i, bench_lognorm(5.8, 0.8, 80, 1500)), 'conversationId', s.conv_id)
    WHEN 'exchange_human' THEN CASE s.role
      WHEN 'inbound' THEN jsonb_build_object('with', 'human', 'role', 'inbound', 'conversationId', s.conv_id,
        'text', bench_body(s.i, bench_lognorm(4.4, 1.0, 5, 800)),
        'clientMessageId', CASE WHEN s.r2 < 0.3 THEN 'cm-' || substr(md5(s.id), 1, 16) END,
        'supersedes', CASE WHEN s.r3 < 0.02 THEN (SELECT p.id FROM bench_stage p WHERE p.conv = s.conv AND p.cat = 'exchange_human' AND p.role = 'inbound' AND p.i < s.i ORDER BY p.i DESC LIMIT 1) END,
        'attachments', CASE WHEN s.r3 > 0.97 THEN jsonb_build_array(jsonb_build_object('id', 'att-' || substr(md5(s.id), 1, 12), 'name', 'screenshot.png', 'mediaType', 'image/png', 'size', 120000 + (s.r2 * 900000)::int, 'sha256', md5(s.id) || md5(s.id))) END)
      ELSE jsonb_build_object('with', 'human', 'role', 'outbound', 'conversationId', s.conv_id,
        'text', bench_body(s.i, 200 + floor(s.r2 * s.r2 * 5800)::int),
        'turnFailure', CASE WHEN s.r3 < 0.015 THEN 'failed' WHEN s.r3 < 0.02 THEN 'held' END)
      END
    WHEN 'memory_update' THEN jsonb_build_object('slug', 'note-' || (s.i % 500), 'cause', 'clone', 'action', 'write',
      'bytesBefore', (s.r1 * 5000)::int, 'bytesAfter', (s.r2 * 6000)::int, 'summary', bench_body(s.i, 100 + (s.r3 * 700)::int))
    WHEN 'http_timing' THEN jsonb_build_object('windowStartedAt', to_char(s.at - interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'windowMs', 600000, 'requests', 100 + (s.r1 * 900)::int,
      'routes', (SELECT jsonb_agg(jsonb_build_object('route', 'GET /route-' || g, 'count', 10 + g, 'errors', 0, 'p50Ms', 3, 'p90Ms', 20, 'maxMs', 200, 'totalMs', 500,
          'db', jsonb_build_object('count', 4, 'totalMs', 100, 'wallMs', 80, 'waitMs', 0), 'serializeMs', 2, 'bytes', 5000, 'maxBytes', 90000)) FROM generate_series(1, 8) g),
      'slowest', (SELECT jsonb_agg(jsonb_build_object('route', 'GET /route-' || g, 'status', 200, 'at', to_char(s.at - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'totalMs', 900 + g,
          'db', jsonb_build_object('count', 5, 'totalMs', 700, 'wallMs', 600, 'waitMs', 1, 'slowestMs', 300, 'slowestSql', bench_body(s.i + g, 300)), 'serializeMs', 5)) FROM generate_series(1, 5) g))
    WHEN 'turn_timing' THEN jsonb_build_object('triggers', jsonb_build_array('human_message'), 'batchSize', 1, 'kinds', jsonb_build_array('normal'),
      'succeeded', s.r1 < 0.97, 'totalMs', (s.r2 * 120000)::int, 'firstTextMs', (s.r3 * 5000)::int,
      'phases', jsonb_build_object('queue', 10, 'sdk', 50000, 'tools', 20000), 'contextTokens', (s.r1 * 150000)::int)
    WHEN 'decision' THEN jsonb_build_object('decision', bench_body(s.i, 50 + (s.r1 * 250)::int), 'grounds', bench_body(s.i + 3, bench_lognorm(6.0, 0.8, 100, 2500)))
    WHEN 'daily_report' THEN jsonb_build_object('date', to_char(s.at, 'YYYY-MM-DD'), 'body', bench_body(s.i, 1000 + (s.r1 * 7000)::int))
    WHEN 'escalation' THEN jsonb_build_object('question', bench_body(s.i, 80 + (s.r1 * 400)::int), 'approvalId', 'ap-' || substr(md5(s.id), 1, 12))
    WHEN 'conversation_deleted' THEN jsonb_build_object('deletedConversationId', s.conv_id, 'deletedBy', 'operator', 'hiddenCount', 4 + (s.r1 * 40)::int,
      'hiddenEntryIds', CASE WHEN s.r2 < 0.3 THEN (SELECT jsonb_agg(d.id) FROM (SELECT id FROM bench_stage WHERE cat = 'decision' ORDER BY md5(bench_stage.id || s.id) LIMIT 2) d) END)
  END)
FROM bench_stage s
ORDER BY s.at, s.i;

-- 取り下げの印: with=self の行 60 本を、直前の clientMessageId つき inbound の取り下げに作り替える（`withdrawnClientMessageId` を持つ self 行）
UPDATE journal j SET entry = jsonb_set(j.entry, '{withdrawnClientMessageId}', to_jsonb(w.cm))
FROM (
  SELECT sj.seq AS self_seq, (SELECT p.entry->>'clientMessageId' FROM journal p
     WHERE p.type = 'exchange' AND p.entry->>'with' = 'human' AND p.entry->>'role' = 'inbound' AND p.entry->>'clientMessageId' IS NOT NULL AND p.seq < sj.seq
     ORDER BY p.seq DESC LIMIT 1) AS cm
  FROM (SELECT seq FROM journal WHERE type = 'exchange' AND entry->>'with' = 'self' ORDER BY md5(id) LIMIT 60) sj
) w WHERE j.seq = w.self_seq AND w.cm IS NOT NULL;

-- 既読の記録: 人間との往復がある会話の半分に。基準時刻は期間の頭から 10 日後（以前の発言は既読扱い）
INSERT INTO conversation_read_baseline (id, at) VALUES ('default', '2026-07-11T00:00:00Z') ON CONFLICT DO NOTHING;
INSERT INTO conversation_read (conversation_id, read_through, updated_at)
SELECT conv_id,
  CASE WHEN random() < 0.6 THEN max(at) ELSE min(at) + (max(at) - min(at)) * random() END,
  max(at)
FROM bench_stage WHERE cat = 'exchange_human'
GROUP BY conv_id
HAVING hashtext(conv_id) % 2 = 0
ON CONFLICT DO NOTHING;

DROP TABLE bench_stage;
DROP TABLE bench_tomb;
DROP TABLE bench_pool;
DROP FUNCTION bench_body(bigint, int);
DROP FUNCTION bench_lognorm(float8, float8, int, int);
