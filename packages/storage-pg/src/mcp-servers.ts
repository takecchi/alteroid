import { parseMcpServers } from '@alteroid/core';
import type { McpServers, McpServerStore, StoredMcpServers } from '@alteroid/core';
import { eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { mcpServers } from './schema.js';

/** 高々1行しか持たない表なので、鍵は固定でよい（`PgProfileStore` と同じ）。 */
const MCP_SERVERS_ID = 'default';

/**
 * 人間の MCP 連携の登録の置き場（クラウド段。#325 段1）。
 *
 * fs 版（`~/.alteroid/mcp-servers.json`）と同じものの器違いである。**Railway では
 * これが唯一の置き場になる** —— volume が無いので、`.mcp.json` をファイルで
 * 置いても器と一緒に消える（#325 本文）。
 *
 * **読むときにも検査する**（`FsMcpServerStore` と同じ理由）。jsonb は SQL から
 * 直接書き換えられるので、入口で見ただけでは足りない。
 */
export class PgMcpServerStore implements McpServerStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async read(): Promise<StoredMcpServers | null> {
    const rows = await this.#db
      .select({ servers: mcpServers.servers, updatedAt: mcpServers.updatedAt })
      .from(mcpServers)
      .where(eq(mcpServers.id, MCP_SERVERS_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const servers = parseMcpServers(row.servers);
    if (Object.keys(servers).length === 0) return null;
    return { mcpServers: servers, updatedAt: row.updatedAt.toISOString() };
  }

  async write(input: McpServers): Promise<StoredMcpServers> {
    // **書く前に検査する**（`McpServerStore.write` の doc）。不正ならここで投げ、
    // 表には触れない（前のものが残る）。
    const servers = parseMcpServers(input);
    const at = new Date();
    if (Object.keys(servers).length === 0) {
      await this.#db.delete(mcpServers).where(eq(mcpServers.id, MCP_SERVERS_ID));
      return { mcpServers: {}, updatedAt: at.toISOString() };
    }
    await this.#db
      .insert(mcpServers)
      .values({ id: MCP_SERVERS_ID, servers, updatedAt: at })
      .onConflictDoUpdate({ target: mcpServers.id, set: { servers, updatedAt: at } });
    return { mcpServers: servers, updatedAt: at.toISOString() };
  }
}
