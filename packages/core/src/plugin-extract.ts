import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { pluginDirName, validatePluginFilePath, type StoredPlugin } from './plugins.js';
import type { PluginStore } from './store.js';

/**
 * 記憶ストアの plugin を、SDK の `Options.plugins`（`type: 'local'`）が読めるディレクトリへ展開する。
 *
 * 展開先は `<root>/plugins/<name>@<sha>-<marker の要約 12 桁>/`。sha は取り元の commit SHA。版・内容・フラグの
 * どれかが変われば別のディレクトリになる（同じ `name@sha` を別の内容で置き換えても、走行中のセッションが
 * 読んでいる展開済みのものを退避・削除しないため）。
 *
 * - **ホワイトリスト方式。** 既知の形だけを書く。「hooks を消す」方式にしないのは、hooks を宣言できる
 *   場所が `hooks/` 以外にもあり（manifest・frontmatter）、消し漏れが監査を通らない実行になるため。
 * - **`enableHooks` が true でも hooks は展開しない。** 有効にする実装は、監査（`canUseTool`）を
 *   飛ばさないことを実機で確かめてから書く。
 * - frontmatter も許可したキーだけを書き出して作り直す。「hooks を消す」方式にしないのは、
 *   インデントの付け方などで消し漏れる書き方が後から見つかるため。YAML の解析器を依存に足さず、
 *   読み取れない形は失敗側に倒して展開しない。
 */

/** ホワイトリストの版。許す形を変えたら上げる（展開済みのものを作り直させる）。 */
export const PLUGIN_ALLOWLIST_VERSION = 3;

/**
 * frontmatter で残すキー。ツールの許可・権限・サブプロセスの起動を宣言できるキー
 * （`allowed-tools`・`tools`・`mcpServers`・`permissionMode`・`hooks`）と未知のキーは通さない。
 */
const FRONTMATTER_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'argument-hint',
  'when_to_use',
  'model',
  'disable-model-invocation',
  'user-invocable',
]);

/**
 * manifest で残す欄。パスを差し替える欄（skills / agents / commands など）や未知の欄を通さないのは、
 * ホワイトリスト外のファイルや別の場所を読み込ませる経路になるため。
 */
const MANIFEST_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]);

const MARKER_FILE = '.alteroid-extract.json';
const MANIFEST_PATH = '.claude-plugin/plugin.json';
const MCP_PATH = '.mcp.json';
const ALLOWED_PREFIXES = ['skills/', 'agents/', 'commands/'] as const;

// 要約の桁が付かない旧形式も規則に合うものとして片づけの対象に入れる（残っても誰も読まない）。
const DIR_NAME_RULE = /^[A-Za-z0-9_-]{1,64}@[0-9a-f]{40}(?:-[0-9a-f]{12})?$/;
const TMP_NAME_RULE =
  /^\.tmp-[A-Za-z0-9_-]{1,64}@[0-9a-f]{40}(?:-[0-9a-f]{12})?-[0-9a-f]{16}(?:-old)?$/;

export type PluginScope = StoredPlugin['scope'];

/**
 * runner が受けた plugin を展開する置き場の既定（`os.tmpdir()` 配下）。`/workspace` に置かないのは、
 * そこが子（マネージャー・作業者）の持ち物で、展開した plugin（skills など）を子が書き換えられてしまうため。
 */
export function defaultRunnerPluginsRoot(): string {
  return join(tmpdir(), 'alteroid-plugins');
}

/** 展開に要るものだけ（runner は取り元の URL・入れた人・日時を受けないので、`StoredPlugin` では持てない）。 */
export type ExtractablePlugin = Pick<
  StoredPlugin,
  'name' | 'files' | 'enableHooks' | 'enableMcp' | 'contentSha256'
> & { source: { sha: string; [other: string]: unknown } };

/**
 * 展開先のディレクトリの作り方。省略は今までどおり（root は既定のモード、`plugins/` は 0o700 で、
 * 所有者は確かめない）。
 */
