import { sql } from 'drizzle-orm';

import type { Db } from './db.js';

// drizzle-kit の生成ファイルを配らない: 起動が別手順に依存しないよう、「先にマイグレーションを流す」手順を足さない。
// 既存行の意味を変える変更を黙って混ぜない: それは記憶の書き換えであり、人間の確認が要る。
//
// 鍵を差し替えるときは主キーではなく一意索引で持つ（`drop constraint` + `add primary key` にしない:
// 毎回の起動で索引を作り直し、そのたびに ACCESS EXCLUSIVE を取る）。順序は「列を足す → 新しい鍵 → 古い鍵を外す」。
// 逆にすると、古い鍵を外してから新しい鍵ができるまで重複を拒めない。
//
// 古い鍵の `create` は配列から消す（drop だけ残す）: この配列は起動のたびに頭から通るので、
// 2周目の `create ... if not exists` は古い鍵が drop 済みで名前に一致せず本当に作りに行き、
// 新しい鍵が許した行が重複になって `could not create unique index … is duplicated` でデーモンが上がらなくなる。
// `if not exists` は「2回目は no-op」を約束しない。空の DB から作る試験では出ない（1周目しか通さない）。
// `drop constraint` は同じ形ではない: 外す先が `create table if not exists` の中の主キーなら、2周目の create は本当の no-op になる。
//
// `export` する: `migrate.test.ts` が「作ってから同じ名前を drop する索引」が無いことを構造で見る。
export const STATEMENTS = [
  `create table if not exists memory (
     slug text primary key,
     content text not null,
     updated_at timestamptz not null default now()
   )`,

  `create table if not exists journal (
     seq bigserial primary key,
     id text not null unique,
     at timestamptz not null,
     type text not null,
     entry jsonb not null
   )`,
  `create index if not exists journal_at_idx on journal (at)`,
  `create index if not exists journal_type_at_idx on journal (type, at)`,

  `create table if not exists jobs (
     id text primary key,
     status text not null,
     created_at timestamptz not null,
     updated_at timestamptz not null,
     job jsonb not null
   )`,

  `create table if not exists approvals (
     id text primary key,
     created_at timestamptz not null,
     answered_at timestamptz,
     approval jsonb not null
   )`,

  `create table if not exists schedules (
     kind text primary key,
     created_at timestamptz not null,
     updated_at timestamptz not null,
     last_run_at timestamptz,
     plan jsonb not null
   )`,

  // `schedules` とは別の表にする（理由は schema.ts の `schedulePhases`）。
  `create table if not exists schedule_phases (
     kind text primary key,
     updated_at timestamptz not null default now(),
     phase jsonb not null
   )`,

  // id を主キーにする: 同じ合図が二重に積まれないため。
  `create table if not exists inbox_events (
     id text primary key,
     event jsonb not null,
     at timestamptz not null,
     deliveries integer not null default 0
   )`,
  `create index if not exists inbox_events_at_idx on inbox_events (at)`,
  // 入れた順は残っていないので、既存の行へは物理順ではなく `(at, id)` で振る（`commitments.seq` と同じ手順）。
  `alter table inbox_events add column if not exists seq bigint`,
  `create sequence if not exists inbox_events_seq_seq`,
  `update inbox_events e set seq = n.rn
     from (
       select id,
         row_number() over (order by at, id)
           + coalesce((select max(seq) from inbox_events), 0) as rn
       from inbox_events
       where seq is null
     ) n
     where e.id = n.id and e.seq is null`,
  `select setval('inbox_events_seq_seq', m.top, true)
     from (select max(seq) as top from inbox_events) m,
          (select last_value, is_called from inbox_events_seq_seq) s
     where m.top is not null
       and m.top >= case when s.is_called then s.last_value + 1 else s.last_value end`,
  `alter table inbox_events alter column seq set default nextval('inbox_events_seq_seq')`,

  `create table if not exists archive (
     id text primary key,
     session_id text not null,
     at timestamptz not null,
     body text not null
   )`,

  `create table if not exists daemon_state (
     key text primary key,
     value text
   )`,

  // 消さない: 巻き戻した旧デーモンがここを読むので、消すと環境が黙って痩せる。新版は書かない（`clear()` だけは
  // 空にする: 人間が外したものが巻き戻した旧版で蘇らないように）。
  `create table if not exists env_profile (
     id text primary key,
     script text not null,
     updated_at timestamptz not null default now()
   )`,

  `create table if not exists session_entries (
     seq bigserial primary key,
     project_key text not null,
     session_id text not null,
     subpath text not null default '',
     uuid text,
     entry jsonb not null
   )`,
  `create index if not exists session_entries_key_idx
     on session_entries (project_key, session_id, subpath, seq)`,
  `create unique index if not exists session_entries_uuid_idx
     on session_entries (project_key, session_id, subpath, uuid)
     where uuid is not null`,

  `create table if not exists sessions (
     project_key text not null,
     session_id text not null,
     subpath text not null default '',
     updated_at timestamptz not null default now(),
     primary key (project_key, session_id, subpath)
   )`,
  `create index if not exists sessions_project_idx on sessions (project_key, updated_at)`,

  // 行為ごとのスコープ列を置かない: ここは「誰がこの API に触れるか」の層で、PRD「権限境界」とは別物。
  `create table if not exists auth_accounts (
     id text primary key,
     display_name text,
     email text,
     created_at timestamptz not null,
     last_login_at timestamptz,
     granted_at timestamptz,
     granted_by text
   )`,
  // email は null を許す: PostgreSQL の unique は null を重複と見なさないので「検証済みメールは高々1アカウント」になる。
  // その索引は `auth_accounts_email_lower_idx`。
  //
  // `auth_accounts_email_idx` と `auth_accounts_single_owner_idx` の create をここへ戻さない: 古い鍵の create は
  // 2周目に本当に作りに行き、`could not create unique index … is duplicated` でデーモンが上がらなくなる。
  // 新しい鍵は無条件には作れない（既存の重複行がありうる）ので `STATEMENTS` に置かず、
  // `ensureAuthAccountsEmailLowerIndex` が数えてから作り、旧索引もそこで drop する（現役の鍵なので、新しい鍵ができてから外す）。

  `create table if not exists auth_identities (
     provider text not null,
     subject text not null,
     account_id text not null,
     email text,
     email_verified boolean not null default false,
     created_at timestamptz not null,
     last_login_at timestamptz not null,
     primary key (provider, subject)
   )`,
  `create index if not exists auth_identities_account_idx on auth_identities (account_id)`,

  `create table if not exists auth_access_tokens (
     id text primary key,
     account_id text not null,
     sha256 text not null,
     label text not null default '',
     created_at timestamptz not null,
     expires_at timestamptz,
     last_used_at timestamptz,
     revoked_at timestamptz
   )`,
  `create unique index if not exists auth_access_tokens_sha256_idx on auth_access_tokens (sha256)`,
  `create index if not exists auth_access_tokens_account_idx on auth_access_tokens (account_id)`,

  `create table if not exists auth_login_requests (
     id text primary key,
     request jsonb not null,
     expires_at timestamptz not null
   )`,
  `create index if not exists auth_login_requests_expires_idx on auth_login_requests (expires_at)`,

  `create table if not exists usage_daily (
     date text not null,
     manager_id text not null,
     model text not null,
     input_tokens bigint not null default 0,
     output_tokens bigint not null default 0,
     cache_read_input_tokens bigint not null default 0,
     cache_creation_input_tokens bigint not null default 0,
     web_search_requests bigint not null default 0,
     cost_usd double precision not null default 0,
     layer text not null default 'manager',
     site text not null default 'session',
     updated_at timestamptz not null
   )`,
  // 既定は観測ではない: どこからが観測かは `usage_ledger.layered_at` が持つ。混ぜると「層を足す前はクローンが使っていなかった」と読める。
  `alter table usage_daily add column if not exists layer text not null default 'manager'`,
  `alter table usage_daily add column if not exists site text not null default 'session'`,
  // `default ''` で null を許さない: 一意索引は null どうしを重複と見なさず、帰属の無い行が `on conflict` に当たらずに
  // record のたびに新しい行が挿さる。空文字は「値が無い」の印で、読むときに undefined へ戻す（`usage.ts` の `#toRow`）。
  // 古い行にとって真になる値は無い: どこからが観測かは `usage_ledger.tokens_at` が持つ。
  `alter table usage_daily add column if not exists token_id text not null default ''`,
  // 層と場所とトークンを鍵に入れる: 3列の鍵だと意味の違う行が衝突し、`on conflict do update` が先にある行へ足し込んで誤帰属になる。
  // 名前を `usage_daily_key_idx` のままにしない: `create unique index if not exists` は名前だけを見るので、
  // 既にある DB では何も起きない（空の DB から作る試験は通る）。
  `create unique index if not exists usage_daily_token_key_idx
     on usage_daily (date, manager_id, model, layer, site, token_id)`,
  `alter table usage_daily drop constraint if exists usage_daily_pkey`,
  // `create unique index if not exists usage_daily_key_idx on usage_daily (date, manager_id, model, layer, site)` を戻さない:
  // 次の起動で名前が一致せず本当に作りに行き、token_id だけが違う行が重複になって
  // `could not create unique index "usage_daily_key_idx" … is duplicated` でデーモンが起動不能になる（実測済み）。
  // 鍵を差し替えたら古い鍵の create は配列から消し、drop だけ残す。`usage_baseline` の主キー制約の drop は同じ形ではない。
  `drop index if exists usage_daily_key_idx`,
  // (manager_id, date) は新しい鍵の並びに無く、date を先に決めずに「この actor が期間中いくら使ったか」を引くために足す。
  `create index if not exists usage_daily_manager_date_idx on usage_daily (manager_id, date)`,

  `create table if not exists usage_baseline (
     manager_id text not null,
     layer text not null default 'manager',
     session_id text,
     models jsonb not null,
     updated_at timestamptz not null,
     resets integer not null default 0,
     last_reset_at timestamptz
   )`,
  // 既定 `'manager'` を付ける: 既にある基準を同じ主体として引けないと「基準が無い」と読まれ、累積の全量が二重計上される。
  `alter table usage_baseline add column if not exists layer text not null default 'manager'`,
  `create unique index if not exists usage_baseline_key_idx
     on usage_baseline (layer, manager_id)`,
  `alter table usage_baseline drop constraint if exists usage_baseline_pkey`,
  // null は「覚えていない」: 古い runner の累積は積まずに日誌に残す。
  `alter table usage_baseline add column if not exists by_runner jsonb`,

  `create table if not exists usage_ledger (
     id text primary key,
     started_at timestamptz not null,
     layered_at timestamptz
   )`,
  // null を許す: 台帳が始まっていても層の軸はまだ始まっていない状態が在る。
  `alter table usage_ledger add column if not exists layered_at timestamptz`,
  // null を許し、`layered_at` と揃えて埋めない: プールを使っていない器が「トークン軸を観測している」と名乗ってしまう。
  // `record` は `token_id` が付いた1件目でだけ埋める。
  `alter table usage_ledger add column if not exists tokens_at timestamptz`,
  // null を許す: 増分が空の record は回数を数えないので、`layered_at` だけが先に入りうる。
  `alter table usage_ledger add column if not exists turns_at timestamptz`,

  // 最初から一意索引で持つ（`schema.ts` の `usageTurns` の doc）。
  `create table if not exists usage_turns (
     date text not null,
     manager_id text not null,
     layer text not null,
     site text not null,
     token_id text not null default '',
     turns bigint not null default 0,
     updated_at timestamptz not null
   )`,
  `create unique index if not exists usage_turns_key_idx
     on usage_turns (date, manager_id, layer, site, token_id)`,

  // id を主キーにする: 「select してから insert」に割ると同じ id の並行 open が両方すり抜け、片付いた仕事が開き直る。
  `create table if not exists commitments (
     id text primary key,
     at timestamptz not null,
     closed_at timestamptz,
     commitment jsonb not null
   )`,
  // 部分索引: 閉じた行が積もっても「未了だけを古い順」の主経路が効き続ける。
  `create index if not exists commitments_open_idx
     on commitments (at) where closed_at is null`,
  // 既存の行へは物理順ではなく `(at, id)` で振る: 入れた順は残っていない。
  // 既定を最後に付ける: 先に付けると新しい行が 1 から振られて既存の行の前へ割り込む。`setval` で巻き戻さない。
  `alter table commitments add column if not exists seq bigint`,
  `create sequence if not exists commitments_seq_seq`,
  `update commitments c set seq = n.rn
     from (
       select id,
         row_number() over (order by at, id)
           + coalesce((select max(seq) from commitments), 0) as rn
       from commitments
       where seq is null
     ) n
     where c.id = n.id and c.seq is null`,
  `select setval('commitments_seq_seq', m.top, true)
     from (select max(seq) as top from commitments) m,
          (select last_value, is_called from commitments_seq_seq) s
     where m.top is not null
       and m.top >= case when s.is_called then s.last_value + 1 else s.last_value end`,
  `alter table commitments alter column seq set default nextval('commitments_seq_seq')`,

  // human guard の派生値。null は unknown（守る側）に落ちるので安全な既定。実体は日誌（memory_update.cause）。
  `alter table memory add column if not exists human_touched_at timestamptz`,
  `alter table memory add column if not exists content_sha256 text`,

  // null は `unknown`（fresh にも stale にも畳まない）。
  `alter table memory add column if not exists described_at timestamptz`,

  // null は「backfill が見ていない」か「日誌に根拠が無かった」: 区別せず `unknown` として読む（値を作らない）。
  `alter table memory add column if not exists created_at timestamptz`,

  // この式索引が無いと type/at の索引は with の絞りにも seq の順序にも効かない。
  `create index if not exists journal_exchange_with_seq_idx
     on journal ((entry->>'with'), seq)`,

  // list() が exchange の行ごとに墓標を引くので、無いと毎行が墓標の全走査になる。
  `create index if not exists journal_conversation_deleted_idx
     on journal ((entry->>'deletedConversationId')) where type = 'conversation_deleted'`,

  `create table if not exists agent_tokens (
     id text primary key,
     label text not null,
     value text not null,
     order_index integer not null,
     disabled_at timestamptz,
     cooldown_until bigint,
     last_rejected_at timestamptz,
     last_rejected_reason text,
     invalidated_at timestamptz,
     invalidated_reason text
   )`,

  `create table if not exists agent_token_settings (
     id text primary key,
     rotate_on text not null,
     cooldown_ms bigint not null,
     updated_at timestamptz
   )`,

  // `default now()` を付けない: 既に入っている行が「いま作られた」ことになる。
  `alter table agent_tokens add column if not exists created_at timestamptz`,
  `alter table agent_tokens add column if not exists updated_at timestamptz`,

  // `default 'stored'` を付けない: null と 'stored' が混在するより読む側の分岐が1つで済む。null は `stored`。
  `alter table agent_tokens add column if not exists source text`,
  // `source = 'env'` の行は値を持たない。
  `alter table agent_tokens alter column value drop not null`,

  // 既定値を付けない: 既存の行は「出所を言えない」のであって「推測だった」のではない。
  `alter table agent_tokens add column if not exists cooldown_source text`,

  // `agent_tokens` の列にしない: 2行が同時に現役だと主張する形を作らない。
  `create table if not exists agent_token_active (
     id text primary key,
     token_id text not null,
     generation bigint not null,
     rotated_at timestamptz not null
   )`,

  // 対になる create は上から消してある: 残すと2周目に作りに行って落ちる。
  `drop index if exists auth_accounts_single_owner_idx`,

  // `body` の not null は外さず空文字を入れる。判定は `removed_at` だけで行う: 空の生ログは正当にありえる。
  `alter table archive add column if not exists removed_at timestamptz`,
  `alter table archive add column if not exists removed_bytes integer`,

  // `value` を not null にする: 「外す」は行の削除で表す。空文字の行を残せると `list()` と器へ降りる集合が食い違う。
  `create table if not exists manager_credentials (
     name text primary key,
     value text not null,
     updated_at timestamptz not null default now()
   )`,

  // すべて nullable で埋め直さない: `classifyArchiveContinuity` が欠落を `'unknown'` へ落とす。
  `alter table archive add column if not exists body_chars integer`,
  `alter table archive add column if not exists body_md5 text`,
  `alter table archive add column if not exists continuity text`,

  // null は `unrecorded`（`0` ではない）: 過去の値を捏造しない。
  `alter table memory add column if not exists described_bytes integer`,

  // null は「基準点がまだ立っていない」（`unrecorded`）。埋め直さない。
  `alter table memory add column if not exists described_bytes_at timestamptz`,

  // 既定値は過去を捏造しない: この列が無かった頃、全行が両方へ撒かれ、値は API から返らなかった。
  `alter table manager_credentials add column if not exists scope text not null default 'all'`,
  `alter table manager_credentials add column if not exists secret boolean not null default true`,

  // `default 'all'` は過去を捏造しない: 旧 `env_profile` の本文は実際にクローンと runner の両方へ撒かれていた。
  `create table if not exists env_profile_entries (
     name text primary key,
     script text not null,
     scope text not null default 'all',
     updated_at timestamptz not null default now()
   )`,

  // 「1度だけ」の印を `daemon_state` に置く: `on conflict do nothing` だけだと、人間が `default` を外したあとの起動で
  // 旧表の本文（外したはずの鍵を含みうる）が毎回蘇る。旧表が空でも印は立てる（のちに旧版が書いたものを拾い直さない）。
  `insert into env_profile_entries (name, script, scope, updated_at)
   select 'default', script, 'all', updated_at from env_profile
    where id = 'default' and btrim(script) <> ''
      and not exists (select 1 from daemon_state where key = 'env_profile_entries_migrated')
   on conflict (name) do nothing`,
  `insert into daemon_state (key, value) values ('env_profile_entries_migrated', '1')
   on conflict (key) do nothing`,

  // 専用の列にする: jsonb の `->>'withdrawnAt'` より `answered_at` と揃った形で `isNull` で絞れる（`jobs.ts` の `where` 節）。
  `alter table approvals add column if not exists withdrawn_at timestamptz`,

  // 宣言は資格の判断に使わない（ログインできる人＝持ち主）。列は当面残す。
  `alter table auth_accounts add column if not exists owner_declared_at timestamptz`,

  // 既にあるどの表にも列を足さない: やり方は独立した器で、記憶（`memory`）にも委譲（`jobs`）にも生やさない。
  `create table if not exists practices (
     slug text primary key,
     kind text not null,
     title text not null,
     content text not null,
     bytes integer not null,
     created_at timestamptz not null,
     updated_at timestamptz not null
   )`,

  // `toast.` 付きを外さない: 親の設定は TOAST 側へ継承されず、TOAST は親と独立に autovacuum される。
  // 既定の scale_factor = 0.2 では生きているチャンクに比例して死骸が放置されるので、0 にして定数へ変える。
  // 数（50 / 10000）に強い根拠は無い暫定値。VACUUM FULL は排他ロックを取るので起動時に打たない。
  `alter table archive set (
     autovacuum_vacuum_threshold = 50,
     autovacuum_vacuum_scale_factor = 0.0,
     autovacuum_analyze_threshold = 50,
     autovacuum_analyze_scale_factor = 0.0,
     toast.autovacuum_vacuum_threshold = 10000,
     toast.autovacuum_vacuum_scale_factor = 0.0
   )`,

  `alter table practices drop column if exists bytes`,

  // `serial` にしない: 版番号は slug ごとに独立した1始まりの連番で、`PgPracticeStore.write` が `max(version) + 1` を入れる。
  `create table if not exists practice_versions (
     slug text not null,
     version integer not null,
     kind text not null,
     title text not null,
     content text not null,
     at timestamptz not null,
     primary key (slug, version)
   )`,

  `create table if not exists mcp_servers (
     id text primary key,
     servers jsonb not null,
     updated_at timestamptz not null default now()
   )`,

  `create table if not exists plugins (
     name text primary key,
     source jsonb not null,
     scope text not null default 'all',
     enable_hooks boolean not null default false,
     enable_mcp boolean not null default false,
     content_sha256 text not null,
     file_count integer not null,
     total_bytes bigint not null,
     installed_at timestamptz not null,
     installed_by text not null
   )`,
  `create table if not exists plugin_files (
     plugin_name text not null references plugins (name) on delete cascade,
     path text not null,
     executable boolean not null,
     content bytea not null,
     primary key (plugin_name, path)
   )`,

  // blob 列を `grant` にしない: `GRANT` は PostgreSQL の予約語で素の DDL では構文エラーになる。
  `create table if not exists permission_grants (
     id text primary key,
     granted_at timestamptz not null,
     revoked_at timestamptz,
     record jsonb not null
   )`,

  `alter table usage_daily add column if not exists unreadable_input_tokens bigint not null default 0`,
  `alter table usage_daily add column if not exists unreadable_output_tokens bigint not null default 0`,
  `alter table usage_daily add column if not exists unreadable_cache_read_input_tokens bigint not null default 0`,
  `alter table usage_daily add column if not exists unreadable_cache_creation_input_tokens bigint not null default 0`,
  `alter table usage_daily add column if not exists unreadable_web_search_requests bigint not null default 0`,
  `alter table usage_daily add column if not exists unreadable_cost_usd bigint not null default 0`,

  // 消費の値の列を持たない: 0 を積むとその層が安いと読める。
  `create table if not exists usage_unmetered (
     date text not null,
     manager_id text not null,
     layer text not null,
     site text not null,
     provider text not null,
     token_id text not null default '',
     turns bigint not null default 0,
     updated_at timestamptz not null
   )`,
  `create unique index if not exists usage_unmetered_key_idx
     on usage_unmetered (date, manager_id, layer, site, provider, token_id)`,
  // 基準時刻の行はここでは入れない: 空の器で契約を測れるよう `ConversationReadStore.ensureBaseline` が入れる。
  `create table if not exists conversation_read (
     conversation_id text primary key,
     read_through timestamptz not null,
     updated_at timestamptz not null
   )`,
  `create table if not exists conversation_read_baseline (
     id text primary key,
     at timestamptz not null
   )`,
  `alter table conversation_read_baseline add column if not exists scanned_through timestamptz`,
  `create table if not exists conversation_outbound_latest (
     conversation_id text primary key,
     at timestamptz not null
   )`,
  // 素の値は入れない（sha256 だけ）。
  `create table if not exists integration_keys (
     id text primary key,
     name text not null,
     source text not null,
     sha256 text not null,
     created_at timestamptz not null,
     created_by text not null,
     expires_at timestamptz,
     revoked_at timestamptz,
     last_used_at timestamptz,
     max_body_bytes integer,
     rate_per_minute integer
   )`,
  `create unique index if not exists integration_keys_sha256_idx on integration_keys (sha256)`,
  // `POST /events` の重複キー。受信箱の行は処理後に消えるので別の表。
  `create table if not exists event_idempotency_keys (
     sender text not null,
     source text not null,
     key text not null,
     event_id text not null,
     at timestamptz not null
   )`,
  `create unique index if not exists event_idempotency_keys_scope_idx on event_idempotency_keys (sender, source, key)`,
  `create index if not exists event_idempotency_keys_at_idx on event_idempotency_keys (at)`,
  `create table if not exists attachments (
     id text primary key,
     sha256 text not null,
     media_type text not null,
     name text not null,
     size bigint not null,
     bytes bytea not null,
     conversation_id text,
     created_at timestamptz not null,
     expires_at timestamptz not null
   )`,
  `create index if not exists attachments_expires_at_idx on attachments (expires_at)`,
  `create index if not exists attachments_created_at_idx on attachments (created_at)`,
  `alter table attachments add column if not exists uploaded_by text`,
  `alter table attachments add column if not exists external_event_id text`,
  `alter table attachments add column if not exists manager_report_id text`,
  // 保存中は期限を持たないので `expires_at` の not null を外す。
  `alter table attachments add column if not exists kept_at timestamptz`,
  `alter table attachments alter column expires_at drop not null`,
  `alter table attachments add column if not exists released_at timestamptz`,
  // `add constraint` は `if not exists` が無いので、無ければ足す: 起動のたびに全行を検め直さない。
  `alter table attachments add column if not exists blob_key text`,
  `alter table attachments alter column bytes drop not null`,
  `do $$ begin
     if not exists (
       select 1 from pg_constraint
       where conname = 'attachments_content_place_chk' and conrelid = 'attachments'::regclass
     ) then
       alter table attachments add constraint attachments_content_place_chk
         check ((bytes is null) <> (blob_key is null));
     end if;
   end $$`,
  // 列ではなく式索引にする: 承認の書き込みは jsonb を丸ごと書く1本の経路で、列を足すと派生値の同期が2か所になる。
  // `jobs.ts` の `CONVERSATION_ID_EXPR` と同じ式。`created_at` を後ろに置くのは会話で絞った `order by created_at` を索引だけで返すため。
  `create index if not exists approvals_conversation_id_idx
     on approvals ((approval->>'conversationId'), created_at)`,
  // 値は runner から読ませない: runner は記憶ストアの鍵を持たず、降ろすのはデーモン。
  `create table if not exists codex_chatgpt_auth (
     id text primary key,
     value text not null,
     revision text not null,
     updated_at timestamptz not null,
     email text,
     plan_type text,
     failure_at timestamptz,
     failure_reason text
   )`,
  // 埋め戻さない: plugin_files は最大 64MiB で、起動のたびに読む重さに見合わない。
  `alter table plugins add column if not exists description text`,
] as const;

