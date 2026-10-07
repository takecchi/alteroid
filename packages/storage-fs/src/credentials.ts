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

/**
 * 正本1行のスキーマ。**`value` は素の文字列のまま保存する**——ここが正本を持つ
 * 唯一の場所であり、値を持たない顔（指紋）は上の層が作る（`FsTokenPoolStore` の
 * `agentTokenRowSchema` と同じ分け方）。
 */
const rowSchema = z.object({
  /**
   * 環境変数の名前。**ここでも形を検査する。**
   *
   * 入口（HTTP のスキーマ・`CredentialStore#set`）でも見ているが、**ファイルは
   * 人間が手で書き換えられる**ので、読むときにもう一度見ないと、手で書いた
   * `../../x` のような名前がそのまま runner へ降りて器の外を指す。守りを1枚に
   * 寄せない（`credentials.ts` の `CREDENTIAL_NAME` の doc と同じ理由）。
   *
   * **⚠️ 人間が手で書き換えられる、ということは、手で壊せるということでもある。**
   * ファイル全体を一度に検査すると、1行の不正で `list()` / `put()` が丸ごと例外を
   * 投げ、正しい行（`GH_TOKEN` 等）まで読めなくなり、直すための書き込みまで失敗しうる。
   * **だから行ごとに検査し、不正な1行だけを飛ばす**（`pg` 版の `filter` と同じ形。
   * 詳細は `#read()` の doc）。
   */
  name: z.string().regex(CREDENTIAL_NAME),
  value: z.string(),
  updatedAt: z.string(),
  /** 撒く先。読めない・無い行は `'all'`（この列より前の全行の実際の挙動）。 */
  scope: z.enum(['all', 'app', 'runner']).default('all'),
  /** シークレット可否。読めない・無い行は `true`（この列より前の全行の実際の挙動）。 */
  secret: z.boolean().default(true),
});

/**
 * トップレベルの形だけを見る。**行の中身はここでは検査しない**——
 * `credentials` の各要素は `unknown` のまま受け取り、行ごとの検査は `#read()` が
 * `rowSchema.safeParse` で1行ずつ行う。ここで `z.array(rowSchema)` にすると、
 * 1行の不正が配列全体を道連れにする。
 *
 * **ここで投げる例外はそのままでよい**——`credentials` が配列でない・ファイルが
 * オブジェクトでない、はファイル全体の形の問題であって、1行の問題ではない。
 */
const topLevelSchema = z.object({
  credentials: z.array(z.unknown()).default([]),
  /** `seedOnce` の印（1度だけの移行をしたことの記録。無ければ空）。 */
  seeded: z.array(z.string()).default([]),
});

/**
 * 正本1行のぶんの読み出し結果と、書き戻すための生の要素を両方持つ。
 *
 * **`invalidRaw` を消さずに持ち回るのが、この issue の直し方の核心である。**
 * `put()` は最終的にこの `CredentialFile` を丸ごとシリアライズし直すので、
 * ここへ入れなかった行は次の書き込みで消える——`credentials` （検査を通った行）
 * だけを書き戻すと、人間が手で書いた不正な行が黙って消えることになる。
 */