export interface ExtractPluginOptions {
  /** root と `plugins/` のモード。子 uid に読ませる runner だけが 0o755 を渡す。 */
  readonly dirMode?: number;
  /** root と `plugins/` の所有者がこの uid であること。違えば展開せずに拒む。 */
  readonly expectedUid?: number;
}

/** クローン（daemon）へ撒く scope。`runner` はマネージャー側が持つので含めない。 */
export const PLUGIN_SCOPES_FOR_CLONE: readonly PluginScope[] = ['all', 'app'];

export type RemovedReason =
  | 'not-allowlisted'
  | 'hooks-disabled'
  | 'hooks-not-extracted'
  | 'mcp-disabled'
  | 'modules-not-extracted'
  | 'frontmatter-unreadable'
  | 'frontmatter-not-allowlisted'
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

/** marker を決める入力。`list()` の要約と `get()` の本体のどちらからも作れる。 */
export interface ExtractIdentity {
  readonly name: string;
  readonly source: { readonly sha: string };
  readonly contentSha256: string;
  readonly enableHooks: boolean;
  readonly enableMcp: boolean;
}

function markerOf(plugin: ExtractIdentity): Marker {
  return {
    allowlistVersion: PLUGIN_ALLOWLIST_VERSION,
    contentSha256: plugin.contentSha256,
    enableHooks: plugin.enableHooks,
    enableMcp: plugin.enableMcp,
  };
}

/**
 * 展開先のディレクトリ名（`<name>@<sha>-<marker の sha256 の先頭 12 桁>`）。
 * marker に入る値が変われば名前が変わるので、走行中のセッションが読む展開済みのものを上書きしない。
 */
export function extractedPluginDirName(plugin: ExtractIdentity): string {
  const marker = markerOf(plugin);
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        marker.allowlistVersion,
        marker.contentSha256,
        marker.enableHooks,
        marker.enableMcp,
      ]),
    )
    .digest('hex')
    .slice(0, 12);
  return `${pluginDirName(plugin.name, plugin.source.sha)}-${digest}`;
}

const REMOVED_REASONS: ReadonlySet<string> = new Set<RemovedReason>([
  'not-allowlisted',
  'hooks-disabled',
  'hooks-not-extracted',
  'mcp-disabled',
  'modules-not-extracted',
  'frontmatter-unreadable',
  'frontmatter-not-allowlisted',
  'manifest-unreadable',
  'invalid-path',
]);

