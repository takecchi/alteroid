import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ensureTrailingNewline,
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

/**
 * ディスクへ書く形。**`chars` を持たない**——#1340 で保存をやめ、本文から
 * 都度導出する形にした（`PracticeStore.write` の doc）。`practiceSchema` から
 * `chars` を落とすことで作る。
 *
 * ⚠️ **既存の JSON に残っている旧い `bytes` 欄を読めなくしないこと。** zod の
 * `z.object` は既定で未知のキーを黙って落とす（`.strict()` を付けていない）ので、
 * 改名前に書かれた `bytes: <数値>` を持つ行もそのまま読める——ここでその挙動を
 * 壊さない（`.strict()` / `.passthrough()` を足さない）。
 */
const practiceRecordSchema = practiceSchema.omit({ chars: true });

type PracticeRecord = z.infer<typeof practiceRecordSchema>;

/**
 * ディスクへ書く、版の履歴の1件（#1309）。**`chars` を持たない**——本体の
 * `PracticeRecord` と同じ理由で、読むたびに `content` から導出する。
 */
const practiceVersionRecordSchema = practiceVersionSchema.omit({ chars: true });

type PracticeVersionRecord = z.infer<typeof practiceVersionRecordSchema>;

/**
 * トップレベルの形だけを見る。**`practices` / `practiceVersions` のどちらも、
 * 各要素はここでは検査しない**（issue #1967。`FsJobStore` の `fileSchema` が
 * #1868 / #1928 でそろえた形、`FsScheduleStore` の `fileSchema` が #1944 で
 * そろえた形と同じ）——`z.array(practiceRecordSchema)` /
 * `z.array(practiceVersionRecordSchema)` にすると、1行の不正が配列全体を
 * 道連れにする。行ごとの検査は `#read()` がそれぞれ
 * `practiceRecordSchema.safeParse` / `practiceVersionRecordSchema.safeParse` で
 * 1行ずつ行う。
 */
const fileSchema = z.object({
  practices: z.array(z.unknown()).default([]),
  /**
   * 追記専用の版の履歴（#1309）。**同じファイル・同じ排他区間に置く**——
   * `practices` とは別ファイルにすると、`write()` が本体と版を2回の書き込みに
   * 割ることになり、途中で落ちたときに「本体は書き変わったが版は増えていない」
   * という食い違いが生まれる（`PracticeStore.write` の doc）。1ファイルなら
   * `#update` の1回の `writeFileAtomic` で両方が同時に反映される。
   */
  practiceVersions: z.array(z.unknown()).default([]),
});

/**
 * `practices.json` の中身。**検査を通った `practices` / `practiceVersions` と、
 * それぞれ形が不正で読めなかった `invalidPracticesRaw` /
 * `invalidPracticeVersionsRaw`（生の要素。パース前のまま）を分けて持つ**
 * （issue #1967。`FsJobStore` の `JobFile` と同じ形）。
 *
 * `invalid*Raw` を消さずに持ち回るのが、この直しの核心である。`write` /
 * `remove` / `clear` はいずれも最終的にこれを丸ごとシリアライズし直す
 * （`serialize`）ので、ここへ入れなかった行は次の書き込みで消える——検査を
 * 通った行だけを書けば、版ずれ・手編集でできた不正な行が黙って消えることになる。
 */
interface PracticeFile {
  practices: PracticeRecord[];
  /** やり方の行の形が不正で読めなかった、生の要素（パース前のまま）。issue #1967。 */
  invalidPracticesRaw: unknown[];
  practiceVersions: PracticeVersionRecord[];
  /** 版の行の形が不正で読めなかった、生の要素（パース前のまま）。issue #1967。 */
  invalidPracticeVersionsRaw: unknown[];
}

