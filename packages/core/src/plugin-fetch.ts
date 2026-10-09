import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OFFICIAL_MARKETPLACE,
  PLUGIN_LIMITS,
  pluginNameSchema,
  validatePluginFilePath,
  type PluginFile,
  type PluginSource,
} from './plugins.js';
import {
  curlResolveValue,
  resolveRepoSource,
  SourceGuardError,
  type Probe,
  type Resolver,
} from './plugin-fetch-guard.js';

/**
 * 取り元から、commit SHA を固定した plugin の `files` を取ってくる。
 *
 * - **作業ツリーを作らない。** `git fetch --depth 1 <sha>` で commit だけを取り、`ls-tree` と
 *   `cat-file --batch` で blob を読む。checkout をしないので、`.gitattributes` のフィルタや
 *   symlink の実体化、リポジトリ側の設定が一切効かない。
 * - **子プロセスの環境変数を空から組む。** daemon の環境には鍵が入りうる。ユーザ・システムの git 設定も読まない。
 * - **許すプロトコルは既定で https だけ**（`GIT_ALLOW_PROTOCOL`）。`file://` や `ssh` を取り元にさせない。
 *   テストだけが `allowedProtocols: 'file'` を渡す。
 * - **器の内側へは取りに行かない。** git に任せるとリダイレクトや名前解決のやり直しで内部へ届くので、
 *   リダイレクトは自分で辿り（`plugin-fetch-guard.ts`）、判定したアドレスを git に固定して渡す。
 * - 時間と取得サイズに上限を掛ける。サイズは `.git` の大きさを見て打ち切る（サーバ側の上限に頼らない）。
 * - symlink と submodule は辿らず、含めない（`skipped` に残す）。拒むと、使わない場所に symlink を持つ
 *   plugin が丸ごと入れられなくなる。
 */

export type PluginFetchErrorKind = 'invalid' | 'unavailable' | 'unconfigured';

/**
 * 取得の失敗。`invalid` は入力か取り元の中身が悪い（呼び手が直せる）、`unavailable` は取りに行けなかった
 * （取り元・ネットワーク・時間）、`unconfigured` は取り元の設定が無い。文言に環境変数や資格は載せない。
 */
export class PluginFetchError extends Error {
  readonly kind: PluginFetchErrorKind;
  constructor(kind: PluginFetchErrorKind, message: string) {
    super(message);
    this.name = 'PluginFetchError';
    this.kind = kind;
  }
}

export type PluginRequest =
  | { kind: 'url'; url: string; path?: string; ref?: string; sha?: string }
  | { kind: 'marketplace'; plugin: string };

export interface SkippedEntry {
  path: string;
  reason: 'symlink' | 'submodule' | 'git-dir';
}

export interface FetchedPlugin {
  name: string;
  description?: string;
  source: PluginSource;
  files: PluginFile[];
  skipped: SkippedEntry[];
}

export interface PluginFetcher {
  fetch(request: PluginRequest): Promise<FetchedPlugin>;
}

export interface PluginFetcherOptions {
  /** 公式 marketplace のリポジトリの URL。無ければ marketplace の取り元は `unconfigured`。 */
  marketplaceUrl?: string;
  /** 索引を取る ref（省略は HEAD）。 */
  marketplaceRef?: string;
  /** 索引のリポジトリ内の path。 */
  marketplaceIndexPath?: string;
  gitPath?: string;
  /** 1回の取得の全体の時間（ミリ秒）。 */
  timeoutMs?: number;
  /** `.git` の大きさの上限（バイト）。 */
  maxFetchBytes?: number;
  limits?: Partial<typeof PLUGIN_LIMITS>;
  /** `GIT_ALLOW_PROTOCOL`。既定は https だけ。 */
  allowedProtocols?: string;
  /** 取り元のホスト名の解決。テストの差し替え用（既定は OS の解決）。 */
  resolver?: Resolver;
  /** 事前の `info/refs` の GET。テストの差し替え用。 */
  probe?: Probe;
}

const MANIFEST_PATH = '.claude-plugin/plugin.json';
const DEFAULT_INDEX_PATH = '.claude-plugin/marketplace.json';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const SHA_RULE = /^[0-9a-f]{40}$/;

interface Ctx {
  gitPath: string;
  dir: string;
  env: NodeJS.ProcessEnv;
  deadline: number;
  maxFetchBytes: number;
  limits: typeof PLUGIN_LIMITS;
}

