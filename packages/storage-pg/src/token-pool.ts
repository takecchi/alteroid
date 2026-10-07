import {
  assertValidActiveToken,
  activeAgentTokenSchema,
  cooldownSourceSchema,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  prepareTokensForReplace,
  tokenRotationPolicySchema,
  UnreadableActiveTokenError,
  UnreadableTokenSettingsError,
  type ActiveAgentToken,
  type AgentToken,
  type TokenPoolStore,
  type TokenRotationSettings,
  type UnreadableToken,
} from '@alteroid/core';
import { asc, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { agentTokenActive, agentTokenSettings, agentTokens } from './schema.js';

const SETTINGS_ID = 'default';

const ACTIVE_ID = 'default';

type AgentTokenRow = typeof agentTokens.$inferSelect;

// `issue.message` を使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わっても値が漏れないようにするため。
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function toRow(token: AgentToken) {
  return {
    id: token.id,
    label: token.label,
    value: token.value ?? null,
    // 既定を書き戻さない: 「'stored' の行」と「列が無い行」が混在するため。
    source: token.source === 'stored' ? 'stored' : null,
    order: token.order,
    disabledAt: token.disabledAt === undefined ? null : new Date(token.disabledAt),
    cooldownUntil: token.cooldownUntil ?? null,
    // `default` で埋めない: null は「出所を言えない」を表すため。
    cooldownSource: token.cooldownSource ?? null,
    lastRejectedAt: token.lastRejectedAt === undefined ? null : new Date(token.lastRejectedAt),
    lastRejectedReason: token.lastRejectedReason ?? null,
    invalidatedAt: token.invalidatedAt === undefined ? null : new Date(token.invalidatedAt),
    invalidatedReason: token.invalidatedReason ?? null,
    createdAt: token.createdAt === undefined ? null : new Date(token.createdAt),
    updatedAt: token.updatedAt === undefined ? null : new Date(token.updatedAt),
  };
}

function fromRow(row: AgentTokenRow): AgentToken {
  return {
    id: row.id,
    label: row.label,
    ...(row.value === null ? {} : { value: row.value }),
    ...(row.source === 'stored' ? { source: 'stored' as const } : {}),
    order: row.order,
    ...(row.disabledAt === null ? {} : { disabledAt: row.disabledAt.toISOString() }),
    ...(row.cooldownUntil === null ? {} : { cooldownUntil: row.cooldownUntil }),
    // 知らない語をそのまま持ち上げない: 版を戻したときに入りうる語で、`AgentToken` の型が嘘になるため。
    ...(row.cooldownSource === null
      ? {}
      : cooldownSourceSchema.safeParse(row.cooldownSource).success
        ? { cooldownSource: cooldownSourceSchema.parse(row.cooldownSource) }
        : {}),
    ...(row.lastRejectedAt === null ? {} : { lastRejectedAt: row.lastRejectedAt.toISOString() }),
    ...(row.lastRejectedReason === null ? {} : { lastRejectedReason: row.lastRejectedReason }),
    ...(row.invalidatedAt === null ? {} : { invalidatedAt: row.invalidatedAt.toISOString() }),
    ...(row.invalidatedReason === null ? {} : { invalidatedReason: row.invalidatedReason }),
    ...(row.createdAt === null ? {} : { createdAt: row.createdAt.toISOString() }),
    ...(row.updatedAt === null ? {} : { updatedAt: row.updatedAt.toISOString() }),
  };
}

// この表を runner から読ませない: runner に記憶ストアの鍵があることになるため。
export class PgTokenPoolStore implements TokenPoolStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<AgentToken[]> {
    const rows = await this.#db.select().from(agentTokens).orderBy(asc(agentTokens.order));
    // `source = 'env'` の行を渡さない: 値を持たないので `credentialOf` が「値が無い」で投げるため。
    return rows.filter((row) => row.source !== 'env').map(fromRow);
  }

  async listUnreadable(): Promise<UnreadableToken[]> {
    return [];
  }

  async removeUnreadable(): Promise<string[]> {
    return [];
  }

  // 1トランザクションで delete → insert する: 途中で落ちて半分だけ入ると、`order` の一意性も「全部消えて全部戻る」約束も崩れるため。
  async replace(tokens: readonly AgentToken[]): Promise<AgentToken[]> {
    const prepared = prepareTokensForReplace(tokens);
    await this.#db.transaction(async (tx) => {
      await tx.delete(agentTokens);
      if (prepared.length > 0) {
        await tx.insert(agentTokens).values(prepared.map(toRow));
      }
    });
    return this.list();
  }

  // 読めない行を既定値へすり替えない: `off` にしてあった回転を黙って戻すことになるため。
  async readSettings(): Promise<TokenRotationSettings> {
    const rows = await this.#db
      .select()
      .from(agentTokenSettings)
      .where(eq(agentTokenSettings.id, SETTINGS_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return DEFAULT_TOKEN_ROTATION_SETTINGS;
    const rotateOn = tokenRotationPolicySchema.safeParse(row.rotateOn);
    if (!rotateOn.success) {
      // `summarizeInvalidFields` を通さない: `row.rotateOn` 単体の safeParse では `path` が空になり、欄名が `(root)` に潰れるため。
      throw new UnreadableTokenSettingsError(
        '認証トークンの回転設定（settings）が読めない形で入っている（消されたのではない）: 不正な欄: rotateOn',
      );
    }
    return {
      rotateOn: rotateOn.data,
      cooldownMs: row.cooldownMs,
      ...(row.updatedAt === null ? {} : { updatedAt: row.updatedAt.toISOString() }),
    };
  }

  async readActive(): Promise<ActiveAgentToken | null> {
    const rows = await this.#db
      .select()
      .from(agentTokenActive)
      .where(eq(agentTokenActive.id, ACTIVE_ID))
      .limit(1);
    const row = rows[0];
    // 無いものを「1本目が現役」で埋めない。
    if (row === undefined) return null;
    const parsed = activeAgentTokenSchema.safeParse({
      tokenId: row.tokenId,
      generation: row.generation,
      rotatedAt: row.rotatedAt.toISOString(),
    });
    if (!parsed.success) {
      throw new UnreadableActiveTokenError(
        `現役の認証トークンの指名（active）が読めない形で入っている（消されたのではない）: ` +
          summarizeInvalidFields(parsed.error.issues),
      );
    }
    return parsed.data;
  }

  async writeActive(active: ActiveAgentToken): Promise<ActiveAgentToken> {
    assertValidActiveToken(active);
    const rotatedAt = new Date(active.rotatedAt);
    await this.#db
      .insert(agentTokenActive)
      .values({
        id: ACTIVE_ID,
        tokenId: active.tokenId,
        generation: active.generation,
        rotatedAt,
      })
      .onConflictDoUpdate({
        target: agentTokenActive.id,
        set: { tokenId: active.tokenId, generation: active.generation, rotatedAt },
      });
    return active;
  }

  async writeSettings(settings: TokenRotationSettings): Promise<TokenRotationSettings> {
    const updatedAt = settings.updatedAt === undefined ? null : new Date(settings.updatedAt);
    await this.#db
      .insert(agentTokenSettings)
      .values({
        id: SETTINGS_ID,
        rotateOn: settings.rotateOn,
        cooldownMs: settings.cooldownMs,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: agentTokenSettings.id,
        set: { rotateOn: settings.rotateOn, cooldownMs: settings.cooldownMs, updatedAt },
      });
    return settings;
  }
}
