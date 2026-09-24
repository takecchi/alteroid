import { sql } from 'drizzle-orm';

import type { Db } from './db.js';

/**
 * スキーマの用意。デーモンの起動時に毎回通す（すべて `if not exists`）。
 *
 * drizzle-kit の生成ファイルを配らないのは、**起動が別手順に依存しないため**
 * である。コンテナは `docker compose up` だけで上がるのが受け入れ基準1であり、
 * 「先にマイグレーションを流す」という人間の手順を足した時点でそれが崩れる。
 * 定義の実体は schema.ts で、ここはその DDL 表現。ずれれば pg のテストが落ちる
 * （storage-pg のテストは実 PostgreSQL（PGlite）で全 IF を通す）。
 *
 * 列を足すときは `alter table ... add column if not exists` をこの配列の末尾へ
 * 加える（既存の DB にも順に当たる）。**既存行の意味を変える変更を黙って混ぜない**
 * — それは記憶の書き換えであり、人間の確認が要る。
 *
 * ## 鍵を差し替える
 *
 * 主キーを付け替える手がここには無かった（`create table if not exists` の羅列は
 * 既にあるテーブルに何もしない）。足すときは**主キーではなく一意索引で持つ**こと。
 *
 * ```
 * create table if not exists t ( ... )                        -- primary key を書かない
 * alter table t add column if not exists c text not null default '…'
 * create unique index if not exists t_key_idx on t (…, c)     -- 新しい鍵
 * alter table t drop constraint if exists t_pkey              -- 古い鍵を外す
 * ```
 *
 * **`drop constraint` + `add primary key` で書かないこと。** `add primary key` は
 * 既に主キーがあると落ちるので必ず drop と対にする形になり、**毎回の起動で索引を
 * 作り直す**（そのたびに ACCESS EXCLUSIVE を取る）。一意索引なら2回目以降が本当の
 * no-op になる。not null が全列に付いていれば強さは主キーと同じで、`on conflict` の
 * 推論も受ける。
 *
 * **順序は「列を足す → 新しい鍵 → 古い鍵を外す」。** 逆にすると、古い鍵を外した
 * 瞬間から新しい鍵ができるまでのあいだ重複を拒めない。
 *
 * ## ⚠️ 古い鍵の `create` は配列から消す（drop だけ残す）
 *
 * **`drop index` を足したら、その索引を作る文をこの配列から消すこと。** 消さずに
 * 残すと、**次の起動でデーモンが上がらなくなる。**
 *
 * この配列は起動のたびに頭から通る。初回は「古い鍵を作る → 新しい鍵を作る →
 * 古い鍵を drop する」で終わるので、**古い鍵はもう存在しない。** よって2周目の
 * `create ... if not exists` は**名前で一致せず、本当に作りに行く** — そのときに
 * は新しい鍵が許した行（古い鍵から見れば重複）が既に積まれていて、
 * `could not create unique index … is duplicated` で落ちる。**`if not exists` は
 * 「2回目は no-op」を約束しない。同じ配列の後ろで drop していれば no-op ではない。**
 *
 * 実際に踏んだ（2026-08-25、`usage_daily_key_idx`。本番のデーモンが起動不能に
 * なった）。**空の DB から作るテストでは出ない** — 1周目しか通さないからである。
 * 歯は「migrate を2回通す + 新しい鍵でだけ立つ行を挟む」の形で置く
 * （`usage.test.ts` の `grep -Fn -- '2周目が古い鍵を作りに行く' packages/storage-pg/src/usage.test.ts`）。
 *
 * **`drop constraint` は同じ形ではない。** 外す先が `create table if not exists`
 * の中で宣言された主キーなら、その create は2周目に本当の no-op になる
 * （テーブルが在るから）。危ないのは `drop index` と対の `create index` だけ。
 *
 * **`export` しているのはテストのためである** — `migrate.test.ts` が、この配列に
 * 「作ってから同じ名前を drop する索引」が無いことを構造で見る（直上の規則を、
 * 次に `drop index` を足した人の手元で落とすため）。
 */
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

  // 既定の仕込み（日報・発意 tick）の位相。**`schedules` とは別の表である**
  // （理由は schema.ts の `schedulePhases`）。既にある DB へ当たっても、この表が
  // 無い状態は「まだ一度も位相を記録していない」＝ 初回起動と同じに読めるので、
  // 既存行の意味を書き換えない。
  `create table if not exists schedule_phases (
     kind text primary key,
     updated_at timestamptz not null default now(),
     phase jsonb not null
   )`,

  // まだ処理し終えていない受信箱の合図（store.ts の InboxStore）。id が主キーなのは
  // 同じ合図が二重に積まれないためで、deliveries は put で上書きしても引き継がれる。
  `create table if not exists inbox_events (
     id text primary key,
     event jsonb not null,
     at timestamptz not null,
     deliveries integer not null default 0
   )`,
  `create index if not exists inbox_events_at_idx on inbox_events (at)`,

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

  // 実行環境プロファイル（\`.zprofile\` 相当）。**高々1行**である。
  // 用途ごとに行を増やす形にしないのは、増やせる形にした瞬間に「どの行が
  // どの層に効くか」の対応表が生まれ、それが権限の一覧に化けるからである。
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

  // --- ログインとアクセス許可 ---------------------------------------------
  // 「誰がこの API に触れるか」の層。PRD「権限境界」（クローンが記憶を根拠に
  // 何を人間へ確認するか）とは別物なので、行為ごとのスコープ列は置かない。
  `create table if not exists auth_accounts (
     id text primary key,
     display_name text,
     email text,
     created_at timestamptz not null,
     last_login_at timestamptz,
     granted_at timestamptz,
     granted_by text
   )`,
  // email は null を許す（未検証・衝突時は入れない）。PostgreSQL の unique は
  // null を重複と見なさないので、これで「検証済みメールは高々1アカウント」になる。
  `create unique index if not exists auth_accounts_email_idx on auth_accounts (email)`,
  // ⚠️ **ここに `auth_accounts_single_owner_idx`（持ち主を1行に絞る部分一意索引）を
  // 作る文が在った。2026-09-09 のオーナー決定で落とし、この配列の末尾へ drop を
  // 置いた。** 直上の「古い鍵の `create` は配列から消す」に従って**この create は
  // 消してある** — 残すと、2人目を許可した後の次の起動で本当に作りに行き
  // `could not create unique index … is duplicated` でデーモンが上がらなくなる。

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

  // --- 利用状況の台帳（usage.ts の UsageStore） ---------------------------
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
  // --- 「誰が・どこで」の軸を足す（既にある DB へも順に当たる） ---------------
  //
  // **既定は既にある行にとって真である。** この列より前に台帳へ積まれていたのは
  // マネージャーのセッション本体の分だけで、クローンの分は1バイトも記録されて
  // いなかった（`clone.ts` が `result.modelUsage` を渡していなかった）。だから
  // `'manager'` / `'session'` は行の意味を書き換えず、暗黙だったものを明示する。
  //
  // **ただしその既定は観測ではない。** どこからが観測かは `usage_ledger.layered_at`
  // が持ち、`aggregate` が `beforeLayers` として返す。ここを混ぜると「層を足す前の
  // 期間はクローンが使っていなかった」と読める出力になる。
  `alter table usage_daily add column if not exists layer text not null default 'manager'`,
  `alter table usage_daily add column if not exists site text not null default 'session'`,
  // --- 「どの認証トークンで」の軸を足す（Issue #393 受け入れ基準6） ---------
  //
  // **`not null default ''` である。null を許さない。** PostgreSQL の一意索引は
  // 既定で `nulls distinct` — null どうしを重複と見なさない。null を許すと
  // **帰属の無い行が `on conflict` に当たらず、record のたびに新しい行が挿さって
  // 積み上がらない。** そしてそれが起きるのはプールを使っていない器 ＝ 既定の
  // 構成である（受け入れ基準7 を真正面から壊す）。空文字は鍵を成立させるための
  // 「値が無い」の印で、読むときに undefined へ戻す（`usage.ts` の `#toRow`）。
  //
  // **この既定は `layer` / `site` と違って「古い行にとって真」ではない。** あちらは
  // 暗黙だったものを明示しただけだが、こちらは**真になる値が存在しない** — この列
  // より前の行がどのトークンで走ったかは、どこにも記録されていない。だから
  // `usage_ledger.tokens_at` を別に持ち、`aggregate` が `beforeTokens` で言う。
  `alter table usage_daily add column if not exists token_id text not null default ''`,
  // 新しい鍵。**層と場所とトークンを鍵に入れる。** クローンは自分のセッション本体と
  // 要約の蒸留の両方で使うので、同じ日・同じ actor・同じモデルで意味の違う行が2つ
  // 立つ。3列の鍵のままだと2行目が拒まれ、`on conflict do update` が先にある行へ
  // 増分を足し込む — そのとき layer / site は先に入った側の値のまま残り、**出力から
  // 見分けられない誤帰属**になる。トークンの軸も同じ理由で鍵に入る。
  //
  // **名前が `usage_daily_key_idx` ではないのは意図である。** `create unique index
  // if not exists` は**名前だけ**を見るので、旧名のまま列を足しても**既にある DB
  // では何も起きない**（鍵は古いままで、別のトークンの増分が先にある行へ足し込まれて
  // 誤帰属になる）。**そしてテストは空の DB から作るので通る** — 本番だけが古い鍵で
  // 走り、出力には何も出ない。名前を変えれば、既にある DB でも新しい索引が作られる。
  `create unique index if not exists usage_daily_token_key_idx
     on usage_daily (date, manager_id, model, layer, site, token_id)`,
  // 古い3列の主キーを外す（新しい鍵を作ったあとに外す。migrate.ts 冒頭の順序）。
  // 索引としても新しい鍵の前方一致に含まれるので、残しても冗長なだけである。
  `alter table usage_daily drop constraint if exists usage_daily_pkey`,
  // 古い5列の鍵（`usage_daily_key_idx`）を外す。**この drop には対になる create が
  // 無い。無いのが正しい**（下の ⚠️）。
  //
  // ⚠️ **`create unique index if not exists usage_daily_key_idx on usage_daily
  // (date, manager_id, model, layer, site)` をこの配列へ戻さないこと。** かつて
  // この drop の上に在り、**デーモンが2度と起動できなくなった**（起動のたびに
  // この配列は頭から通る）。初回の起動では5列の索引が作られ、6列の鍵ができた
  // あとこの drop で消える。**次の起動では `if not exists` が名前で一致しないので
  // 本当に作りに行き**、そのときには token_id だけが違う行が既に積まれている：
  // `could not create unique index "usage_daily_key_idx" … Key (date, manager_id,
  // model, layer, site)=(…) is duplicated`（実測 2026-08-25。本番のデーモンが
  // 起動不能になった）。**6列の鍵が許す行が、5列の鍵では重複になる。**
  //
  // **一般形: 鍵を差し替えたら、古い鍵の create を配列から消すこと。** drop だけ
  // 残す（既にある DB のために要る）。`if not exists` は「2回目は no-op」を約束
  // しない — **同じ配列の後ろでそれを drop していれば、次の周回は no-op ではない。**
  // migrate.ts 冒頭の doc「鍵を差し替える」も参照。
  //
  // **`usage_baseline` の側は同じ形ではない。** あちらが外すのは `create table if
  // not exists` の中で宣言された主キー**制約**で、その create は2回目に本当の
  // no-op になる（テーブルが在るから）。危ないのは `drop index` と対の
  // `create index` だけである。
  `drop index if exists usage_daily_key_idx`,
  // 新しい鍵の先頭が date なので、date だけの絞り込みは前方一致が効く（別に
  // (date) 索引を足すのは冗長）。(manager_id, date) はその並びに無いので、
  // 「この actor が期間中いくら使ったか」を date を先に決めずに引く経路として足す。
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
  // 累積を持つ主体は「層 × actor」である。**既定 `'manager'` が入ることで、既に
  // ある基準はそのまま同じ主体として引ける** — 引けなくなると「基準が無い」と
  // 読まれ、次の1回で累積の全量が増分として積まれる ＝ 記録済みの分の二重計上。
  `alter table usage_baseline add column if not exists layer text not null default 'manager'`,
  `create unique index if not exists usage_baseline_key_idx
     on usage_baseline (layer, manager_id)`,
  `alter table usage_baseline drop constraint if exists usage_baseline_pkey`,

  // 単一行（id = 'default'）。台帳が記録を始めた時刻。aggregate の since の元。
  `create table if not exists usage_ledger (
     id text primary key,
     started_at timestamptz not null,
     layered_at timestamptz
   )`,
  // 層と場所の軸が記録を始めた時刻。**null を許す** — 台帳が始まっていても層の
  // 軸はまだ始まっていない、という状態が実際に在る（この移行が当たった直後）。
  `alter table usage_ledger add column if not exists layered_at timestamptz`,
  // 認証トークンの軸が記録を始めた時刻。**null を許す**うえに、`layered_at` と
  // 違って**プールを使っていない器では最後まで null のままである**（層と場所は
  // 必ず取れるが、トークンの帰属は現役の指名が無ければ取れない）。だから
  // `record` は「`token_id` が付いた1件目」でだけここを埋める。揃えて埋めると、
  // トークンを1本も持っていない器が「トークン軸を観測している」と名乗る。
  `alter table usage_ledger add column if not exists tokens_at timestamptz`,
  // 回数の軸が記録を始めた時刻。**null を許す。** `layered_at` と同じ時機
  // （最初の record）で入るのが通常だが、増分が空の record では回数を数えない
  // ので、`layered_at` だけが先に入って `turns_at` が後から入る状態がありうる。
  `alter table usage_ledger add column if not exists turns_at timestamptz`,

  // 「起きた回数」の別テーブル。**新規テーブルなので鍵の差し替えは無い** —
  // `usage_daily` の索引名の教訓（上）はここには掛からない。最初から一意索引で
  // 持つ（`schema.ts` の `usageTurns` の doc）。
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

  // --- 引き受けたまま終わっていない仕事（store.ts の CommitmentStore） --------
  // id が主キーなのは open の冪等性を SQL 側で強制するためである。「select して
  // から insert」に割ると同じ id の並行 open が両方すり抜け、片付いた仕事が
  // 開き直る。主キーがあれば `insert ... on conflict do nothing` の1操作で済む。
  `create table if not exists commitments (
     id text primary key,
     at timestamptz not null,
     closed_at timestamptz,
     commitment jsonb not null
   )`,
  // 一覧の主経路は「未了だけを古い順」。閉じた行が積もっても効き続けるよう部分索引。
  `create index if not exists commitments_open_idx
     on commitments (at) where closed_at is null`,

  // --- 記憶の保護状態（human guard。schema.ts の `memory` の doc） -----------
  // 「一度でも人間が書いた記憶を、統合の走行が黙って壊せないようにする」ための
  // 派生値。実体は日誌（memory_update.cause）にあり、この2列は読み出しを安く
  // するためのキャッシュ。**既存行にとって null は「まだ分からない」であり、
  // それは unknown（守る側）に落ちるので安全な既定である。**
  `alter table memory add column if not exists human_touched_at timestamptz`,
  `alter table memory add column if not exists content_sha256 text`,

  // --- 記憶の目次化（#170）が要る導出値 --------------------------------------
  // 上の2列の隣へ追記で足す。**既存行にとって null は「まだ観測していない」**
  // ——`resolveMemoryDescriptionFreshness` はこれを `unknown`（fresh にも
  // stale にも畳まない）として扱う。安全な既定である。
  `alter table memory add column if not exists described_at timestamptz`,

  // --- 記憶の作成時刻（createdAt） --------------------------------------------
  // 上の列の隣へ追記で足す。**既存行にとって null は「まだ backfill が見て
  // いない」または「見たが日誌に根拠が無かった」のどちらかで、読み出し側は
  // どちらも区別せず `{ kind: 'unknown' }` として扱う（`schema.ts` の
  // `memory.createdAt` の doc）。安全な既定である——値を作らない。
  `alter table memory add column if not exists created_at timestamptz`,

  // --- 会話の窓を with で絞る（journal.ts の list()。issue #418） -----------
  // 絞りを limit より前へ移した結果、pg は「with に当たる行が scan 件見つかる
  // まで seq を逆順に辿る」形になる。この式索引が無いと、type/at の索引では
  // with の絞りにも seq の順序にも効かない（`schema.ts` の
  // `journal_exchange_with_seq_idx` の doc）。新しい列を足すわけではないので、
  // 既存行の意味は1つも変わらない。
  `create index if not exists journal_exchange_with_seq_idx
     on journal ((entry->>'with'), seq)`,

  // --- 認証トークンのプール（Issue #393「PR1 プールの器」） -------------------
  // **回さない。** ここが持つのは正本の置き場だけ。まだ誰の DB にも無い新規
  // テーブルなので、他のテーブルのような「列を足す→鍵を差し替える」の順序は
  // 要らず、最初から今の形で作ってよい。
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

  // 回す契機と冷却の既定。高々1行（id = 'default'）。
  `create table if not exists agent_token_settings (
     id text primary key,
     rotate_on text not null,
     cooldown_ms bigint not null,
     updated_at timestamptz
   )`,

  // 行がいつ作られ、いつ変わったか（Issue #393）。**`default now()` を付けない**
  // ——付けると PR1 の版で入った既存の行が「いま作られた」ことになる
  // （`@alteroid/core` の `AgentToken.createdAt` の doc）。
  `alter table agent_tokens add column if not exists created_at timestamptz`,
  `alter table agent_tokens add column if not exists updated_at timestamptz`,

  // 資格の出所（Issue #393）。**null は `stored`** ——後から足した列なので、
  // 既存の行は null である。**`default 'stored'` を付けない**（付けても意味は
  // 同じだが、null と 'stored' の2通りが混在するより、読む側の分岐が1つで済む）。
  `alter table agent_tokens add column if not exists source text`,
  // **`value` の not null を外す。** `source = 'env'` の行は値を持たない。
  `alter table agent_tokens alter column value drop not null`,

  // 冷却の期限の出所（#683）。**`default now()` のような既定値を付けない**
  // ——既存の行は「出所を言えない」のであって「推測だった」のではない
  // （`@alteroid/core` の `AgentToken.cooldownSource` の doc）。埋めると
  // 「推測だと観測した」という嘘を全行へ書くことになる。
  `alter table agent_tokens add column if not exists cooldown_source text`,

  // いま撒いてある現役の指名（Issue #393 PR3）。高々1行（id = 'default'）。
  // **`agent_tokens` の列にしない** — 2行が同時に現役だと主張する形を作らない。
  `create table if not exists agent_token_active (
     id text primary key,
     token_id text not null,
     generation bigint not null,
     rotated_at timestamptz not null
   )`,

  // 持ち主を1行に絞っていた部分一意索引を落とす（2026-09-09 のオーナー決定。
  // 許可は複数のアカウントへ出せるようになった）。**対になる create は上から
  // 消してある** — 残すと2周目に作りに行って落ちる。既に索引の無い DB（新規）
  // では `if exists` が効いて本当の no-op になる。
  `drop index if exists auth_accounts_single_owner_idx`,

  // --- archive の tombstone（#698） ----------------------------------------
  // **消す口（`remove()`）を足すための列。行は消さない——本文だけを落とす。**
  // `body` の not null は外さない（空文字を入れる）。判定は `removed_at` が
  // null かどうかだけで行う（`body` が空文字であることを根拠にしない——空の
  // 生ログは正当にありえる）。
  `alter table archive add column if not exists removed_at timestamptz`,
  `alter table archive add column if not exists removed_bytes integer`,

  // --- マネージャーへ降ろす環境変数の正本 ------------------------------------
  // **1名前1行。** 名前が主キーなので、置き換えは `on conflict` で済む。
  // まだ誰の DB にも無い新規テーブルなので、他のテーブルのような「列を足す →
  // 鍵を差し替える」の順序は要らず、最初から今の形で作ってよい。
  //
  // **`value` を not null にしてある。** 「外す」は行の削除で表す（空文字の行を
  // 残せる形にすると、`list()` が返す集合と器へ降りる集合が食い違う）。
  `create table if not exists manager_credentials (
     name text primary key,
     value text not null,
     updated_at timestamptz not null default now()
   )`,

  // --- archive の本文の指紋と連続性判定（#698） ----------------------------
  // **tombstone（removed_at / removed_bytes）とは別の目的の列である。**
  // 積む瞬間に「同じ session_id の直前の退避と前方一致するか」を判定して残す
  // （`archive-continuity.ts` の `classifyArchiveContinuity`）。**すべて nullable。**
  // この機能より前に積まれた行はどれも持たない（`classifyArchiveContinuity`
  // が欠落を `'unknown'` へ落とすので、埋め直す必要はない）。
  `alter table archive add column if not exists body_chars integer`,
  `alter table archive add column if not exists body_md5 text`,
  `alter table archive add column if not exists continuity text`,

  // --- 要旨の変化量（#913）--------------------------------------------------
  // `described_at`（#170、上の「記憶の目次化」の節）の隣に本来置きたい列だが、
  // 間に他のテーブルの列が何本も積まれているので、過去の文の並びは動かさず
  // この末尾へ足す。**既存行にとって null は「この仕組みより前の記憶」を表し、
  // `resolveMemoryDescriptionFreshness` はこれを `unrecorded`（`0` ではない）
  // として扱う。安全な既定である——値を作らない。索引は足さない**（`drop index`
  // と対でない `alter table ... add column` は、この配列が2周目に通っても
  // 「古い鍵を作りに行く」形の罠（このファイル冒頭の doc）には当たらない）。
  `alter table memory add column if not exists described_bytes integer`,

  // --- 要旨の変化量の基準点を測った時刻（#821 残課題）--------------------
  // `described_bytes`（直上）の隣に足す。**既存行にとって null は「基準点が
  // まだ立っていない」を表し（`resolveMemoryDescriptionDrift` はこれを
  // `unrecorded` として扱う）、埋め直さない**——過去の値を捏造しない
  // という、この2列を最初に置いた #913 の判断をそのまま引き継ぐ。索引は
  // 足さない（同じ理由。このファイル冒頭の doc）。
  `alter table memory add column if not exists described_bytes_at timestamptz`,

  // --- 環境変数の撒く先・シークレット可否（2026-09-14）--------------------
  // **どちらも「今まで全行がそうだった」ことをそのまま表す既定値である**
  // ——この列が無かった頃、`manager_credentials` の全行は実際に両方へ撒かれ
  // （scope 相当が常に `all`）、かつ値は API から絶対に返らなかった
  // （secret 相当が常に `true`）。だから `default` を付けても過去を捏造しない
  // （このファイル冒頭の「既存行の意味を変える変更を黙って混ぜない」の例外に
  // ならない——意味は変えておらず、無かった列に「元からそうだった値」を
  // 明示しているだけである）。
  `alter table manager_credentials add column if not exists scope text not null default 'all'`,
  `alter table manager_credentials add column if not exists secret boolean not null default true`,

  // --- 承認待ちの取り下げ（#963）------------------------------------------
  // **既存行にとって null は「取り下げられていない」を表す** —— この列が
  // 無かった頃、取り下げという状態そのものが存在しなかったので、過去の値を
  // 捏造していない（`described_bytes` 等と同じ判断）。`answered_at` と対の
  // 列として持つのは、`listApprovals({ pendingOnly: true })` の絞り込みに
  // 使うため（`jobs.ts` の `where` 節）—— jsonb の中の `withdrawnAt` を毎回
  // `->>'withdrawnAt' is null` で見るより、専用の列を素直に `isNull` で
  // 見るほうが `answered_at` と揃った形になる。索引は足さない（承認待ちの
  // 行数は運用の規模から見て小さく、`answered_at` にも専用の索引は無い）。
  `alter table approvals add column if not exists withdrawn_at timestamptz`,

  // --- オーナー本人の宣言（#1198）------------------------------------------
  // `null` は「宣言されていない」——既存行は全部これになるので、マージ直後も
  // `requireOwner` を通す行は無い（今日と1ビットも変わらない）。単純な列追加
  // なので、このファイル冒頭の「危ないのは drop index と対の create index
  // だけ」に当たらない——2周目以降も本当の no-op である。
  `alter table auth_accounts add column if not exists owner_declared_at timestamptz`,

  // --- 仕事のやり方（#1055 段3）--------------------------------------------
  // 新しい表を足すだけなので、既存行の意味は1ビットも変わらない（このファイル
  // 冒頭の「既存行の意味を変える変更を黙って混ぜない」に当たらない）。索引は
  // 足さない —— 引き方は slug の一致と全件の昇順だけで、主キーがそのまま効く。
  //
  // ⛔ **既にあるどの表にも列を足していない。** やり方は独立した器であって、
  // 記憶（`memory`）にも委譲（`jobs`）にも生えない（#1055 段3 の決定）。
  `create table if not exists practices (
     slug text primary key,
     kind text not null,
     title text not null,
     content text not null,
     bytes integer not null,
     created_at timestamptz not null,
     updated_at timestamptz not null
   )`,

  // --- archive の死んだ行バージョンを autovacuum に回収させる（#698）-------
  // **これは列でも索引でもなく、テーブルの格納パラメータ（reloptions）である。**
  // `archive` の `remove()` は行を消さず `body` を空へ UPDATE する（tombstone。
  // `packages/storage-pg/src/archive.ts`）ので、畳むたびに旧タプルと、それが
  // 指していた TOAST のチャンクが死骸として残る。
  //
  // ⛔ **これは「本番の archive が 43 GB になった」ことへの対策ではない。**
  // そう読みたくなるが、本番の実測がそれを支持しない（2026-09-22T19:4xZ、
  // オーナー代理が `psql` で取った値。`pg_toast_16475` は `archive` の TOAST）:
  //
  // ```
  // relname        | n_live_tup | n_dead_tup | last_autovacuum      | autovacuum_count
  // archive        |      4,373 |         27 | 2026-09-22 15:28:46Z |                2
  // pg_toast_16475 |  1,907,283 |          0 | 2026-09-22 15:33:23Z |               42
  // ```
  //
  // **TOAST の `reloptions` は空（＝素の既定値）のまま 42 回 autovacuum が回って
  // いた。**⟹ 回収は追いついていた。43 GB は「回収されていない死骸」ではなく
  // 「autovacuum が再利用可能にしたが、OS へ返していない空き領域」だったと読める
  // （⚠️ これは解釈である —— 43 GB だった時点の死骸の量は誰も測っていない）。
  //
  // ⭐ **効く側は `toast.` の付いたほうである。** 使い捨ての PostgreSQL 17.11 で
  // 測った（2026-09-22T19:2xZ 観測。本番の DB には接続していない）:
  //
  // - 親に `alter table t set (autovacuum_vacuum_scale_factor = 0.0)` を打っても
  //   **TOAST 側の `reloptions` は NULL のままである**（親の設定は継承されない）
  // - `toast.` を付けたときだけ TOAST 側の `reloptions` に載る
  // - TOAST は `pg_stat_all_tables` に**自分の行**を持ち、`n_live_tup` /
  //   `n_dead_tup` / `autovacuum_count` を親とは別に数える（親 200 行に対し
  //   TOAST は 128,400 行、という桁で食い違う）
  // - **親の autovacuum を発火しない閾値に縛ったうえで TOAST 側だけ緩めたところ、
  //   親の `autovacuum_count` が 0 のまま TOAST だけが autovacuum された** ⟹
  //   TOAST の回収に親 heap の autovacuum は要らない。独立に回る
  //
  // ⟹ **この文が直しているのは1つだけである** —— 既定の `scale_factor = 0.2` は
  // 閾値を `0.2 × 生きているチャンク数` で決めるので、**生きている本文が増える
  // ほど、放置される死骸も比例して増える。** 上の実測では live が 1,907,283
  // チャンクなので、数百 MB ぶんの死骸までは回収されない。`archive` の live が
  // 10 倍になれば、放置される量も 10 倍になる。⟹ **0 にすれば、この余裕が
  // 「live に比例する量」から「定数」へ変わる。**
  //
  // ⚠️ **それ以上のことはしない。** 峰（＝生きている本文の総量）そのものを
  // 下げるのは、畳む側（`apps/daemon/src/archive-folder.ts`）の仕事である。
  //
  // ⚠️ **数（50 / 10000）そのものに強い根拠は無い** —— `archive-folder.ts` の
  // `DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES` と同じ立場の暫定値である。TOAST 側だけ
  // 10000 にしてあるのは、チャンクが約 2 kB 刻みで積まれるので 50 では「数百 kB の
  // 死骸のたびに GB 級の TOAST を舐め直す」形になるからで、10000 チャンク ≒ 20 MB
  // を下限に置いた。**足りなければここを動かす。**
  //
  // ⚠️ **これは「一度太ったものを縮める」設定ではない。** 通常の VACUUM は空き
  // 領域を再利用可能にするだけで、OS へファイルを返すのは末尾がまるごと空いた
  // ときだけである（同じ実験で両方観測した）。OS へ返すには `VACUUM FULL` が要り、
  // **それは排他ロックを取るのでデーモンの起動時には打たない。**
  //
  // ⚠️ `alter table ... set (...)` は2周目以降も本当の no-op にはならない（毎回
  // カタログを書き直す）。**このファイル冒頭の「`drop index` と対の `create index`」
  // の罠には当たらない** —— 落ちる形が無いためである。取るロックは SHARE UPDATE
  // EXCLUSIVE で読み書きを止めないが、⚠️ **この強さは PostgreSQL の文書に拠って
  // おり、自分では測っていない。**
  `alter table archive set (
     autovacuum_vacuum_threshold = 50,
     autovacuum_vacuum_scale_factor = 0.0,
     autovacuum_analyze_threshold = 50,
     autovacuum_analyze_scale_factor = 0.0,
     toast.autovacuum_vacuum_threshold = 10000,
     toast.autovacuum_vacuum_scale_factor = 0.0
   )`,

  // --- 仕事のやり方の bytes を chars へ改名し、保存をやめる（#1340）--------
  // `bytes` という名前で `content.length`（文字数）を保存していたのが嘘
  // だった——直し方は「実体を名前に合わせる」ではなく「名前を実体に合わせた
  // うえで、保存自体をやめる」（Issue #1340 コメント、2026-09-23）。
  // 正規化後の本文の文字数（コードポイント数）は `char_length(content)` で
  // 都度導出する（`PgPracticeStore`）ので、この列はもう要らない。
  //
  // **導出値なので、既存行の意味は1ビットも変わらない**——このファイル冒頭の
  // 「既存行の意味を変える変更を黙って混ぜない」には当たらない。`drop column
  // if exists` は同じ列に対して2回目以降も本当の no-op である（`drop index`
  // と対の `create index` が踏む罠——このファイル冒頭「⚠️ 古い鍵の `create` は
  // 配列から消す」——とは違う形。ここでは同名の `create` をどこにも残していない）。
  `alter table practices drop column if exists bytes`,

  // --- やり方の追記専用の版の履歴（#1309）-----------------------------------
  // 新しい表を足すだけなので、既存行の意味は1ビットも変わらない（このファイル
  // 冒頭の「既存行の意味を変える変更を黙って混ぜない」に当たらない）。
  //
  // **主キーは `(slug, version)` の複合キーで、`serial` にしていない**——版番号は
  // slug ごとに独立した1始まりの連番でなければならない（`PgPracticeStore.write`
  // が `max(version) + 1` を自分で計算して入れる。`schema.ts` の `practiceVersions`
  // の doc）。
  `create table if not exists practice_versions (
     slug text not null,
     version integer not null,
     kind text not null,
     title text not null,
     content text not null,
     at timestamptz not null,
     primary key (slug, version)
   )`,

  // --- 人間の MCP 連携の登録（#325 段1）-------------------------------------
  // **`env_profile` と同じ形（高々1行）。** 新しい表を足すだけなので既存行の
  // 意味は1ビットも変わらず、`create table if not exists` は2周目以降も本当の
  // no-op である（同名の `drop` をどこにも置いていない —— このファイル冒頭の
  // 「⚠️ 古い鍵の `create` は配列から消す」の罠の形ではない）。
  `create table if not exists mcp_servers (
     id text primary key,
     servers jsonb not null,
     updated_at timestamptz not null default now()
   )`,

  // --- 人間が承認した Bash 許可の記録（Issue #863）---------------------------
  // 新しい表を足すだけなので、既存行の意味は1ビットも変わらない（このファイル
  // 冒頭の「既存行の意味を変える変更を黙って混ぜない」に当たらない）。
  //
  // `approvals` と同じ形——本体は jsonb、絞り込みに使う欄（`granted_at` /
  // `revoked_at`）だけ派生列として持つ（`schema.ts` の `permissionGrants` の
  // doc）。**⚠️ 設計メモは blob 列を `grant` としていたが、`GRANT` は
  // PostgreSQL の予約語で素の DDL では構文エラーになる**（実測:
  // `syntax error at or near "grant"`）ので `record` に変えてある
  // （`schema.ts` の同じ doc に実測込みで詳しい）。
  `create table if not exists permission_grants (
     id text primary key,
     granted_at timestamptz not null,
     revoked_at timestamptz,
     record jsonb not null
   )`,
] as const;