interface Repo {
  url: string;
  sha: string;
  ctx: Ctx;
}

/** 取り元を判定する道具。`allowedProtocols` を渡すのはテストだけで、そのときの file:// は判定を飛ばす。 */
interface Guard {
  resolver?: Resolver;
  probe?: Probe;
  skipFileUrls: boolean;
}

interface GitResult {
  stdout: Buffer;
}

function invalid(message: string): PluginFetchError {
  return new PluginFetchError('invalid', message);
}

function unavailable(message: string): PluginFetchError {
  return new PluginFetchError('unavailable', message);
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const child = join(path, name);
    const info = await lstat(child).catch(() => null);
    if (info === null) continue;
    total += info.isDirectory() ? await dirSize(child) : info.size;
  }
  return total;
}

const NO_AUTO_MAINTENANCE = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'] as const;

/**
 * git を1回走らせる。shell を通さない。全体の期限を超えたら殺す。`watchDir` があれば、その大きさが
 * 上限を超えた時点で殺す（走り終えた後にも1回見る）。
 */
async function runGit(
  ctx: Ctx,
  args: string[],
  options: { input?: string; maxStdout?: number; watchDir?: string; net?: string[] } = {},
): Promise<GitResult> {
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) throw unavailable('取得の時間の上限を超えた');
  const maxStdout = options.maxStdout ?? 1024 * 1024;
  // 自動の保守を止める: fetch は終わり際に `git maintenance run --auto --detach` を切り離して起こし、それが
  // 作業場の objects/ へ書く。グループの外へ出るので殺せず、後片づけの rm と競合して ENOTEMPTY になる（#4099）
  const fullArgs = [...NO_AUTO_MAINTENANCE, ...(options.net ?? []), ...args];

  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn(ctx.gitPath, fullArgs, {
      cwd: ctx.dir,
      env: ctx.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // git は子（git-remote-https など）を起こす。child.kill だけでは子が残るので、
      // 自分をグループの先頭にして、グループごと殺せるようにする。
      detached: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    const err: Buffer[] = [];
    let errBytes = 0;
    let failure: PluginFetchError | null = null;
    const kill = (error: PluginFetchError) => {
      failure ??= error;
      try {
        if (child.pid === undefined) child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // グループが既に無い（git が先に終わった）。残りは close で拾う。
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(() => kill(unavailable('取得の時間の上限を超えた')), remaining);
    const poll =
      options.watchDir === undefined
        ? null
        : setInterval(() => {
            void dirSize(options.watchDir ?? '').then((size) => {
              if (size > ctx.maxFetchBytes) kill(unavailable('取得したデータが大きすぎる'));
            });
          }, 200);

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        kill(invalid('git の出力が大きすぎる'));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= 8192) err.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      reject(unavailable('git を起動できない'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      void (async () => {
        if (failure === null && options.watchDir !== undefined) {
          if ((await dirSize(options.watchDir)) > ctx.maxFetchBytes) {
            failure = unavailable('取得したデータが大きすぎる');
          }
        }
        if (failure !== null) return reject(failure);
        if (code !== 0) {
          const detail = Buffer.concat(err).toString('utf8').trim().split('\n').at(-1) ?? '';
          return reject(unavailable(`git が失敗した: ${detail.slice(0, 200)}`));
        }
        resolve({ stdout: Buffer.concat(out) });
      })();
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

/**
 * 取りに行く先を判定し、git に渡す設定（`-c`）と URL を返す。git にはリダイレクトを辿らせず、
 * 判定を通ったアドレスを固定する（名前解決のやり直しで、別のアドレスへ届かせない）。
 */
async function guardSource(
  ctx: Ctx,
  guard: Guard,
  url: string,
): Promise<{ url: string; net: string[] }> {
  if (guard.skipFileUrls && url.startsWith('file:')) return { url, net: [] };
  try {
    const source = await resolveRepoSource(url, {
      ...(guard.resolver === undefined ? {} : { resolver: guard.resolver }),
      ...(guard.probe === undefined ? {} : { probe: guard.probe }),
      remainingMs: () => Math.max(1, ctx.deadline - Date.now()),
    });
    const net = ['-c', 'http.followRedirects=false'];
    // IP リテラルは名前解決が起きないので、固定するものが無い。
    if (!source.literal) {
      net.push(
        '-c',
        `http.curloptResolve=${curlResolveValue(source.host, source.port, source.addresses)}`,
      );
    }
    return { url: source.repoUrl, net };
  } catch (error) {
    if (error instanceof SourceGuardError) {
      throw error.kind === 'unavailable' ? unavailable(error.message) : invalid(error.message);
    }
    throw error;
  }
}

async function resolveRef(
  ctx: Ctx,
  url: string,
  ref: string | undefined,
  net: string[],
): Promise<string> {
  const name = ref ?? 'HEAD';
  const { stdout } = await runGit(ctx, ['ls-remote', '--', url, name], { net });
  const rows = stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [sha = '', refName = ''] = line.split('\t');
      return { sha, refName };
    });
  const pick = (refName: string) => rows.find((row) => row.refName === refName)?.sha;
  const found =
    name === 'HEAD'
      ? pick('HEAD')
      : (pick(`refs/heads/${name}`) ??
        pick(`refs/tags/${name}^{}`) ??
        pick(`refs/tags/${name}`) ??
        pick(name));
  if (found === undefined || !SHA_RULE.test(found)) {
    throw invalid('指定の ref（ブランチ・タグ）が取り元に無い');
  }
  return found;
}

async function openRepo(
  ctx: Ctx,
  guard: Guard,
  url: string,
  pin: { ref?: string; sha?: string },
): Promise<Repo> {
  if (pin.sha !== undefined && !SHA_RULE.test(pin.sha)) {
    throw invalid('sha は小文字40桁の16進で書くこと');
  }
  const target = await guardSource(ctx, guard, url);
  const sha = pin.sha ?? (await resolveRef(ctx, target.url, pin.ref, target.net));
  await runGit(ctx, ['init', '-q', '--bare', '.']);
  await runGit(ctx, ['fetch', '-q', '--depth', '1', '--no-tags', '--', target.url, sha], {
    watchDir: ctx.dir,
    net: target.net,
  });
  try {
    await runGit(ctx, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    throw invalid('取り元から、指定の commit を取れなかった');
  }
  return { url, sha, ctx };
}

function checkRelativePath(path: string, label: string): string {
  const reason = validatePluginFilePath(path);
  if (reason !== null) throw invalid(`${label}が不正: ${reason}`);
  return path;
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
}

function parseTree(raw: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of raw.toString('utf8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const [mode = '', type = '', oid = '', size = '-'] = meta;
    entries.push({
      mode,
      type,
      oid,
      size: size === '-' ? 0 : Number(size),
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

async function readBlobs(ctx: Ctx, oids: string[], expectedBytes: number): Promise<Buffer[]> {
  const { stdout } = await runGit(ctx, ['cat-file', '--batch'], {
    input: `${oids.join('\n')}\n`,
    maxStdout: expectedBytes + oids.length * 160 + 1024,
  });
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const oid of oids) {
    const lineEnd = stdout.indexOf(0x0a, offset);
    if (lineEnd === -1) throw unavailable('git の出力を読めない');
    const [gotOid, type, sizeText] = stdout.subarray(offset, lineEnd).toString('utf8').split(' ');
    const size = Number(sizeText);
    if (gotOid !== oid || type !== 'blob' || !Number.isInteger(size)) {
      throw unavailable('git の出力を読めない');
    }
    const start = lineEnd + 1;
    blobs.push(stdout.subarray(start, start + size));
    offset = start + size + 1;
  }
  return blobs;
}

async function readPluginFiles(
  repo: Repo,
  path: string | undefined,
): Promise<{ files: PluginFile[]; skipped: SkippedEntry[] }> {
  const { ctx, sha } = repo;
  const treeish =
    path === undefined ? `${sha}^{tree}` : `${sha}:${checkRelativePath(path, 'path')}`;
  let type: string;
  try {
    type = (await runGit(ctx, ['cat-file', '-t', treeish])).stdout.toString('utf8').trim();
  } catch {
    throw invalid('指定の path が、その commit に無い');
  }
  if (type !== 'tree')
    throw invalid('指定の path がディレクトリでない（symlink やファイルは取らない）');

  const listing = await runGit(ctx, ['ls-tree', '-r', '-z', '-l', treeish], {
    maxStdout: ctx.limits.maxFiles * (ctx.limits.maxPathLength * 4 + 128) + 1024 * 1024,
  });
  const skipped: SkippedEntry[] = [];
  const keep: TreeEntry[] = [];
  for (const entry of parseTree(listing.stdout)) {
    if (entry.path.split('/').some((segment) => segment.toLowerCase() === '.git')) {
      skipped.push({ path: entry.path, reason: 'git-dir' });
    } else if (entry.mode === '120000') {
      skipped.push({ path: entry.path, reason: 'symlink' });
    } else if (entry.type === 'commit') {
      skipped.push({ path: entry.path, reason: 'submodule' });
    } else if (entry.type === 'blob') {
      keep.push(entry);
    }
  }
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (keep.length > ctx.limits.maxFiles) throw invalid('ファイルの数が多すぎる');
  let total = 0;
  for (const entry of keep) {
    checkRelativePath(entry.path, 'リポジトリ内の path');
    if (entry.size > ctx.limits.maxFileBytes) throw invalid('大きすぎるファイルがある');
    total += entry.size;
    if (total > ctx.limits.maxTotalBytes) throw invalid('本体の合計が大きすぎる');
  }

  const blobs =
    keep.length === 0
      ? []
      : await readBlobs(
          ctx,
          keep.map((e) => e.oid),
          total,
        );
  const files = keep.map((entry, index) => ({
    path: entry.path,
    executable: entry.mode === '100755',
    content: new Uint8Array(blobs[index] ?? Buffer.alloc(0)),
  }));
  return { files, skipped };
}

async function readSingleBlob(repo: Repo, path: string): Promise<Buffer> {
  const object = `${repo.sha}:${path}`;
  try {
    const type = (await runGit(repo.ctx, ['cat-file', '-t', object])).stdout
      .toString('utf8')
      .trim();
    if (type !== 'blob') throw new Error('not a blob');
    return (await runGit(repo.ctx, ['cat-file', 'blob', object], { maxStdout: MAX_INDEX_BYTES }))
      .stdout;
  } catch (error) {
    if (error instanceof PluginFetchError && error.kind === 'invalid') throw error;
    throw invalid('marketplace の索引を取り元から読めない');
  }
}

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
}

function readManifest(files: PluginFile[]): Manifest {
  const file = files.find((f) => f.path === MANIFEST_PATH);
  if (file === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.content));
  } catch {
    throw invalid('.claude-plugin/plugin.json が JSON として読めない');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('.claude-plugin/plugin.json がオブジェクトでない');
  }
  const record = parsed as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  return {
    ...(text(record.name) === undefined ? {} : { name: text(record.name) }),
    ...(text(record.version) === undefined ? {} : { version: text(record.version) }),
    ...(text(record.description) === undefined ? {} : { description: text(record.description) }),
  };
}

function lastSegment(value: string): string {
  const segments = value.split('/').filter((s) => s !== '');
  return (segments.at(-1) ?? '').replace(/\.git$/, '');
}

function validName(name: string): string {
  const parsed = pluginNameSchema.safeParse(name);
  if (!parsed.success) throw invalid('plugin の名前が使えない形（英数字・-・_ の1〜64文字）');
  return parsed.data;
}

function versionOf(value: string | undefined): { version?: string } {
  return value === undefined || value.length > 128 ? {} : { version: value };
}

interface IndexEntry {
  name: string;
  description?: string;
  version?: string;
  source: unknown;
}

function findIndexEntry(raw: Buffer, plugin: string): IndexEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid('marketplace の索引が JSON として読めない');
  }
  const plugins =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { plugins?: unknown }).plugins
      : undefined;
  if (!Array.isArray(plugins)) throw invalid('marketplace の索引に plugins が無い');
  for (const item of plugins as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.name !== plugin) continue;
    return {
      name: plugin,
      source: record.source,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(typeof record.version === 'string' ? { version: record.version } : {}),
    };
  }
  throw invalid('marketplace の索引に、その名前の plugin が無い');
}

