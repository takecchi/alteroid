import { randomBytes } from 'node:crypto';

import type { FetchedPlugin, SkippedEntry } from './plugin-fetch.js';
import { planPluginExtractionRemovals } from './plugin-extract.js';
import type { PluginSource } from './plugins.js';

/**
 * 入れる前の確認で見せる要約と、確定までの間だけ取得物を預かる置き場。
 *
 * 要約は展開器の計画（`planPluginExtractionRemovals`）を通して作るので、
 * 「落ちると言ったもの」と「実際に落ちるもの」がずれない。
 * 預かるのはメモリだけ。再起動で消えてよい（確認し直せばよい）。
 */

export interface PluginPreviewSummary {
  name: string;
  description?: string;
  source: PluginSource;
  /** 解決した commit SHA（`source.sha` と同じ）。 */
  sha: string;
  fileCount: number;
  totalBytes: number;
  files: { path: string; size: number; executable: boolean }[];
  counts: { skills: number; agents: number; commands: number };
  /** hooks の在りか（`hooks/`・manifest・SKILL.md などの frontmatter）。**展開器は enableHooks でも出さない**。 */
  hooks: { present: boolean; paths: string[] };
  modules: { present: boolean; paths: string[] };
  lspServers: { present: boolean; paths: string[] };
  /** `.mcp.json` と manifest の `mcpServers`。enableMcp のときだけ展開される。 */
  mcp: { present: boolean; paths: string[] };
  executables: string[];
  skipped: SkippedEntry[];
  /** enableHooks / enableMcp を true にしても展開器が落とすもの。 */
  extractorDrops: { path: string; reason: string }[];
  skillExcerpts: { path: string; excerpt: string; truncated: boolean }[];
}

const EXCERPT_CHARS = 500;
const MAX_EXCERPTS = 5;

function stripFrontmatter(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!/^---[ \t]*\r?\n/.test(body)) return body;
  const lines = body.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[i] ?? '')) return lines.slice(i + 1).join('\n');
  }
  return body;
}

function excerptOf(bytes: Uint8Array): { excerpt: string; truncated: boolean } | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const body = stripFrontmatter(text).trim();
  const chars = [...body];
  return {
    excerpt: chars.slice(0, EXCERPT_CHARS).join(''),
    truncated: chars.length > EXCERPT_CHARS,
  };
}

const uniqueSorted = (values: string[]) =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function summarizeFetchedPlugin(fetched: FetchedPlugin): PluginPreviewSummary {
  const { files } = fetched;
  const bytesOf = (f: { content: Uint8Array }) => f.content.byteLength;

  const dropsAll = planPluginExtractionRemovals(fetched, { enableHooks: true, enableMcp: true });
  const dropsDefault = planPluginExtractionRemovals(fetched, {
    enableHooks: false,
    enableMcp: false,
  });
  const reasonPaths = (reason: string) =>
    uniqueSorted(dropsDefault.filter((d) => d.reason === reason).map((d) => d.path));

  const skillDirs = new Set<string>();
  let agents = 0;
  let commands = 0;
  for (const file of files) {
    const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (skill?.[1] !== undefined) skillDirs.add(skill[1]);
    if (file.path.startsWith('agents/') && /\.md$/i.test(file.path)) agents += 1;
    if (file.path.startsWith('commands/') && /\.md$/i.test(file.path)) commands += 1;
  }

  const hooksPaths = reasonPaths('hooks-disabled');
  const modulesPaths = uniqueSorted([
    ...reasonPaths('modules-not-extracted'),
    ...files.filter((f) => f.path.startsWith('modules/')).map((f) => f.path),
  ]);
  const lspPaths = uniqueSorted(
    dropsAll
      .map((d) => d.path)
      .filter((path) => path === '.lsp.json' || path.endsWith('#lspServers')),
  );
  const mcpPaths = reasonPaths('mcp-disabled');

  const skillExcerpts: PluginPreviewSummary['skillExcerpts'] = [];
  for (const file of files) {
    if (skillExcerpts.length >= MAX_EXCERPTS) break;
    if (!/^skills\/[^/]+\/SKILL\.md$/.test(file.path)) continue;
    const excerpt = excerptOf(file.content);
    if (excerpt !== null) skillExcerpts.push({ path: file.path, ...excerpt });
  }
  skillExcerpts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    name: fetched.name,
    ...(fetched.description === undefined ? {} : { description: fetched.description }),
    source: fetched.source,
    sha: fetched.source.sha,
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + bytesOf(f), 0),
    files: files
      .map((f) => ({ path: f.path, size: bytesOf(f), executable: f.executable }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    counts: { skills: skillDirs.size, agents, commands },
    hooks: { present: hooksPaths.length > 0, paths: hooksPaths },
    modules: { present: modulesPaths.length > 0, paths: modulesPaths },
    lspServers: { present: lspPaths.length > 0, paths: lspPaths },
    mcp: { present: mcpPaths.length > 0, paths: mcpPaths },
    executables: uniqueSorted(files.filter((f) => f.executable).map((f) => f.path)),
    skipped: fetched.skipped,
    extractorDrops: dropsAll
      .map((d) => ({ path: d.path, reason: d.reason }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    skillExcerpts,
  };
}

export interface PluginPreviewStoreOptions {
  /** 預かる期間（ミリ秒）。 */
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface PluginPreviewStore {
  put(fetched: FetchedPlugin): { previewId: string; expiresAt: string };
  /** 期限内ならそのまま返す。期限切れ・不明は `undefined`。 */
  get(previewId: string): FetchedPlugin | undefined;
  discard(previewId: string): void;
}

export const PLUGIN_PREVIEW_TTL_MS = 10 * 60 * 1000;

export function createPluginPreviewStore(
  options: PluginPreviewStoreOptions = {},
): PluginPreviewStore {
  const ttlMs = options.ttlMs ?? PLUGIN_PREVIEW_TTL_MS;
  const maxEntries = options.maxEntries ?? 8;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { fetched: FetchedPlugin; expiresAt: number; bytes: number }>();

  function sweep(): void {
    const current = now();
    for (const [id, entry] of entries) if (entry.expiresAt <= current) entries.delete(id);
  }

  function totalBytes(): number {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes;
    return total;
  }

  return {
    put(fetched) {
      sweep();
      const bytes = fetched.files.reduce((sum, f) => sum + f.content.byteLength, 0);
      // Map は挿入順なので、先頭が最も古い。
      while (entries.size > 0 && (entries.size >= maxEntries || totalBytes() + bytes > maxBytes)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const previewId = randomBytes(24).toString('base64url');
      const expiresAt = now() + ttlMs;
      entries.set(previewId, { fetched, expiresAt, bytes });
      return { previewId, expiresAt: new Date(expiresAt).toISOString() };
    },
    get(previewId) {
      sweep();
      return entries.get(previewId)?.fetched;
    },
    discard(previewId) {
      entries.delete(previewId);
    },
  };
}
