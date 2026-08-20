import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * クラウド段のテーブル定義（docs/architecture.md「ストレージ」）。
 *
 * fs ドライバと同じ IF を満たすための器であって、新しい概念は足さない。
 * **記憶は Markdown のまま**テーブルに入る。人間が読んで直せること（提供価値1）は
 * ここでも要件なので、行に切り刻んで構造化しない — CLI / HTTP API から出し入れ
 * するのは fs 版と同じ1枚の Markdown 文書である。
 */

/** 記憶 = Markdown 文書。1行1文書。 */
export const memory = pgTable('memory', {
  slug: text('slug').primaryKey(),
  content: text('content').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * 日誌 = 追記専用。
 *
 * `seq` を持つのは順序のためである。`at` は ISO の文字列時刻で、同一ミリ秒の
 * 追記が同じ値を持ちうる。fs 版（JSONL の行順）と同じ「追記した順」を返すには
 * 時刻とは別の単調な軸が要る。
 */
export const journal = pgTable(
  'journal',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    type: text('type').notNull(),
    entry: jsonb('entry').notNull(),
  },
  (table) => [
    index('journal_at_idx').on(table.at),
    index('journal_type_at_idx').on(table.type, table.at),
  ],
);

/** ジョブ台帳（manager_id ↔ SDK session_id の対応もここ）。 */
export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  job: jsonb('job').notNull(),
});

/** 承認待ちキュー。 */
export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'date' }),
  approval: jsonb('approval').notNull(),
});

/**
 * 継続中の依頼（時間起点の仕込み）。
 *
 * `kind` が主キーなのは、同じ名前の依頼を二重に持たないためである（同じ名前で
 * 仕込み直したら置き換わるのが正しい）。本文は jsonb にそのまま入れる。
 */
export const schedules = pgTable('schedules', {
  kind: text('kind').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  plan: jsonb('plan').notNull(),
});

/**
 * 既定の仕込み（日報・発意 tick）の位相。
 *
 * **`schedules` と同じ表に入れないのは意図である。** あちらは人間とクローンが読み書き
 * する「継続中の依頼」で、`schedule_list` はその `list()` を直に読む。既定の仕込みを
 * 行として混ぜると、クローンからは依頼に見えて `schedule_remove` で消せてしまう
 * （`schedulePhaseSchema` に同じことを書いてある）。
 *
 * 持つのは「前回いつ動いたか」だけで、本文も周期も無い。**これが無いと器を作り直す
 * たびに位相が捨てられ、周期より短い間隔で再デプロイが続くと発意 tick が一度も
 * 発火しない。**
 */
export const schedulePhases = pgTable('schedule_phases', {
  kind: text('kind').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  phase: jsonb('phase').notNull(),
});

/**
 * 引き受けたまま終わっていない仕事の台帳（`store.ts` の `CommitmentStore`）。
 *
 * `id` が主キーなのは、**`open` の冪等性をここで強制するため**である。「select して
 * から insert」に割ると、同じ id の並行 open が両方すり抜けて後の書き込みが先の
 * 行を上書きする ＝ 一度片付けた仕事が配り直しのたびに開き直る。主キーがあれば
 * `insert ... on conflict do nothing` の1操作で済み、割り込む隙間そのものが無い。
 *
 * 列に出すのは並べ替えと絞り込みに使う `at` / `closed_at` だけで、本体は jsonb に
 * そのまま入れる（`schedules` と同じ作法）。クローンが読むのは jsonb の側である。
 */
export const commitments = pgTable(
  'commitments',
  {
    id: text('id').primaryKey(),
    /** 引き受けた時刻。未了を古い順に並べる軸（＝齢の出所）。 */
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    /** 片付いた時刻。null なら未了。`close` はこの列が null の行だけを更新する。 */
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    commitment: jsonb('commitment').notNull(),
  },
  // 一覧の主経路は「未了だけを古い順」なので、部分索引にして片付いた行を載せない
  // （自動 open は人間の発言のたびに1行増えるため、閉じた行はいずれ大半を占める）。
  (table) => [
    index('commitments_open_idx')
      .on(table.at)
      .where(sql`closed_at is null`),
  ],
);

/**
 * まだ処理し終えていない受信箱の合図（`store.ts` の `InboxStore`）。
 *
 * `id` が主キーなのは、同じ合図が二重に積まれないためである（`put` は同じ id なら
 * 上書きし、`deliveries` は引き継ぐ）。本文（`InboxEvent`）は jsonb にそのまま入れる
 * — 記録の意味は fs 版（`inbox.json`）と同じで、器が違うだけである。
 */
