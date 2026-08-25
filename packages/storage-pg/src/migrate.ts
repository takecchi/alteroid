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

  // いま撒いてある現役の指名（Issue #393 PR3）。高々1行（id = 'default'）。
  // **`agent_tokens` の列にしない** — 2行が同時に現役だと主張する形を作らない。
  `create table if not exists agent_token_active (
     id text primary key,
     token_id text not null,
     generation bigint not null,
     rotated_at timestamptz not null
   )`,
] as const;

export async function migrate(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}