/** `ensureOpenManagerBodyIndex` が作る部分 unique 索引の名前（issue #1041）。 */
export const OPEN_MANAGER_BODY_INDEX = 'commitments_open_manager_body_idx';

/**
 * 同一マネージャー×同一本文×未了を **DB が拒む**ようにする索引（issue #1041）。
 *
 * **`STATEMENTS` に置いていないのは、無条件に当ててはいけない唯一の文だからである。**
 * 既存の重複行が1組でも在ると `could not create unique index` で落ち、この配列は
 * 起動のたびに頭から通るので、**デーモンが二度と上がらなくなる**（2026-08-25 に
 * `usage_daily_key_idx` で実際に踏んだのと同じ形。このファイル冒頭の doc）。
 *
 * **鍵は `md5(body)` である。** 生の `body` は btree の索引行のサイズ上限
 * （約2.7KB）を超えうるので、長い報告だけが記帳できなくなる。代償は
 * `PgCommitmentStore.open` の doc に全文で書いてある。
 */
const CREATE_OPEN_MANAGER_BODY_INDEX = `create unique index if not exists ${OPEN_MANAGER_BODY_INDEX}
   on commitments ((commitment->>'source'), md5(commitment->>'body'))
   where closed_at is null and commitment->>'origin' = 'manager'`;

