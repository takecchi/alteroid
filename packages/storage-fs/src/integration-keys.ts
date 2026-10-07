import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  compareIntegrationKeyOrder,
  hasNul,
  integrationKeyRecordSchema,
  prepareIntegrationKeyForWrite,
} from '@alteroid/core';
import type {
  IntegrationKeyRecord,
  IntegrationKeyStore,
  RemoveUnreadableRowsOptions,
  RemoveUnreadableRowsResult,
  RevokeIntegrationKeyOutcome,
  UnreadableIntegrationKey,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const fileSchema = z.object({ keys: z.array(z.unknown()).default([]) });

interface KeyFile {
  keys: IntegrationKeyRecord[];
  // 消さずに持ち回る: 次の書き込みで黙って消えないように
  invalidRaw: unknown[];
}

// `issue.message` は使わない: zod の既定メッセージが将来 `received` を含む形に変わると値が漏れるため
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function rowIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

export class FsIntegrationKeyStore implements IntegrationKeyStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'integration-keys.json');
  }

  async putIntegrationKey(key: IntegrationKeyRecord): Promise<void> {
    const parsed = prepareIntegrationKeyForWrite(integrationKeyRecordSchema.parse(key));
    await this.#mutate<null>((file) => {
      if (file.keys.some((row) => row.id === parsed.id)) {
        throw new Error('integration key: 同じ id が既に在る');
      }
      if (file.keys.some((row) => row.sha256 === parsed.sha256)) {
        throw new Error('integration key: 同じ値の鍵が既に在る');
      }
      return { next: { ...file, keys: [...file.keys, parsed] }, result: null };
    });
  }

  async findIntegrationKeyBySha256(sha256: string): Promise<IntegrationKeyRecord | null> {
    if (hasNul(sha256)) return null;
    const { keys } = await this.#read();
    return keys.find((row) => row.sha256 === sha256) ?? null;
  }

  async getIntegrationKey(id: string): Promise<IntegrationKeyRecord | null> {
    if (hasNul(id)) return null;
    const { keys } = await this.#read();
    return keys.find((row) => row.id === id) ?? null;
  }

  async listIntegrationKeys(): Promise<IntegrationKeyRecord[]> {
    const { keys } = await this.#read();
    return [...keys].sort(compareIntegrationKeyOrder);
  }

  async listUnreadableIntegrationKeys(): Promise<UnreadableIntegrationKey[]> {
    const { invalidRaw } = await this.#read();
    return invalidRaw.map((raw): UnreadableIntegrationKey => {
      const id = rowIdOf(raw);
      const result = integrationKeyRecordSchema.safeParse(raw);
      return {
        ...(id === undefined ? {} : { id }),
        reason: result.success ? '不正な行' : summarizeInvalidFields(result.error.issues),
      };
    });
  }

  async removeUnreadableIntegrationKeys(
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions = {},
  ): Promise<RemoveUnreadableRowsResult> {
    const wanted = [...new Set(ids)];
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const present = new Set(file.invalidRaw.flatMap((raw) => rowIdOf(raw) ?? []));
      const unknown = wanted.filter((id) => !present.has(id));
      if (unknown.length > 0 || wanted.length === 0) {
        return { kind: 'unknown' as const, count: unknown.length };
      }
      // 日誌などを先に呼ぶ: 投げたらここで止まり、何も書かないため
      await options.beforeRemove?.(wanted);
      const drop = new Set(wanted);
      await mkdir(this.#dir, { recursive: true });
      const body = {
        keys: [
          ...file.keys,
          ...file.invalidRaw.filter((raw) => {
            const id = rowIdOf(raw);
            return id === undefined || !drop.has(id);
          }),
        ],
      };
      await writeFileAtomic(this.#path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      return { kind: 'removed' as const, ids: wanted };
    });
  }

  async markIntegrationKeyUsed(id: string, at: string): Promise<void> {
    if (hasNul(id)) return;
    await this.#mutate<null>((file) => {
      const row = file.keys.find((it) => it.id === id);
      if (row === undefined || row.revokedAt !== null) return { next: null, result: null };
      const used = integrationKeyRecordSchema.parse({ ...row, lastUsedAt: at });
      return {
        next: { ...file, keys: file.keys.map((it) => (it.id === id ? used : it)) },
        result: null,
      };
    });
  }

  async revokeIntegrationKey(id: string, at: string): Promise<RevokeIntegrationKeyOutcome> {
    if (hasNul(id)) return { status: 'not_found' };
    return this.#mutate<RevokeIntegrationKeyOutcome>((file) => {
      const row = file.keys.find((it) => it.id === id);
      if (row === undefined) return { next: null, result: { status: 'not_found' as const } };
      if (row.revokedAt !== null) {
        return { next: null, result: { status: 'already_revoked' as const, key: row } };
      }
      const revoked = integrationKeyRecordSchema.parse({ ...row, revokedAt: at });
      return {
        next: { ...file, keys: file.keys.map((it) => (it.id === id ? revoked : it)) },
        result: { status: 'revoked' as const, key: revoked },
      };
    });
  }

  async #read(): Promise<KeyFile> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { keys: [], invalidRaw: [] };
      throw error;
    }
    const top = fileSchema.parse(JSON.parse(text));
    const keys: IntegrationKeyRecord[] = [];
    const invalidRaw: unknown[] = [];
    top.keys.forEach((raw, index) => {
      const result = integrationKeyRecordSchema.safeParse(raw);
      if (result.success) {
        keys.push(result.data);
        return;
      }
      invalidRaw.push(raw);
      const fields = [...new Set(result.error.issues.map((it) => String(it.path[0] ?? '(root)')))];
      const id = rowIdOf(raw);
      process.stderr.write(
        `alteroid: integration-keys の不正な行を読み飛ばしました（${index + 1} 行目、不正な欄: ${fields.join(',')}）` +
          `${id === undefined ? '' : ` id=${JSON.stringify(id)}`}\n`,
      );
    });
    return { keys, invalidRaw };
  }

  async #mutate<T>(mutate: (file: KeyFile) => { next: KeyFile | null; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      if (next === null) return result;
      await mkdir(this.#dir, { recursive: true });
      const body = { keys: [...next.keys, ...next.invalidRaw] };
      await writeFileAtomic(this.#path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      return result;
    });
  }
}
