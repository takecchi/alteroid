import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
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

// 記憶は Markdown のまま入れ、行に切り刻んで構造化しない: 人間が読んで直せること（提供価値1）はここでも要件で、fs 版と同じ1枚の Markdown 文書を出し入れする。
export const memory = pgTable('memory', {
  slug: text('slug').primaryKey(),
  content: text('content').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  // ここは「誰も送らない導出値」だけを追記で伸ばす: 人間・クローンが書く値は `content` 列の側に置く（入口のスキーマを1つも変えないことが要件）。
  // 一度立ったら降ろさない: クローンの書き込みで null に戻さないよう、更新対象に含めない。
  // 実体は日誌（`memory_update.cause`）で、この列は読み出しを安くするキャッシュ。
  humanTouchedAt: timestamp('human_touched_at', { withTimezone: true, mode: 'date' }),
  /**
   * 更新する場所は `persona.ts` の `write()` / `append()` の2箇所で、両方揃えること:
   * pg は書き込み経路が独立した2メソッドに分かれ、片方だけ直すともう片方だけが外部編集と誤検出される。
   */
  contentSha256: text('content_sha256'),
  describedAt: timestamp('described_at', { withTimezone: true, mode: 'date' }),
  // `toDocument` が返す `bytes` と同じ測り方にする: ずれると全文書が「要旨を書いた直後から少し変わっている」に化ける。
  describedBytes: integer('described_bytes'),
  // `describedAt` とは限らない: 基準点が無ければ本文だけの書き込みの直前の `updated_at` が入る。
  describedBytesAt: timestamp('described_bytes_at', { withTimezone: true, mode: 'date' }),
  // 一度きりの確定値: `write` / `append` の `onConflictDoUpdate` の `set` に含めず、`markCreatedAt` は `isNull` 条件の UPDATE。
  // `unknown` という値は書き込まない（null が「根拠が無い」を表す）。
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }),
});

export const journal = pgTable(
  'journal',
  {
    // `at` は同一ミリ秒の追記が同じ値を持ちうるので、「追記した順」を返すには時刻とは別の単調な軸が要る。
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    type: text('type').notNull(),
    entry: jsonb('entry').notNull(),
  },
  (table) => [
    index('journal_at_idx').on(table.at),
    index('journal_type_at_idx').on(table.type, table.at),
    // 外さない: 無いと `journal_type_at_idx` は `with` の絞りにも `seq` の順序にも効かず、往復の多い日誌で実質フルスキャンになる。
    index('journal_exchange_with_seq_idx').on(sql`(${table.entry}->>'with')`, table.seq),
    index('journal_conversation_deleted_idx')
      .on(sql`(${table.entry}->>'deletedConversationId')`)
      .where(sql`${table.type} = 'conversation_deleted'`),
  ],
);

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  job: jsonb('job').notNull(),
});

// 索引 `approvals_conversation_id_idx`（式索引）は表定義に書かず `migrate.ts` だけが持つ。
export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'date' }),
  // 本体は `approval`（jsonb）に在るが、`pendingOnly` の絞りが `answered_at` と同じ形で効くよう専用の列としても持つ。
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
  approval: jsonb('approval').notNull(),
});

export const permissionGrants = pgTable('permission_grants', {
  id: text('id').primaryKey(),
  grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  // 列名を `grant` にしない: `GRANT` は予約語で素の DDL では構文エラーになり、
  // 二重引用符で回避すると「この列だけ引用が必須」という別の罠が残る。
  record: jsonb('record').notNull(),
});

export const schedules = pgTable('schedules', {
  // `kind` を主キーにする: 同じ名前の依頼を二重に持たないため（同じ名前で仕込み直したら置き換わるのが正しい）。
  kind: text('kind').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  plan: jsonb('plan').notNull(),
});

// `schedules` と同じ表に入れない: 混ぜるとクローンからは依頼に見えて `schedule_remove` で消せてしまう。
// 無いと器を作り直すたびに位相が捨てられ、周期より短い間隔で再デプロイが続くと発意 tick が一度も発火しない。
export const schedulePhases = pgTable('schedule_phases', {
  kind: text('kind').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  phase: jsonb('phase').notNull(),
});