interface CredentialFile {
  credentials: StoredCredential[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。 */
  invalidRaw: unknown[];
  /** `seedOnce` が立てた印。書き戻すときも落とさない。 */
  seeded: string[];
}

const EMPTY: CredentialFile = { credentials: [], invalidRaw: [], seeded: [] };

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである。
 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/** 生の要素から、値を出さずに「名前」だけを安全に取り出す（取れなければ `undefined`）。 */
function extractRowName(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const name = (raw as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * マネージャーへ降ろす環境変数の正本の置き場（既定 `~/.alteroid/credentials.json`）。
 *
 * **`memory/` には置かない。** 値（鍵そのもの）を持つ場所であって、人間が手で
 * 書き換える前提の場所ではない（`alteroid credential` / `PUT /credentials` を
 * 経由する）。`FsAuthStore` / `FsTokenPoolStore` と同じ扱いである。
 *
 * **一時ファイルを 0600 で作ってから rename する。** rename の後に絞ると、その
 * 隙間で他人が読める。
 */
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
        // **空文字は「外す」。** 器（`CredentialStore#set`）と同じ約束にしてある
        // ——片方だけ残ると、指紋を見ても理由が分からない食い違いになる。
        if (entry.value.length === 0) {
          rows.delete(entry.name);
          continue;
        }
        // **呼び手（`credential-service.ts` の `resolveEntryForWrite`）が scope・
        // secret を必ず解決してから渡す。** ここでは受け取ったものをそのまま
        // 書くだけで、既定値の補完はしない（1か所で決める）。
        rows.set(entry.name, {
          name: entry.name,
          value: entry.value,
          updatedAt: at,
          scope: entry.scope ?? 'all',
          secret: entry.secret ?? true,
        });
      }
      // **`invalidRaw` をそのまま持ち回る。** ここで検査を通った行だけを
      // 返すと、次の `#update` のシリアライズで不正な行が消える（直すための
      // 書き込みが、直っていない行を道連れに消していい理由は無い）。
      //
      // **⚠️ ただし、この `put()` が書き込む名前と一致する不正な行は外す。**
      // 人間が `alteroid credential set
      // GH_TOKEN …` で直したつもりなのに、同じ名前の壊れた行が `invalidRaw`
      // として残り続けると、ファイルに同じ名前の行が2つ並び、以後 `list()` の
      // たびに直したはずの跡が出続ける——「直した」という人間の意図に対する
      // 驚きになる。pg は名前が主キーなので、この重複はそもそも起こり得ない
      // （同じ名前は `onConflictDoUpdate` で1行に畳まれる）。fs もそれに合わせる。
      // **名前が取れない行・違う名前の行はここでは触らない**（元の形のまま
      // 残す）。
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
      // 同じ名前の壊れた行（`invalidRaw`）が在るなら、人間の手が入っている行として
      // 上書きしない（`put` はそれを置き換えるが、こちらは「無い名前だけ」を書く）。
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

  /**
   * `credentials.json` を読む。**行ごとに検査し、不正な1行だけを飛ばす**
   * （配列全体を1回に検査すると、1行でも不正なだけで `list()` / `put()` が丸ごと
   * 例外を投げ、正しい行も読めなくなる）。
   *
   * **飛ばすのは行の形が不正なとき（名前が正規表現に合わない・欄が欠けている・
   * 型が違う、など）だけである。** ファイルそのものが JSON として読めない・
   * トップレベルの形が違う（`credentials` が配列でない等）ときは、
   * 例外にする——それは1行の問題ではないため。
   *
   * 飛ばした行は stderr へ1行の跡を残し（`describeSkippedCredentialRow`。
   * **値は出さない**）、`invalidRaw` として生の形のまま保持する——`put()` が
   * これを書き戻すことで、人間が手で書いた不正な行を黙って消さない。
   */
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

  /**
   * read-modify-write を直列化する（`FsTokenPoolStore#update` と同じ
   * `withPathLock` ベースの排他）。
   *
   * **書き込んだ `CredentialFile` を返す。** `put()` が書き込み直後にもう一度
   * `#read()` する（＝ファイルを読み直して跡を重複して出す）必要をなくすため
   * （`#read()` は跡を出すので、二度読みすると跡が二重に出る）。
   */
  async #update(mutate: (file: CredentialFile) => CredentialFile): Promise<CredentialFile> {
    return withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // **不正な行（`invalidRaw`）も一緒に書き戻す。** ここへ入れなかった
      // 分は消える——`credentials`（検査を通った行）だけを書けば、人間が
      // 手で書いた不正な行が次の書き込みで黙って消える。
      const serialized: { credentials: unknown[]; seeded?: string[] } = {
        credentials: [...next.credentials, ...next.invalidRaw],
        // 印が1つも無いファイルには欄を足さない（既存のファイルの形を変えない）。
        ...(next.seeded.length > 0 ? { seeded: next.seeded } : {}),
      };
      // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。rename 後に
      // 絞ると、その隙間で他人が読める。
      await writeFileAtomic(this.#path, `${JSON.stringify(serialized, null, 2)}\n`, {
        mode: 0o600,
      });
      return next;
    });
  }
}
