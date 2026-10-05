import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  assertValidActiveToken,
  activeAgentTokenSchema,
  agentTokenSchema,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  prepareTokensForReplace,
  tokenRotationSettingsSchema,
  UnreadableActiveTokenError,
  UnreadableTokenSettingsError,
  type ActiveAgentToken,
  type AgentToken,
  type TokenPoolStore,
  type TokenRotationSettings,
  type UnreadableToken,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * 認証トークンのプールの正本を持つ行のスキーマ。**`value` は素の文字列のまま
 * 保存する**——ここが正本を持つ唯一の場所であり、値を持たない顔（`AgentTokenView`）
 * は上の層（`token-pool-service.ts`）が作る。
 *
 * **本体は `@alteroid/core` の `agentTokenSchema`（issue #1652）。** 書き込み
 * 時の検査（`order: z.number().int()` 等）は3実装（fs / pg / インメモリ）で
 * 共有するためそちらへ移した——ここで `.extend()` しているのは、`source` だけ
 * fs のファイル形式特有の事情（下のコメント）があるためである。
 */
const agentTokenRowSchema = agentTokenSchema.extend({
  /**
   * **`'env'` も読めるようにしてある（書けない）。** 器の環境変数
   * （`CLAUDE_CODE_OAUTH_TOKEN`）を指す行という概念は廃止したので、新しく
   * `'env'` の行を書く経路はもう無い（`@alteroid/core` の `AgentToken.source`
   * は `'stored'` しか持たない——`agentTokenSchema` も同じく `'stored'` しか
   * 通さない）。**それでも過去にこの機構が書いた行がファイルに残っている
   * ことがある**——読めなければ `fileSchema.parse` がファイル全体を
   * 落としてしまうので、読めることだけは残し、`list()` 側で読み捨てる
   * （値を持たない行なので、そのまま渡すと `credentialOf` が壊れる）。
   */
  source: z.enum(['stored', 'env']).optional(),
});

/**
 * トップレベルの形だけを見る。**`tokens` / `settings` / `active` はどれも
 * ここでは検査しない**——`settings: tokenRotationSettingsSchema.optional()`
 * のように厳密な形にすると、1つが壊れているだけで `fileSchema.parse` が
 * ファイル全体を道連れにし、`tokens` まで読めなくなる（直す前の形。issue
 * #2053。`tokens` を配列のまま道連れにしていた issue #1942 と同じ穴の
 * 続き）。3つとも `#read()` が個別に `safeParse` する——`tokens` は行ごと
 * （既存。issue #1942）、`settings` / `active` は1個の値として（この直し）。
 *
 * **ここで投げる例外は今のままでよい**——`tokens` が配列でない・ファイルが
 * オブジェクトでない、はファイル全体の形の問題であって、1行・1項目の問題
 * ではない。
 */
const fileSchema = z.object({
  tokens: z.array(z.unknown()).default([]),
  settings: z.unknown().optional(),
  /**
   * いま撒いてある現役（Issue #393 PR3）。**まだ指名していなければ無い。**
   *
   * 設定（`settings`）と別の項目にしてあるのは、あちらの `updatedAt` が
   * 「人間かクローンが設定を変えた時刻」という意味を背負っているからである
   * （`ActiveAgentToken` の doc）。
   */
  active: z.unknown().optional(),
});

type AgentTokenRow = z.infer<typeof agentTokenRowSchema>;

