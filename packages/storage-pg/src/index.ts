import { collapseErrorCause } from '@alteroid/core';
import type { Stores } from '@alteroid/core';
import { drizzle } from 'drizzle-orm/node-postgres';

import { PgTranscriptArchive } from './archive.js';
import { PgAttachmentStore, type PgAttachmentStoreOptions } from './attachments.js';
import { PgAuthStore } from './auth.js';
import { PgEventReceiptStore } from './event-receipts.js';
import { PgIntegrationKeyStore } from './integration-keys.js';
import { PgCommitmentStore } from './commitments.js';
import { PgPracticeStore } from './practices.js';
import type { Db } from './db.js';
import { PgInboxStore } from './inbox.js';
import { PgConversationReadStore } from './conversation-reads.js';
import { PgJobStore } from './jobs.js';
import { PgJournalStore } from './journal.js';
import { PgMcpServerStore } from './mcp-servers.js';
import { migrate } from './migrate.js';
import {
  createTimedPool,
  PG_LONG_QUERY_TIMEOUT_MS,
  type PgTimeoutEvent,
  withPgQueryTimeout,
} from './pg-timeouts.js';
import { PgPersonaStore } from './persona.js';
import { PgPermissionGrantStore } from './permission-grants.js';
import { PgCodexChatgptAuthStore } from './codex-auth.js';
import { PgCredentialVaultStore } from './credentials.js';
import { PgPluginStore } from './plugins.js';
import { PgProfileStore } from './profile.js';
import { PgScheduleStore } from './schedules.js';
import { PgSessionRegistry } from './sessions.js';
import { PgSessionStore } from './session-store.js';
import { PgTokenPoolStore } from './token-pool.js';
import { PgUsageStore } from './usage.js';

export { PgTranscriptArchive } from './archive.js';
export { PgAttachmentStore, type PgAttachmentStoreOptions } from './attachments.js';
export { S3AttachmentBlobStore } from './attachment-blobs-s3.js';
export { PgAuthStore } from './auth.js';
export { PgEventReceiptStore } from './event-receipts.js';
export { PgIntegrationKeyStore } from './integration-keys.js';
export { PgCommitmentStore } from './commitments.js';
export { PgPracticeStore } from './practices.js';
export { PgInboxStore } from './inbox.js';
export { PgConversationReadStore } from './conversation-reads.js';
export { PgJobStore } from './jobs.js';
export { PgJournalStore } from './journal.js';
export {
  PG_CONNECT_TIMEOUT_MS,
  PG_LONG_QUERY_TIMEOUT_MS,
  PG_QUERY_TIMEOUT_MS,
  PgTimeoutError,
  type PgTimeoutEvent,
  withPgQueryTimeout,
} from './pg-timeouts.js';
export { PgMcpServerStore } from './mcp-servers.js';
export { PgPersonaStore } from './persona.js';
export { PgPermissionGrantStore } from './permission-grants.js';
export { PgCredentialVaultStore } from './credentials.js';
export { PgPluginStore } from './plugins.js';
export { PgProfileStore } from './profile.js';
export { PgScheduleStore } from './schedules.js';
export { PgSessionRegistry } from './sessions.js';
export { PgSessionStore } from './session-store.js';
export { PgTokenPoolStore } from './token-pool.js';
export { PgUsageStore } from './usage.js';
export * from './footprint.js';
export { migrate } from './migrate.js';
export type { Db } from './db.js';
export * as tables from './schema.js';

/**
 * 接続情報はデーモンプロセスだけが持つ。マネージャー子プロセスの環境変数には渡さない:
 * 上向きの不可視を認証情報の配布範囲で守るため（docs/architecture.md「非対称な可視性」）。
 */
export interface PgStores extends Stores {
  sessionStore: PgSessionStore;
  db: Db;
  close(): Promise<void>;
}

export interface CreatePgStoresOptions {
  url: string;
  max?: number;
  attachments?: PgAttachmentStoreOptions;
  /**
   * 握り潰さない: Pool は idle 接続のエラーを `error` として投げ、受け手が居ないと
   * Node ごと落ちる。記憶の器の瞬断でデーモンと走行中のマネージャーを殺さないため。
   */
  onError?: (error: Error) => void;
  /** 問い合わせ・接続を期限で打ち切ったときに呼ぶ（#4655）。日誌へ残すのは呼び手の仕事。 */
  onTimeout?: (event: PgTimeoutEvent) => void;
}

// `error.message` だけにしない: SQLSTATE 等の識別子が落ちる。`collapseErrorCause` を通す。
export function describePgConnectionError(error: Error): string {
  return `alteroid: PostgreSQL の接続でエラー: ${collapseErrorCause(error)}\n`;
}

/**
 * 正当に 30 秒（{@link PG_QUERY_TIMEOUT_MS}）を超えうる口。ここに載せた口の中の問い合わせだけ、期限を {@link PG_LONG_QUERY_TIMEOUT_MS} へ延ばす（#4655）。
 * 載っていない口は既定の期限で打ち切る。載せる基準: 大きい本文（退避・生ログ・添付・plugin）を運ぶ、件数で締めずに表を走査しうる、全件を消す。
 */
