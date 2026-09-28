import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  activeAgentTokenSchema,
  agentTokenSchema,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  tokenRotationSettingsSchema,
  type ActiveAgentToken,
  type AgentToken,
  type TokenPoolStore,
  type TokenRotationSettings,
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
 * トップレベルの形だけを見る。**`tokens` の各要素はここでは検査しない**
 * ——`z.array(agentTokenRowSchema)` にすると、1行の不正が配列全体を道連れに
 * する（直す前の形。issue #1942。`FsJobStore` / `FsAuthStore` の
 * `fileSchema` と同じ理由・同じ形——issue #1868 / #1928）。行ごとの検査は
 * `#read()` が `agentTokenRowSchema.safeParse` で1行ずつ行う。
 *
 * **ここで投げる例外は今のままでよい**——`tokens` が配列でない・ファイルが
 * オブジェクトでない、はファイル全体の形の問題であって、1行の問題ではない。
 */
const fileSchema = z.object({
  tokens: z.array(z.unknown()).default([]),
  settings: tokenRotationSettingsSchema.optional(),
  /**
   * いま撒いてある現役（Issue #393 PR3）。**まだ指名していなければ無い。**
   *
   * 設定（`settings`）と別の項目にしてあるのは、あちらの `updatedAt` が
   * 「人間かクローンが設定を変えた時刻」という意味を背負っているからである
   * （`ActiveAgentToken` の doc）。
   */
  active: activeAgentTokenSchema.optional(),
});

type AgentTokenRow = z.infer<typeof agentTokenRowSchema>;

/**
 * `tokens.json` の中身。**検査を通った `tokens` と、形が不正で読めなかった
 * `invalidTokensRaw`（生の要素。パース前のまま）を分けて持つ**（issue
 * #1942。`FsJobStore` の `JobFile` / `FsAuthStore` の `AuthFile` と同じ形）。
 *
 * `invalidTokensRaw` を消さずに持ち回るのが、この直しの核心である。
 * `writeSettings` / `writeActive` はいずれも最終的にこれを丸ごとシリアライズ
 * し直す（`#update`）ので、ここへ入れなかった行は次の書き込みで消える——
 * `tokens`（検査を通った行）だけを書けば、版ずれ・手編集でできた不正な行が
 * 黙って消えることになる。**`replace()` だけは例外**——直下の doc を見よ。
 */
interface TokenPoolFile {
  tokens: AgentTokenRow[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。 */
  invalidTokensRaw: unknown[];
  settings?: TokenRotationSettings;
  active?: ActiveAgentToken;
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
   * 全文置換（`TokenPoolStore.replace` の doc）。**呼び手が「これが正本の
   * 全体だ」と渡す操作なので、壊れて持ち回っていた行（`invalidTokensRaw`）も
   * ここで一緒に捨てる**（issue #1942）——`FsJobStore.clear()` と同じ
   * 「壊れているかどうかを問わず消す」向き。pg 実装（`PgTokenPoolStore.replace`）
   * も `delete → insert` の1トランザクションで全消去してから積み直すので、
   * fs だけが古い壊れた行を持ち越すと、実装ごとに `replace()` の意味が
   * 変わってしまう。
   */
  async replace(tokens: readonly AgentToken[]): Promise<AgentToken[]> {
    const parsed = tokens.map((token) => agentTokenRowSchema.parse(token));
    await this.#update((file) => ({ ...file, tokens: parsed, invalidTokensRaw: [] }));
    return this.list();
  }

  async readSettings(): Promise<TokenRotationSettings> {
    const file = await this.#read();
    return file.settings ?? DEFAULT_TOKEN_ROTATION_SETTINGS;
  }

  async writeSettings(settings: TokenRotationSettings): Promise<TokenRotationSettings> {
    const parsed = tokenRotationSettingsSchema.parse(settings);
    await this.#update((file) => ({ ...file, settings: parsed }));
    return parsed;
  }

  async readActive(): Promise<ActiveAgentToken | null> {
    const file = await this.#read();
    // **無いものを「1本目が現役」で埋めない**（`TokenPoolStore.readActive` の doc）。
    return file.active ?? null;
  }

  async writeActive(active: ActiveAgentToken): Promise<ActiveAgentToken> {
    const parsed = activeAgentTokenSchema.parse(active);
    await this.#update((file) => ({ ...file, active: parsed }));
    return parsed;
  }

  /**
   * `tokens.json` を読む。**`tokens` は行ごとに検査し、不正な1行だけを飛ばす**
   * （issue #1942。以前は `fileSchema.parse` で配列全体を1回に検査していた
   * ため、1行でも不正だと `list()` / `replace()` / `readSettings()` /
   * `writeSettings()` / `readActive()` / `writeActive()` が丸ごと例外を投げ、
   * 正しい行も読めなくなっていた——`#read()` が `tokens` / `settings` /
   * `active` を同時に返す1つの関数だからである。pg 実装
   * （`PgTokenPoolStore`）は正規化された列を持つので、そもそも「1行の不正が
   * 他の行を道連れにする」形をしていない）。
   *
   * **飛ばすのは行の形が不正なとき（欄が欠けている・型が違う、など）だけ
   * である。** ファイルそのものが JSON として読めない・トップレベルの形が
   * 違う（`tokens` が配列でない等）ときは、いまの振る舞い（例外）のままに
   * してある——それは1行の問題ではないため。
   *
   * 飛ばした行は stderr へ1行の跡を残し（`describeSkippedTokenRow`。**値は
   * `value`（トークン本体）を含めず、id だけ**）、`invalidTokensRaw` として
   * 生の形のまま保持する——`writeSettings` / `writeActive` がこれを書き戻す
   * ことで、版ずれ・手編集でできた不正な行を黙って消さない（`replace()` は
   * 例外——直上の doc）。
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
      return { tokens, invalidTokensRaw, settings: top.settings, active: top.active };
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
   * 消える。
   */
  async #update(mutate: (file: TokenPoolFile) => TokenPoolFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const serialized = {
        tokens: [...next.tokens, ...next.invalidTokensRaw],
        settings: next.settings,
        active: next.active,
      };
      // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。rename 後に
      // 絞ると、その隙間で他人が読める。
      await writeFileAtomic(this.#path, `${JSON.stringify(serialized, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  }
}