// `id` を主キーにする: 「select してから insert」に割ると同じ id の並行 open がすり抜け、片付けた仕事が開き直る。
export const commitments = pgTable(
  'commitments',
  {
    id: text('id').primaryKey(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    commitment: jsonb('commitment').notNull(),
    // null は migrate が振る前の行で、並びでは最後に来る。書き直し（`jsonb_set`）では動かない。
    seq: bigint('seq', { mode: 'number' }).default(sql`nextval('commitments_seq_seq')`),
  },
  // 部分索引にして片付いた行を載せない: 自動 open で閉じた行がいずれ大半を占める。
  (table) => [
    index('commitments_open_idx')
      .on(table.at)
      .where(sql`closed_at is null`),
    // `migrate` が無条件には作らない: 既存の重複行が在ると作成が落ち、`STATEMENTS` に置くとデーモンが上がらなくなる。
    // `ensureOpenManagerBodyIndex` が数えてから作るので、在る DB と無い DB の両方がありうる。
    // 鍵が `md5(body)` なのは btree の索引行のサイズ上限のため。
    uniqueIndex('commitments_open_manager_body_idx')
      .on(sql`(${table.commitment}->>'source')`, sql`md5(${table.commitment}->>'body')`)
      .where(sql`closed_at is null and commitment->>'origin' = 'manager'`),
  ],
);

// `id` を主キーにする: 同じ合図が二重に積まれないため。
export const inboxEvents = pgTable(
  'inbox_events',
  {
    id: text('id').primaryKey(),
    event: jsonb('event').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    deliveries: integer('deliveries').notNull().default(0),
    // 再 put は `nextval` で取り直す（fs / in-memory と同じく末尾へ）。null は migrate が振る前の行で、並びでは最後に来る。
    seq: bigint('seq', { mode: 'number' }).default(sql`nextval('inbox_events_seq_seq')`),
  },
  (table) => [index('inbox_events_at_idx').on(table.at)],
);

export const archive = pgTable('archive', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
  // `not null` を外さず、消すときは空文字を入れる。「消された」は `removedAt` だけで判定する: 空の生ログは正当にありうる。
  body: text('body').notNull(),
  removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
  removedBytes: integer('removed_bytes'),
  // 指紋は `stripNulls` 後の `body` に対して取る: ストアに実際に入る値を表すため。fs / インメモリは
  // `stripNulls` をしないので NUL を含む本文では判定が揃わない可能性がある（`archive-continuity.ts`）。
  // すべて nullable: 欠落は `classifyArchiveContinuity` が `'unknown'` へ落とす。
  bodyChars: integer('body_chars'),
  bodyMd5: text('body_md5'),
  continuity: text('continuity'),
});

