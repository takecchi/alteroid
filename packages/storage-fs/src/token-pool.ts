import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  activeAgentTokenSchema,
  cooldownSourceSchema,
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
 */
const agentTokenRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string().optional(),
  /**
   * **`'env'` も読めるようにしてある（書けない）。** 器の環境変数
   * （`CLAUDE_CODE_OAUTH_TOKEN`）を指す行という概念は廃止したので、新しく
   * `'env'` の行を書く経路はもう無い（`@alteroid/core` の `AgentToken.source`
   * は `'stored'` しか持たない）。**それでも過去にこの機構が書いた行が
   * ファイルに残っていることがある**——読めなければ `fileSchema.parse` が
   * ファイル全体を落としてしまうので、読めることだけは残し、`list()` 側で
   * 読み捨てる（値を持たない行なので、そのまま渡すと `credentialOf` が壊れる）。
   */
  source: z.enum(['stored', 'env']).optional(),
  order: z.number().int(),
  disabledAt: z.string().optional(),
  cooldownUntil: z.number().optional(),
  /**
   * 冷却の期限の出所（#683。`@alteroid/core` の `CooldownSource`）。
   *
   * **無い行が在る**（#683 より前に書かれたファイル）。**既定値を持たせない**
   * ——`default` で埋めると「推測だと観測した」という嘘になる。
   */
  cooldownSource: cooldownSourceSchema.optional(),
  lastRejectedAt: z.string().optional(),
  lastRejectedReason: z.string().optional(),
  invalidatedAt: z.string().optional(),
  invalidatedReason: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const fileSchema = z.object({
  tokens: z.array(agentTokenRowSchema).default([]),
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

type TokenPoolFile = z.infer<typeof fileSchema>;

const EMPTY: TokenPoolFile = { tokens: [] };

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

  async replace(tokens: readonly AgentToken[]): Promise<AgentToken[]> {
    const parsed = tokens.map((token) => agentTokenRowSchema.parse(token));
    await this.#update((file) => ({ ...file, tokens: parsed }));
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

  async #read(): Promise<TokenPoolFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（`FsAuthStore#update` と同じ `withPathLock`
   * ベースの排他。issue #1113 / #1050）。
   */
  async #update(mutate: (file: TokenPoolFile) => TokenPoolFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。rename 後に
      // 絞ると、その隙間で他人が読める。
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    });
  }
}
