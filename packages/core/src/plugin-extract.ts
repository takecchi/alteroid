import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { pluginDirName, validatePluginFilePath, type StoredPlugin } from './plugins.js';
import type { PluginStore } from './store.js';

/**
 * 記憶ストアの plugin を、SDK の `Options.plugins`（`type: 'local'`）が読めるディレクトリへ展開する。
 *
 * 展開先は `<root>/plugins/<name>@<sha>/`。sha は取り元の commit SHA で、版が変われば別のディレクトリになる。
 *
 * - **ホワイトリスト方式。** 既知の形だけを書く。「hooks を消す」方式にしないのは、hooks を宣言できる
 *   場所が `hooks/` 以外にもあり（manifest・frontmatter）、消し漏れが監査を通らない実行になるため。
 * - **`enableHooks` が true でも hooks は展開しない。** 有効にする実装は、監査（`canUseTool`）を
 *   飛ばさないことを実機で確かめてから書く。
 * - YAML の解析器を依存に足さない。frontmatter は先頭ブロックを行単位で扱い、
 *   読み取れない形（複雑なキー・マージキー・全体が flow 形式など）は失敗側に倒して展開しない。
 *   「解析できたつもりで hooks を落とし損ねる」より、「展開しない」を選ぶ。
 */

/** ホワイトリストの版。許す形を変えたら上げる（展開済みのものを作り直させる）。 */
export const PLUGIN_ALLOWLIST_VERSION = 1;

const MARKER_FILE = '.alteroid-extract.json';
const MANIFEST_PATH = '.claude-plugin/plugin.json';
const MCP_PATH = '.mcp.json';
const ALLOWED_PREFIXES = ['skills/', 'agents/', 'commands/'] as const;

const DIR_NAME_RULE = /^[A-Za-z0-9_-]{1,64}@[0-9a-f]{40}$/;
const TMP_NAME_RULE = /^\.tmp-[A-Za-z0-9_-]{1,64}@[0-9a-f]{40}-[0-9a-f]{16}(?:-old)?$/;

export type PluginScope = StoredPlugin['scope'];

export type RemovedReason =
  | 'not-allowlisted'
  | 'hooks-disabled'
  | 'hooks-not-extracted'
  | 'mcp-disabled'
  | 'modules-not-extracted'
  | 'frontmatter-unreadable'
  | 'manifest-unreadable'
  | 'invalid-path';

/** 展開しなかったもの。内容や値は持たない（path は plugin 内の相対 path か、`<path>#<欄>`）。 */
export interface RemovedItem {
  readonly plugin: string;
  readonly path: string;
  readonly reason: RemovedReason;
}

export interface ExtractedPlugin {
  readonly name: string;
  /** 展開先の絶対パス。 */
  readonly path: string;
  readonly removed: readonly RemovedItem[];
}

interface OutputFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

interface Marker {
  readonly allowlistVersion: number;
  readonly contentSha256: string;
  readonly enableHooks: boolean;
  readonly enableMcp: boolean;
}

function markerOf(plugin: StoredPlugin): Marker {
  return {
    allowlistVersion: PLUGIN_ALLOWLIST_VERSION,
    contentSha256: plugin.contentSha256,
    enableHooks: plugin.enableHooks,
    enableMcp: plugin.enableMcp,
  };
}

function markerMatches(found: unknown, expected: Marker): boolean {
  if (typeof found !== 'object' || found === null) return false;
  const record = found as Record<string, unknown>;
  return (
    record.allowlistVersion === expected.allowlistVersion &&
    record.contentSha256 === expected.contentSha256 &&
    record.enableHooks === expected.enableHooks &&
    record.enableMcp === expected.enableMcp
  );
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `{` `[` の釣り合い（引用符は見ない。読み違えても、多く落とす側にしか倒れない）。 */
function bracketDelta(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
  }
  return depth;
}

const FRONTMATTER_KEY =
  /^(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_.-]+(?: +[A-Za-z0-9_.-]+)*))[ \t]*:(?:[ \t]|$)(.*)$/;

/**
 * markdown の frontmatter から `hooks:` を取り除く。frontmatter が無ければそのまま。
 * 読み取れなければ `null`。
 */
