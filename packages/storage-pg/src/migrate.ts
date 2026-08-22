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
 */
const STATEMENTS = [
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

  // --- 開いている実行許可（store.ts の PermissionStore） ---------------------
  // 一意なのは id ではなく rule である。同じ規則が2行あると、人間が1行消しても
  // 規則は効いたままになり「消したのに効き続ける」＝ 増やす口だけが片道で開く。
  // 重複の禁止を SQL 側へ置けば `insert ... on conflict do nothing` の1操作で
  // 判定ごと済み、割り込む隙間が無い。
  //
  // **deny / ask の列を足さないこと。ここは allow だけの台帳である。**
  // **「どの層に効くか」の列も足さないこと** — すぐ下の env_profile が、まさに
  // その形が権限の一覧へ化けると警告している。
  `create table if not exists permissions (
     id text primary key,
     rule text not null unique,
     granted_at timestamptz not null,
     permission jsonb not null
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
  // **持ち主は高々1人。** 定数式に対する部分一意索引なので、granted_at が入っている
  // 行はテーブル全体で1行しか存在できない。並行 grant を「読んでから書く」で
  // 防ごうとすると、owner が居ない状態の同時実行をすり抜ける — 器の側で構造的に
  // 潰しておく（マルチユーザーは PRD 非ゴール）。
  `create unique index if not exists auth_accounts_single_owner_idx
     on auth_accounts ((granted_at is not null)) where granted_at is not null`,

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
  // 新しい鍵。**層と場所を鍵に入れる。** クローンは自分のセッション本体と要約の
  // 蒸留の両方で使うので、同じ日・同じ actor・同じモデルで意味の違う行が2つ立つ。
  // 3列の鍵のままだと2行目が拒まれ、`on conflict do update` が先にある行へ増分を
  // 足し込む — そのとき layer / site は先に入った側の値のまま残り、**出力から
  // 見分けられない誤帰属**になる。
  `create unique index if not exists usage_daily_key_idx
     on usage_daily (date, manager_id, model, layer, site)`,
  // 古い3列の主キーを外す（新しい鍵を作ったあとに外す。migrate.ts 冒頭の順序）。
  // 索引としても新しい鍵の前方一致に含まれるので、残しても冗長なだけである。
  `alter table usage_daily drop constraint if exists usage_daily_pkey`,
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
] as const;

export async function migrate(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}