/**
 * `tokens.json` の中身。**検査を通った値と、形が不正で読めなかった生の値
 * （パース前のまま）を、`tokens` / `settings` / `active` それぞれで分けて
 * 持つ**（issue #1942 の `invalidTokensRaw` を issue #2053 で `settings` /
 * `active` にも広げた形。`FsJobStore` の `JobFile` / `FsAuthStore` の
 * `AuthFile` と同じ考え方）。
 *
 * `invalidTokensRaw` / `invalidSettingsRaw` / `invalidActiveRaw` を消さずに
 * 持ち回るのが、この直しの核心である。`writeSettings` / `writeActive` は
 * いずれも最終的にこれを丸ごとシリアライズし直す（`#update`）ので、ここへ
 * 入れなかった値は次の書き込みで消える——検査を通った値だけを書けば、版
 * ずれ・手編集でできた不正な値が黙って消えることになる。**`replace()` も
 * `invalidTokensRaw` を持ち越す**（issue #2354。かつては `tokens` に限って
 * 捨てていた〈#1942〉が、決定で改めた。`replace()` の doc）。`replace()` が
 * 全文置換すると約束しているのは、読めた `tokens` だけである。読めない行を
 * 消す口は `removeUnreadable()`（id で指す）だけである。
 */
interface TokenPoolFile {
  tokens: AgentTokenRow[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。 */
  invalidTokensRaw: unknown[];
  settings?: TokenRotationSettings;
  /** `settings` が壊れていて読めなかったときの、生の値（パース前のまま）。 */
  invalidSettingsRaw?: unknown;
  active?: ActiveAgentToken;
  /** `active` が壊れていて読めなかったときの、生の値（パース前のまま）。 */
  invalidActiveRaw?: unknown;
}

const EMPTY: TokenPoolFile = { tokens: [], invalidTokensRaw: [] };

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである（`FsJobStore` の `summarizeInvalidFields` と
 * 同じ理由・同じ形）。
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
 * 生の要素から、値を出さずに「ラベル」だけを安全に取り出す（取れなければ
 * `undefined`）。**`value` には決して触れない**（issue #2346）。
 */
function extractRowLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const label = (raw as Record<string, unknown>).label;
  return typeof label === 'string' ? label : undefined;
}

/**
 * 飛ばした token 行を stderr へ1行で要約する。**id 以外の値は絶対に載せない**
 * ——`value`（トークン本体）が入りうる（`describeSkippedCredentialRow` と
 * 同じ理由。issue #1942）。
 */
function describeSkippedTokenRow(params: { index: number; reason: string; id?: string }): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: tokens の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

/**
 * `settings` / `active` が壊れていて読めないことを stderr へ1行で要約する。
 * **値は絶対に載せない**（`describeSkippedTokenRow` と同じ理由。issue
 * #2053）——`summarizeInvalidFields` が返すのは欄の名前だけである。
 *
 * **「消えたのではない」ことが分かる文言にする。** `readSettings()` /
 * `readActive()` が投げる例外（`UnreadableTokenSettingsError` /
 * `UnreadableActiveTokenError`）にも同じ理由で同じ言い回しを使う。
 */
function describeUnreadableTokenPoolField(params: {
  field: 'settings' | 'active';
  reason: string;
}): string {
  return (
    `alteroid: ${params.field} が読めない形で入っています（${params.reason}）。` +
    `消えたわけではありません——書き直せば直ります。`
  );
}

/**
 * 認証トークンのプールの置き場（既定 `~/.alteroid/tokens.json`）。
 *
 * **回さない**（Issue #393「PR1 プールの器」）。ここが持つのは正本の読み書きだけで、
 * 検知・切替は上の層が持つ（`@alteroid/core` の `createTokenRotator`）。
 *
 * `FsAuthStore`（`auth.ts`）と同じ書き方——**一時ファイルを 0600 で作ってから
 * rename する**。rename の後に絞ると、その隙間で他人が読める。
 */