function stripFrontmatterHooks(text: string): { text: string; droppedHooks: boolean } | null {
  const lines = text.split('\n');
  const head = lines[0] ?? '';
  const first = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  if (!/^---[ \t]*\r?$/.test(first)) return { text, droppedHooks: false };
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[i] ?? '')) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;

  const kept: string[] = [];
  let droppedHooks = false;
  let skipping = false;
  let flowDepth = 0;
  let sawKey = false;
  for (let i = 1; i < close; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\r$/, '');
    if (flowDepth > 0) {
      flowDepth += bracketDelta(line);
      continue;
    }
    const continuation = line.trim() === '' || /^[ \t]/.test(line) || line.startsWith('#');
    const listItem = line === '-' || line.startsWith('- ');
    if (skipping) {
      if (continuation || listItem) continue;
      skipping = false;
    }
    if (continuation) {
      kept.push(raw);
      continue;
    }
    if (listItem && sawKey) {
      kept.push(raw);
      continue;
    }
    const match = FRONTMATTER_KEY.exec(line);
    if (match === null) return null;
    sawKey = true;
    const key = match[1] ?? match[2] ?? match[3] ?? '';
    if (key.toLowerCase() === 'hooks') {
      droppedHooks = true;
      skipping = true;
      flowDepth = Math.max(
        0,
        bracketDelta(/^[ \t]*[{[]/.test(match[4] ?? '') ? (match[4] ?? '') : ''),
      );
      continue;
    }
    kept.push(raw);
  }
  if (flowDepth > 0) return null;
  const rebuilt = [lines[0] ?? '', ...kept, ...lines.slice(close)].join('\n');
  return { text: rebuilt, droppedHooks };
}

function hooksReason(plugin: StoredPlugin): RemovedReason {
  return plugin.enableHooks ? 'hooks-not-extracted' : 'hooks-disabled';
}

/** 何を書くか（fs に触れない）。 */
function planExtraction(plugin: StoredPlugin): { outputs: OutputFile[]; removed: RemovedItem[] } {
  const outputs: OutputFile[] = [];
  const removed: RemovedItem[] = [];
  const drop = (path: string, reason: RemovedReason) =>
    removed.push({ plugin: plugin.name, path, reason });

  for (const file of plugin.files) {
    const path = file.path;
    if (validatePluginFilePath(path) !== null) {
      drop('(invalid path)', 'invalid-path');
      continue;
    }
    if (path === MANIFEST_PATH) {
      const text = decodeUtf8(file.content);
      let manifest: unknown;
      try {
        manifest = text === null ? undefined : JSON.parse(text);
      } catch {
        manifest = undefined;
      }
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        drop(path, 'manifest-unreadable');
        continue;
      }
      const record = manifest as Record<string, unknown>;
      const strip = (field: string, reason: RemovedReason) => {
        if (!Object.hasOwn(record, field)) return;
        delete record[field];
        drop(`${path}#${field}`, reason);
      };
      strip('hooks', hooksReason(plugin));
      strip('modules', 'modules-not-extracted');
      if (!plugin.enableMcp) strip('mcpServers', 'mcp-disabled');
      outputs.push({
        path,
        bytes: new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`),
        executable: false,
      });
      continue;
    }
    if (path === MCP_PATH) {
      if (plugin.enableMcp) outputs.push({ path, bytes: file.content, executable: false });
      else drop(path, 'mcp-disabled');
      continue;
    }
    if (path.startsWith('hooks/')) {
      drop(path, hooksReason(plugin));
      continue;
    }
    if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      drop(path, 'not-allowlisted');
      continue;
    }
    if (/\.md$/i.test(path)) {
      const text = decodeUtf8(file.content);
      const stripped = text === null ? null : stripFrontmatterHooks(text);
      if (stripped === null) {
        drop(path, 'frontmatter-unreadable');
        continue;
      }
      if (stripped.droppedHooks) {
        drop(`${path}#hooks`, hooksReason(plugin));
        outputs.push({
          path,
          bytes: new TextEncoder().encode(stripped.text),
          executable: file.executable,
        });
        continue;
      }
    }
    outputs.push({ path, bytes: file.content, executable: file.executable });
  }
  return { outputs, removed };
}

/** 書込み可へ戻してから消す。0o555 のままでは中身を消せず、symlink は辿らない。 */
async function removeTree(path: string): Promise<void> {
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await makeWritable(join(path, name));
}

