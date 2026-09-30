import {
  activeAgentTokenSchema,
  cooldownSourceSchema,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
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

/** 高々1行しか持たない表なので、鍵は固定でよい（`env_profile` と同じ作法）。 */
const SETTINGS_ID = 'default';

/** 現役の指名も高々1行なので、鍵は固定でよい（設定と同じ作法）。 */
const ACTIVE_ID = 'default';

type AgentTokenRow = typeof agentTokens.$inferSelect;

/**
 * 不正な値を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れ
 * ない（実測 2026-09-29: この repo の zod 版では enum の既定メッセージは
 * 値そのものを含まない形だったが、それに依存しない）。出すのは「どの欄が」
 * だけである（fs 側 `packages/storage-fs/src/token-pool.ts` の
 * `summarizeInvalidFields` / `PgScheduleStore` の同名関数と同じ理由・同じ
 * 形。パッケージを跨いだ共通化はしていない。issue #2053）。
 */
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
    // **null は `stored`**（後から足した列なので既存の行は null）。既定を書き戻して
    // 「'stored' の行」と「列が無い行」を混在させない。
    //
    // **もう `'env'` は書かない。** 器の環境変数を指す行という概念は廃止した
    // （`@alteroid/core` の `AgentToken.source` は `'stored'` しか持たない）ので、
    // ここへ来る `token.source` はもう `'env'` になりえない。
    source: token.source === 'stored' ? 'stored' : null,
    order: token.order,
    disabledAt: token.disabledAt === undefined ? null : new Date(token.disabledAt),
    cooldownUntil: token.cooldownUntil ?? null,
    // **null は「出所を言えない」である**（#683。`default` で埋めない）。
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
    // **`'env'` はもう domain 値として作らない。** 器の環境変数を指す行という
    // 概念は廃止した（`@alteroid/core` の `AgentToken.source` は `'stored'` しか
    // 持たない）——過去にこの機構が書いた行（`source = 'env'`、`value` 無し）が
    // 列にそのまま残っていることがあるが、それは `list()` 側で読み捨てる。
    ...(row.source === 'stored' ? { source: 'stored' as const } : {}),
    order: row.order,
    ...(row.disabledAt === null ? {} : { disabledAt: row.disabledAt.toISOString() }),
    ...(row.cooldownUntil === null ? {} : { cooldownUntil: row.cooldownUntil }),
    // **読めない語は落とす。** 列は `text` なので、この版が知らない語（版が
    // 進んだ後に戻したとき）も入りうる —— そのまま持ち上げると `AgentToken`
    // の型が嘘になる。**落ちた先は「出所を言えない」で、それは正しい。**
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
    // **`source = 'env'` の行は読み捨てる。** 器の環境変数を指す行という概念は
    // 廃止した（値を持たないので、渡すと `credentialOf` が「値が無い」で
    // 投げる）——`fromRow` の doc と同じ理由。
    return rows.filter((row) => row.source !== 'env').map(fromRow);
  }

  /**
   * **常に空**（issue #2346。`TokenPoolStore.listUnreadable` の doc）。pg は行を正規化した
   * 列で持つので、fs のように「形が合わない行」を作れない——`fromRow` は知らない
   * `cooldownSource` の語を落とすだけで、その行は読めている（「出所を言えない」が
   * 正しい）。`source = 'env'` の行を読み捨てるのは廃止した概念の残骸であって、
   * 読めない行ではない。**これを「読めない行が無いことの証明」と読まないこと**——
   * 列の型が守っているのは DB が受け付けた値の形までである。
   */
  async listUnreadable(): Promise<UnreadableToken[]> {
    return [];
  }

  /**
   * **常に空を返す**（issue #2354。`TokenPoolStore.removeUnreadable` の doc）。
   * 読めない行を持てないので、消すものが無い。
   */
  async removeUnreadable(): Promise<string[]> {
    return [];
  }

  /**
   * 全文置換。**1トランザクションで delete → insert**——途中で落ちて半分だけ
   * 入る形を作らない（片方の行だけ古い・新しいが混ざると、`order` の一意性も
   * 「全部消えて全部戻る」という約束も崩れる）。
   *
   * **fs 実装とは違い、持ち越す「読めない行」が無い**（issue #2354。fs は読めない行を
   * 持ち越す——`FsTokenPoolStore.replace` の doc）。pg は正規化された列で持つので
   * 読めない行を作れず、`listUnreadable()` は常に空である。そのため全消去して積み直しても
   * 失う読めない行は無く、意味は実装間で食い違わない。
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

  /**
   * **「無い」（既定値）と「読めない」（throw）を区別する**（issue #2053）。
   * `rotateOn` が版ずれ・手編集で enum の外になっている等、行はあるが
   * `tokenRotationPolicySchema` を通らないときは `UnreadableTokenSettingsError`
   * を投げる——既定値へすり替えると、`off` にしてあった回転を実装が黙って
   * 戻すことになる（`TokenPoolStore.readSettings` の doc）。`writeSettings()`
   * はこの状態でも上書きできる（読まずに書くため——下の doc）。
   */
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
      // **この列だけを検査しているので、不正な欄は常に `rotateOn` である。**
      // `summarizeInvalidFields` を通さないのは、`row.rotateOn` 単体の
      // safeParse では issue の `path` が空（ルート）になり、欄名が
      // `summarizeInvalidFields` の `(root)` に潰れてしまうため。
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

  /**
   * **「無い」（`null`）と「読めない」（throw）を区別する**（issue #2053）。
   * 列は `NOT NULL` だが、`tokenId`（空文字）・`generation`（負の数）は列の
   * 型では防げない——`activeAgentTokenSchema` を通らないときは
   * `UnreadableActiveTokenError` を投げる（`TokenPoolStore.readActive` の
   * doc）。`writeActive()` はこの状態でも上書きできる（読まずに書くため）。
   */
  async readActive(): Promise<ActiveAgentToken | null> {
    const rows = await this.#db
      .select()
      .from(agentTokenActive)
      .where(eq(agentTokenActive.id, ACTIVE_ID))
      .limit(1);
    const row = rows[0];
    // **無いものを「1本目が現役」で埋めない**（`TokenPoolStore.readActive` の doc）。
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