const EMPTY: PracticeFile = {
  practices: [],
  invalidPracticesRaw: [],
  practiceVersions: [],
  invalidPracticeVersionsRaw: [],
};

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである（`FsJobStore.summarizeInvalidFields` と同じ
 * 理由・同じ形。パッケージ内で閉じた共通化に留め、ファイルを跨いだ共通化は
 * していない——#1928 / #1944 / #1951 と同じ判断）。
 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/**
 * 生の要素から、値を出さずに `slug` だけを安全に取り出す（取れなければ
 * `undefined`）。**`practices` / `practiceVersions` どちらの行にも使う共通の
 * 関数**（issue #1967。`FsJobStore.extractRowId` / `FsScheduleStore.extractKind`
 * と同じ形——鍵の名前だけが `slug` である）。
 */
function extractSlug(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const slug = (raw as Record<string, unknown>).slug;
  return typeof slug === 'string' ? slug : undefined;
}

/**
 * 生の要素から、値を出さずに `version` だけを安全に取り出す（取れなければ
 * `undefined`）。`practiceVersions` の行にだけ使う——`readVersion` が
 * `invalidPracticeVersionsRaw` の中から slug + version の一致を探すために要る。
 */
function extractVersion(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const version = (raw as Record<string, unknown>).version;
  return typeof version === 'number' ? version : undefined;
}

/**
 * 飛ばしたやり方の行を stderr へ1行で要約する。**slug 以外の値は絶対に
 * 載せない**——`title` / `content` には人間・クローンの自由文がそのまま
 * 入りうる（`FsJobStore.describeSkippedJobRow` と同じ理由。issue #1967）。
 */
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

/** 飛ばした版の行を stderr へ1行で要約する（`describeSkippedPracticeRow` と対）。 */
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

/**
 * `PracticeFile` をディスク上の形へ直す。**検査を通った `practices` /
 * `practiceVersions` と、それぞれの `invalidPracticesRaw` /
 * `invalidPracticeVersionsRaw` を1本の配列へ合流させる**——分けたまま書くと、
 * 次の `#read()` が `fileSchema`（トップレベルの形しか見ない）を通すときに
 * 未知のキー（`invalidPracticesRaw` / `invalidPracticeVersionsRaw`）として
 * 黙って捨てられ、壊れた行を持ち回る意味が消える。
 */
function serialize(file: PracticeFile): { practices: unknown[]; practiceVersions: unknown[] } {
  return {
    practices: [...file.practices, ...file.invalidPracticesRaw],
    practiceVersions: [...file.practiceVersions, ...file.invalidPracticeVersionsRaw],
  };
}

/** コードポイント数（UTF-16 のコード単位数ではない）。#1340。 */
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

/**
 * 仕事のやり方 = 1枚の JSON（#1055 段3）。
 *
 * ## ⭐ なぜ Markdown のファイル群（`memory/` の形）にしないのか
 *
 * やり方は散文なので、一見すると記憶と同じく1文書1ファイルにしたくなる。
 * **その形を採らなかったのは、記憶がその形で踏んだ穴が既に repo に記録されて
 * いるからである。**
 *
 * - 1ファイル1文書にすると、本文に入らない値（`kind` / `createdAt`）を置く先が
 *   **本文の外（索引ファイル）**になる。`FsPersonaStore` はまさにそれを持って
 *   いて、索引が失われた・本文のハッシュと食い違ったときは `unknown`（守る側）を
 *   返すしかない（`PersonaStore.protectionStatus` の doc）。**派生値の drift を
 *   新しく1つ作ることになる。**
 * - `createdAt` を本文の外に持てないなら FS の時刻に頼ることになるが、それは
 *   記憶で明示的に禁じられている（`MemoryDocumentMeta.createdAt` の doc、
 *   逐語「**`mtime` にも `birthtime` にも由来しない——これはいまも禁止である**」）。
 *
 * ⟹ **やり方を定義する値は全部1つのファイルに置く。** 索引も sidecar も作らない。
 *
 * 人間が直接開いて読めることは保つ（`schedules.json` / `commitments.json` と
 * 同じ場所・同じ形）。⚠️ **ただし人間の主な入口はここではない** —— 3入口
 * （クローンの道具 / デーモンの HTTP / 画面）から読めて直せることが段3 の
 * 受け入れ基準であり、この JSON はその下に在る器にすぎない。
 */
