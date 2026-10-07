import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  compareIsoInstant,
  createUnreadableRowOnce,
  permissionGrantSchema,
  preparePermissionGrantForPut,
  UnreadablePermissionGrantError,
  unreadableRowKey,
} from '@alteroid/core';
import type {
  PermissionGrant,
  PermissionGrantStore,
  RemoveUnreadableRowsOptions,
  RemoveUnreadableRowsResult,
  UnreadablePermissionGrant,
  UnreadableRowOnce,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 行の中身はここで検査しない: `z.array(permissionGrantSchema)` にすると、1行の不正が配列全体を道連れにするため
const fileSchema = z.object({
  grants: z.array(z.unknown()).default([]),
});

interface GrantFile {
  grants: PermissionGrant[];
  // 消さずに持ち回る: 書き戻しに入れないと、次の書き込みで消えるため
  invalidGrantsRaw: unknown[];
}

const EMPTY: GrantFile = { grants: [], invalidGrantsRaw: [] };

// `issue.message` は使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わると値が漏れるため
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

// id 以外の値は載せない: `allows` / `denies` / `answer` には人間の回答の原文がそのまま入りうるため
function describeSkippedGrantRow(params: { index: number; reason: string; id?: string }): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: 許可の記録の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

export class FsPermissionGrantStore implements PermissionGrantStore {
  readonly #dir: string;
  readonly #path: string;

  // 読めなかった行は1回だけ知らせる: `#onPreToolUse` が Bash のたびに `list()` を引き直すので、毎回出すと同じ警告が積み上がるため
  readonly #unreadableOnce: UnreadableRowOnce = createUnreadableRowOnce();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'permission-grants.json');
  }

  async list(): Promise<PermissionGrant[]> {
    // 実時刻で比べる: 文字列比較だとオフセット表記の違う行で、pg の `asc(grantedAt)` と並びが食い違うため
    return [...(await this.#read()).grants].sort((a, b) =>
      compareIsoInstant(a.grantedAt, b.grantedAt),
    );
  }

  async get(id: string): Promise<PermissionGrant | null> {
    const { grants } = await this.#read();
    return grants.find((grant) => grant.id === id) ?? null;
  }

  async put(grant: PermissionGrant): Promise<void> {
    const prepared = preparePermissionGrantForPut(permissionGrantSchema.parse(grant));
    await this.#update((file) => {
      const grants = file.grants.filter((existing) => existing.id !== prepared.id);
      grants.push(prepared);
      // 書き込む id と一致する壊れた行は置き換える: 残すと同じ id が2行並び、`list()` のたびに直したはずの跡が出続けるため
      const invalidGrantsRaw = file.invalidGrantsRaw.filter(
        (raw) => extractRowId(raw) !== prepared.id,
      );
      return { next: { grants, invalidGrantsRaw }, result: undefined };
    });
  }

  async revoke(id: string, at: string): Promise<PermissionGrant | null> {
    return this.#update((file) => {
      const found = file.grants.find((grant) => grant.id === id);
      if (found === undefined) {
        if (file.invalidGrantsRaw.some((raw) => extractRowId(raw) === id)) {
          throw new UnreadablePermissionGrantError({ id });
        }
        return { next: file, result: null };
      }
      const next = permissionGrantSchema.parse({ ...found, revokedAt: found.revokedAt ?? at });
      return {
        next: {
          grants: file.grants.map((grant) => (grant.id === id ? next : grant)),
          invalidGrantsRaw: file.invalidGrantsRaw,
        },
        result: next,
      };
    });
  }

  async markUsed(id: string, at: string): Promise<boolean> {
    return this.#update((file) => {
      const found = file.grants.find((grant) => grant.id === id);
      if (found === undefined || found.revokedAt !== undefined)
        return { next: file, result: false };
      if (found.lastUsedAt !== undefined && compareIsoInstant(found.lastUsedAt, at) >= 0) {
        return { next: file, result: true };
      }
      const next = permissionGrantSchema.parse({ ...found, lastUsedAt: at });
      return {
        next: {
          grants: file.grants.map((grant) => (grant.id === id ? next : grant)),
          invalidGrantsRaw: file.invalidGrantsRaw,
        },
        result: true,
      };
    });
  }

  async listUnreadable(): Promise<UnreadablePermissionGrant[]> {
    const { invalidGrantsRaw } = await this.#read();
    return invalidGrantsRaw.map((raw): UnreadablePermissionGrant => {
      const id = extractRowId(raw);
      const result = permissionGrantSchema.safeParse(raw);
      return {
        ...(id === undefined ? {} : { id }),
        reason: result.success ? '不正な行' : summarizeInvalidFields(result.error.issues),
      };
    });
  }

  async removeUnreadable(
    ids: readonly string[],
    options: RemoveUnreadableRowsOptions = {},
  ): Promise<RemoveUnreadableRowsResult> {
    const wanted = [...new Set(ids)];
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const present = new Set(
        file.invalidGrantsRaw.flatMap((raw) => {
          const id = extractRowId(raw);
          return id === undefined ? [] : [id];
        }),
      );
      const unknown = wanted.filter((id) => !present.has(id));
      if (unknown.length > 0 || wanted.length === 0) {
        return { kind: 'unknown', count: unknown.length };
      }
      // 日誌などを先に呼ぶ: 投げたらここで止まり、何も書かないため
      await options.beforeRemove?.(wanted);
      const drop = new Set(wanted);
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify(
          this.#serialize({
            grants: file.grants,
            invalidGrantsRaw: file.invalidGrantsRaw.filter((raw) => {
              const id = extractRowId(raw);
              return id === undefined || !drop.has(id);
            }),
          }),
          null,
          2,
        )}\n`,
      );
      return { kind: 'removed', ids: wanted };
    });
  }

  async #read(): Promise<GrantFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));
      const grants: PermissionGrant[] = [];
      const invalidGrantsRaw: unknown[] = [];
      top.grants.forEach((rawGrant, index) => {
        const result = permissionGrantSchema.safeParse(rawGrant);
        const id = extractRowId(rawGrant);
        // 鍵に配列の位置（index）を使わない: 他の行が増減すると、同じ壊れた行でも位置がずれるため
        const key = unreadableRowKey(id, rawGrant);
        if (result.success) {
          grants.push(result.data);
          this.#unreadableOnce.sawReadable(key);
          return;
        }
        invalidGrantsRaw.push(rawGrant);
        if (this.#unreadableOnce.sawUnreadable(key)) {
          process.stderr.write(
            `${describeSkippedGrantRow({
              index,
              reason: summarizeInvalidFields(result.error.issues),
              id,
            })}\n`,
          );
        }
      });
      return { grants, invalidGrantsRaw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  // 1本の配列へ合流させる: 分けたまま書くと、次の `#read()` で未知のキーとして黙って捨てられるため
  #serialize(file: GrantFile): { grants: unknown[] } {
    return { grants: [...file.grants, ...file.invalidGrantsRaw] };
  }

  async #update<T>(mutate: (file: GrantFile) => { next: GrantFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(this.#serialize(next), null, 2)}\n`);
      return result;
    });
  }
}