export const OPEN_MANAGER_BODY_INDEX = 'commitments_open_manager_body_idx';

// `STATEMENTS` に置かない: 既存の重複行が在ると作れず、起動のたびに通る配列でデーモンが上がらなくなる。
// 鍵を `md5(body)` にする: 生の `body` は btree の索引行の上限（約2.7KB）を超えうる。
const CREATE_OPEN_MANAGER_BODY_INDEX = `create unique index if not exists ${OPEN_MANAGER_BODY_INDEX}
   on commitments ((commitment->>'source'), md5(commitment->>'body'))
   where closed_at is null and commitment->>'origin' = 'manager'`;

export interface OpenManagerBodyDuplicate {
  readonly source: string;
  readonly ids: readonly string[];
}

function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
}

async function hasOpenManagerBodyIndex(db: Db): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 from pg_class where relname = ${OPEN_MANAGER_BODY_INDEX}`,
  );
  return rowsOf(result).length > 0;
}

// `export` する: 運用側が索引を作りにいかずに「いま作れる状態か」を確かめられる口が要る。
export async function findOpenManagerBodyDuplicates(db: Db): Promise<OpenManagerBodyDuplicate[]> {
  const result = await db.execute(sql`
    select
      commitment->>'source' as source,
      array_agg(id order by at asc, id asc) as ids
    from commitments
    where closed_at is null and commitment->>'origin' = 'manager'
    group by commitment->>'source', md5(commitment->>'body')
    having count(*) > 1
    order by count(*) desc, min(at) asc
  `);
  return rowsOf(result).map((row) => {
    const value = row as { source: string | null; ids: string[] };
    return { source: value.source ?? '', ids: value.ids };
  });
}

// 重複を黙って畳まない: 器が未了の行を閉じると、クローンは閉じられたことに気づけない。
// 落とさない: 投げると `migrate` が落ちてデーモンが上がらなくなる。索引を作らずに警告して進み
// （`PgCommitmentStore.open` の `where not exists` は効いたまま）、人間が行を直す材料に件数と id を逐語で載せる。
export async function ensureOpenManagerBodyIndex(
  db: Db,
  warn: (line: string) => void,
): Promise<void> {
  // 索引が既に在るなら台帳を1行も走査しない: 起動のたびに通るので、毎回数えると起動の費用が台帳の齢に比例して増える。
  if (await hasOpenManagerBodyIndex(db)) return;
  const duplicates = await findOpenManagerBodyDuplicates(db);
  if (duplicates.length === 0) {
    await db.execute(sql.raw(CREATE_OPEN_MANAGER_BODY_INDEX));
    return;
  }
  const rows = duplicates.reduce((total, group) => total + group.ids.length, 0);
  warn(
    `alteroid: 台帳に同一マネージャー×同一本文の未了が重複している` +
      `（${duplicates.length} 組 / ${rows} 行）。` +
      `${OPEN_MANAGER_BODY_INDEX} を作らずに起動する（#1041）。` +
      `同時に開かれた2件目を DB が拒む段だけが無い状態になる。` +
      `重複を人間が閉じるか直せば、次の起動で索引は作られる。\n`,
  );
  for (const group of duplicates) {
    warn(`alteroid:   source=${group.source} ids=${group.ids.join(', ')}\n`);
  }
}