export class FsPracticeStore implements PracticeStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'practices.json');
  }

  /**
   * `entries` は slug の昇順。**不正な行は `entries` に入れず、`unreadable` に別欄で
   * 返す**（issue #2346。以前は黙って飛ばしていたため、上の層が「やり方は1件も無い。
   * 正常」と言い切れた。`FsScheduleStore.list` の #2343 と同じ形）——飛ばした行は
   * `#read()` が stderr へ跡を残し（issue #1967）、`invalidPracticesRaw` として書き
   * 戻しでも生かしたまま持ち回る（消さない）。`unreadable` は slug（取れれば）と
   * 不正な欄名だけを持ち、題・本文は載せない。
   */
  async list(): Promise<PracticeList> {
    const { practices, invalidPracticesRaw } = await this.#read();
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

  /**
   * **`list()` とは違い、読めない行は投げる**（`PracticeStore.read` の doc
   * 「無ければ null。読めないは throw」。`FsScheduleStore.get` の同じ形・
   * 同じ理由。issue #1967）。**投げる型は `UnreadablePracticeError`
   * （`@alteroid/core`、issue #2011）**——`PUT`/`DELETE /practices/:slug`
   * （`apps/daemon/src/app.ts`）と `practice_write`/`practice_remove`
   * （`packages/core/src/tools.ts`）が `instanceof` で見分け、「在ったが
   * 読めない」として書き直し・削除まで進むため。
   */
  async read(slug: string): Promise<Practice | null> {
    const file = await this.#read();
    const found = file.practices.find((entry) => entry.slug === slug);
    if (found !== undefined) return toPractice(found);
    const invalidRaw = file.invalidPracticesRaw.find((raw) => extractSlug(raw) === slug);
    if (invalidRaw === undefined) return null;
    const result = practiceRecordSchema.safeParse(invalidRaw);
    // `invalidPracticesRaw` に入っている時点で必ず失敗するはずだが、型の上
    // では `result.success` を保証できないので、成功していたら（起こり
    // 得ない）その値を返す——念のための保険であって、通常はここへ来ない。
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
    // **正規化を自分で書かない。** 出所は `@alteroid/core` の
    // `ensureTrailingNewline` 1箇所である（`PracticeStore.write` の doc と #370）。
    const content = ensureTrailingNewline(input.content);
    const now = new Date().toISOString();
    return this.#update((file) => {
      const existing = file.practices.find((entry) => entry.slug === input.slug);
      // **前提の版の比較は `#update`（`withPathLock` の内側）で、書き込みの直前に行う**
      // （Issue #2853）。外で読んでから入ると、その間の別の書き手を見逃す。
      // 読めない形の行は「無い」側に数える（`existing` が `undefined`。壊れた行の
      // 中身は安全に読めない）。`ifMatch` を持たない書き手は従来どおり書き直せる。
      if (!practiceVersionMatches(existing ?? null, options?.ifMatch)) {
        throw new PracticeConflictError(
          input.slug,
          existing === undefined ? null : toPractice(existing),
        );
      }
      const next = practiceRecordSchema.parse({
        slug: input.slug,
        kind: input.kind,
        title: input.title,
        content,
        // 上書きで作成時刻を捏造しない（`PracticeStore.write` の doc）。
        // **既存が壊れた行にしか無ければ `existing` は `undefined`**——
        // 壊れた行から `createdAt` を安全に取り出す手段が無いので、この
        // slug は新規作成として扱う（＝壊れた行を捨てて上書きする。
        // `FsScheduleStore.put` が壊れた kind に対して取る扱いと同じ）。
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      // ⭐ **書いた後の本文を版として追記する（#1309）。** 番号は「検査を通った
      // 版の最大値」と「壊れた生の行のうち、この slug と一致し `version` が
      // 正の整数として読めるものの最大値」の**両方の最大値 + 1**（issue #1967
      // のフォローアップ、マネージャー指摘）。
      //
      // ⚠️ **以前は「検査を通った版の数 + 1」（`priorVersions.length + 1`）
      // だけで決めていた。** 壊れた版の行（`invalidPracticeVersionsRaw`）を
      // 一切見ないので、`version` 欄そのものは正の整数として読める（他の欄が
      // 壊れているだけの）壊れた行と番号が重なることがあった——直す前は
      // 1行の不正で `#read()` 自体が丸ごと例外を投げていたので、この重なりは
      // そもそも起こり得なかった。この PR がその道連れ崩壊を直したことで、
      // 初めて踏めるようになった穴である。**追記専用の履歴（`practiceVersions`
      // の doc）で version が二重になる形を作らないために、壊れた行の中から
      // 読み取れる version 番号も衝突の判定に含める。**
      //
      // `version` 欄以外が壊れている壊れた行からは `version` を信用して
      // 読み取ってよい——`extractVersion` は `typeof` で数値であることしか
      // 見ないので、ここでさらに正の整数であることを確かめる（0 / 負値 /
      // 小数はそもそも `practiceVersionRecordSchema` の `version` の契約
      // （`z.number().int().positive()`）に合わない値なので、衝突の判定にも
      // 使わない）。
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
        kind: input.kind,
        title: input.title,
        content,
        at: now,
      });
      // **書き込む slug と一致する壊れた行は置き換える**（`FsJobStore.putJob`
      // と同じフォローアップ。issue #1740 / #1868 / #1967）。直したはずの
      // slug の壊れた行が `invalidPracticesRaw` として残り続けると、ファイル
      // に同じ slug が2行並び、以後 `list()` のたびに直したはずの跡が出続
      // ける——「直した」という呼び出し側の意図に対する驚きになる。
      //
      // **`practiceVersions` 側はここで filter しない。** 版の履歴は追記
      // 専用（#1309）で、同じ slug の版が何件も共存するのが正常な状態
      // ——`invalidPracticeVersionsRaw` も同じ理由で slug が一致するというだけ
      // では消さない（消すと、その slug の壊れた過去の版が書き戻しのたびに
      // 黙って失われる）。
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

  /**
   * **不正な行も slug 指定で消せる**（issue #1967。`FsScheduleStore.remove`
   * が #1944 でそろえた形と同じ理由）。`read()` が読めない行を投げたままに
   * する一方で、`remove()` まで `practices`（検査を通った行）だけを見ると、
   * 壊れた slug は「投げるので消せない」まま永久に残ってしまう——人間が
   * 復旧するための唯一の手を塞ぐことになる。`invalidPracticesRaw` も一緒に
   * filter する。
   *
   * **版は消さない**（`PracticeStore.remove` の doc、#1309）——`practices` /
   * `invalidPracticesRaw` からだけ間引き、`practiceVersions` /
   * `invalidPracticeVersionsRaw` には触れない。
   */
  async remove(slug: string, options?: RemovePracticeOptions): Promise<void> {
    await this.#update((file) => {
      // 前提の版（Issue #2923）。`#update`（`withPathLock` の内側）で消す直前に比べる。
      // 読めない形の行は「無い」側に数える（`write` と同じ）。
      if (options?.ifMatch !== undefined) {
        const existing = file.practices.find((entry) => entry.slug === slug);
        if (!practiceVersionMatches(existing ?? null, options.ifMatch)) {
          throw new PracticeConflictError(
            slug,
            existing === undefined ? null : toPractice(existing),
          );
        }
      }
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

  /**
   * **壊れた行（`invalidPracticesRaw` / `invalidPracticeVersionsRaw`）も
   * 一緒に消す**（`FsJobStore.clear` / `FsScheduleStore.clear` が #1868 /
   * #1944 でそろえた形と同じ理由。issue #1967）。`clear()` はワークスペース
   * リセット専用の全消去操作で、pg 実装は表の行を `DELETE` で全部消す
   * （`PgPracticeStore.clear` の doc）——行の中身が壊れているかどうかは
   * 関係なく消える。fs だけが壊れた行を生かして残すと、同じ `clear()` の
   * 意味が実装ごとに変わってしまう。
   *
   * **返す件数も、消した壊れた行を数える**（issue #1930 / #1892 と同じ扱い）。
   * ただし直す前から `practiceVersions` はこの件数に入っていない
   * （`PracticeStore.clear` の doc は「消した件数」を `practices` の側でだけ
   * 数える契約——`WorkspaceResetSummary` が「やり方が何件消えたか」を申告
   * するための数であり、版の履歴は別の軸として数えていない）。ここでは
   * その既存の数え方は変えず、`practices` 側の壊れた行だけを件数に足す。
   */
  async clear(): Promise<number> {
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

  /**
   * ある slug の版の一覧（メタだけ）。版番号の昇順。**不正な版の行は返さない**
   * （issue #1967。`list()` と同じ「読めるものだけを返し、投げない」線——版の
   * 一覧は個々の版の存在を保証する契約ではないので、`read()` / `readVersion()`
   * のような「読めない」throw とは別に扱う）。飛ばした行は `#read()` が
   * stderr へ跡を残す。
   */
  async listVersions(slug: string): Promise<PracticeVersionMeta[]> {
    return (await this.#read()).practiceVersions
      .filter((entry) => entry.slug === slug)
      .sort((a, b) => a.version - b.version)
      .map((entry) => toVersionMeta(entry));
  }

  /**
   * 版を1つ、本文まで読む。**`listVersions()` とは違い、読めない行は投げる**
   * （`PracticeStore.readVersion` の doc「無ければ null——`read()` と同じ線」。
   * `read()` / `FsScheduleStore.get` と同じ形・同じ理由。issue #1967）。
   * **投げる型は `read()` と同じ `UnreadablePracticeError`**（`version` も持つ。
   * issue #2011）。
   */
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

  /**
   * `practices.json` を読む。**`practices` と `practiceVersions` の両方を、
   * 行ごとに検査して不正な1行だけを飛ばす**（issue #1967。以前は
   * `fileSchema.parse` でそれぞれの配列全体を1回に検査していたため、1行でも
   * 不正だと `list()` / `listVersions()` が丸ごと例外を投げ、正しい行も
   * 読めなくなっていた）。
   *
   * **飛ばすのは行の形が不正なとき（欄が欠けている・型が違う、など）だけで
   * ある。** ファイルそのものが JSON として読めない・トップレベルの形が
   * 違う（`practices` / `practiceVersions` が配列でない等）ときは、いまの
   * 振る舞い（例外）のままにしてある——それは1行の問題ではないため。
   *
   * 飛ばした行は stderr へ1行の跡を残し（`describeSkippedPracticeRow` /
   * `describeSkippedPracticeVersionRow`。**値は title / content 等の本文を
   * 含めず、slug だけ**）、`invalidPracticesRaw` / `invalidPracticeVersionsRaw`
   * として生の形のまま保持する——`write` / `remove` / `clear` がこれを
   * 書き戻すことで、版ずれ・手編集でできた不正な行を黙って消さない。
   * **`read` / `readVersion` はこれを見て、読めない行を slug（+ version）
   * 指定で引かれたら投げる**（`list` / `listVersions` とは別の契約）。
   */
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

  /**
   * read-modify-write を直列化する（`FsScheduleStore.#update` と同じ形。
   * 排他の強さは `file-lock.ts` の doc）。
   *
   * **`write` の「既存の `createdAt` を引き継ぐ」は、読んでから書くまでの間に
   * 別の書き込みが挟まると壊れる**ので、この区間の中で決める。
   */
  async #update<T>(mutate: (file: PracticeFile) => { next: PracticeFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(serialize(next), null, 2)}\n`);
      return result;
    });
  }
}
