import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ensureTrailingNewline,
  stripNul,
  PracticeConflictError,
  practiceSchema,
  practiceVersionMatches,
  practiceVersionSchema,
  UnreadablePracticeError,
  compareCodeUnits,
} from '@alteroid/core';
import type {
  Practice,
  PracticeList,
  PracticeMeta,
  PracticeStore,
  PracticeVersion,
  RemovePracticeOptions,
  WritePracticeOptions,
  PracticeVersionMeta,
  UnreadablePractice,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 旧い `bytes` 欄を持つ既存の行を読めなくしない: `.strict()` / `.passthrough()` を足さない（zod は既定で未知のキーを落とすため、そのまま読める）
const practiceRecordSchema = practiceSchema.omit({ chars: true });

type PracticeRecord = z.infer<typeof practiceRecordSchema>;

const practiceVersionRecordSchema = practiceVersionSchema.omit({ chars: true });

type PracticeVersionRecord = z.infer<typeof practiceVersionRecordSchema>;

// 行の中身はここで検査しない: 行の schema を直接使うと、1行の不正が配列全体を道連れにするため
const fileSchema = z.object({
  practices: z.array(z.unknown()).default([]),
  // 版の履歴は同じファイル・同じ排他区間に置く: 別ファイルだと本体と版が2回の書き込みに割れ、途中で落ちると「本体は書き変わったが版は増えていない」食い違いが生まれるため
  practiceVersions: z.array(z.unknown()).default([]),
});

interface PracticeFile {
  practices: PracticeRecord[];
  // `invalid*Raw` は消さずに持ち回る: 書き戻しに入れないと、次の書き込みで消えるため
  invalidPracticesRaw: unknown[];
  practiceVersions: PracticeVersionRecord[];
  invalidPracticeVersionsRaw: unknown[];
}

const EMPTY: PracticeFile = {
  practices: [],
  invalidPracticesRaw: [],
  practiceVersions: [],
  invalidPracticeVersionsRaw: [],
};

// `issue.message` は使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わると値が漏れるため
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function extractSlug(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const slug = (raw as Record<string, unknown>).slug;
  return typeof slug === 'string' ? slug : undefined;
}

function extractVersion(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const version = (raw as Record<string, unknown>).version;
  return typeof version === 'number' ? version : undefined;
}

// slug 以外の値は載せない: `title` / `content` には人間・クローンの自由文がそのまま入りうるため
function describeSkippedPracticeRow(params: {
  index: number;
  reason: string;
  slug?: string;
}): string {
  const slugNote = params.slug === undefined ? '' : ` slug=${JSON.stringify(params.slug)}`;
  return (
    `alteroid: practices の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${slugNote}`
  );
}

function describeSkippedPracticeVersionRow(params: {
  index: number;
  reason: string;
  slug?: string;
}): string {
  const slugNote = params.slug === undefined ? '' : ` slug=${JSON.stringify(params.slug)}`;
  return (
    `alteroid: practiceVersions の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${slugNote}`
  );
}

// 1本の配列へ合流させる: 分けたまま書くと、次の `#read()` で未知のキーとして黙って捨てられるため
function serialize(file: PracticeFile): { practices: unknown[]; practiceVersions: unknown[] } {
  return {
    practices: [...file.practices, ...file.invalidPracticesRaw],
    practiceVersions: [...file.practiceVersions, ...file.invalidPracticeVersionsRaw],
  };
}

// `.length` ではなくコードポイント数で数える: UTF-16 のコード単位数とは食い違うため
function countChars(content: string): number {
  return [...content].length;
}

function toMeta(entry: PracticeRecord): PracticeMeta {
  return {
    slug: entry.slug,
    kind: entry.kind,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    chars: countChars(entry.content),
  };
}

function toPractice(entry: PracticeRecord): Practice {
  return { ...entry, chars: countChars(entry.content) };
}

function toVersionMeta(entry: PracticeVersionRecord): PracticeVersionMeta {
  return {
    slug: entry.slug,
    version: entry.version,
    kind: entry.kind,
    title: entry.title,
    at: entry.at,
    chars: countChars(entry.content),
  };
}

function toVersion(entry: PracticeVersionRecord): PracticeVersion {
  return { ...entry, chars: countChars(entry.content) };
}

// Markdown のファイル群にせず1枚の JSON に全部置く: 本文外の値（`kind` / `createdAt`）の置き先が索引ファイルになり、派生値の drift を新しく作るうえ、`createdAt` を FS の時刻に頼れないため
export class FsPracticeStore implements PracticeStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'practices.json');
  }

  async list(): Promise<PracticeList> {
    const { practices, invalidPracticesRaw } = await this.#read();
    // 不正な行は黙って飛ばさず `unreadable` に別欄で返す: 飛ばすと、上の層が「やり方は1件も無い。正常」と言い切れてしまうため
    return {
      entries: [...practices]
        .sort((a, b) => compareCodeUnits(a.slug, b.slug))
        .map((entry) => toMeta(entry)),
      unreadable: invalidPracticesRaw.map((raw): UnreadablePractice => {
        const slug = extractSlug(raw);
        const result = practiceRecordSchema.safeParse(raw);
        const reason = result.success ? '不正な行' : summarizeInvalidFields(result.error.issues);
        return slug === undefined ? { reason } : { slug, reason };
      }),
    };
  }

  async read(slug: string): Promise<Practice | null> {
    const file = await this.#read();
    const found = file.practices.find((entry) => entry.slug === slug);
    if (found !== undefined) return toPractice(found);
    const invalidRaw = file.invalidPracticesRaw.find((raw) => extractSlug(raw) === slug);
    if (invalidRaw === undefined) return null;
    const result = practiceRecordSchema.safeParse(invalidRaw);
    // 読めない行は `null` にせず `UnreadablePracticeError` を投げる: 呼び手が `instanceof` で見分けて「在ったが読めない」として書き直し・削除まで進むため
    if (result.success) return toPractice(result.data);
    throw new UnreadablePracticeError(
      `やり方 ${slug} が読めない形で入っている（消されたのではない）: ${result.error.message}`,
      { slug },
    );
  }

  async write(
    input: {
      slug: string;
      kind: string;
      title: string;
      content: string;
    },
    options?: WritePracticeOptions,
  ): Promise<Practice> {
    // 正規化を自分で書かない: 出所は `@alteroid/core` の `ensureTrailingNewline` 1箇所のため
    const content = ensureTrailingNewline(stripNul(input.content));
    const kind = stripNul(input.kind);
    const title = stripNul(input.title);
    const now = new Date().toISOString();
    return this.#update((file) => {
      const existing = file.practices.find((entry) => entry.slug === input.slug);
      // 前提の版の比較は `#update` の内側で行う: 外で読んでから入ると、その間の別の書き手を見逃すため
      if (!practiceVersionMatches(existing ?? null, options?.ifMatch)) {
        throw new PracticeConflictError(
          input.slug,
          existing === undefined ? null : toPractice(existing),
        );
      }
      const next = practiceRecordSchema.parse({
        slug: input.slug,
        kind,
        title,
        content,
        // 壊れた行にしか既存が無いときは新規作成として扱う: 壊れた行から `createdAt` を安全に取り出す手段が無いため
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      // 版番号は壊れた行の version も含めた最大値 + 1 にする: 検査を通った版の数 + 1 だと壊れた行と番号が重なり、追記専用の履歴で version が二重になるため
      const priorValidVersions = file.practiceVersions.filter((entry) => entry.slug === input.slug);
      const priorInvalidVersionNumbers = file.invalidPracticeVersionsRaw
        .filter((raw) => extractSlug(raw) === input.slug)
        .map((raw) => extractVersion(raw))
        .filter(
          (version): version is number =>
            version !== undefined && Number.isInteger(version) && version > 0,
        );
      const priorMaxVersion = Math.max(
        0,
        ...priorValidVersions.map((entry) => entry.version),
        ...priorInvalidVersionNumbers,
      );
      const nextVersion = practiceVersionRecordSchema.parse({
        slug: input.slug,
        version: priorMaxVersion + 1,
        kind,
        title,
        content,
        at: now,
      });
      // 書き込む slug と一致する壊れた行は置き換える: 残すと同じ slug が2行並び、`list()` のたびに直したはずの跡が出続けるため
      // `practiceVersions` 側は filter しない: 追記専用で同じ slug の版が共存するのが正常で、消すと壊れた過去の版が黙って失われるため
      const invalidPracticesRaw = file.invalidPracticesRaw.filter(
        (raw) => extractSlug(raw) !== input.slug,
      );
      return {
        next: {
          ...file,
          practices: [...file.practices.filter((entry) => entry.slug !== input.slug), next],
          invalidPracticesRaw,
          practiceVersions: [...file.practiceVersions, nextVersion],
        },
        result: toPractice(next),
      };
    });
  }

  async remove(slug: string, options?: RemovePracticeOptions): Promise<void> {
    await this.#update((file) => {
      if (options?.ifMatch !== undefined) {
        const existing = file.practices.find((entry) => entry.slug === slug);
        if (!practiceVersionMatches(existing ?? null, options.ifMatch)) {
          throw new PracticeConflictError(
            slug,
            existing === undefined ? null : toPractice(existing),
          );
        }
      }
      // 壊れた行も slug 指定で消す: `read()` が投げたままだと、壊れた slug が永久に残って人間が復旧する唯一の手を塞ぐため
      return {
        next: {
          ...file,
          practices: file.practices.filter((entry) => entry.slug !== slug),
          invalidPracticesRaw: file.invalidPracticesRaw.filter((raw) => extractSlug(raw) !== slug),
        },
        result: undefined,
      };
    });
  }

  async clear(): Promise<number> {
    // 壊れた行も一緒に消す: 全消去なので、fs だけ壊れた行が残ると `clear()` の意味が実装ごとに変わるため
    return this.#update((file) => ({
      next: {
        practices: [],
        invalidPracticesRaw: [],
        practiceVersions: [],
        invalidPracticeVersionsRaw: [],
      },
      result: file.practices.length + file.invalidPracticesRaw.length,
    }));
  }

  // 不正な版の行は返さず投げない: 版の一覧は個々の版の存在を保証する契約ではないため
  async listVersions(slug: string): Promise<PracticeVersionMeta[]> {
    return (await this.#read()).practiceVersions
      .filter((entry) => entry.slug === slug)
      .sort((a, b) => a.version - b.version)
      .map((entry) => toVersionMeta(entry));
  }

  async readVersion(slug: string, version: number): Promise<PracticeVersion | null> {
    const file = await this.#read();
    const found = file.practiceVersions.find(
      (entry) => entry.slug === slug && entry.version === version,
    );
    if (found !== undefined) return toVersion(found);
    const invalidRaw = file.invalidPracticeVersionsRaw.find(
      (raw) => extractSlug(raw) === slug && extractVersion(raw) === version,
    );
    if (invalidRaw === undefined) return null;
    const result = practiceVersionRecordSchema.safeParse(invalidRaw);
    if (result.success) return toVersion(result.data);
    throw new UnreadablePracticeError(
      `やり方 ${slug} の版 ${version} が読めない形で入っている（消されたのではない）: ${result.error.message}`,
      { slug, version },
    );
  }

  async #read(): Promise<PracticeFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));
      const practices: PracticeRecord[] = [];
      const invalidPracticesRaw: unknown[] = [];
      top.practices.forEach((rawEntry, index) => {
        const result = practiceRecordSchema.safeParse(rawEntry);
        if (result.success) {
          practices.push(result.data);
          return;
        }
        invalidPracticesRaw.push(rawEntry);
        process.stderr.write(
          `${describeSkippedPracticeRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            slug: extractSlug(rawEntry),
          })}\n`,
        );
      });
      const practiceVersions: PracticeVersionRecord[] = [];
      const invalidPracticeVersionsRaw: unknown[] = [];
      top.practiceVersions.forEach((rawVersion, index) => {
        const result = practiceVersionRecordSchema.safeParse(rawVersion);
        if (result.success) {
          practiceVersions.push(result.data);
          return;
        }
        invalidPracticeVersionsRaw.push(rawVersion);
        process.stderr.write(
          `${describeSkippedPracticeVersionRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            slug: extractSlug(rawVersion),
          })}\n`,
        );
      });
      return { practices, invalidPracticesRaw, practiceVersions, invalidPracticeVersionsRaw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  // `write` の「既存の `createdAt` を引き継ぐ」決定はこの区間の中で行う: 読んでから書くまでに別の書き込みが挟まると壊れるため
  async #update<T>(mutate: (file: PracticeFile) => { next: PracticeFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(serialize(next), null, 2)}\n`);
      return result;
    });
  }
}