export const AUTH_ACCOUNTS_EMAIL_LOWER_INDEX = 'auth_accounts_email_lower_idx';

const AUTH_ACCOUNTS_EMAIL_IDX = 'auth_accounts_email_idx';

const CREATE_AUTH_ACCOUNTS_EMAIL_LOWER_INDEX = `create unique index if not exists ${AUTH_ACCOUNTS_EMAIL_LOWER_INDEX}
   on auth_accounts (lower(email))`;

export interface AuthAccountsEmailLowerDuplicate {
  readonly ids: readonly string[];
}

async function hasAuthAccountsEmailLowerIndex(db: Db): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 from pg_class where relname = ${AUTH_ACCOUNTS_EMAIL_LOWER_INDEX}`,
  );
  return rowsOf(result).length > 0;
}

export async function findAuthAccountsEmailLowerDuplicates(
  db: Db,
): Promise<AuthAccountsEmailLowerDuplicate[]> {
  const result = await db.execute(sql`
    select array_agg(id order by created_at asc, id asc) as ids
    from auth_accounts
    where email is not null
    group by lower(email)
    having count(*) > 1
    order by count(*) desc
  `);
  return rowsOf(result).map((row) => {
    const value = row as { ids: string[] };
    return { ids: value.ids };
  });
}

// 重複を黙って畳まない・落とさない: どのアカウントが本物かは器では決められず、投げると
// デーモンが上がらなくなる。作らずに警告して進む（旧索引は残るので完全一致の重複は拒まれる）。
// 旧索引の drop は新しい鍵ができた直後: 先に外すと大小文字だけが違う重複を拒めない空白ができる。
// 警告にメールアドレスは載せない（ログへ個人情報を出さない）。
export async function ensureAuthAccountsEmailLowerIndex(
  db: Db,
  warn: (line: string) => void,
): Promise<void> {
  if (await hasAuthAccountsEmailLowerIndex(db)) {
    await db.execute(sql.raw(`drop index if exists ${AUTH_ACCOUNTS_EMAIL_IDX}`));
    return;
  }
  const duplicates = await findAuthAccountsEmailLowerDuplicates(db);
  if (duplicates.length === 0) {
    await db.execute(sql.raw(CREATE_AUTH_ACCOUNTS_EMAIL_LOWER_INDEX));
    await db.execute(sql.raw(`drop index if exists ${AUTH_ACCOUNTS_EMAIL_IDX}`));
    return;
  }
  const rows = duplicates.reduce((total, group) => total + group.ids.length, 0);
  warn(
    `alteroid: auth_accounts に大小文字だけが違う検証済みメールの重複がある` +
      `（${duplicates.length} 組 / ${rows} 行）。` +
      `${AUTH_ACCOUNTS_EMAIL_LOWER_INDEX} を作らずに起動する（#1702）。` +
      `旧索引（${AUTH_ACCOUNTS_EMAIL_IDX}）は残したままなので、大小文字まで完全に` +
      `同じメールの重複はこれまでどおり DB が拒む。` +
      `重複を人間が直せば（例: 片方のアカウントのメールを空にする）、` +
      `次の起動で索引は作られる。\n`,
  );
  for (const group of duplicates) {
    warn(`alteroid:   ids=${group.ids.join(', ')}\n`);
  }
}

// `warn` を差し替えられるのはテストのため: 警告が出たことと逐語を歯で測れないと、「索引が作られなかった」状態が誰にも見えないまま運用へ出る。
export async function migrate(
  db: Db,
  warn: (line: string) => void = (line) => process.stderr.write(line),
): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
  await ensureOpenManagerBodyIndex(db, warn);
  await ensureAuthAccountsEmailLowerIndex(db, warn);
}
