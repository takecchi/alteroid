import {
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  tokenRotationPolicySchema,
  type ActiveAgentToken,
  type AgentToken,
  type TokenPoolStore,
  type TokenRotationSettings,
} from '@alteroid/core';
import { asc, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { agentTokenActive, agentTokenSettings, agentTokens } from './schema.js';

/** 高々1行しか持たない表なので、鍵は固定でよい（`env_profile` と同じ作法）。 */
const SETTINGS_ID = 'default';

/** 現役の指名も高々1行なので、鍵は固定でよい（設定と同じ作法）。 */
const ACTIVE_ID = 'default';

type AgentTokenRow = typeof agentTokens.$inferSelect;

function toRow(token: AgentToken) {
  return {
    id: token.id,
    label: token.label,
    value: token.value ?? null,
    // **null は `stored`**（後から足した列なので既存の行は null）。既定を書き戻して
    // 「'stored' の行」と「列が無い行」を混在させない。
    source: token.source === 'env' ? 'env' : null,
    order: token.order,
    disabledAt: token.disabledAt === undefined ? null : new Date(token.disabledAt),
    cooldownUntil: token.cooldownUntil ?? null,
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
    ...(row.source === 'env' ? { source: 'env' as const } : {}),
    order: row.order,
    ...(row.disabledAt === null ? {} : { disabledAt: row.disabledAt.toISOString() }),
    ...(row.cooldownUntil === null ? {} : { cooldownUntil: row.cooldownUntil }),
    ...(row.lastRejectedAt === null ? {} : { lastRejectedAt: row.lastRejectedAt.toISOString() }),
    ...(row.lastRejectedReason === null ? {} : { lastRejectedReason: row.lastRejectedReason }),
    ...(row.invalidatedAt === null ? {} : { invalidatedAt: row.invalidatedAt.toISOString() }),
    ...(row.invalidatedReason === null ? {} : { invalidatedReason: row.invalidatedReason }),
    ...(row.createdAt === null ? {} : { createdAt: row.createdAt.toISOString() }),
    ...(row.updatedAt === null ? {} : { updatedAt: row.updatedAt.toISOString() }),
  };
}

/**
 * 認証トークンのプールの置き場（クラウド段。Issue #393「PR1 プールの器」）。
 *
 * fs 版（`~/.alteroid/tokens.json`）と同じものの器違いである——**回さない**の
 * 約束も同じ。この表を runner から読ませない（`auth-and-access` / `env_profile`
 * と同じ理由——読ませられるということは runner に記憶ストアの鍵があるという
 * ことで、M4 受け入れ基準3 が無いと言っているものである）。
 */
export class PgTokenPoolStore implements TokenPoolStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<AgentToken[]> {
    const rows = await this.#db.select().from(agentTokens).orderBy(asc(agentTokens.order));
    return rows.map(fromRow);
  }

  /**
   * 全文置換。**1トランザクションで delete → insert**——途中で落ちて半分だけ
   * 入る形を作らない（片方の行だけ古い・新しいが混ざると、`order` の一意性も
   * 「全部消えて全部戻る」という約束も崩れる）。
   */
  async replace(tokens: readonly AgentToken[]): Promise<AgentToken[]> {
    await this.#db.transaction(async (tx) => {
      await tx.delete(agentTokens);
      if (tokens.length > 0) {
        await tx.insert(agentTokens).values(tokens.map(toRow));
      }
    });
    return this.list();
  }

  async readSettings(): Promise<TokenRotationSettings> {
    const rows = await this.#db
      .select()
      .from(agentTokenSettings)
      .where(eq(agentTokenSettings.id, SETTINGS_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return DEFAULT_TOKEN_ROTATION_SETTINGS;
    return {
      rotateOn: tokenRotationPolicySchema.parse(row.rotateOn),
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
    // **無いものを「1本目が現役」で埋めない**（`TokenPoolStore.readActive` の doc）。
    if (row === undefined) return null;
    return {
      tokenId: row.tokenId,
      generation: row.generation,
      rotatedAt: row.rotatedAt.toISOString(),
    };
  }

  async writeActive(active: ActiveAgentToken): Promise<ActiveAgentToken> {
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
