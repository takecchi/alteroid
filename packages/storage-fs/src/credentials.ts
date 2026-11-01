import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  assertValidCredentialEntries,
  assertValidCredentialNames,
  CREDENTIAL_NAME,
  type CredentialEntry,
  type StoredCredential,
  compareCodeUnits,
  extractRowField,
} from '@alteroid/core';
import type { CredentialVaultStore } from '@alteroid/core';
import { z } from 'zod';

import { readTextIfExists, writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';
import { partitionRows } from './partition-rows.js';

const rowSchema = z.object({
  // 読むときにも形を検査する: ファイルは手で書き換えられ、`../../x` のような名前がそのまま runner へ降りて器の外を指すため
  name: z.string().regex(CREDENTIAL_NAME),
  value: z.string(),
  updatedAt: z.string(),
  scope: z.enum(['all', 'app', 'runner']).default('all'),
  secret: z.boolean().default(true),
});

// 行の中身はここで検査しない: `z.array(rowSchema)` にすると、1行の不正が配列全体を道連れにするため
const topLevelSchema = z.object({
  credentials: z.array(z.unknown()).default([]),
  // 名前の形の検査は `#read` で行う: 1つの不正が配列全体を道連れにしないため
  pendingRemovals: z.array(z.unknown()).default([]),
});

interface CredentialFile {
  credentials: StoredCredential[];
  // 消さずに持ち回る: 書き戻しに入れないと、人間が手で書いた不正な行が黙って消えるため
  invalidRaw: unknown[];
  // 行と同じファイルに置く: 同じ lock・同じアトミックな書き込みで、`put` の書き戻しに消されない
  pendingRemovals: string[];
}

const EMPTY: CredentialFile = { credentials: [], invalidRaw: [], pendingRemovals: [] };

// `memory/` には置かない: 鍵そのものを持つ場所で、人間が手で書き換える前提ではないため
export class FsCredentialVaultStore implements CredentialVaultStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#dir = dirname(path);
  }

  async list(): Promise<StoredCredential[]> {
    const file = await this.#read();
    return [...file.credentials].sort((a, b) => compareCodeUnits(a.name, b.name));
  }

  async put(entries: readonly CredentialEntry[]): Promise<StoredCredential[]> {
    assertValidCredentialEntries(entries);
    const at = new Date().toISOString();
    const written = await this.#update((file) => {
      const rows = new Map(file.credentials.map((row) => [row.name, row]));
      for (const entry of entries) {
        // 空文字は「外す」: `CredentialStore#set` と同じ約束にしないと、指紋を見ても理由が分からない食い違いになるため
        if (entry.value.length === 0) {
          rows.delete(entry.name);
          continue;
        }
        // 既定値の補完はここでしない: 呼び手が scope・secret を解決して渡し、1か所で決めるため
        rows.set(entry.name, {
          name: entry.name,
          value: entry.value,
          updatedAt: at,
          scope: entry.scope ?? 'all',
          secret: entry.secret ?? true,
        });
      }
      // 書き込む名前と一致する不正な行は外す: 残すと同じ名前の行が2つ並び、直したはずの跡が `list()` のたびに出続けるため
      const writtenNames = new Set(entries.map((entry) => entry.name));
      const invalidRaw = file.invalidRaw.filter((raw) => {
        const name = extractRowField(raw, 'name');
        return name === undefined || !writtenNames.has(name);
      });
      return { ...file, credentials: [...rows.values()], invalidRaw };
    });
    return [...written.credentials].sort((a, b) => compareCodeUnits(a.name, b.name));
  }

  async listPendingRemovals(): Promise<string[]> {
    const file = await this.#read();
    return [...file.pendingRemovals].sort(compareCodeUnits);
  }

  async updatePendingRemovals(change: {
    add: readonly string[];
    forget: readonly string[];
  }): Promise<void> {
    assertValidCredentialNames([...change.add, ...change.forget]);
    await this.#update((file) => {
      const names = new Set(file.pendingRemovals);
      for (const name of change.add) names.add(name);
      for (const name of change.forget) names.delete(name);
      return { ...file, pendingRemovals: [...names] };
    });
  }

  async #read(): Promise<CredentialFile> {
    const raw = await readTextIfExists(this.#path);
    if (raw === undefined) return EMPTY;
    const top = topLevelSchema.parse(JSON.parse(raw));
    // `value` は載せない: 名前（`name`）だけを出す
    const { valid: credentials, invalid: invalidRaw } = partitionRows(
      top.credentials,
      rowSchema,
      'credentials',
      'name',
    );
    // 形に合わない名前は読み飛ばす: ファイルは手で書き換えられ、`../../x` のような名前を runner への外す合図に載せないため
    const pendingRemovals = top.pendingRemovals.filter(
      (name): name is string => typeof name === 'string' && CREDENTIAL_NAME.test(name),
    );
    return { credentials, invalidRaw, pendingRemovals };
  }

  // 書き込んだ `CredentialFile` を返す: `put()` が書き込み直後に `#read()` し直すと、読み飛ばしの跡が二重に出るため
  async #update(mutate: (file: CredentialFile) => CredentialFile): Promise<CredentialFile> {
    return withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // 不正な行も一緒に書き戻す: 入れないと、人間が手で書いた不正な行が次の書き込みで黙って消えるため
      const serialized = {
        credentials: [...next.credentials, ...next.invalidRaw],
        pendingRemovals: next.pendingRemovals,
      };
      // rename 後に絞らず、一時ファイルを 0600 で作る: 隙間で他人が読めるため
      await writeFileAtomic(this.#path, `${JSON.stringify(serialized, null, 2)}\n`, {
        mode: 0o600,
      });
      return next;
    });
  }
}
