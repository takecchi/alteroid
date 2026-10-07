import {
  McpServersConflictError,
  mcpServersVersionOf,
  parseMcpServers,
  prepareMcpServersForWrite,
  sortMcpServers,
} from '@alteroid/core';
import type {
  McpServers,
  McpServerStore,
  StoredMcpServers,
  WriteMcpServersOptions,
} from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { mcpServers } from './schema.js';

const MCP_SERVERS_ID = 'default';

// 入口の検査だけで済ませない: jsonb は SQL から直接書き換えられるため、読むときにも検査する。
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
    const servers = sortMcpServers(parseMcpServers(row.servers));
    if (Object.keys(servers).length === 0) return null;
    return { mcpServers: servers, updatedAt: row.updatedAt.toISOString() };
  }

  async write(input: McpServers, options?: WriteMcpServersOptions): Promise<StoredMcpServers> {
    const servers = parseMcpServers(prepareMcpServersForWrite(input));
    const ifMatch = options?.ifMatch;
    if (ifMatch === undefined) return this.#replace(this.#db, servers);
    // 行が無いこともあるので `for update` ではなく advisory lock で、読む前から書き終わりまで直列にする。
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('alteroid.mcp_servers'))`);
      const rows = await tx
        .select({ servers: mcpServers.servers, updatedAt: mcpServers.updatedAt })
        .from(mcpServers)
        .where(eq(mcpServers.id, MCP_SERVERS_ID))
        .limit(1);
      const row = rows[0];
      const parsed = row === undefined ? {} : sortMcpServers(parseMcpServers(row.servers));
      const current =
        row === undefined || Object.keys(parsed).length === 0
          ? null
          : { mcpServers: parsed, updatedAt: row.updatedAt.toISOString() };
      if (ifMatch !== mcpServersVersionOf(current)) throw new McpServersConflictError(current);
      return this.#replace(tx, servers);
    });
  }

  async #replace(db: Db, servers: McpServers): Promise<StoredMcpServers> {
    const at = new Date();
    if (Object.keys(servers).length === 0) {
      await db.delete(mcpServers).where(eq(mcpServers.id, MCP_SERVERS_ID));
      return { mcpServers: {}, updatedAt: at.toISOString() };
    }
    await db
      .insert(mcpServers)
      .values({ id: MCP_SERVERS_ID, servers, updatedAt: at })
      .onConflictDoUpdate({ target: mcpServers.id, set: { servers, updatedAt: at } });
    return { mcpServers: sortMcpServers(servers), updatedAt: at.toISOString() };
  }
}
