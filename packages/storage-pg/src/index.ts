import { collapseErrorCause } from '@alteroid/core';
import type { Stores } from '@alteroid/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

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

// 別々に `new` しない: 片方だけ差し替えると預けた先と読む先が食い違い、型では落ちない。
function sessionStores(db: Db): {
  sessionStore: PgSessionStore;
  sessionTranscriptTail: PgSessionStore;
} {
  const store = new PgSessionStore(db);
  return { sessionStore: store, sessionTranscriptTail: store };
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
}

// `error.message` だけにしない: SQLSTATE 等の識別子が落ちる。`collapseErrorCause` を通す。
export function describePgConnectionError(error: Error): string {
  return `alteroid: PostgreSQL の接続でエラー: ${collapseErrorCause(error)}\n`;
}

export function createPgStoresFromDb(
  db: Db,
  close?: () => Promise<void>,
  attachmentOptions?: PgAttachmentStoreOptions,
): PgStores {
  const journal = new PgJournalStore(db);
  return {
    db,
    persona: new PgPersonaStore(db, journal),
    journal,
    jobs: new PgJobStore(db),
    schedules: new PgScheduleStore(db),
    commitments: new PgCommitmentStore(db),
    practices: new PgPracticeStore(db),
    inbox: new PgInboxStore(db),
    archive: new PgTranscriptArchive(db),
    sessions: new PgSessionRegistry(db),
    auth: new PgAuthStore(db),
    integrationKeys: new PgIntegrationKeyStore(db),
    eventReceipts: new PgEventReceiptStore(db),
    permissionGrants: new PgPermissionGrantStore(db),
    profile: new PgProfileStore(db),
    credentials: new PgCredentialVaultStore(db),
    mcpServers: new PgMcpServerStore(db),
    plugins: new PgPluginStore(db),
    conversationReads: new PgConversationReadStore(db),
    codexAuth: new PgCodexChatgptAuthStore(db),
    tokens: new PgTokenPoolStore(db),
    usage: new PgUsageStore(db),
    attachments: new PgAttachmentStore(db, attachmentOptions),
    ...sessionStores(db),
    close: close ?? (async () => undefined),
  };
}

// マイグレーションをここで通す: `docker compose up` だけで上がるようにするため（人間の手順を足さない）。
export async function createPgStores(options: CreatePgStoresOptions | string): Promise<PgStores> {
  const config = typeof options === 'string' ? { url: options } : options;
  const pool = new Pool({
    connectionString: config.url,
    ...(config.max === undefined ? {} : { max: config.max }),
  });

  const onError =
    config.onError ??
    ((error: Error) => {
      process.stderr.write(describePgConnectionError(error));
    });
  pool.on('error', onError);

  const db = drizzle(pool);
  await migrate(db);
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