export const daemonState = pgTable('daemon_state', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// 消さない: 巻き戻した旧デーモンがここを読むので、消すと環境が黙って痩せる。新版は書かない（`clear()` だけは空にする）。
export const envProfile = pgTable('env_profile', {
  id: text('id').primaryKey(),
  script: text('script').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// 行を持たせる: 本文の中のシェル分岐では効かせ分けられない（app と runner の違いが本文から見えず、同じ本文が両方へ降りる）。
// `scope` は確認・許可の話ではなくプロセストポロジーの表現（`packages/core/src/store.ts` の `EnvProfileEntry`）。
// runner から読ませない: runner へはデーモンが制御面で降ろす。
export const envProfileEntries = pgTable('env_profile_entries', {
  name: text('name').primaryKey(),
  script: text('script').notNull(),
  scope: text('scope').notNull().default('all'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

// 行を増やす形にしない: 登録は1つの文書として全文置換され、名前ごとの効かせ分けは持たない。runner から読ませない。
export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  servers: jsonb('servers').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const codexChatgptAuth = pgTable('codex_chatgpt_auth', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  revision: text('revision').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  email: text('email'),
  planType: text('plan_type'),
  failureAt: timestamp('failure_at', { withTimezone: true, mode: 'date' }),
  failureReason: text('failure_reason'),
});

export const managerCredentials = pgTable('manager_credentials', {
  name: text('name').primaryKey(),
  // 値は平文で持つ（`agent_tokens.value` と同じ扱い）。外へ出るのは指紋だけ。
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  // 既定は過去を捏造しない: この列が無かった頃の全行は両方へ撒かれ、値を返さない挙動だった。
  scope: text('scope').notNull().default('all'),
  secret: boolean('secret').notNull().default(true),
});

export const sessionEntries = pgTable(
  'session_entries',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    projectKey: text('project_key').notNull(),
    sessionId: text('session_id').notNull(),
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
    // `uuid` を持つ行だけ冪等キーにする: SDK が再送・再取り込みしうる。持たない行（タイトル・タグ等）はそのまま積む。
    uniqueIndex('session_entries_uuid_idx')
      .on(table.projectKey, table.sessionId, table.subpath, table.uuid)
      .where(sql`uuid is not null`),
  ],
);

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

// マルチユーザーのための表ではない（PRD 非ゴール）: 許可された行が複数在っても、`account_id` で記憶や日誌を引く列は足さない。
// 行為ごとのスコープ列を置かない: 「確認が要る行為の一覧」に化け、PRD「権限境界」と衝突する。
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name'),
    // 検証済みのものだけが入る（不変条件）。
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }),
    grantedBy: text('granted_by'),
    // 資格の判断には使わない（ログインできる人＝持ち主）。列は当面残す。
    ownerDeclaredAt: timestamp('owner_declared_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // `migrate` が無条件には作らない: 既存の重複行（大小文字だけが違う2行）が在ると作成が落ち、
    // `STATEMENTS` に置くとデーモンが上がらなくなる。`ensureAuthAccountsEmailLowerIndex` が数えてから作るので、
    // 在る DB と無い DB の両方がありうる。旧索引 `auth_accounts_email_idx` と `auth_accounts_single_owner_idx` は
    // `migrate.ts` で create を消し、drop だけ残す。
    uniqueIndex('auth_accounts_email_lower_idx').on(sql`lower(${table.email})`),
  ],
);

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

// 素の値は入れない（sha256 だけ）: 漏れた保管先から復元できてはいけない。
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

// 素の値は入れない（sha256 だけ）。許可の一覧（scopes）の列を置かない: 鍵は「固定の1 source で外部イベントを送る」1つの能力だけを表す。
export const integrationKeys = pgTable(
  'integration_keys',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    source: text('source').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdBy: text('created_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    maxBodyBytes: integer('max_body_bytes'),
    ratePerMinute: integer('rate_per_minute'),
  },
  (table) => [uniqueIndex('integration_keys_sha256_idx').on(table.sha256)],
);

// `POST /events` の重複キーの記録（`event-idempotency.ts`）。受信箱の行は処理後に消えるので別の表に持つ。
// 一意索引が「同じ送り手・同じ source・同じキー」の並行する2本のうち1本だけを通す。
export const eventIdempotencyKeys = pgTable(
  'event_idempotency_keys',
  {
    sender: text('sender').notNull(),
    source: text('source').notNull(),
    key: text('key').notNull(),
    eventId: text('event_id').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('event_idempotency_keys_scope_idx').on(table.sender, table.source, table.key),
    index('event_idempotency_keys_at_idx').on(table.at),
  ],
);

export const usageDaily = pgTable(
  'usage_daily',
  {
    date: text('date').notNull(),
    managerId: text('manager_id').notNull(),
    model: text('model').notNull(),
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
    // 既定 `manager` は観測ではない: どこからが観測かは `usage_ledger.layered_at` が持つ。
    layer: text('layer').notNull().default('manager'),
    site: text('site').notNull().default('session'),
    // null にしない: 一意索引は null を重複と見なさず、帰属の無い行が `on conflict` に当たらずに record のたびに行が挿さる。
    // 空文字は「トークンが無い」の印で、読むときに `undefined` へ戻す（`PgUsageStore` の `#toRow`）。
    // 古い行にとって真になる値は無い: どこからが観測かは `usage_ledger.tokens_at` が持つ。
    tokenId: text('token_id').notNull().default(''),
    // 常に整数として持つ: 出力側は `unreadable` を欄そのものが無い形で返して区別する（`usage.ts` の `#toRow`）。
    unreadableInputTokens: bigint('unreadable_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    unreadableOutputTokens: bigint('unreadable_output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    unreadableCacheReadInputTokens: bigint('unreadable_cache_read_input_tokens', {
      mode: 'number',
    })
      .notNull()
      .default(0),
    unreadableCacheCreationInputTokens: bigint('unreadable_cache_creation_input_tokens', {
      mode: 'number',
    })
      .notNull()
      .default(0),
    unreadableWebSearchRequests: bigint('unreadable_web_search_requests', { mode: 'number' })
      .notNull()
      .default(0),
    unreadableCostUsd: bigint('unreadable_cost_usd', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    // 主キーではなく一意索引で持つ: `drop constraint` + `add primary key` は起動のたびに索引を作り直す（ACCESS EXCLUSIVE）。
    // 全列 not null なので強さは同じで、`on conflict` の推論も受ける。
    // 名前を `usage_daily_key_idx` のままにしない: `create unique index if not exists` は名前だけを見るので、
    // 既にある DB では鍵が古いまま残る。空の DB から作る試験は通り、本番だけが古い鍵で走る（`migrate.ts`）。
    uniqueIndex('usage_daily_token_key_idx').on(
      table.date,
      table.managerId,
      table.model,
      table.layer,
      table.site,
      table.tokenId,
    ),
    // (manager_id, date) は鍵の並びに無く、date を先に決めずに「このマネージャーが期間中いくら使ったか」を引くために足す。
    index('usage_daily_manager_date_idx').on(table.managerId, table.date),
  ],
);

export const usageBaseline = pgTable(
  'usage_baseline',
  {
    managerId: text('manager_id').notNull(),
    // actor の id だけを鍵にしない: 層をまたいで同じ id が来ると別の累積が1つの基準を共有し、差分がまるごと嘘になる。
    layer: text('layer').notNull().default('manager'),
    sessionId: text('session_id'),
    models: jsonb('models').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    resets: integer('resets').notNull().default(0),
    lastResetAt: timestamp('last_reset_at', { withTimezone: true, mode: 'date' }),
    // null は「覚えていない」（この列が入る前の行を含む）。
    byRunner: jsonb('by_runner'),
  },
  // `usage_daily` と同じ理由で一意索引。既定 `'manager'` で既にある基準を同じ主体として引ける:
  // 引けないと「基準が無い」と読まれ、累積の全量が二重計上される。
  (table) => [uniqueIndex('usage_baseline_key_idx').on(table.layer, table.managerId)],
);

// 単一行（`id` は常に `'default'`）。行が無ければ「まだ一度も record していない」で、
// それより前を照会した範囲は「0」ではなく「記録が無い」として扱う（`beforeLedger`）。
export const usageLedger = pgTable('usage_ledger', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  // `started_at` と分けて持つ: 層の軸は台帳より後から入ったので、その間の行の `layer` / `site` は既定値であって観測ではない。
  // 1つにすると、層を足す前の期間が「クローンは使っていなかった」と読める（`aggregate` が `beforeLayers` を返す）。
  layeredAt: timestamp('layered_at', { withTimezone: true, mode: 'date' }),
  // `layered_at` と揃えて入れない: `token_id` が付いた record で初めて入れる。揃えると、トークンを持たない器が
  // 「トークン軸を観測している」と名乗り、`byToken` の `null` の1件が「1本のトークンで全部使った」と読める。
  tokensAt: timestamp('tokens_at', { withTimezone: true, mode: 'date' }),
  // `layered_at` と同じ record では入らないことがある: 増分が空の record は回数を数えない。
  turnsAt: timestamp('turns_at', { withTimezone: true, mode: 'date' }),
});

// `usage_daily` と別テーブルにし、鍵に `model` を持たない: 1回の `record` がモデルごとに `usage_daily` の行を複数書くので、
// 鍵にモデルを含めると合計が「ターン数」ではなく「ターン×モデル数」になる。
export const usageTurns = pgTable(
  'usage_turns',
  {
    date: text('date').notNull(),
    managerId: text('manager_id').notNull(),
    layer: text('layer').notNull(),
    site: text('site').notNull(),
    // `not null default ''` は `usageDaily.tokenId` と同じ理由（null を許すと帰属の無い行が積み上がらない）。
    tokenId: text('token_id').notNull().default(''),
    turns: bigint('turns', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    // 主キーではなく一意索引で持つ（`usage_daily` と同じ判断）。
    uniqueIndex('usage_turns_key_idx').on(
      table.date,
      table.managerId,
      table.layer,
      table.site,
      table.tokenId,
    ),
  ],
);

// 消費の値の列を持たず、`usage_daily` / `usage_turns` の合計に混ぜない: 0 を積むとその層が安いと読める。
// `usage_daily` へ provider 列を足さない: 既存の行を1バイトも変えないため。
export const usageUnmetered = pgTable(
  'usage_unmetered',
  {
    date: text('date').notNull(),
    managerId: text('manager_id').notNull(),
    layer: text('layer').notNull(),
    site: text('site').notNull(),
    provider: text('provider').notNull(),
    // `not null default ''` は `usageDaily.tokenId` と同じ理由。
    tokenId: text('token_id').notNull().default(''),
    turns: bigint('turns', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    // 主キーではなく一意索引で持つ（`usage_turns` と同じ）。
    uniqueIndex('usage_unmetered_key_idx').on(
      table.date,
      table.managerId,
      table.layer,
      table.site,
      table.provider,
      table.tokenId,
    ),
  ],
);

// `order` は SQL の予約語なので、列名は `order_index` に逃がす（JS 側は `AgentToken.order` と揃える）。
// `value` は素の文字列のまま入れる: ここが正本を持つ唯一の場所で、外へ出す顔は上の層が作る。
export const agentTokens = pgTable('agent_tokens', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  // `source = 'env'` の行は持たないので null を許す。
  value: text('value'),
  // null は `stored`（後から足した列なので既存の行は null）。
  source: text('source'),
  order: integer('order_index').notNull(),
  disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
  cooldownUntil: bigint('cooldown_until', { mode: 'number' }),
  // null を `default` と読まず、DB の既定値も付けない: 既存の行は「推測だった」ではなく「言えなかった」。
  cooldownSource: text('cooldown_source'),
  lastRejectedAt: timestamp('last_rejected_at', { withTimezone: true, mode: 'date' }),
  lastRejectedReason: text('last_rejected_reason'),
  // `cooldownUntil`（戻る）とも `disabledAt`（人間が外した。戻らない）とも違う3つ目の状態。
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true, mode: 'date' }),
  // 解釈しない文字列: SDK やプローブが返した語をそのまま持つ。
  invalidatedReason: text('invalidated_reason'),
  // どちらも null を許し、`default now()` で埋め直さない: 埋めると「いま作られた」という嘘になる。
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
});

// `agent_tokens` に `active` の列を置かない: 2行が同時に現役だと主張する形が作れる。
// `agent_token_settings` にも混ぜない: あちらの `updated_at` は「人間かクローンが設定を変えた時刻」で、回し手の書き込みを混ぜると意味が壊れる。
export const agentTokenActive = pgTable('agent_token_active', {
  id: text('id').primaryKey(),
  tokenId: text('token_id').notNull(),
  generation: bigint('generation', { mode: 'number' }).notNull(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

// 用途ごとに行を増やせるようにしない: 増やせる形にすると「どの行がどの層に効くか」の対応表が要るようになる。
export const agentTokenSettings = pgTable('agent_token_settings', {
  id: text('id').primaryKey(),
  rotateOn: text('rotate_on').notNull(),
  cooldownMs: bigint('cooldown_ms', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
});

export const authLoginRequests = pgTable(
  'auth_login_requests',
  {
    id: text('id').primaryKey(),
    request: jsonb('request').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('auth_login_requests_expires_idx').on(table.expiresAt)],
);

// 本文以外を列に切る: 一覧が返す `PracticeMeta` は本文を含まず、jsonb 1列だと一覧の1行のために全文を運ぶことになる。
// 「実行される」欄を足さない（`practiceSchema`）: 器が持つのは「こう書いてある」までで、「こう実行せよ」ではない。
export const practices = pgTable('practices', {
  slug: text('slug').primaryKey(),
  // 自由文字列（列挙にしない理由は `practiceKindSchema`）。
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  // 文字数の列を持たない: `char_length(content)` で都度導出する（保存しない理由は `packages/core/src/schema.ts` の `practiceMetaSchema`）。
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

// `practices` の行が消えても版は消さない（`PgPracticeStore.remove` は `practices` の `delete` だけ。`clear` でだけ一緒に空にする）。
// `version` を `serial` にしない: 番号は slug ごとに独立した1始まりの連番で、グローバルな連番だと slug をまたいで飛ぶ。
// `PgPracticeStore.write` が `max(version) + 1` を入れる。
export const practiceVersions = pgTable(
  'practice_versions',
  {
    slug: text('slug').notNull(),
    version: integer('version').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.slug, table.version] })],
);

// `readThrough` は戻らない（`greatest` の upsert）。
export const conversationRead = pgTable('conversation_read', {
  conversationId: text('conversation_id').primaryKey(),
  readThrough: timestamp('read_through', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

// 一度決まったら変えない（`on conflict do nothing`）。
export const conversationReadBaseline = pgTable('conversation_read_baseline', {
  id: text('id').primaryKey(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
  scannedThrough: timestamp('scanned_through', { withTimezone: true, mode: 'date' }),
});

export const conversationOutboundLatest = pgTable('conversation_outbound_latest', {
  conversationId: text('conversation_id').primaryKey(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// `getMeta` と `prune` は `bytes` を読まない: 控えだけの問い合わせが大きな列を引かないため。
export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    sha256: text('sha256').notNull(),
    mediaType: text('media_type').notNull(),
    name: text('name').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    // 中身の置き場は `bytes`（pg の bytea）か `blob_key`（外部ストレージ）のどちらか一方だけ。
    bytes: bytea('bytes'),
    blobKey: text('blob_key'),
    conversationId: text('conversation_id'),
    externalEventId: text('external_event_id'),
    managerReportId: text('manager_report_id'),
    uploadedBy: text('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    // 保存中（`keptAt` あり）は null（期限なし）。
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    keptAt: timestamp('kept_at', { withTimezone: true, mode: 'date' }),
    // 在るものには未結び付け1時間の掃除を掛けない。
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('attachments_expires_at_idx').on(table.expiresAt),
    index('attachments_created_at_idx').on(table.createdAt),
    check(
      'attachments_content_place_chk',
      sql`(${table.bytes} is null) <> (${table.blobKey} is null)`,
    ),
  ],
);

// 本体のファイルは `plugin_files`（bytea）に分ける: jsonb は NUL を持てず、base64 にすると3分の1ふくらみ、
// 1つの値の上限（256MB）に本体の合計が縛られる。`file_count` / `total_bytes` は `list()` が `plugin_files` を引かないための派生列。
export const plugins = pgTable('plugins', {
  name: text('name').primaryKey(),
  description: text('description'),
  source: jsonb('source').notNull(),
  scope: text('scope').notNull().default('all'),
  enableHooks: boolean('enable_hooks').notNull().default(false),
  enableMcp: boolean('enable_mcp').notNull().default(false),
  contentSha256: text('content_sha256').notNull(),
  fileCount: integer('file_count').notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true, mode: 'date' }).notNull(),
  installedBy: text('installed_by').notNull(),
});

export const pluginFiles = pgTable(
  'plugin_files',
  {
    pluginName: text('plugin_name')
      .notNull()
      .references(() => plugins.name, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    executable: boolean('executable').notNull(),
    content: bytea('content').notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginName, table.path] })],
);