/** `ensureOpenManagerBodyIndex` が見つけた、索引を作れなくする重複の1組。 */
export interface OpenManagerBodyDuplicate {
  readonly source: string;
  readonly ids: readonly string[];
}

function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
}

/**
 * 索引を作れなくする重複（同一 `source` × 同じ `md5(body)` の未了が2行以上）を数える。
 *
 * **`export` しているのはテストのためだけではない** —— 運用側が「いま索引を作れる
 * 状態か」を、索引を作りにいかずに確かめられる口が要る。
 */
/** 索引が既に在るか（`pg_class` を1行引くだけ。台帳には触らない）。 */
async function hasOpenManagerBodyIndex(db: Db): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 from pg_class where relname = ${OPEN_MANAGER_BODY_INDEX}`,
  );
  return rowsOf(result).length > 0;
}

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

/**
 * 索引を作る。**ただし既存の重複が在るなら作らず、逐語で警告して進む。**
 *
 * ## ⛔ 重複を黙って畳まない
 *
 * 「索引が作れるように、古い1件を残して残りを閉じる」という直し方が最初に思い付く
 * が、**採らない。** 台帳は「引き受けたまま終わっていない仕事」の唯一の在り処で、
 * **クローンが閉じていない行を器が閉じたら、クローンはそれに気づけない**——閉じた
 * 行は未了の一覧から消えるからである。器がクローンの記憶を書き換える形は、
 * この製品がいちばん避けるものである。
 *
 * ## ⛔ かといって落とさない（起動を止めない）
 *
 * ここで投げれば `migrate` が落ち、**デーモンが上がらなくなる**。重複行が在ること
 * 自体は危険ではない（そこに在るだけである）。**データの状態を、製品ぜんぶの停止へ
 * 変換しない。**
 *
 * ## ⟹ 索引を作らずに警告して進む
 *
 * このとき何が失われるかを正確に言う：**`PgCommitmentStore.open` の
 * `where not exists`（直列に来た同文の畳み込み）は効いたままで、DB が拒む段だけが
 * 無くなる。**⟹ 台帳は #1035 以前へは戻らず、**同時に来た2件目だけがすり抜ける。**
 *
 * **警告には件数と id を逐語で載せる。** 「重複がある」とだけ言われても、運用側は
 * どの行を見ればよいか分からない——**人間がその行を読んで、自分で閉じるか直すかを
 * 決められる材料**をここで渡す。次の起動で重複が無くなっていれば、索引は黙って作られる。
 */
export async function ensureOpenManagerBodyIndex(
  db: Db,
  warn: (line: string) => void,
): Promise<void> {
  // **索引が既に在るなら、台帳を1行も走査しない。** ここは起動のたびに通るので、
  // `findOpenManagerBodyDuplicates`（未了の全行を group by する）を毎回走らせると
  // 起動の費用が台帳の齢に比例して増える —— 索引が在る＝重複はもう作れないので、
  // 数える意味そのものが無い。
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

/**
 * スキーマを用意する。**起動のたびに通る。**
 *
 * `STATEMENTS` を頭から当てたあと、**無条件には当てられない1文**だけを
 * {@link ensureOpenManagerBodyIndex} が条件付きで当てる（issue #1041。既存の
 * 重複行が在ると索引が作れず、作りにいけば起動そのものが落ちる）。
 *
 * **`warn` を差し替えられるのはテストのためである。** 既定は stderr
 * （`index.ts` の接続エラーと同じ口）。警告が出たことと、その逐語を歯で測れないと、
 * 「索引が作られなかった」という状態が誰にも見えないまま運用へ出る。
 */
export async function migrate(
  db: Db,
  warn: (line: string) => void = (line) => process.stderr.write(line),
): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
  await ensureOpenManagerBodyIndex(db, warn);
}