export const inboxEvents = pgTable(
  'inbox_events',
  {
    id: text('id').primaryKey(),
    event: jsonb('event').notNull(),
    /** `post` が受理した時刻。古い順に配るための軸。 */
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    /** 何度目の配達か。`claimPending` が読みと同時に進める。 */
    deliveries: integer('deliveries').notNull().default(0),
  },
  (table) => [index('inbox_events_at_idx').on(table.at)],
);

/** セッション生ログの退避先（PreCompact で落とした全文）。 */
export const archive = pgTable('archive', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
  body: text('body').notNull(),
});

/** デーモンの内部状態（クローンの session id など）。消えても記憶から戻る。 */
export const daemonState = pgTable('daemon_state', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/**
 * 実行環境プロファイル（人間の `.zprofile` に当たるもの）。**高々1行**。
 *
 * 用途ごとに行を増やせる形にしない。増やせるようにした瞬間、「どの行がどの層に
 * 効くか」の対応表が要るようになり、それは行為ごとの許可一覧と同じ形をしている
 * （AGENTS.md 地雷3）。効かせ分けが要るなら、本文の中でシェルとして分岐すればよい。
 */
export const envProfile = pgTable('env_profile', {
  id: text('id').primaryKey(),
  script: text('script').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * SDK の SessionStore が預ける生ログ1行。
 *
 * `uuid` を持つ行は冪等キーとして扱う（SDK が再送・再取り込みしうる）。
 * 持たない行（タイトル・タグ等）はそのまま積む。
 */
export const sessionEntries = pgTable(
  'session_entries',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    projectKey: text('project_key').notNull(),
    sessionId: text('session_id').notNull(),
    /** 主トランスクリプトは空文字。SDK 側の `subpath` 省略に対応する。 */
    subpath: text('subpath').notNull().default(''),
    uuid: text('uuid'),
    entry: jsonb('entry').notNull(),
  },
  (table) => [
    index('session_entries_key_idx').on(
      table.projectKey,
      table.sessionId,
      table.subpath,
      table.seq,
    ),
    uniqueIndex('session_entries_uuid_idx')
      .on(table.projectKey, table.sessionId, table.subpath, table.uuid)
      .where(sql`uuid is not null`),
  ],
);

/** セッションの索引（`listSessions` の mtime をここで持つ）。 */
export const sessions = pgTable(
  'sessions',
  {
    projectKey: text('project_key').notNull(),
    sessionId: text('session_id').notNull(),
    subpath: text('subpath').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectKey, table.sessionId, table.subpath] }),
    index('sessions_project_idx').on(table.projectKey, table.updatedAt),
  ],
);

/**
 * ログインしたアカウント。**マルチユーザーのための表ではない**（PRD 非ゴール）。
 * 持ち主が複数の端末・複数のログイン手段から入れるようにするための層である。
 *
 * `granted_at` が許可の2値。行為ごとのスコープ列は**置かない** — 置いた瞬間に
 * 「確認が要る行為の一覧」に化け、PRD「権限境界」と衝突する。
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name'),
    /** 本人が選んだ連絡先。検証済みのものだけが入る（不変条件）。 */
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }),
    grantedBy: text('granted_by'),
  },
  (table) => [
    uniqueIndex('auth_accounts_email_idx').on(table.email),
    // 持ち主は高々1人（granted_at が入る行はテーブル全体で1行まで）。
    uniqueIndex('auth_accounts_single_owner_idx')
      .on(sql`(${table.grantedAt} is not null)`)
      .where(sql`${table.grantedAt} is not null`),
  ],
);

/** 外部プロバイダ上の identity。`(provider, subject)` が一意。 */
export const authIdentities = pgTable(
  'auth_identities',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    accountId: text('account_id').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.subject] }),
    index('auth_identities_account_idx').on(table.accountId),
  ],
);

/**
 * 発行済みアクセストークン。**素の値は入れない**（sha256 だけ）。
 * 漏れた保管先から復元できてはいけない（記憶へ到達できる鍵であるため）。
 */
export const authAccessTokens = pgTable(
  'auth_access_tokens',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    sha256: text('sha256').notNull(),
    label: text('label').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('auth_access_tokens_sha256_idx').on(table.sha256),
    index('auth_access_tokens_account_idx').on(table.accountId),
  ],
);

