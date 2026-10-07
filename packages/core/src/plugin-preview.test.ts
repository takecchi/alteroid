import { describe, expect, it } from 'vitest';

import type { FetchedPlugin } from './plugin-fetch.js';
import { createPluginPreviewStore, summarizeFetchedPlugin } from './plugin-preview.js';

const SHA = 'a'.repeat(40);
const encoder = new TextEncoder();

function file(path: string, text: string, executable = false) {
  return { path, executable, content: encoder.encode(text) };
}

function fetched(
  files: ReturnType<typeof file>[],
  overrides: Partial<FetchedPlugin> = {},
): FetchedPlugin {
  return {
    name: 'demo',
    source: { kind: 'url', url: 'https://example.invalid/r.git', sha: SHA },
    files,
    skipped: [],
    ...overrides,
  };
}

describe('summarizeFetchedPlugin', () => {
  it('名前・取り元・SHA・ファイル一覧と大きさ・skills/agents/commands の数を返す', () => {
    const summary = summarizeFetchedPlugin(
      fetched(
        [
          file('.claude-plugin/plugin.json', '{"name":"demo"}'),
          file('skills/a/SKILL.md', 'あ'),
          file('skills/b/SKILL.md', 'b'),
          file('skills/b/extra.md', 'b2'),
          file('agents/x.md', 'x'),
          file('commands/y.md', 'y'),
          file('commands/z.md', 'z'),
        ],
        { description: '説明' },
      ),
    );
    expect(summary.name).toBe('demo');
    expect(summary.description).toBe('説明');
    expect(summary.sha).toBe(SHA);
    expect(summary.source).toMatchObject({ kind: 'url', sha: SHA });
    expect(summary.counts).toEqual({ skills: 2, agents: 1, commands: 2 });
    expect(summary.fileCount).toBe(7);
    expect(summary.files).toContainEqual({ path: 'skills/a/SKILL.md', size: 3, executable: false });
    expect(summary.totalBytes).toBe(
      summary.files.reduce((sum: number, f: { size: number }) => sum + f.size, 0),
    );
    expect(summary.hooks.present).toBe(false);
    expect(summary.mcp.present).toBe(false);
    expect(summary.executables).toEqual([]);
  });

  it('hooks（hooks/・manifest・frontmatter）を、どこにあるかと一緒に出す', () => {
    const summary = summarizeFetchedPlugin(
      fetched([
        file('.claude-plugin/plugin.json', JSON.stringify({ name: 'demo', hooks: {} })),
        file('hooks/hooks.json', '{}'),
        file('skills/a/SKILL.md', '---\nname: a\nhooks:\n  PreToolUse: x\n---\n本文\n'),
      ]),
    );
    expect(summary.hooks.present).toBe(true);
    expect(summary.hooks.paths).toEqual(
      expect.arrayContaining([
        'hooks/hooks.json',
        '.claude-plugin/plugin.json#hooks',
        'skills/a/SKILL.md#hooks',
      ]),
    );
    expect(summary.extractorDrops.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['hooks/hooks.json']),
    );
  });

  it('modules・lspServers・.mcp.json・実行ファイルの有無と、展開器が落とすもの', () => {
    const summary = summarizeFetchedPlugin(
      fetched([
        file(
          '.claude-plugin/plugin.json',
          JSON.stringify({ name: 'demo', modules: ['m.js'], lspServers: {}, mcpServers: {} }),
        ),
        file('.mcp.json', '{"mcpServers":{}}'),
        file('.lsp.json', '{}'),
        file('bin/tool', '#!/bin/sh', true),
        file('skills/a/SKILL.md', 'a'),
      ]),
    );
    expect(summary.modules.present).toBe(true);
    expect(summary.lspServers.present).toBe(true);
    expect(summary.mcp.present).toBe(true);
    expect(summary.mcp.paths).toEqual(expect.arrayContaining(['.mcp.json']));
    expect(summary.executables).toEqual(['bin/tool']);
    const dropped = new Map(
      summary.extractorDrops.map((d: { path: string; reason: string }) => [d.path, d.reason]),
    );
    expect(dropped.get('bin/tool')).toBe('not-allowlisted');
    expect(dropped.get('.claude-plugin/plugin.json#modules')).toBe('modules-not-extracted');
    expect(dropped.get('.lsp.json')).toBe('not-allowlisted');
    expect(dropped.has('.mcp.json')).toBe(false);
  });

  it('SKILL.md の本文の冒頭を出す（frontmatter は除く。長ければ切る）', () => {
    const long = '長'.repeat(2000);
    const summary = summarizeFetchedPlugin(
      fetched([file('skills/a/SKILL.md', `---\nname: a\n---\n${long}`)]),
    );
    expect(summary.skillExcerpts).toHaveLength(1);
    const [excerpt] = summary.skillExcerpts;
    expect(excerpt?.path).toBe('skills/a/SKILL.md');
    expect(excerpt?.excerpt.startsWith('長')).toBe(true);
    expect(excerpt?.excerpt.length).toBeLessThan(700);
    expect(excerpt?.truncated).toBe(true);
  });

  it('取らなかった symlink を引き継ぐ', () => {
    const summary = summarizeFetchedPlugin(
      fetched([file('skills/a/SKILL.md', 'a')], {
        skipped: [{ path: 'skills/l', reason: 'symlink' }],
      }),
    );
    expect(summary.skipped).toEqual([{ path: 'skills/l', reason: 'symlink' }]);
  });
});

describe('createPluginPreviewStore', () => {
  it('previewId で、置いたものをそのまま返す', () => {
    const store = createPluginPreviewStore();
    const plugin = fetched([file('skills/a/SKILL.md', 'a')]);
    const { previewId, expiresAt } = store.put(plugin);
    expect(previewId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(Number.isNaN(Date.parse(expiresAt))).toBe(false);
    expect(store.get(previewId)).toBe(plugin);
    expect(store.get('unknown')).toBeUndefined();
  });

  it('期限が来たら返さない', () => {
    let now = 1_000_000;
    const store = createPluginPreviewStore({ ttlMs: 60_000, now: () => now });
    const { previewId } = store.put(fetched([file('a', 'a')]));
    now += 59_999;
    expect(store.get(previewId)).toBeDefined();
    now += 2;
    expect(store.get(previewId)).toBeUndefined();
  });

  it('discard で消える', () => {
    const store = createPluginPreviewStore();
    const { previewId } = store.put(fetched([file('a', 'a')]));
    store.discard(previewId);
    expect(store.get(previewId)).toBeUndefined();
  });

  it('件数・合計バイトの上限を超えたら古いものから落とす', () => {
    const store = createPluginPreviewStore({ maxEntries: 2 });
    const a = store.put(fetched([file('a', 'a')]));
    const b = store.put(fetched([file('a', 'b')]));
    const c = store.put(fetched([file('a', 'c')]));
    expect(store.get(a.previewId)).toBeUndefined();
    expect(store.get(b.previewId)).toBeDefined();
    expect(store.get(c.previewId)).toBeDefined();

    const bytes = createPluginPreviewStore({ maxBytes: 10 });
    const x = bytes.put(fetched([file('a', '123456')]));
    const y = bytes.put(fetched([file('a', '123456')]));
    expect(bytes.get(x.previewId)).toBeUndefined();
    expect(bytes.get(y.previewId)).toBeDefined();
  });
});
