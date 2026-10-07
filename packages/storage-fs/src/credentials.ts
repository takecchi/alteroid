import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  assertValidCredentialEntries,
  CREDENTIAL_NAME,
  describeSkippedCredentialRow,
  type CredentialEntry,
  type StoredCredential,
  compareCodeUnits,
} from '@alteroid/core';
import type { CredentialVaultStore } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

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
  seeded: z.array(z.string()).default([]),
});

interface CredentialFile {
  credentials: StoredCredential[];
  // 消さずに持ち回る: 書き戻しに入れないと、人間が手で書いた不正な行が黙って消えるため
  invalidRaw: unknown[];
  seeded: string[];
}

const EMPTY: CredentialFile = { credentials: [], invalidRaw: [], seeded: [] };

// `issue.message` は使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わると値が漏れるため
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function extractRowName(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const name = (raw as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

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
        const name = extractRowName(raw);
        return name === undefined || !writtenNames.has(name);
      });
      return { credentials: [...rows.values()], invalidRaw, seeded: file.seeded };
    });
    return [...written.credentials].sort((a, b) => compareCodeUnits(a.name, b.name));
  }

  async seedOnce(marker: string, entries: readonly CredentialEntry[]): Promise<string[]> {
    assertValidCredentialEntries(entries);
    const at = new Date().toISOString();
    const written: string[] = [];
    await this.#update((file) => {
      if (file.seeded.includes(marker)) return file;
      const rows = new Map(file.credentials.map((row) => [row.name, row]));
      // 同じ名前の壊れた行は上書きしない: 人間の手が入っている行のため
      const invalidNames = new Set(file.invalidRaw.map((raw) => extractRowName(raw)));
      for (const entry of entries) {
        if (entry.value.length === 0 || rows.has(entry.name) || invalidNames.has(entry.name)) {
          continue;
        }
        rows.set(entry.name, {
          name: entry.name,
          value: entry.value,
          updatedAt: at,
          scope: entry.scope ?? 'all',
          secret: entry.secret ?? true,
        });
        written.push(entry.name);
      }
      return {
        credentials: [...rows.values()],
        invalidRaw: file.invalidRaw,
        seeded: [...file.seeded, marker],
      };
    });
    return written;
  }

  async #read(): Promise<CredentialFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = topLevelSchema.parse(JSON.parse(raw));
      const credentials: StoredCredential[] = [];
      const invalidRaw: unknown[] = [];
      top.credentials.forEach((rawRow, index) => {
        const result = rowSchema.safeParse(rawRow);
        if (result.success) {
          credentials.push(result.data);
          return;
        }
        invalidRaw.push(rawRow);
        process.stderr.write(
          `${describeSkippedCredentialRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            name: extractRowName(rawRow),
          })}\n`,
        );
      });
      return { credentials, invalidRaw, seeded: top.seeded };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  // 書き込んだ `CredentialFile` を返す: `put()` が書き込み直後に `#read()` し直すと、読み飛ばしの跡が二重に出るため
  async #update(mutate: (file: CredentialFile) => CredentialFile): Promise<CredentialFile> {
    return withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // 不正な行も一緒に書き戻す: 入れないと、人間が手で書いた不正な行が次の書き込みで黙って消えるため
      const serialized: { credentials: unknown[]; seeded?: string[] } = {
        credentials: [...next.credentials, ...next.invalidRaw],
        // 印が1つも無いファイルには欄を足さない: 既存のファイルの形を変えないため
        ...(next.seeded.length > 0 ? { seeded: next.seeded } : {}),
      };
      // rename 後に絞らず、一時ファイルを 0600 で作る: 隙間で他人が読めるため
      await writeFileAtomic(this.#path, `${JSON.stringify(serialized, null, 2)}\n`, {
        mode: 0o600,
      });
      return next;
    });
  }
}