/** marker に書き添えた「展開しなかったもの」。形が合わなければ `null`（読み直す側へ倒す）。 */
function removedFromMarker(found: unknown, pluginName: string): RemovedItem[] | null {
  if (typeof found !== 'object' || found === null) return null;
  const list = (found as Record<string, unknown>).removed;
  if (!Array.isArray(list)) return null;
  const out: RemovedItem[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { path, reason } = item as Record<string, unknown>;
    if (typeof path !== 'string' || typeof reason !== 'string' || !REMOVED_REASONS.has(reason)) {
      return null;
    }
    out.push({ plugin: pluginName, path, reason: reason as RemovedReason });
  }
  return out;
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

/** インデント 0 の `key: value`。引用符つき・複雑なキーは受けない（読み違えを避ける）。 */
const FRONTMATTER_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR_HEADER = /^[|>](?:[+-][1-9]?|[1-9][+-]?)?$/;
const QUOTED_ONE_LINE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')$/;

/**
 * 許可したキーの値が「1 行のスカラー」か。flow 形式・アンカー・タグ・閉じない引用符は、次の行へ
 * 続く可能性や別の意味を持つので受けない。
 */
function isSingleLineScalar(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  if (v.startsWith('"') || v.startsWith("'")) return QUOTED_ONE_LINE.test(v);
  return !/^[{[&*!%@`|>]/.test(v);
}

/**
 * markdown の frontmatter を、許可したキーだけで作り直す。frontmatter が無ければそのまま。
 * 読み取れなければ `null`。
 */
function rebuildFrontmatter(text: string): { text: string; dropped: string[] } | null {
  const lines = text.split('\n');
  const head = lines[0] ?? '';
  const first = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  if (!/^---[ \t]*\r?$/.test(first)) return { text, dropped: [] };
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[i] ?? '')) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;

  const kept: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  // 'dropped' は次のキーまで読み飛ばす。'block' は許可したキーのブロックスカラーの続き。
  let mode: 'top' | 'dropped' | 'block' = 'top';
  let flowDepth = 0;
  for (let i = 1; i < close; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\r$/, '');
    if (flowDepth > 0) {
      flowDepth += bracketDelta(line);
      continue;
    }
    const indented = /^[ \t]/.test(line);
    const blank = line.trim() === '';
    if (mode === 'block' && (indented || blank)) {
      kept.push(raw);
      continue;
    }
    if (mode === 'dropped') {
      const listItem = line === '-' || line.startsWith('- ');
      if (indented || blank || listItem || line.startsWith('#')) continue;
    }
    mode = 'top';
    if (blank || line.startsWith('#')) continue;
    const match = FRONTMATTER_KEY.exec(line);
    if (match === null) return null;
    const key = match[1] ?? '';
    const value = match[2] ?? '';
    if (seen.has(key)) return null;
    seen.add(key);
    if (!FRONTMATTER_ALLOWED_KEYS.has(key)) {
      dropped.push(key);
      mode = 'dropped';
      flowDepth = Math.max(0, /^[{[]/.test(value.trim()) ? bracketDelta(value) : 0);
      continue;
    }
    if (BLOCK_SCALAR_HEADER.test(value.trim())) {
      mode = 'block';
    } else if (!isSingleLineScalar(value)) {
      return null;
    }
    kept.push(raw);
    // 値の無いキーの次に続く行（入れ子・複数行の plain scalar）は次の周回で `FRONTMATTER_KEY` に
    // 合わず、展開しない側へ倒れる。
  }
  if (flowDepth > 0) return null;
  const rebuilt = [lines[0] ?? '', ...kept, ...lines.slice(close)].join('\n');
  return { text: rebuilt, dropped };
}

function frontmatterDropReason(key: string, plugin: ExtractablePlugin): RemovedReason {
  return key.toLowerCase() === 'hooks' ? hooksReason(plugin) : 'frontmatter-not-allowlisted';
}

function hooksReason(plugin: ExtractablePlugin): RemovedReason {
  return plugin.enableHooks ? 'hooks-not-extracted' : 'hooks-disabled';
}

/** 何を書くか（fs に触れない）。 */
function planExtraction(plugin: ExtractablePlugin): {
  outputs: OutputFile[];
  removed: RemovedItem[];
} {
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
      const source = manifest as Record<string, unknown>;
      const record: Record<string, unknown> = {};
      for (const field of Object.keys(source)) {
        if (MANIFEST_METADATA_FIELDS.has(field)) {
          record[field] = source[field];
        } else if (field === 'mcpServers' && plugin.enableMcp) {
          record[field] = source[field];
        } else if (field === 'hooks') {
          drop(`${path}#${field}`, hooksReason(plugin));
        } else if (field === 'modules') {
          drop(`${path}#${field}`, 'modules-not-extracted');
        } else if (field === 'mcpServers') {
          drop(`${path}#${field}`, 'mcp-disabled');
        } else {
          drop(`${path}#${field}`, 'not-allowlisted');
        }
      }
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
      const rebuilt = text === null ? null : rebuildFrontmatter(text);
      if (rebuilt === null) {
        drop(path, 'frontmatter-unreadable');
        continue;
      }
      for (const key of rebuilt.dropped) {
        drop(`${path}#${key}`, frontmatterDropReason(key, plugin));
      }
      outputs.push({
        path,
        bytes: rebuilt.text === text ? file.content : new TextEncoder().encode(rebuilt.text),
        executable: file.executable,
      });
      continue;
    }
    outputs.push({ path, bytes: file.content, executable: file.executable });
  }
  return { outputs, removed };
}