function assertInside(base: string, target: string): void {
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('展開先の外を指す path');
  }
}

async function ensurePluginsDir(root: string): Promise<string> {
  const dir = resolve(root, 'plugins');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('plugins の置き場が実在のディレクトリでない（symlink か dir 以外）');
  }
  return dir;
}

async function readMarker(dir: string): Promise<unknown> {
  const markerPath = join(dir, MARKER_FILE);
  const info = await lstat(markerPath).catch(() => null);
  if (info === null || !info.isFile()) return null;
  try {
    return JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function writeStage(stage: string, outputs: OutputFile[], marker: Marker): Promise<void> {
  const dirs = new Set<string>();
  const ensureDir = async (dir: string) => {
    assertInside(stage, dir);
    if (dirs.has(dir)) return;
    const info = await lstat(dir).catch(() => null);
    if (info === null) {
      await ensureDir(resolve(dir, '..'));
      await mkdir(dir, { mode: 0o700 });
    } else if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('展開先の途中が実在のディレクトリでない');
    }
    dirs.add(dir);
  };
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

  const written: { target: string; executable: boolean }[] = [];
  for (const output of outputs) {
    const target = resolve(stage, output.path);
    assertInside(stage, target);
    if (target === stage) throw new Error('展開先の外を指す path');
    await ensureDir(resolve(target, '..'));
    const handle = await open(target, flags, 0o600);
    try {
      await handle.writeFile(output.bytes);
    } finally {
      await handle.close();
    }
    written.push({ target, executable: output.executable });
  }
  const markerTarget = join(stage, MARKER_FILE);
  const markerHandle = await open(markerTarget, flags, 0o600);
  try {
    await markerHandle.writeFile(`${JSON.stringify(marker)}\n`);
  } finally {
    await markerHandle.close();
  }
  written.push({ target: markerTarget, executable: false });

  for (const file of written) await chmod(file.target, file.executable ? 0o555 : 0o444);
  const ordered = [...dirs].sort((a, b) => b.length - a.length);
  for (const dir of ordered) await chmod(dir, 0o555);
  await chmod(stage, 0o555);
}

/**
 * 1つの plugin を `<root>/plugins/<name>@<sha>/` へ展開する。冪等（マーカーが一致すれば何もしない）。
 *
 * 展開した形が既にあっても、symlink や dir 以外が先に置かれていれば辿らずに作り直す。
 * 走行中のセッションが読んでいる版を壊さないため、書くのは同じ親の `.tmp-*` で、置くのは rename。
 */
export async function extractPlugin(root: string, plugin: StoredPlugin): Promise<ExtractedPlugin> {
  const pluginsDir = await ensurePluginsDir(root);
  const dirName = pluginDirName(plugin.name, plugin.source.sha);
  const finalPath = resolve(pluginsDir, dirName);
  assertInside(pluginsDir, finalPath);
  const { outputs, removed } = planExtraction(plugin);
  const marker = markerOf(plugin);
  const result: ExtractedPlugin = { name: plugin.name, path: finalPath, removed };

  const existing = await lstat(finalPath).catch(() => null);
  const existingIsDir = existing !== null && !existing.isSymbolicLink() && existing.isDirectory();
  if (existingIsDir && markerMatches(await readMarker(finalPath), marker)) return result;

  const stage = resolve(pluginsDir, `.tmp-${dirName}-${randomBytes(8).toString('hex')}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    await writeStage(stage, outputs, marker);
  } catch (error) {
    await removeTree(stage).catch(() => undefined);
    throw error;
  }

  let aside: string | null = null;
  if (existing !== null) {
    if (existingIsDir) {
      aside = `${stage}-old`;
      await rename(finalPath, aside);
    } else {
      await rm(finalPath, { force: true });
    }
  }
  try {
    await rename(stage, finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const winner = await lstat(finalPath).catch(() => null);
    if (
      (code === 'ENOTEMPTY' || code === 'EEXIST') &&
      winner !== null &&
      !winner.isSymbolicLink() &&
      markerMatches(await readMarker(finalPath), marker)
    ) {
      await removeTree(stage).catch(() => undefined);
      if (aside !== null) await removeTree(aside).catch(() => undefined);
      return result;
    }
    if (aside !== null) await rename(aside, finalPath).catch(() => undefined);
    await removeTree(stage).catch(() => undefined);
    throw error;
  }
  if (aside !== null) await removeTree(aside).catch(() => undefined);
  return result;
}

export interface PrunePluginsResult {
  readonly removed: string[];
  readonly failed: { entry: string; message: string }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `keep`（`<name>@<sha>` の集合）に無い展開済みの版と、`.tmp-*` を消す。**daemon の起動時にだけ呼ぶこと**
 * （走行中のセッションが読んでいる版や、別のプロセスが書いている途中の `.tmp-*` を消さないため）。
 *
 * 名前が `<plugin 名の規則>@<40桁16進>`（`.tmp-` は `.tmp-<同>-<16桁16進>[-old]`）に合わないものは
 * 人間が置いたものかもしれないので触らない。
 */
export async function pruneExtractedPluginDirs(
  root: string,
  keep: ReadonlySet<string>,
): Promise<PrunePluginsResult> {
  const pluginsDir = resolve(root, 'plugins');
  const result: PrunePluginsResult = { removed: [], failed: [] };
  const info = await lstat(pluginsDir).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) return result;
  for (const entry of await readdir(pluginsDir)) {
    const stale = TMP_NAME_RULE.test(entry) || (DIR_NAME_RULE.test(entry) && !keep.has(entry));
    if (!stale) continue;
    try {
      await removeTree(join(pluginsDir, entry));
      result.removed.push(entry);
    } catch (error) {
      result.failed.push({ entry, message: messageOf(error) });
    }
  }
  return result;
}

/**
 * ストアの `list()` から残す版を決めて {@link pruneExtractedPluginDirs} を呼ぶ。
 * `list()` が失敗したら何も消さずに投げる（読めなかったことを「何も無い」と読んで全部消さない）。
 */
export async function pruneExtractedPluginsAgainstStore(
  root: string,
  store: Pick<PluginStore, 'list'>,
  scopes: readonly PluginScope[],
): Promise<PrunePluginsResult> {
  const summaries = await store.list();
  const keep = new Set(
    summaries
      .filter((summary) => scopes.includes(summary.scope))
      .map((summary) => pluginDirName(summary.name, summary.source.sha)),
  );
  return pruneExtractedPluginDirs(root, keep);
}

export interface ExtractedPluginRef {
  readonly name: string;
  readonly path: string;
  readonly skipMcpDiscovery: boolean;
}

export interface PluginExtractFailure {
  /** `list` の失敗は plugin を特定できないので `null`。 */
  readonly name: string | null;
  readonly stage: 'list' | 'get' | 'extract';
  readonly message: string;
}

export interface ExtractForScopesResult {
  readonly plugins: ExtractedPluginRef[];
  readonly removed: RemovedItem[];
  readonly failures: PluginExtractFailure[];
}

/**
 * ストアから `scopes` に含まれる plugin を読んで展開し、`Options.plugins` に渡せる形で返す。
 * 1つの失敗で全体を止めない。日誌には書かない（結果を返すだけ。書くのは呼び手）。
 */
export async function extractPluginsForScopes(options: {
  root: string;
  store: Pick<PluginStore, 'list' | 'get'>;
  scopes: readonly PluginScope[];
}): Promise<ExtractForScopesResult> {
  const { root, store, scopes } = options;
  const out: ExtractForScopesResult = { plugins: [], removed: [], failures: [] };
  let summaries;
  try {
    summaries = await store.list();
  } catch (error) {
    out.failures.push({ name: null, stage: 'list', message: messageOf(error) });
    return out;
  }
  for (const summary of summaries) {
    if (!scopes.includes(summary.scope)) continue;
    let plugin: StoredPlugin | null;
    try {
      plugin = await store.get(summary.name);
    } catch (error) {
      out.failures.push({ name: summary.name, stage: 'get', message: messageOf(error) });
      continue;
    }
    if (plugin === null) {
      out.failures.push({ name: summary.name, stage: 'get', message: 'plugin が見つからない' });
      continue;
    }
    try {
      const extracted = await extractPlugin(root, plugin);
      out.plugins.push({
        name: plugin.name,
        path: extracted.path,
        skipMcpDiscovery: !plugin.enableMcp,
      });
      out.removed.push(...extracted.removed);
    } catch (error) {
      out.failures.push({ name: summary.name, stage: 'extract', message: messageOf(error) });
    }
  }
  return out;
}
