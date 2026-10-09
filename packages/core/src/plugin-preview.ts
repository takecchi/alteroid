import { randomBytes } from 'node:crypto';

import type { FetchedPlugin, SkippedEntry } from './plugin-fetch.js';
import { planPluginExtraction } from './plugin-extract.js';
import type { PluginSource } from './plugins.js';

// 要約は展開器の計画を通して作る: 「落ちると言ったもの」と「実際に落ちるもの」をずらさないため。

export interface PluginPreviewSummary {
  name: string;
  description?: string;
  source: PluginSource;
  sha: string;
  fileCount: number;
  totalBytes: number;
  files: { path: string; size: number; executable: boolean }[];
  counts: { skills: number; agents: number; commands: number };
  /** 展開器は enableHooks でも hooks を出さない。 */
  hooks: { present: boolean; paths: string[] };
  modules: { present: boolean; paths: string[] };
  lspServers: { present: boolean; paths: string[] };
  mcp: { present: boolean; paths: string[] };
  executables: { extracted: string[]; notExtracted: string[] };
  shellExecution: { present: boolean; paths: string[] };
  skipped: SkippedEntry[];
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

const SHELL_EXECUTION = /!`[^`\n]|^```!/m;

function bodyOf(bytes: Uint8Array): string {
  try {
    return stripFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return '';
  }
}

const uniqueSorted = (values: string[]) =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function summarizeFetchedPlugin(fetched: FetchedPlugin): PluginPreviewSummary {
  const { files } = fetched;
  const bytesOf = (f: { content: Uint8Array }) => f.content.byteLength;

  const planAll = planPluginExtraction(fetched, { enableHooks: true, enableMcp: true });
  const dropsAll = planAll.removed;
  const dropsDefault = planPluginExtraction(fetched, {
    enableHooks: false,
    enableMcp: false,
  }).removed;
  const extractedExecutables = new Set(
    planAll.outputs.filter((o) => o.executable).map((o) => o.path),
  );
  const shellPaths = uniqueSorted(
    planAll.outputs
      .filter(
        (o) =>
          /^(?:skills|commands)\//.test(o.path) &&
          /\.md$/i.test(o.path) &&
          SHELL_EXECUTION.test(bodyOf(o.bytes)),
      )
      .map((o) => o.path),
  );
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
  const mcpPaths = uniqueSorted([
    ...reasonPaths('mcp-disabled'),
    ...dropsDefault
      .map((d) => d.path)
      .filter((path) => path.toLowerCase().endsWith('.md#mcpservers')),
  ]);

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
    executables: {
      extracted: uniqueSorted(
        files.filter((f) => extractedExecutables.has(f.path)).map((f) => f.path),
      ),
      notExtracted: uniqueSorted(
        files.filter((f) => f.executable && !extractedExecutables.has(f.path)).map((f) => f.path),
      ),
    },
    shellExecution: { present: shellPaths.length > 0, paths: shellPaths },
    skipped: fetched.skipped,
    extractorDrops: dropsAll
      .map((d) => ({ path: d.path, reason: d.reason }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    skillExcerpts,
  };
}

export interface PluginPreviewStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface PluginPreviewStore {
  put(fetched: FetchedPlugin): { previewId: string; expiresAt: string };
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