/**
 * 展開しないもの（fs に触れない）。入れる前の確認で「何が落ちるか」を見せるのに使う
 * （展開の本体と同じ計画を通すので、見せたものと実際に落ちるものがずれない）。
 */
export function planPluginExtractionRemovals(
  plugin: Pick<StoredPlugin, 'name' | 'files'>,
  flags: { enableHooks: boolean; enableMcp: boolean },
): readonly RemovedItem[] {
  return planPluginExtraction(plugin, flags).removed;
}

/**
 * 展開するもの（書かれるバイト）と展開しないもの。fs に触れない。プレビューが実行ファイルの分類や
 * 本文の検査をするときも、実際に書かれる内容（許可したキーだけで作り直した frontmatter）を見る。
 */
export function planPluginExtraction(
  plugin: Pick<StoredPlugin, 'name' | 'files'>,
  flags: { enableHooks: boolean; enableMcp: boolean },
): {
  readonly outputs: readonly { path: string; bytes: Uint8Array; executable: boolean }[];
  readonly removed: readonly RemovedItem[];
} {
  return planExtraction({
    ...plugin,
    ...flags,
    contentSha256: '',
    source: { sha: '' },
  });
}

/** 書込み可へ戻してから消す。0o555 のままでは中身を消せず、symlink は辿らない。 */
async function removeTree(path: string): Promise<void> {
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

/**
 * ディレクトリを `O_NOFOLLOW | O_DIRECTORY` で開いた fd に `fchmod` し、中を再帰する。
 * lstat → chmod（パスで引く）の形にしないのは、その間に symlink へ差し替えられると、
 * 差し替え先（展開物の外）の権限を変えてしまうため。symlink・dir 以外・消えたものは何もしない。
 * 子は Linux では `/proc/self/fd/<fd>` 越しに開く（親のパスが途中で差し替わっても、開いた親の中を読む）。
 */
async function makeWritable(path: string): Promise<void> {
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch {
    return;
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) return;
    await handle.chmod(0o700);
    const via = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path;
    for (const name of await readdir(via)) await makeWritable(join(via, name));
  } finally {
    await handle.close();
  }
}

function assertInside(base: string, target: string): void {
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('展開先の外を指す path');
  }
}

/**
 * 置き場を、自分の持ち物として確かめてモードを揃える。`/tmp` 配下は誰でも書けるので、
 * 先に同名の symlink や他人のディレクトリを置かれても使わない（他人の持ち物は差し替えられる）。
 */
async function ensureTrustedDirectory(
  dir: string,
  mode: number,
  expectedUid: number | undefined,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('plugins の置き場が実在のディレクトリでない（symlink か dir 以外）');
  }
  if (expectedUid !== undefined && info.uid !== expectedUid) {
    throw new Error('plugins の置き場の所有者が期待と違う。展開しない');
  }
  if ((info.mode & 0o777) !== mode) await chmod(dir, mode);
}

async function ensurePluginsDir(root: string, options: ExtractPluginOptions): Promise<string> {
  const dir = resolve(root, 'plugins');
  if (options.dirMode === undefined) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('plugins の置き場が実在のディレクトリでない（symlink か dir 以外）');
    }
    return dir;
  }
  await ensureTrustedDirectory(resolve(root), options.dirMode, options.expectedUid);
  await ensureTrustedDirectory(dir, options.dirMode, options.expectedUid);
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

