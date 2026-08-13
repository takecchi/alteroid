import type { Stores } from '@alteroid/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { PgTranscriptArchive } from './archive.js';
import { PgAuthStore } from './auth.js';
import type { Db } from './db.js';
import { PgJobStore } from './jobs.js';
import { PgJournalStore } from './journal.js';
import { migrate } from './migrate.js';
import { PgPersonaStore } from './persona.js';
import { PgScheduleStore } from './schedules.js';
import { PgSessionRegistry } from './sessions.js';
import { PgSessionStore } from './session-store.js';

export { PgTranscriptArchive } from './archive.js';
export { PgAuthStore } from './auth.js';
export { PgJobStore } from './jobs.js';
export { PgJournalStore } from './journal.js';
export { PgPersonaStore } from './persona.js';
export { PgScheduleStore } from './schedules.js';
export { PgSessionRegistry } from './sessions.js';
export { PgSessionStore } from './session-store.js';
export { migrate } from './migrate.js';
export type { Db } from './db.js';
export * as tables from './schema.js';

/**
 * @alteroid/storage-pg — クラウド用ストレージドライバ（PostgreSQL / drizzle）。
 *
 * fs ドライバと同じ IF を満たす別の器であって、能力の差を作らない。ローカルで
 * 動いたものがそのままコンテナで動くこと（受け入れ基準1）が M4 の要件である。
 *
 * **この接続情報を持つのはデーモンプロセスだけである。** マネージャー子プロセスの
 * 環境変数には渡さない — 上向きの不可視をツール削除ではなく認証情報の配布範囲で
 * 守るのがこの設計の本命で、その強制がここで初めて構造的に成立する
 * （docs/architecture.md「非対称な可視性」）。
 */
export interface PgStores extends Stores {
  /** SDK のセッション永続化先（クローン・マネージャーの生ログ）。 */
  sessionStore: PgSessionStore;
  db: Db;
  /** 接続を閉じる。デーモンの停止時に呼ぶ。 */
  close(): Promise<void>;
}

export interface CreatePgStoresOptions {
  /** `postgres://user:pass@host:5432/db` */
  url: string;
  /** 接続プールの上限。既定は node-postgres のまま。 */
  max?: number;
  /**
   * 接続の異常を受け取る先。既定は stderr。
   *
   * **握り潰さない。** node-postgres の Pool は idle 接続のエラー（DB 再起動・
   * ネットワーク断）を `error` として投げ、受け手が居ないと Node ごと落ちる。
   * デーモンが落ちれば走行中のマネージャーも巻き添えになる — 常駐は自律の前提
   * なので、記憶の器の瞬断でクローンを殺さない。
   */
  onError?: (error: Error) => void;
}

/** 既存の drizzle ハンドルからストア一式を組む（ドライバを問わない）。 */
export function createPgStoresFromDb(db: Db, close?: () => Promise<void>): PgStores {
  return {
    db,
    persona: new PgPersonaStore(db),
    journal: new PgJournalStore(db),
    jobs: new PgJobStore(db),
    schedules: new PgScheduleStore(db),
    archive: new PgTranscriptArchive(db),
    sessions: new PgSessionRegistry(db),
    auth: new PgAuthStore(db),
    sessionStore: new PgSessionStore(db),
    close: close ?? (async () => undefined),
  };
}

/**
 * 接続してスキーマを用意し、ストア一式を返す。
 *
 * マイグレーションをここで通すのは、`docker compose up` だけで上がることが
 * 受け入れ基準だからである（人間の手順を足さない）。
 */
export async function createPgStores(options: CreatePgStoresOptions | string): Promise<PgStores> {
  const config = typeof options === 'string' ? { url: options } : options;
  const pool = new Pool({
    connectionString: config.url,
    ...(config.max === undefined ? {} : { max: config.max }),
  });

  // idle 接続のエラーを受ける。受けなければ uncaughtException でデーモンごと死ぬ。
  const onError =
    config.onError ??
    ((error: Error) => {
      process.stderr.write(`alteroid: PostgreSQL の接続でエラー: ${error.message}\n`);
    });
  pool.on('error', onError);

  const db = drizzle(pool);
  await migrate(db);
  return createPgStoresFromDb(db, async () => {
    pool.off('error', onError);
    await pool.end();
  });
}

/**
 * 記憶が空なら種の記憶を1枚だけ置く（fs の `initWorkspace` と同じ役割）。
 *
 * ここでも「確認が要る行為の一覧」は書かない。既定の権限境界を置いた瞬間に、
 * 人による違い＝クローンが記憶として持つべきものが潰れる（PRD「権限境界」）。
 */
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
