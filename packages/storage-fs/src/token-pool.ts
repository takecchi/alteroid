import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  activeAgentTokenSchema,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  tokenRotationSettingsSchema,
  type ActiveAgentToken,
  type AgentToken,
  type TokenPoolStore,
  type TokenRotationSettings,
} from '@alteroid/core';
import { z } from 'zod';

/**
 * 認証トークンのプールの正本を持つ行のスキーマ。**`value` は素の文字列のまま
 * 保存する**——ここが正本を持つ唯一の場所であり、値を持たない顔（`AgentTokenView`）
 * は上の層（`token-pool-service.ts`）が作る。
 */
const agentTokenRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `source: 'env'` の行は持たない（器の環境変数を指すだけなので）。 */
  value: z.string().optional(),
  source: z.enum(['stored', 'env']).optional(),
  order: z.number().int(),
  disabledAt: z.string().optional(),
  cooldownUntil: z.number().optional(),
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
 * 検知・切替は上の層（後続の PR）が持つ。
 *
 * `FsAuthStore`（`auth.ts`）と同じ書き方——**一時ファイルを 0600 で作ってから
 * rename する**。rename の後に絞ると、その隙間で他人が読める。
 */
export class FsTokenPoolStore implements TokenPoolStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#dir = dirname(path);
  }

  async list(): Promise<AgentToken[]> {
    const file = await this.#read();
    return [...file.tokens].sort((a, b) => a.order - b.order);
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

  /** read-modify-write を直列化する（`FsAuthStore#update` と同じ最小の排他）。 */
  async #update(mutate: (file: TokenPoolFile) => TokenPoolFile): Promise<void> {
    const run = this.#chain.then(async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      // 一時ファイルの時点で 0600。rename 後に絞ると、その隙間で他人が読める。
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.#path);
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
