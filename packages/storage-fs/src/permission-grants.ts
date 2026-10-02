import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  compareIsoInstant,
  createUnreadableRowOnce,
  permissionGrantSchema,
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

/**
 * トップレベルの形だけを見る。**`grants` の各要素は `unknown` のまま
 * 受け取り、行ごとの検査は `#read()` が `permissionGrantSchema.safeParse` で
 * 1行ずつ行う**（issue #1941。`jobs.ts` の `jobs` / `approvals`・
 * `credentials.ts` の `credentials` と同じ形——`z.array(permissionGrantSchema)`
 * にすると、1行の不正が配列全体を道連れにする）。
 */
const fileSchema = z.object({
  grants: z.array(z.unknown()).default([]),
});

/**
 * `permission-grants.json` の中身。**検査を通った `grants` と、形が不正で
 * 読めなかった `invalidGrantsRaw`（生の要素。パース前のまま）を分けて持つ**
 * （`FsCredentialVaultStore` の `CredentialFile`・issue #1740 と同じ形。
 * `invalidGrantsRaw` を消さずに持ち回るのがこの直しの核心——`put()` /
 * `revoke()` / `markUsed()` はいずれも最終的にこれを丸ごとシリアライズし
 * 直す（`#toDisk`）ので、ここへ入れなかった行は次の書き込みで消える）。
 */
interface GrantFile {
  grants: PermissionGrant[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。 */
  invalidGrantsRaw: unknown[];
}

const EMPTY: GrantFile = { grants: [], invalidGrantsRaw: [] };

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れ
 * ない。出すのは「どの欄が」だけである（`jobs.ts` の `summarizeInvalidFields`
 * と同じ理由・同じ形）。
 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/** 生の要素から、値を出さずに「id」だけを安全に取り出す（取れなければ `undefined`）。 */
function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * 飛ばした許可の行を stderr へ1行で要約する。**id 以外の値は絶対に載せない**
 * ——`allows` / `denies` / `answer` には人間の回答の原文がそのまま入りうる
 * （`jobs.ts` の `describeSkippedJobRow` と同じ理由）。
 */
function describeSkippedGrantRow(params: { index: number; reason: string; id?: string }): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: 許可の記録の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

/**
 * 人間が承認した Bash 許可の記録（Issue #863）。1枚の JSON（`FsJobStore` の
 * `jobs.json` と同じ形——`paths.jobs` ディレクトリを共有するが、ファイルは
 * 別にする。`permission-grants.json` という名前は設計メモの明示）。
 */
export class FsPermissionGrantStore implements PermissionGrantStore {
  readonly #dir: string;
  readonly #path: string;

  /**
   * `#read()` が読めなかった行を、インスタンスの生存中「1回だけ」知らせる
   * ための追跡器（issue #2191）。以前は `#read()` を呼ぶたびに（＝
   * `list()` / `get()` / `put()` / `revoke()` / `markUsed()` のどれを呼んでも）
   * 同じ壊れた行へ毎回1行 stderr へ出していた——`clone.ts` の
   * `#onPreToolUse` が Bash を呼ぶたびに `list()` を引き直すため、直っていない
   * 行1つで同じ警告が積み上がり続けていた。pg 実装（`PgPermissionGrantStore`）
   * と同じ道具（`createUnreadableRowOnce` / `unreadableRowKey`。
   * `@alteroid/core`）で揃える。
   */
  readonly #unreadableOnce: UnreadableRowOnce = createUnreadableRowOnce();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'permission-grants.json');
  }