async function writeStage(
  stage: string,
  outputs: OutputFile[],
  marker: Marker,
  removed: readonly RemovedItem[],
): Promise<void> {
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
    // `removed` は一致の判定に使わない。get を省く側が、日誌に載せる一覧を読み戻すために置く。
    const body = {
      ...marker,
      removed: removed.map(({ path, reason }) => ({ path, reason })),
    };
    await markerHandle.writeFile(`${JSON.stringify(body)}\n`);
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
 * 1つの plugin を `<root>/plugins/<extractedPluginDirName>/` へ展開する。冪等（マーカーが一致すれば何もしない）。
 *
 * 名前に marker の要約が入るので、内容やフラグが変わっても前の展開先には触れない。それでも同じ名前に
 * 壊れた marker・symlink・dir 以外が先に置かれていれば、辿らずに作り直す（退避してから置く）。
 * 書くのは同じ親の `.tmp-*` で、置くのは rename。
 */
export async function extractPlugin(
  root: string,
  plugin: ExtractablePlugin,
  options: ExtractPluginOptions = {},
): Promise<ExtractedPlugin> {
  const pluginsDir = await ensurePluginsDir(root, options);
  const dirName = extractedPluginDirName(plugin);
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
    await writeStage(stage, outputs, marker, removed);
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

/** 期待される展開先が実在の dir で、marker が一致し、取り除いた一覧も読めるときだけ返す。 */
async function findCurrentExtraction(
  root: string,
  identity: ExtractIdentity,
): Promise<{ path: string; removed: RemovedItem[] } | null> {
  const pluginsDir = resolve(root, 'plugins');
  const dir = await lstat(pluginsDir).catch(() => null);
  if (dir === null || dir.isSymbolicLink() || !dir.isDirectory()) return null;
  const path = resolve(pluginsDir, extractedPluginDirName(identity));
  assertInside(pluginsDir, path);
  const info = await lstat(path).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) return null;
  const found = await readMarker(path);
  if (!markerMatches(found, markerOf(identity))) return null;
  const removed = removedFromMarker(found, identity.name);
  return removed === null ? null : { path, removed };
}

/** runner が置き場を確かめるときの作り方（子 uid は読めて書けず、差し替えられない root 所有の 0o755）。 */
export function runnerPluginsDirOptions(): ExtractPluginOptions {
  return { dirMode: 0o755, expectedUid: process.getuid?.() };
}

/**
 * runner の起動時の片づけ。置き場（root と `plugins/`）を展開時と同じ検査（所有者・モード・symlink でない）
 * に通してから {@link pruneExtractedPluginDirs} を呼ぶ。通らなければ何も消さず、理由を `write` へ出す
 * （他人が差し替えられる置き場の中を、root 権限で chmod・削除しないため）。
 */
export async function pruneRunnerPluginsOnBoot(
  root: string,
  options: ExtractPluginOptions,
  write: (line: string) => void,
): Promise<PrunePluginsResult | undefined> {
  try {
    await ensurePluginsDir(root, options);
  } catch (error) {
    write(`alteroid-runner: plugin の置き場を信頼できないので、片づけない: ${messageOf(error)}\n`);
    return undefined;
  }
  try {
    return await pruneExtractedPluginDirs(root, new Set());
  } catch (error) {
    write(`alteroid-runner: 前の器の plugin の展開物を消せませんでした: ${messageOf(error)}\n`);
    return undefined;
  }
}

export interface PrunePluginsResult {
  readonly removed: string[];
  readonly failed: { entry: string; message: string }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `keep`（`<name>@<sha>` の集合）に無い展開済みの版と、`.tmp-*` を消す。**読んでいるセッションが1つも無く、
 * 書いている途中の展開も無いときにだけ呼ぶこと**（daemon の起動時、runner の起動時と、runner では走行中の
 * セッションが無く展開が終わっているとき。走行中のセッションが読んでいる版や、書いている途中の `.tmp-*` を消さないため）。
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
      .map((summary) => extractedPluginDirName(summary)),
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
    // 要約の contentSha256 とフラグから期待される展開先が既にあれば、files を読まない（全 plugin の
    // 本体を毎回ストアから引かないため）。読み違えたときは get して展開する側へ倒す。
    const current = await findCurrentExtraction(root, summary).catch(() => null);
    if (current !== null) {
      out.plugins.push({
        name: summary.name,
        path: current.path,
        skipMcpDiscovery: !summary.enableMcp,
      });
      out.removed.push(...current.removed);
      continue;
    }
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