export class FsTokenPoolStore implements TokenPoolStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#dir = dirname(path);
  }

  async list(): Promise<AgentToken[]> {
    const file = await this.#read();
    // **`source: 'env'` の行は読み捨てる。** 器の環境変数を指す行という概念は
    // 廃止した（値を持たないので、渡すと `credentialOf` が「値が無い」で
    // 投げる）。ファイルの `source` 列そのものは過去との読み取り互換のために
    // `'env'` を受け付けるが（{@link agentTokenRowSchema} の doc）、ここから先
    // （domain の {@link AgentToken}）には `'stored'` の行しか出さない。
    return file.tokens
      .filter((token): token is AgentToken => token.source !== 'env')
      .sort((a, b) => a.order - b.order);
  }

  /**
   * `list()` が読み飛ばした行を、**値を含まない形**（id・ラベル・不正な欄名だけ）で
   * 返す（issue #2346。`TokenPoolStore.listUnreadable` の doc）。飛ばした行は
   * `#read()` が stderr へ跡を残し、`invalidTokensRaw` として生かしたまま持ち回る。
   * **`value`（トークン本体）は取り出す経路そのものを作らない**——`extractRowId` /
   * `extractRowLabel` は名指しした欄しか読まない。
   */
  async listUnreadable(): Promise<UnreadableToken[]> {
    const { invalidTokensRaw } = await this.#read();
    return invalidTokensRaw.map((raw): UnreadableToken => {
      const id = extractRowId(raw);
      const label = extractRowLabel(raw);
      const result = agentTokenRowSchema.safeParse(raw);
      const reason = result.success ? '不正な行' : summarizeInvalidFields(result.error.issues);
      return {
        ...(id === undefined ? {} : { id }),
        ...(label === undefined ? {} : { label }),
        reason,
      };
    });
  }

  /**
   * 全文置換（`TokenPoolStore.replace` の doc）。**入力に無い読めた行は消えるが、読めずに
   * 持ち回っていた行（`invalidTokensRaw`）は消さずに持ち越す**（issue #2354 の決定）。
   *
   * **かつては一緒に捨てていた**（issue #1942。`FsJobStore.clear()` と同じ「壊れて
   * いるかどうかを問わず消す」向き、pg の全消去との揃え）。**#2354 で、理由を3つ
   * 挙げて持ち越しに改めた。**
   * - トークンを登録・無効化するのは人の手で、クローンにも回し手にもその権限は無い。
   *   人が入れた行を、自動の回転が知らせずに消してよい理由が無い——**この口は人の
   *   `PUT /tokens`（`TokenPoolService.replace`）と回し手の書き戻し
   *   （`token-rotator.ts` の `replace()`）の両方が通る**ので、捨てれば回転のたびに
   *   読めない行が消えうる。
   * - 「普段の書き戻しでは生の行を残す」という #1942 の半分（`writeSettings` /
   *   `writeActive` は `invalid*Raw` を持ち回る）と揃う。
   * - 失うものの重さが違う。捨てた跡が残っても鍵そのものは戻らない。持ち越して失う
   *   のは「全文置換の意味の純粋さ」だけである。
   *
   * **pg 実装（`PgTokenPoolStore.replace`）は全消去して積み直すが、読めない行を
   * そもそも持てない**（`listUnreadable()` が常に空）ので、実装間で失うものは
   * 食い違わない。**読めない行を消したいときは {@link FsTokenPoolStore.removeUnreadable}**
   * （id で指す）を使う。
   */
  async replace(tokens: readonly AgentToken[]): Promise<AgentToken[]> {
    const parsed = prepareTokensForReplace(tokens).map((token) => agentTokenRowSchema.parse(token));
    await this.#update((file) => ({ ...file, tokens: parsed }));
    return this.list();
  }

  /**
   * 読めない行を id で指して消す（`TokenPoolStore.removeUnreadable` の doc。issue #2354）。
   * `invalidTokensRaw` のうち `extractRowId` が一致する行だけを落とす——id が取れない行は
   * 指せないので残る。読めた行・`settings` / `active` には触れない。
   * **消した行の id だけを返す**（値は返さない）。読み書きは `#update` の排他の中で1回にまとめる。
   */
  async removeUnreadable(ids: readonly string[]): Promise<string[]> {
    const wanted = new Set(ids);
    const removed: string[] = [];
    await this.#update((file) => ({
      ...file,
      invalidTokensRaw: file.invalidTokensRaw.filter((raw) => {
        const id = extractRowId(raw);
        if (id === undefined || !wanted.has(id)) return true;
        removed.push(id);
        return false;
      }),
    }));
    return removed;
  }

  /**
   * **「無い」（既定値）と「読めない」（throw）を区別する**（`TokenPoolStore.
   * readSettings` の doc、issue #2053）。`settings` が壊れていて読めなかった
   * ときは `UnreadableTokenSettingsError` を投げる——既定値へすり替えると、
   * `off` にしてあった回転を実装が黙って戻すことになる。
   */
  async readSettings(): Promise<TokenRotationSettings> {
    const file = await this.#read();
    if (file.settings !== undefined) return file.settings;
    if (file.invalidSettingsRaw === undefined) return DEFAULT_TOKEN_ROTATION_SETTINGS;
    const reason = summarizeInvalidFields(
      tokenRotationSettingsSchema.safeParse(file.invalidSettingsRaw).error?.issues ?? [],
    );
    throw new UnreadableTokenSettingsError(
      `認証トークンの回転設定（settings）が読めない形で入っている（消されたのではない）: ${reason}`,
    );
  }

  /**
   * 壊れた既存値があっても上書きできる（`TokenPoolStore.readSettings` の
   * doc、issue #2053）——保持していた生の値（`invalidSettingsRaw`）を新しい
   * 値で置き換える。
   */
  async writeSettings(settings: TokenRotationSettings): Promise<TokenRotationSettings> {
    const parsed = tokenRotationSettingsSchema.parse(settings);
    await this.#update((file) => ({ ...file, settings: parsed, invalidSettingsRaw: undefined }));
    return parsed;
  }

  /**
   * **「無い」（`null`）と「読めない」（throw）を区別する**（issue #2053）。
   * `active` が壊れていて読めなかったときは `UnreadableActiveTokenError` を
   * 投げる——`null` へすり替えると、実際は指名済みなのに「まだ指名していない」
   * と嘘をつくことになる（`TokenPoolStore.readActive` の doc）。
   */
  async readActive(): Promise<ActiveAgentToken | null> {
    const file = await this.#read();
    // **無いものを「1本目が現役」で埋めない**（`TokenPoolStore.readActive` の doc）。
    if (file.active !== undefined) return file.active;
    if (file.invalidActiveRaw === undefined) return null;
    const reason = summarizeInvalidFields(
      activeAgentTokenSchema.safeParse(file.invalidActiveRaw).error?.issues ?? [],
    );
    throw new UnreadableActiveTokenError(
      `現役の認証トークンの指名（active）が読めない形で入っている（消されたのではない）: ${reason}`,
    );
  }

  /**
   * 壊れた既存値があっても上書きできる（issue #2053）——保持していた生の値
   * （`invalidActiveRaw`）を新しい値で置き換える。
   */
  async writeActive(active: ActiveAgentToken): Promise<ActiveAgentToken> {
    assertValidActiveToken(active);
    const parsed = activeAgentTokenSchema.parse(active);
    await this.#update((file) => ({ ...file, active: parsed, invalidActiveRaw: undefined }));
    return parsed;
  }

  /**
   * `tokens.json` を読む。**`tokens` は行ごとに検査し、不正な1行だけを飛ばす**
   * （issue #1942）。**`settings` / `active` も、`tokens` とは互いに独立に
   * 検査する**（issue #2053）——以前は `fileSchema.parse` がトップレベルの
   * `settings` / `active` まで一度に検査していたため、どちらか1つが不正な
   * だけで `list()` / `replace()` / `readSettings()` / `writeSettings()` /
   * `readActive()` / `writeActive()` が丸ごと例外を投げ、正しい `tokens` の
   * 行まで読めなくなっていた——`#read()` が `tokens` / `settings` / `active`
   * を同時に返す1つの関数だからである。pg 実装（`PgTokenPoolStore`）は
   * `tokens` が正規化された列を持つので、そもそも「1つの不正が他を道連れに
   * する」形をしていない（`settings` / `active` はそれぞれ独立の1行表）。
   *
   * **飛ばす・保持するのは値の形が不正なとき（欄が欠けている・型が違う、
   * など）だけである。** ファイルそのものが JSON として読めない・トップ
   * レベルの形が違う（`tokens` が配列でない等）ときは、いまの振る舞い
   * （例外）のままにしてある——それは1つの値の問題ではないため。
   *
   * 飛ばした・読めなかった値は stderr へ1行の跡を残し（`tokens` の行は
   * `describeSkippedTokenRow`。`settings` / `active` は
   * `describeUnreadableTokenPoolField`。**どちらも値そのものは含めず、
   * どこが不正かだけ**）、`invalidTokensRaw` / `invalidSettingsRaw` /
   * `invalidActiveRaw` として生の形のまま保持する——`writeSettings` /
   * `writeActive` がこれを書き戻すことで、版ずれ・手編集でできた不正な値を
   * 黙って消さない（`replace()` も持ち越す。消すのは `removeUnreadable()` だけ
   * ——issue #2354）。
   */
  async #read(): Promise<TokenPoolFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));
      const tokens: AgentTokenRow[] = [];
      const invalidTokensRaw: unknown[] = [];
      top.tokens.forEach((rawToken, index) => {
        const result = agentTokenRowSchema.safeParse(rawToken);
        if (result.success) {
          tokens.push(result.data);
          return;
        }
        invalidTokensRaw.push(rawToken);
        process.stderr.write(
          `${describeSkippedTokenRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawToken),
          })}\n`,
        );
      });

      let settings: TokenRotationSettings | undefined;
      let invalidSettingsRaw: unknown;
      if (top.settings !== undefined) {
        const result = tokenRotationSettingsSchema.safeParse(top.settings);
        if (result.success) {
          settings = result.data;
        } else {
          invalidSettingsRaw = top.settings;
          process.stderr.write(
            `${describeUnreadableTokenPoolField({
              field: 'settings',
              reason: summarizeInvalidFields(result.error.issues),
            })}\n`,
          );
        }
      }

      let active: ActiveAgentToken | undefined;
      let invalidActiveRaw: unknown;
      if (top.active !== undefined) {
        const result = activeAgentTokenSchema.safeParse(top.active);
        if (result.success) {
          active = result.data;
        } else {
          invalidActiveRaw = top.active;
          process.stderr.write(
            `${describeUnreadableTokenPoolField({
              field: 'active',
              reason: summarizeInvalidFields(result.error.issues),
            })}\n`,
          );
        }
      }

      return {
        tokens,
        invalidTokensRaw,
        ...(settings === undefined ? {} : { settings }),
        ...(invalidSettingsRaw === undefined ? {} : { invalidSettingsRaw }),
        ...(active === undefined ? {} : { active }),
        ...(invalidActiveRaw === undefined ? {} : { invalidActiveRaw }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（`FsAuthStore#update` と同じ `withPathLock`
   * ベースの排他。issue #1113 / #1050）。
   *
   * **検査を通った `tokens` と `invalidTokensRaw` を1本の `tokens` 配列へ
   * 合流させてから書く**（issue #1942）——分けたまま書くと、次の `#read()`
   * が `fileSchema`（トップレベルの形しか見ない）を通すときに未知のキー
   * （`invalidTokensRaw`）として黙って捨てられ、壊れた行を持ち回る意味が
   * 消える。**`settings` / `active` も同じ理由で、検査を通った値が無ければ
   * 保持していた生の値を書く**（issue #2053）——`writeSettings` /
   * `writeActive` は呼ばれた側だけ `invalid*Raw` を `undefined` にクリアする
   * ので（新しい値で置き換わる）、触っていない側の壊れた生の値はここで
   * 保持され続ける。
   */
  async #update(mutate: (file: TokenPoolFile) => TokenPoolFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const serialized = {
        tokens: [...next.tokens, ...next.invalidTokensRaw],
        settings: next.settings ?? next.invalidSettingsRaw,
        active: next.active ?? next.invalidActiveRaw,
      };
      // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。rename 後に
      // 絞ると、その隙間で他人が読める。
      await writeFileAtomic(this.#path, `${JSON.stringify(serialized, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  }
}
