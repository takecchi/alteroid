import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
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