/**
 * 利用状況の台帳（`usage.ts` の `UsageStore`）。3つに分けている。
 *
 * - `usageDaily`: 増分を「日 × マネージャー × モデル」で足し込んだ行。集計の主体
 * - `usageBaseline`: マネージャー1本ごとの前回累積（差分を取るための基準）
 * - `usageLedger`: 台帳が記録を始めた時刻。単一行（`id = 'default'`）で持つ —
 *   `aggregate` が返す `since` の元になる（1件も record していなければ行が無い）
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    date: text('date').notNull(),
    managerId: text('manager_id').notNull(),
    model: text('model').notNull(),
    // トークン数は SDK 側でも巨大になりうるので bigint。`mode: 'number'` で
    // JS 側は number として扱う（drizzle が mapFromDriverValue で変換する）。
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadInputTokens: bigint('cache_read_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheCreationInputTokens: bigint('cache_creation_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    webSearchRequests: bigint('web_search_requests', { mode: 'number' }).notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    /**
     * **誰が**使ったか（`clone` / `manager`）。既定は `manager` である。
     *
     * この列より前に入っていた行はすべてマネージャーの分なので、既定が真になる
     * （クローンの分は1バイトも記録されていなかった）。**ただしその既定は観測
     * ではない** — どこからが観測かは `usage_ledger.layered_at` が持つ。
     */
    layer: text('layer').notNull().default('manager'),
    /** **どこで**使ったか（`session` / `distill`）。既定は `session`。 */
    site: text('site').notNull().default('session'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    // **主キーではなく一意索引で持つ。** 層と場所は後から足した列で、既にある DB の
    // 3列 primary key を差し替える必要がある。`create unique index if not exists` は
    // 2回目以降が本当の no-op になるのに対し、`drop constraint` + `add primary key`
    // はデーモンが起動するたびに索引を作り直す（毎回 ACCESS EXCLUSIVE を取る）。
    // 意味は同じである — 5列すべて not null なので、一意索引は主キーと同じ強さで
    // 重複を拒む。`on conflict` の推論もこの索引が受ける。
    uniqueIndex('usage_daily_key_idx').on(
      table.date,
      table.managerId,
      table.model,
      table.layer,
      table.site,
    ),
    // pk の先頭が date なので、date だけの絞り込みは pk の索引がそのまま前方一致で
    // 効く（別に (date) 索引を足すのは冗長）。(manager_id, date) は pk に無い並びで、
    // 「このマネージャーが期間中いくら使ったか」を date を先に決めずに引く経路になる
    // ので、こちらだけを足す。
    index('usage_daily_manager_date_idx').on(table.managerId, table.date),
  ],
);

/** マネージャー1本につき1行。前回読んだ累積スナップショット（差分の基準）。 */
export const usageBaseline = pgTable(
  'usage_baseline',
  {
    managerId: text('manager_id').notNull(),
    /**
     * どの層の累積か。既定は `manager`（この列より前の基準はすべてマネージャーの分）。
     *
     * **actor の id だけを鍵にしないこと。** 層をまたいで同じ id が来たときに、
     * 別の累積が1つの基準を共有して差分がまるごと嘘になる。
     */
    layer: text('layer').notNull().default('manager'),
    sessionId: text('session_id'),
    models: jsonb('models').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    resets: integer('resets').notNull().default(0),
    lastResetAt: timestamp('last_reset_at', { withTimezone: true, mode: 'date' }),
  },
  // `usage_daily` と同じ理由で一意索引（migrate.ts の「鍵を差し替える」参照）。
  // 既定 `'manager'` が入るので、既にある基準はそのまま同じ主体として引ける
  // （引けなくなると「基準が無い」と読まれ、次の1回で累積の全量が積まれる
  // ＝ 記録済みの分の二重計上になる）。
  (table) => [uniqueIndex('usage_baseline_key_idx').on(table.layer, table.managerId)],
);

/**
 * 台帳が記録を始めた時刻。**単一行**（`id` は常に `'default'`）。
 *
 * `aggregate` の `since` はここから返す。行が無ければ「まだ一度も record して
 * いない」＝ `null`。行があれば、それより前を照会した範囲は「0」ではなく
 * 「記録が無い」として扱う（`beforeLedger`）。
 */
export const usageLedger = pgTable('usage_ledger', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  /**
   * **層と場所の軸**が記録を始めた時刻。まだ一度も記録していなければ null。
   *
   * `started_at` と分けて持つ。台帳（#45）より層の軸のほうが後から入ったので、
   * その間の行の `layer` / `site` は既定値であって観測ではない。1つにすると、
   * 層を足す前の期間が「クローンは使っていなかった」「蒸留は起きていなかった」と
   * 読める（`aggregate` はここから `beforeLayers` を返す）。
   */
  layeredAt: timestamp('layered_at', { withTimezone: true, mode: 'date' }),
});

/** 進行中のログイン試行（CLI とブラウザの往復を繋ぐ一時的な行）。 */
export const authLoginRequests = pgTable(
  'auth_login_requests',
  {
    id: text('id').primaryKey(),
    request: jsonb('request').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('auth_login_requests_expires_idx').on(table.expiresAt)],
);