  async list(): Promise<PermissionGrant[]> {
    // **`grantedAt` の昇順で返す**（3実装で揃える——`PgPermissionGrantStore` /
    // インメモリ実装〈`testing.ts`〉と同じ並び。ファイルの生の順序は書き込み
    // 順であって時系列の保証が無いので、ここで揃える）。**実時刻で比べる**（issue
    // #2451。`compareIsoInstant` の doc——文字列比較だとオフセット表記の違う行で
    // pg の `asc(grantedAt)` と並びが食い違う）。
    return [...(await this.#read()).grants].sort((a, b) =>
      compareIsoInstant(a.grantedAt, b.grantedAt),
    );
  }

  async get(id: string): Promise<PermissionGrant | null> {
    const { grants } = await this.#read();
    return grants.find((grant) => grant.id === id) ?? null;
  }

  async put(grant: PermissionGrant): Promise<void> {
    await this.#update((file) => {
      const grants = file.grants.filter((existing) => existing.id !== grant.id);
      grants.push(permissionGrantSchema.parse(grant));
      // **書き込む id と一致する壊れた行は置き換える**（`FsCredentialVaultStore.put` /
      // `FsJobStore.putJob` と同じフォローアップ。issue #1740 / #1868）。直した
      // はずの id の壊れた行が `invalidGrantsRaw` として残り続けると、ファイル
      // に同じ id が2行並び、以後 `list()` のたびに直したはずの跡が出続ける
      // ——「直した」という呼び手の意図に対する驚きになる。
      const invalidGrantsRaw = file.invalidGrantsRaw.filter(
        (raw) => extractRowId(raw) !== grant.id,
      );
      return { next: { grants, invalidGrantsRaw }, result: undefined };
    });
  }

  /**
   * `PermissionGrantStore.revoke` の doc（lost update・#1654 と同型）。
   * **現在値を読むのも書くのも同じ `#update` の排他区間の中**——`get()` した
   * 古い写しではなく、ここで読み直した現在値から `revokedAt` の有無を見る。
   *
   * **id が `invalidGrantsRaw`（読めない行）にしか無いときは `null`（無い）では
   * なく `UnreadablePermissionGrantError` を投げ、ファイルは1バイトも書かない**
   * （issue #2425。`FsJobStore.updateJob` の `UnreadableJobError` と同じ線）。
   * 読めない行は `list()` / `get()` に現れないので、投げても許可が余計に通る
   * ことは無い（fail-closed のまま）。
   */
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

  /**
   * `PermissionGrantStore.markUsed` の doc。`revokedAt` などの他の欄には
   * 一切触れない——差し替えるのは `lastUsedAt` だけ。既存より古い時刻では
   * 戻さない。
   */
  async markUsed(id: string, at: string): Promise<boolean> {
    return this.#update((file) => {
      const found = file.grants.find((grant) => grant.id === id);
      // 無い・取り消し済みなら記録しない（Issue #1687。`PermissionGrantStore.markUsed` の doc）。
      if (found === undefined || found.revokedAt !== undefined)
        return { next: file, result: false };
      if (found.lastUsedAt !== undefined && found.lastUsedAt >= at) {
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

  /**
   * `list()` が読み飛ばした行を、本文を含まない形（id と不正な欄名だけ）で返す
   * （`PermissionGrantStore.listUnreadable` の doc。issue #2536）。`invalidGrantsRaw` から作る。
   * `extractRowId` は名指しした欄しか読まないので、`allows` / `answer` などを取り出す経路は無い。
   */
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

  /**
   * 読めない行を id で指して消す（`PermissionGrantStore.removeUnreadable` の doc。issue #2440）。
   * `invalidGrantsRaw` のうち `extractRowId` が一致する行だけを落とす——id が取れない行は
   * 指せないので残る。読めた行には触れない。**読んで・突き合わせて・日誌（`beforeRemove`）を
   * 呼んで・書くまでを1つの排他区間に入れる。** 知らない id があれば書かない（ファイルを
   * 1バイトも変えない）。`beforeRemove` が投げたら書かずに投げ直す。**値は返さない（id だけ）。**
   */
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
      // **日誌などを先に。投げたら、ここで止まり、何も書かない。**
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

  /**
   * `permission-grants.json` を読む。**行ごとに検査し、不正な1行だけを
   * 飛ばす**（issue #1941。以前は `fileSchema.parse` で `grants` 配列全体を
   * 1回に検査していたため、1行でも不正だと `list()` / `get()` / `put()` /
   * `revoke()` / `markUsed()` が丸ごと例外を投げ、正しい許可の記録も読めなく
   * なっていた——pg 実装（`PgPermissionGrantStore.list()`）は元から1行ずつ
   * `safeParse` していた）。
   *
   * **飛ばすのは行の形が不正なとき（欄が欠けている・型が違う、など）だけ
   * である。** ファイルそのものが JSON として読めない・トップレベルの形が
   * 違う（`grants` が配列でない等）ときは、いまの振る舞い（例外）のまま
   * にしてある——それは1行の問題ではないため（`jobs.ts` / `credentials.ts`
   * と同じ設計判断）。
   *
   * 飛ばした行は stderr へ跡を残し（`describeSkippedGrantRow`。**値は
   * allows/denies/answer 等の本文を含めず、id だけ**）、`invalidGrantsRaw`
   * として生の形のまま保持する——`put()` / `revoke()` / `markUsed()` がこれを
   * 書き戻すことで、版ずれ・手編集でできた不正な行を黙って消さない。
   *
   * **同じ行には、このインスタンスの生存中1回しか知らせない**（issue
   * #2191。`#unreadableOnce`）。鍵は行の id（取れなければ内容の指紋）——
   * `put()` で直った後にまた壊れれば、もう一度知らせる。読めた行は毎回
   * `sawReadable()` で「まだ知らせていない」側へ戻す。
   *
   * **飛ばした行の許可は fail-closed になる。** `grants`（検査を通った行）
   * にしか現れないので、`get()` は無いのと同じ `null` を返し、`list()` の
   * 一覧にも載らない——`clone.ts` の `#onPreToolUse` はこの一覧からルールが
   * 一致する行を探すので、壊れた行の許可は「無い」ものとして扱われ、確認が
   * もう一度要るだけで済む（誤って `allow` へは倒れない。issue #1941 の
   * 「確かめていないこと」の2点目）。
   */
  async #read(): Promise<GrantFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));
      const grants: PermissionGrant[] = [];
      const invalidGrantsRaw: unknown[] = [];
      top.grants.forEach((rawGrant, index) => {
        const result = permissionGrantSchema.safeParse(rawGrant);
        const id = extractRowId(rawGrant);
        // **鍵は id（取れなければ中身の指紋）——配列の位置（index）は使わない**
        // （他の行が増減すると同じ壊れた行でも位置がずれるため。
        // `unreadableRowKey` の doc）。
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

  /**
   * `GrantFile` をディスク上の形へ直す。**検査を通った `grants` と
   * `invalidGrantsRaw` を1本の配列へ合流させる**——分けたまま書くと、次の
   * `#read()` が `fileSchema`（トップレベルの形しか見ない）を通すときに
   * 未知のキー（`invalidGrantsRaw`）として黙って捨てられ、壊れた行を持ち
   * 回る意味が消える（`jobs.ts` の `#serialize` と同じ理由）。
   */
  #serialize(file: GrantFile): { grants: unknown[] } {
    return { grants: [...file.grants, ...file.invalidGrantsRaw] };
  }

  /**
   * read-modify-write を直列化する（`FsJobStore.#update` と同じ理由——issue
   * #1113 / #1050 の教訓。`withPathLock` でプロセス内・プロセス間の両方を
   * 排他する）。**`mutate` が返す `result` をそのまま呼び出し側へ返す**
   * （`FsScheduleStore.#update` と同じ形——`revoke` / `markUsed` が「読んで
   * から書くまで」を排他区間の中へ引き取れるようにするため）。
   */
  async #update<T>(mutate: (file: GrantFile) => { next: GrantFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(this.#serialize(next), null, 2)}\n`);
      return result;
    });
  }
}