const LONG_QUERY_METHODS = {
  journal: ['list', 'listPage', 'clear'],
  archive: ['archive', 'read', 'readTail', 'remove', 'clear'],
  sessionStore: ['load', 'append', 'readTail', 'delete', 'clearAll'],
  attachments: ['put', 'open', 'get', 'prune', 'clear'],
  plugins: ['get', 'put'],
  commitments: ['list', 'removeForConversation', 'clear'],
  inbox: ['claimPending', 'pending', 'peekPending', 'clear'],
  jobs: ['listJobs', 'clear'],
} as const;

// 器の上の口を包み直す: 口の中から同じ器の別の口を呼んでも（`list` → `listPage`）、他の器が持つ参照から呼んでも（記憶 → 日誌）、同じく延びるため
function extendLongQueries<T extends object>(store: T, names: readonly string[]): T {
  const methods = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of names) {
    const original = methods[name];
    if (typeof original !== 'function') {
      throw new Error(`長い期限で包む口 ${name} が器に無い（LONG_QUERY_METHODS を直すこと）`);
    }
    const bound = original.bind(store);
    methods[name] = (...args: unknown[]) =>
      withPgQueryTimeout(PG_LONG_QUERY_TIMEOUT_MS, async () => bound(...args));
  }
  return store;
}

export function createPgStoresFromDb(
  db: Db,
  close?: () => Promise<void>,
  attachmentOptions?: PgAttachmentStoreOptions,
): PgStores {
  const journal = extendLongQueries(new PgJournalStore(db), LONG_QUERY_METHODS.journal);
  // 預けた先と読む先（`sessionStore` / `sessionTranscriptTail`）は同じ器を渡す: 片方だけ差し替えると食い違い、型では落ちない
  const sessionStore = extendLongQueries(new PgSessionStore(db), LONG_QUERY_METHODS.sessionStore);
  return {
    db,
    persona: new PgPersonaStore(db, journal),
    journal,
    jobs: extendLongQueries(new PgJobStore(db), LONG_QUERY_METHODS.jobs),
    schedules: new PgScheduleStore(db),
    commitments: extendLongQueries(new PgCommitmentStore(db), LONG_QUERY_METHODS.commitments),
    practices: new PgPracticeStore(db),
    inbox: extendLongQueries(new PgInboxStore(db), LONG_QUERY_METHODS.inbox),
    archive: extendLongQueries(new PgTranscriptArchive(db), LONG_QUERY_METHODS.archive),
    sessions: new PgSessionRegistry(db),
    auth: new PgAuthStore(db),
    integrationKeys: new PgIntegrationKeyStore(db),
    eventReceipts: new PgEventReceiptStore(db),
    permissionGrants: new PgPermissionGrantStore(db),
    profile: new PgProfileStore(db),
    credentials: new PgCredentialVaultStore(db),
    mcpServers: new PgMcpServerStore(db),
    plugins: extendLongQueries(new PgPluginStore(db), LONG_QUERY_METHODS.plugins),
    conversationReads: new PgConversationReadStore(db),
    codexAuth: new PgCodexChatgptAuthStore(db),
    tokens: new PgTokenPoolStore(db),
    usage: new PgUsageStore(db),
    attachments: extendLongQueries(
      new PgAttachmentStore(db, attachmentOptions),
      LONG_QUERY_METHODS.attachments,
    ),
    sessionStore,
    sessionTranscriptTail: sessionStore,
    close: close ?? (async () => undefined),
  };
}

// マイグレーションをここで通す: `docker compose up` だけで上がるようにするため（人間の手順を足さない）。
export async function createPgStores(options: CreatePgStoresOptions | string): Promise<PgStores> {
  const config = typeof options === 'string' ? { url: options } : options;
  const pool = createTimedPool({
    connectionString: config.url,
    ...(config.max === undefined ? {} : { max: config.max }),
    ...(config.onTimeout === undefined ? {} : { onTimeout: config.onTimeout }),
  });

  const onError =
    config.onError ??
    ((error: Error) => {
      process.stderr.write(describePgConnectionError(error));
    });
  pool.on('error', onError);

  const db = drizzle(pool);
  // 長い期限で包む: 大きい表への索引の作成・全行の backfill が起動のたびに通り、既定の期限で切ると器が起き上がらないため
  await withPgQueryTimeout(PG_LONG_QUERY_TIMEOUT_MS, () => migrate(db));
  return createPgStoresFromDb(
    db,
    async () => {
      pool.off('error', onError);
      await pool.end();
    },
    config.attachments,
  );
}

// 「確認が要る行為の一覧」を書かない: 既定の権限境界を置くと、クローンが記憶として持つべき人による違いが潰れる（PRD「権限境界」）。
export async function seedPgWorkspace(stores: Stores): Promise<boolean> {
  const documents = await stores.persona.list();
  if (documents.length > 0) return false;
  await stores.persona.write('about-me', SEED_MEMORY);
  return true;
}

const SEED_MEMORY = `# このクローンについて

<!--
まだ何も書かれていない。alteroid chat で話した内容から、クローンが自分で
ここへ蒸留していく。人間が直接書き換えてもよく（クラウド構成では CLI か
HTTP API 経由）、その場合は次の会話から反映される。

書くとよいこと:
- 何を目指しているか（目的）
- 何を大事にしているか（価値観・好み）
- 何を任せてよくて、何は必ず聞いてほしいか（理由つきで）

「確認が要る行為の一覧」を書く必要はない。クローンは記憶に根拠があるかで判断する。
-->
`;
