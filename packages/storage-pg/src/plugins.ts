import {
  PluginNameConflictError,
  isValidPluginName,
  parsePluginInput,
  parsePluginSummary,
  parseStoredPlugin,
  pluginSummaryOf,
  sortPluginSummaries,
} from '@alteroid/core';
import type { PluginInput, PluginStore, PluginSummary, StoredPlugin } from '@alteroid/core';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { toIso, toNumber } from './db.js';
import { pluginFiles, plugins } from './schema.js';

const INSERT_CHUNK = 200;

function descriptionField(value: string | null): { description?: string } {
  return value === null ? {} : { description: value };
}

/**
 * 置き換えは1つのトランザクションにする: 途中で落ちても前の登録が残る。
 * 読むときにも検査する: 表は SQL から直接書き換えられるので `contentSha256` を計算し直して突き合わせ、
 * 合わなければ文言に値を載せずに投げる。
 */
export class PgPluginStore implements PluginStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<PluginSummary[]> {
    const rows = await this.#db.select().from(plugins);
    return sortPluginSummaries(
      rows.map((row) => {
        try {
          return parsePluginSummary({
            name: row.name,
            ...descriptionField(row.description),
            source: row.source,
            scope: row.scope,
            enableHooks: row.enableHooks,
            enableMcp: row.enableMcp,
            installedAt: toIso(row.installedAt),
            installedBy: row.installedBy,
            contentSha256: row.contentSha256,
            fileCount: row.fileCount,
            totalBytes: toNumber(row.totalBytes),
          });
        } catch (error) {
          throw new Error(`plugin「${row.name}」を読めない: ${(error as Error).message}`, {
            cause: error,
          });
        }
      }),
    );
  }

  async get(name: string): Promise<StoredPlugin | null> {
    if (!isValidPluginName(name)) return null;
    // repeatable read にする: read committed だと2本の select の間の置き換えで別々の版の行を混ぜて読む。
    const loaded = await this.#db.transaction(
      async (tx) => {
        const rows = await tx.select().from(plugins).where(eq(plugins.name, name)).limit(1);
        const found = rows[0];
        if (found === undefined) return null;
        const fileRows = await tx
          .select()
          .from(pluginFiles)
          .where(eq(pluginFiles.pluginName, name));
        return { row: found, files: fileRows };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (loaded === null) return null;
    const { row, files } = loaded;
    try {
      return parseStoredPlugin({
        name: row.name,
        ...descriptionField(row.description),
        source: row.source,
        scope: row.scope,
        enableHooks: row.enableHooks,
        enableMcp: row.enableMcp,
        files: files.map((file) => ({
          path: file.path,
          executable: file.executable,
          content: new Uint8Array(file.content),
        })),
        installedAt: toIso(row.installedAt),
        installedBy: row.installedBy,
        contentSha256: row.contentSha256,
      });
    } catch (error) {
      throw new Error(`plugin「${name}」を読めない: ${(error as Error).message}`, { cause: error });
    }
  }

  async put(input: PluginInput): Promise<PluginSummary> {
    const plugin = parsePluginInput(input);
    await this.#db.transaction(async (tx) => {
      // 直列にする: 大文字小文字だけが違う名前の同時 put が互いの衝突検査をすり抜ける。
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('alteroid.plugins'))`);
      const clash = await tx
        .select({ name: plugins.name })
        .from(plugins)
        .where(
          and(sql`lower(${plugins.name}) = lower(${plugin.name})`, ne(plugins.name, plugin.name)),
        )
        .limit(1);
      if (clash[0] !== undefined) throw new PluginNameConflictError(plugin.name, clash[0].name);

      const summary = pluginSummaryOf(plugin);
      const values = {
        // null を明示する: 省くと説明の無い置き換えで古い説明が残る。
        description: plugin.description ?? null,
        source: plugin.source,
        scope: plugin.scope,
        enableHooks: plugin.enableHooks,
        enableMcp: plugin.enableMcp,
        contentSha256: plugin.contentSha256,
        fileCount: summary.fileCount,
        totalBytes: summary.totalBytes,
        installedAt: new Date(plugin.installedAt),
        installedBy: plugin.installedBy,
      };
      await tx
        .insert(plugins)
        .values({ name: plugin.name, ...values })
        .onConflictDoUpdate({ target: plugins.name, set: values });
      await tx.delete(pluginFiles).where(eq(pluginFiles.pluginName, plugin.name));
      for (let i = 0; i < plugin.files.length; i += INSERT_CHUNK) {
        await tx.insert(pluginFiles).values(
          plugin.files.slice(i, i + INSERT_CHUNK).map((file) => ({
            pluginName: plugin.name,
            path: file.path,
            executable: file.executable,
            content: Buffer.from(file.content),
          })),
        );
      }
    });
    return pluginSummaryOf(plugin);
  }

  async remove(name: string): Promise<boolean> {
    if (!isValidPluginName(name)) return false;
    const removed = await this.#db
      .delete(plugins)
      .where(eq(plugins.name, name))
      .returning({ name: plugins.name });
    return removed.length > 0;
  }
}
