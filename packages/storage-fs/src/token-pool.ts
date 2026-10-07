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

const agentTokenRowSchema = agentTokenSchema.extend({
  // `'env'` も読めるようにする: 過去に書かれた行がファイルに残っており、読めないと `fileSchema.parse` がファイル全体を落とすため
  source: z.enum(['stored', 'env']).optional(),
});

// 中身はここで検査しない: 厳密な形にすると、1つの破損で `fileSchema.parse` がファイル全体を道連れにし、`tokens` まで読めなくなるため
const fileSchema = z.object({
  tokens: z.array(z.unknown()).default([]),
  settings: z.unknown().optional(),
  // `settings` と別の項目にする: あちらの `updatedAt` が「設定を変えた時刻」という意味を背負っているため
  active: z.unknown().optional(),
});

type AgentTokenRow = z.infer<typeof agentTokenRowSchema>;

interface TokenPoolFile {
  tokens: AgentTokenRow[];
  // `invalid*Raw` は消さずに持ち回る: 書き戻しに入れないと、次の書き込みで消えるため
  invalidTokensRaw: unknown[];
  settings?: TokenRotationSettings;
  invalidSettingsRaw?: unknown;
  active?: ActiveAgentToken;
  invalidActiveRaw?: unknown;
}

const EMPTY: TokenPoolFile = { tokens: [], invalidTokensRaw: [] };

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

// `value` には触れない: トークン本体が入るため
function extractRowLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const label = (raw as Record<string, unknown>).label;
  return typeof label === 'string' ? label : undefined;
}

// id 以外の値は載せない: `value`（トークン本体）が入りうるため
function describeSkippedTokenRow(params: { index: number; reason: string; id?: string }): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: tokens の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

function describeUnreadableTokenPoolField(params: {
  field: 'settings' | 'active';
  reason: string;
}): string {
  return (
    `alteroid: ${params.field} が読めない形で入っています（${params.reason}）。` +
    `消えたわけではありません——書き直せば直ります。`
  );
}

export class FsTokenPoolStore implements TokenPoolStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#dir = dirname(path);
  }

  async list(): Promise<AgentToken[]> {
    const file = await this.#read();
    // `source: 'env'` の行は読み捨てる: 値を持たない行を渡すと、`credentialOf` が「値が無い」で投げるため
    return file.tokens
      .filter((token): token is AgentToken => token.source !== 'env')
      .sort((a, b) => a.order - b.order);
  }

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

  async replace(tokens: readonly AgentToken[]): Promise<AgentToken[]> {
    // 読めない行（`invalidTokensRaw`）は捨てず持ち越す: 人の手で入れた行を自動の回転が知らせず消してよい理由が無く、この口は回し手の書き戻しも通るため
    const parsed = prepareTokensForReplace(tokens).map((token) => agentTokenRowSchema.parse(token));
    await this.#update((file) => ({ ...file, tokens: parsed }));
    return this.list();
  }

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

  async readSettings(): Promise<TokenRotationSettings> {
    const file = await this.#read();
    if (file.settings !== undefined) return file.settings;
    if (file.invalidSettingsRaw === undefined) return DEFAULT_TOKEN_ROTATION_SETTINGS;
    // 読めないときは既定値にせず投げる: すり替えると、`off` にしてあった回転を黙って戻すため
    const reason = summarizeInvalidFields(
      tokenRotationSettingsSchema.safeParse(file.invalidSettingsRaw).error?.issues ?? [],
    );
    throw new UnreadableTokenSettingsError(
      `認証トークンの回転設定（settings）が読めない形で入っている（消されたのではない）: ${reason}`,
    );
  }

  async writeSettings(settings: TokenRotationSettings): Promise<TokenRotationSettings> {
    const parsed = tokenRotationSettingsSchema.parse(settings);
    await this.#update((file) => ({ ...file, settings: parsed, invalidSettingsRaw: undefined }));
    return parsed;
  }

  async readActive(): Promise<ActiveAgentToken | null> {
    const file = await this.#read();
    if (file.active !== undefined) return file.active;
    if (file.invalidActiveRaw === undefined) return null;
    // 読めないときは `null` にせず投げる: すり替えると、指名済みなのに「まだ指名していない」と嘘をつくため
    const reason = summarizeInvalidFields(
      activeAgentTokenSchema.safeParse(file.invalidActiveRaw).error?.issues ?? [],
    );
    throw new UnreadableActiveTokenError(
      `現役の認証トークンの指名（active）が読めない形で入っている（消されたのではない）: ${reason}`,
    );
  }

  async writeActive(active: ActiveAgentToken): Promise<ActiveAgentToken> {
    assertValidActiveToken(active);
    const parsed = activeAgentTokenSchema.parse(active);
    await this.#update((file) => ({ ...file, active: parsed, invalidActiveRaw: undefined }));
    return parsed;
  }

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

  async #update(mutate: (file: TokenPoolFile) => TokenPoolFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // 壊れた生の値も同じファイルへ合流させて書く: 分けたまま書くと、次の `#read()` で未知のキーとして黙って捨てられるため
      const serialized = {
        tokens: [...next.tokens, ...next.invalidTokensRaw],
        settings: next.settings ?? next.invalidSettingsRaw,
        active: next.active ?? next.invalidActiveRaw,
      };
      // rename 後に絞らず、一時ファイルを 0600 で作る: 隙間で他人が読めるため
      await writeFileAtomic(this.#path, `${JSON.stringify(serialized, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  }
}
