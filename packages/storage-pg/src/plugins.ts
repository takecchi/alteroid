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

/** 1回の insert に載せる files の行数（1行4パラメータ。ドライバの上限に当たらない大きさ）。 */
const INSERT_CHUNK = 200;

/** null（説明なし・列を足す前の行）は欄ごと省く（fs・インメモリと同じ形にそろえる）。 */
function descriptionField(value: string | null): { description?: string } {
  return value === null ? {} : { description: value };
}

/**
 * 人間が入れた plugin の置き場（クラウド段）。
 *
 * fs 版（`~/.alteroid/plugins/<name>.json`）と同じものの器違いである。**Railway では
 * これが唯一の置き場になる**（volume が無いので、ファイルで置いても器と一緒に消える）。
 *
 * - 1 plugin = `plugins` の1行 + `plugin_files` の複数行（本体は `bytea`）。**置き換えは
 *   1つのトランザクション**（途中で落ちても前の登録が残る）。
 * - **読むときにも検査する**（`PgMcpServerStore` と同じ理由）。表は SQL から直接書き換えられる
 *   ので、`contentSha256` を files から計算し直して突き合わせる。合わなければ投げる
 *   （文言に値を載せない）。
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
    // 2本の select の間に置き換え（delete → insert）が入ると、別々の版の行を混ぜて読む。
    // read committed のままでは文ごとに見える範囲が変わるので、repeatable read で1枚の見え方に固定する。
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
          // Buffer（Uint8Array の派生）を素の Uint8Array にして返す（器ごとに型を揃える）。
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
    // **書く前に検査する**（`PluginStore.put` の doc）。不正ならここで投げ、表には触れない。
    const plugin = parsePluginInput(input);
    await this.#db.transaction(async (tx) => {
      // 大文字小文字だけが違う名前の同時 put が、互いの衝突検査をすり抜けないよう直列にする。
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
        // 説明の無い置き換えで古い説明を残さないよう、null を明示して上書きする。
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
    // plugin_files は外部キーの cascade で一緒に消える。
    const removed = await this.#db
      .delete(plugins)
      .where(eq(plugins.name, name))
      .returning({ name: plugins.name });
    return removed.length > 0;
  }
}
