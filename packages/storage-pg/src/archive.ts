import type { TranscriptArchive } from '@alteroid/core';
import { desc, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { archive } from './schema.js';

/**
 * セッション生ログの退避先（可観測性3層の最下段）。
 *
 * fs 版がファイル名で持っていた識別子を、そのまま主キーとして使う。ジョブ台帳の
 * `archiveIds` は fs / pg のどちらでも同じ形で残るので、manager_id から生ログへ
 * 降りる経路はドライバを替えても切れない。
 */
export class PgTranscriptArchive implements TranscriptArchive {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async archive(sessionId: string, transcript: string): Promise<string> {
    const body = stripNulls(transcript);
    const at = new Date();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const id = `${sanitize(sessionId)}-${stamp}.jsonl`;
    await this.#db
      .insert(archive)
      .values({ id, sessionId, at, body })
      .onConflictDoUpdate({ target: archive.id, set: { body } });
    return id;
  }

  /** 新しい順。 */
  async list(): Promise<string[]> {
    const rows = await this.#db
      .select({ id: archive.id })
      .from(archive)
      .orderBy(desc(archive.at), desc(archive.id));
    return rows.map((row) => row.id);
  }

  async read(id: string): Promise<string | null> {
    const rows = await this.#db
      .select({ body: archive.body })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    return rows[0]?.body ?? null;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