const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function repoUrlOf(value: unknown, shorthandAllowed: boolean): string {
  if (typeof value !== 'string' || value === '') throw invalid('索引の source に URL が無い');
  if (shorthandAllowed && GITHUB_SHORTHAND.test(value)) {
    return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  }
  if (value.startsWith('-')) throw invalid('索引の source の URL が不正');
  // 資格がクエリ・フラグメントに載っていても、取り元として日誌・DB に残さない。
  if (/[?#]/.test(value))
    throw invalid('索引の source の URL にクエリ・フラグメントを含められない');
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function createPluginFetcher(options: PluginFetcherOptions = {}): PluginFetcher {
  const limits = { ...PLUGIN_LIMITS, ...options.limits };
  const guard: Guard = {
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    skipFileUrls: options.allowedProtocols !== undefined,
  };

  async function withCtx<T>(work: (ctx: Ctx) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-plugin-fetch-'));
    try {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: options.allowedProtocols ?? 'https',
        LC_ALL: 'C',
      };
      return await work({
        gitPath: options.gitPath ?? 'git',
        dir,
        env,
        deadline: Date.now() + (options.timeoutMs ?? 60_000),
        maxFetchBytes: options.maxFetchBytes ?? 128 * 1024 * 1024,
        limits,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function fetchUrl(
    request: Extract<PluginRequest, { kind: 'url' }>,
  ): Promise<FetchedPlugin> {
    return await withCtx(async (ctx) => {
      const repo = await openRepo(ctx, guard, request.url, {
        ...(request.ref === undefined ? {} : { ref: request.ref }),
        ...(request.sha === undefined ? {} : { sha: request.sha }),
      });
      const { files, skipped } = await readPluginFiles(repo, request.path);
      const manifest = readManifest(files);
      const name = validName(
        manifest.name ??
          (request.path === undefined
            ? lastSegment(safePathname(request.url))
            : lastSegment(request.path)),
      );
      return {
        name,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        source: {
          kind: 'url',
          url: request.url,
          ...(request.path === undefined ? {} : { path: request.path }),
          sha: repo.sha,
          ...versionOf(manifest.version),
        },
        files,
        skipped,
      };
    });
  }

  async function fetchMarketplace(
    request: Extract<PluginRequest, { kind: 'marketplace' }>,
  ): Promise<FetchedPlugin> {
    const marketplaceUrl = options.marketplaceUrl;
    if (marketplaceUrl === undefined || marketplaceUrl === '') {
      throw new PluginFetchError(
        'unconfigured',
        '公式 marketplace のリポジトリの URL が設定されていない（ALTEROID_PLUGIN_MARKETPLACE_URL）',
      );
    }
    return await withCtx(async (ctx) => {
      const index = await openRepo(ctx, guard, marketplaceUrl, {
        ...(options.marketplaceRef === undefined ? {} : { ref: options.marketplaceRef }),
      });
      const entry = findIndexEntry(
        await readSingleBlob(index, options.marketplaceIndexPath ?? DEFAULT_INDEX_PATH),
        request.plugin,
      );
      const name = validName(entry.name);

      let repo: Repo;
      let path: string | undefined;
      const source = entry.source;
      if (typeof source === 'string') {
        if (!source.startsWith('./')) throw invalid('索引の source を読めない');
        path = checkRelativePath(source.slice(2).replace(/\/+$/, ''), '索引の path');
        repo = index;
      } else if (typeof source === 'object' && source !== null) {
        const record = source as Record<string, unknown>;
        const kind = record.source;
        if (kind !== 'github' && kind !== 'url' && kind !== 'git-subdir') {
          throw invalid('索引の source の種類に未対応');
        }
        const url = repoUrlOf(kind === 'github' ? record.repo : record.url, kind !== 'url');
        const sha = optionalString(record.sha);
        const ref = optionalString(record.ref);
        if (kind === 'git-subdir') {
          const subdir = optionalString(record.path);
          if (subdir === undefined) throw invalid('索引の git-subdir に path が無い');
          path = checkRelativePath(subdir.replace(/^\.\//, '').replace(/\/+$/, ''), '索引の path');
        }
        repo = await openRepo(ctx, guard, url, {
          ...(sha === undefined ? {} : { sha }),
          ...(ref === undefined ? {} : { ref }),
        });
      } else {
        throw invalid('索引の source を読めない');
      }

      const { files, skipped } = await readPluginFiles(repo, path);
      const manifest = readManifest(files);
      const description = entry.description ?? manifest.description;
      return {
        name,
        ...(description === undefined ? {} : { description }),
        source: {
          kind: 'marketplace',
          marketplace: OFFICIAL_MARKETPLACE,
          plugin: name,
          url: repo.url,
          ...(path === undefined ? {} : { path }),
          sha: repo.sha,
          ...versionOf(entry.version ?? manifest.version),
        },
        files,
        skipped,
      };
    });
  }

  return {
    fetch: (request) => (request.kind === 'url' ? fetchUrl(request) : fetchMarketplace(request)),
  };
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}
