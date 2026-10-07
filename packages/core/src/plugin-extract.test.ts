import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  extractPlugin,
  extractPluginsForScopes,
  pruneExtractedPluginDirs,
  pruneExtractedPluginsAgainstStore,
  type ExtractedPlugin,
} from './plugin-extract.js';
import { parsePluginInput, type PluginInput, type StoredPlugin } from './plugins.js';
import { createMemoryStores } from './testing.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const encoder = new TextEncoder();

function file(path: string, text: string, executable = false) {
  return { path, executable, content: encoder.encode(text) };
}

function plugin(
  files: ReturnType<typeof file>[],
  overrides: Record<string, unknown> = {},
): StoredPlugin {
  return parsePluginInput({
    name: 'demo',
    source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_A },
    files,
    installedAt: '2026-10-07T00:00:00.000Z',
    installedBy: 'account-1',
    ...overrides,
  } as PluginInput);
}

const MANIFEST = JSON.stringify({ name: 'demo', version: '1.0.0', description: 'dummy-content' });

function basePlugin(overrides: Record<string, unknown> = {}): StoredPlugin {
  return plugin(
    [
      file('.claude-plugin/plugin.json', MANIFEST),
      file('skills/one/SKILL.md', '---\nname: one\ndescription: dummy-content\n---\n# body\n'),
    ],
    overrides,
  );
}

/** 0o555 のディレクトリを、テスト後の掃除が消せるように書込み可へ戻す。 */
async function makeWritable(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) return;
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) await makeWritable(join(dir, name));
}

const roots: string[] = [];
async function newRoot(): Promise<string> {
  const root = await makeTempDir('alteroid-plugin-extract-');
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await makeWritable(root);
});

async function listTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const info = await lstat(join(dir, name));
    if (info.isDirectory()) out.push(...(await listTree(join(dir, name), rel)));
    else out.push(rel);
  }
  return out;
}

/** 展開先のファイル（展開側のマーカーを除く）。 */
async function extractedFiles(result: ExtractedPlugin): Promise<string[]> {
  return (await listTree(result.path)).filter((p) => p !== '.alteroid-extract.json');
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('ホワイトリスト方式の展開', () => {
  it('許可した形だけを展開し、hooks/ とそれ以外は出さない', async () => {
    const root = await newRoot();
    const result = await extractPlugin(
      root,
      plugin([
        file('.claude-plugin/plugin.json', MANIFEST),
        file('skills/one/SKILL.md', '# dummy-content\n'),
        file('skills/one/scripts/run.sh', 'dummy-content', true),
        file('agents/a.md', '# dummy-content\n'),
        file('commands/c.md', '# dummy-content\n'),
        file('hooks/hooks.json', '{}'),
        file('hooks/run.sh', 'dummy-content', true),
        file('scripts/other.sh', 'dummy-content', true),
        file('README.md', 'dummy-content'),
        file('.claude-plugin/extra.json', '{}'),
      ]),
    );
    expect(await extractedFiles(result)).toEqual([
      '.claude-plugin/plugin.json',
      'agents/a.md',
      'commands/c.md',
      'skills/one/SKILL.md',
      'skills/one/scripts/run.sh',
    ]);
    const removed = new Map(result.removed.map((r) => [r.path, r]));
    expect(removed.get('hooks/hooks.json')).toMatchObject({
      plugin: 'demo',
      reason: 'hooks-disabled',
    });
    expect(removed.get('hooks/run.sh')).toBeDefined();
    expect(removed.get('scripts/other.sh')?.reason).toBe('not-allowlisted');
    expect(removed.get('README.md')?.reason).toBe('not-allowlisted');
    expect(removed.get('.claude-plugin/extra.json')?.reason).toBe('not-allowlisted');
  });

  it('取り除いたものの一覧に内容や値を載せない', async () => {
    const root = await newRoot();
    const result = await extractPlugin(
      root,
      plugin([
        file(
          '.claude-plugin/plugin.json',
          JSON.stringify({ name: 'demo', hooks: 'secret-looking-marker' }),
        ),
        file('hooks/hooks.json', 'secret-looking-marker'),
      ]),
    );
    expect(JSON.stringify(result.removed)).not.toContain('secret-looking-marker');
    for (const item of result.removed) {
      expect(Object.keys(item).sort()).toEqual(['path', 'plugin', 'reason']);
    }
  });

  it('manifest はメタデータの欄だけ残し、他はすべて落とす（欄の名前だけを返す）', async () => {
    const root = await newRoot();
    const metadata = {
      name: 'demo',
      version: '1.2.3',
      description: 'dummy-content',
      author: { name: 'dummy-author' },
      homepage: 'https://example.com',
      repository: 'https://example.com/repo',
      license: 'MIT',
      keywords: ['dummy-content'],
    };
    const manifest = {
      ...metadata,
      skills: './elsewhere',
      agents: ['./a.md'],
      commands: './c',
      hooks: { PreToolUse: [] },
      modules: ['./m.js'],
      lspServers: { x: { command: 'dummy-content' } },
      unknownField: 'dummy-value',
    };
    const result = await extractPlugin(
      root,
      plugin([file('.claude-plugin/plugin.json', JSON.stringify(manifest))]),
    );
    const written = JSON.parse(
      await readFile(join(result.path, '.claude-plugin/plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(written).toEqual(metadata);
    const byPath = new Map(result.removed.map((r) => [r.path, r.reason]));
    expect([...byPath.keys()].sort()).toEqual(
      ['agents', 'commands', 'hooks', 'lspServers', 'modules', 'skills', 'unknownField'].map(
        (k) => `.claude-plugin/plugin.json#${k}`,
      ),
    );
    expect(byPath.get('.claude-plugin/plugin.json#hooks')).toBe('hooks-disabled');
    expect(byPath.get('.claude-plugin/plugin.json#modules')).toBe('modules-not-extracted');
    expect(byPath.get('.claude-plugin/plugin.json#lspServers')).toBe('not-allowlisted');
    expect(byPath.get('.claude-plugin/plugin.json#skills')).toBe('not-allowlisted');
    expect(byPath.get('.claude-plugin/plugin.json#unknownField')).toBe('not-allowlisted');
    expect(JSON.stringify(result.removed)).not.toContain('dummy-value');
  });

  it('manifest が JSON として読めなければ manifest だけ展開せず、一覧に載せる', async () => {
    const root = await newRoot();
    const result = await extractPlugin(
      root,
      plugin([
        file('.claude-plugin/plugin.json', '{ not json'),
        file('skills/a/SKILL.md', '# x\n'),
      ]),
    );
    expect(await extractedFiles(result)).toEqual(['skills/a/SKILL.md']);
    expect(result.removed).toEqual([
      { plugin: 'demo', path: '.claude-plugin/plugin.json', reason: 'manifest-unreadable' },
    ]);
  });

  it('manifest が object でなければ展開しない', async () => {
    const root = await newRoot();
    const result = await extractPlugin(root, plugin([file('.claude-plugin/plugin.json', '[1]')]));
    expect(await extractedFiles(result)).toEqual([]);
    expect(result.removed[0]?.reason).toBe('manifest-unreadable');
  });

  it('manifest のインラインの mcpServers は enableMcp が false のとき落とす', async () => {
    const manifest = JSON.stringify({
      name: 'demo',
      mcpServers: { x: { command: 'dummy-content' } },
    });
    const off = await extractPlugin(
      await newRoot(),
      plugin([file('.claude-plugin/plugin.json', manifest)]),
    );
    expect(
      JSON.parse(await readFile(join(off.path, '.claude-plugin/plugin.json'), 'utf8')),
    ).toEqual({ name: 'demo' });
    expect(off.removed).toEqual([
      { plugin: 'demo', path: '.claude-plugin/plugin.json#mcpServers', reason: 'mcp-disabled' },
    ]);
    const on = await extractPlugin(
      await newRoot(),
      plugin([file('.claude-plugin/plugin.json', manifest)], { enableMcp: true }),
    );
    expect(
      Object.keys(JSON.parse(await readFile(join(on.path, '.claude-plugin/plugin.json'), 'utf8'))),
    ).toContain('mcpServers');
  });
});

describe('frontmatter の hooks', () => {
  async function extractSkill(text: string) {
    const root = await newRoot();
    const result = await extractPlugin(root, plugin([file('skills/one/SKILL.md', text)]));
    const path = join(result.path, 'skills/one/SKILL.md');
    const written = await readFile(path, 'utf8').catch(() => null);
    return { result, written };
  }

  it('hooks のキーとその入れ子を落とし、他のキーと本文を保つ', async () => {
    const { result, written } = await extractSkill(
      [
        '---',
        'name: one',
        'hooks:',
        '  PreToolUse:',
        '    - matcher: Bash',
        '      hooks:',
        '        - type: command',
        '          command: dummy-content',
        'description: dummy-content',
        '---',
        '# body',
        'hooks: stays in the body',
        '',
      ].join('\n'),
    );
    expect(written).toBe(
      [
        '---',
        'name: one',
        'description: dummy-content',
        '---',
        '# body',
        'hooks: stays in the body',
        '',
      ].join('\n'),
    );
    expect(result.removed).toEqual([
      { plugin: 'demo', path: 'skills/one/SKILL.md#hooks', reason: 'hooks-disabled' },
    ]);
  });

  it('1行の値・引用符つきのキー・大文字違い・CRLF も落とす', async () => {
    for (const line of ['hooks: {}', '"hooks": {}', "'hooks': []", 'Hooks: x', 'hooks:']) {
      const { written } = await extractSkill(`---\r\nname: one\r\n${line}\r\n---\r\nbody\r\n`);
      expect(written).toBe('---\r\nname: one\r\n---\r\nbody\r\n');
    }
  });

  it('複数行の flow 形式の hooks も落とす', async () => {
    const { written } = await extractSkill(
      '---\nname: one\nhooks: {\n  a: 1\n}\ndescription: dummy-content\n---\nbody\n',
    );
    expect(written).toBe('---\nname: one\ndescription: dummy-content\n---\nbody\n');
  });

  it('列と同じ深さの - で続く hooks の値も落とす', async () => {
    const { written } = await extractSkill('---\nhooks:\n- a\n- b\nname: one\n---\nbody\n');
    expect(written).toBe('---\nname: one\n---\nbody\n');
  });

  it('frontmatter が無いファイルはそのまま展開する', async () => {
    const { result, written } = await extractSkill('# title\nhooks: not frontmatter\n');
    expect(written).toBe('# title\nhooks: not frontmatter\n');
    expect(result.removed).toEqual([]);
  });

  it('hooks が無い frontmatter はそのまま展開する', async () => {
    const text = '---\nname: one\ndescription: dummy-content\n---\nbody\n';
    expect((await extractSkill(text)).written).toBe(text);
  });

  it('壊れた frontmatter のファイルは展開せず、一覧に載せる', async () => {
    const broken = [
      '---\nname: one\nno closing line\n',
      '---\n{ hooks: {} }\n---\nbody\n',
      '---\nname: one\n? hooks\n: x\n---\nbody\n',
      '---\nname: one\n<<: *base\n---\nbody\n',
      '---\nname: one\nthis line is not a mapping entry\n---\nbody\n',
      '---\n"ho\\u006fks": x\n---\nbody\n',
    ];
    for (const text of broken) {
      const { result, written } = await extractSkill(text);
      expect(written).toBeNull();
      expect(result.removed).toEqual([
        { plugin: 'demo', path: 'skills/one/SKILL.md', reason: 'frontmatter-unreadable' },
      ]);
    }
  });

  it('UTF-8 として読めない markdown は展開しない', async () => {
    const root = await newRoot();
    const result = await extractPlugin(
      root,
      plugin([
        { path: 'agents/a.md', executable: false, content: new Uint8Array([0x2d, 0xff, 0xfe]) },
      ]),
    );
    expect(await extractedFiles(result)).toEqual([]);
    expect(result.removed[0]?.reason).toBe('frontmatter-unreadable');
  });

  it('agents と commands の markdown にも同じ処理を掛ける', async () => {
    const root = await newRoot();
    const result = await extractPlugin(
      root,
      plugin([
        file('agents/a.md', '---\nname: a\nhooks: {}\n---\nx\n'),
        file('commands/c.md', '---\nhooks: {}\n---\nx\n'),
      ]),
    );
    expect(await readFile(join(result.path, 'agents/a.md'), 'utf8')).toBe('---\nname: a\n---\nx\n');
    expect(await readFile(join(result.path, 'commands/c.md'), 'utf8')).toBe('---\n---\nx\n');
  });
});

describe('hooks と .mcp.json の有効化の欄', () => {
  const files = () => [
    file('.claude-plugin/plugin.json', MANIFEST),
    file('hooks/hooks.json', '{}'),
    file('.mcp.json', '{"mcpServers":{}}'),
    file('skills/a/SKILL.md', '---\nhooks: {}\n---\nx\n'),
  ];

  it('enableHooks が true でも hooks は展開せず、その理由を返す', async () => {
    const root = await newRoot();
    const result = await extractPlugin(root, plugin(files(), { enableHooks: true }));
    expect(await extractedFiles(result)).not.toContain('hooks/hooks.json');
    expect(await readFile(join(result.path, 'skills/a/SKILL.md'), 'utf8')).toBe('---\n---\nx\n');
    const reasons = result.removed.filter(
      (r) => r.path.startsWith('hooks/') || r.path.endsWith('#hooks'),
    );
    expect(reasons.length).toBe(2);
    expect(new Set(reasons.map((r) => r.reason))).toEqual(new Set(['hooks-not-extracted']));
  });

  it('enableMcp の真偽で .mcp.json が切り替わる', async () => {
    const off = await extractPlugin(await newRoot(), plugin(files(), { enableMcp: false }));
    expect(await extractedFiles(off)).not.toContain('.mcp.json');
    expect(off.removed.find((r) => r.path === '.mcp.json')?.reason).toBe('mcp-disabled');
    const on = await extractPlugin(await newRoot(), plugin(files(), { enableMcp: true }));
    expect(await extractedFiles(on)).toContain('.mcp.json');
    expect(on.removed.find((r) => r.path === '.mcp.json')).toBeUndefined();
  });
});

describe('置き方', () => {
  it('<root>/plugins/<name>@<sha>/ に置き、同じ親に .tmp-* を残さない', async () => {
    const root = await newRoot();
    const result = await extractPlugin(root, basePlugin());
    expect(result.path).toBe(join(root, 'plugins', `demo@${SHA_A}`));
    expect(await readdir(join(root, 'plugins'))).toEqual([`demo@${SHA_A}`]);
  });

  it('パーミッション: ファイルは 0o444（executable は 0o555）、ディレクトリは 0o555', async () => {
    const root = await newRoot();
    const result = await extractPlugin(
      root,
      plugin([
        file('.claude-plugin/plugin.json', MANIFEST),
        file('skills/one/SKILL.md', '# x\n'),
        file('skills/one/run.sh', 'dummy-content', true),
      ]),
    );
    expect(await mode(result.path)).toBe(0o555);
    expect(await mode(join(result.path, 'skills'))).toBe(0o555);
    expect(await mode(join(result.path, 'skills/one'))).toBe(0o555);
    expect(await mode(join(result.path, 'skills/one/SKILL.md'))).toBe(0o444);
    expect(await mode(join(result.path, '.claude-plugin/plugin.json'))).toBe(0o444);
    expect(await mode(join(result.path, 'skills/one/run.sh'))).toBe(0o555);
    expect(await mode(join(root, 'plugins'))).toBe(0o700);
  });

  it('冪等: マーカーが一致すれば何もしない（同じ inode のまま・取り除いた一覧も同じ）', async () => {
    const root = await newRoot();
    const input = plugin([
      file('.claude-plugin/plugin.json', MANIFEST),
      file('hooks/hooks.json', '{}'),
    ]);
    const first = await extractPlugin(root, input);
    const before = await stat(first.path);
    const second = await extractPlugin(root, input);
    expect((await stat(second.path)).ino).toBe(before.ino);
    expect(second.removed).toEqual(first.removed);
    expect(second.removed.length).toBe(1);
    expect(await readdir(join(root, 'plugins'))).toEqual([`demo@${SHA_A}`]);
  });

  it('マーカーが一致しなければ作り直す（contentSha256・enableMcp・enableHooks・版）', async () => {
    const root = await newRoot();
    const first = await extractPlugin(root, basePlugin());
    const changedFiles = plugin([
      file('.claude-plugin/plugin.json', MANIFEST),
      file('skills/one/SKILL.md', '# changed\n'),
    ]);
    const second = await extractPlugin(root, changedFiles);
    expect(second.path).toBe(first.path);
    expect(await readFile(join(second.path, 'skills/one/SKILL.md'), 'utf8')).toBe('# changed\n');
    expect(await readdir(join(root, 'plugins'))).toEqual([`demo@${SHA_A}`]);

    const withMcp = plugin(
      [
        file('.claude-plugin/plugin.json', MANIFEST),
        file('.mcp.json', '{}'),
        file('skills/one/SKILL.md', '# changed\n'),
      ],
      { enableMcp: true },
    );
    await extractPlugin(root, withMcp);
    expect(await extractedFiles(second)).toContain('.mcp.json');
    const withoutMcp = { ...withMcp, enableMcp: false };
    await extractPlugin(root, withoutMcp);
    expect(await extractedFiles(second)).not.toContain('.mcp.json');
  });

  it('マーカーが壊れていれば作り直す', async () => {
    const root = await newRoot();
    const first = await extractPlugin(root, basePlugin());
    const marker = join(first.path, '.alteroid-extract.json');
    await chmod(first.path, 0o700);
    await chmod(marker, 0o600);
    await writeFile(marker, 'not json');
    await chmod(first.path, 0o555);
    const ino = (await stat(first.path)).ino;
    const second = await extractPlugin(root, basePlugin());
    expect((await stat(second.path)).ino).not.toBe(ino);
    expect(
      JSON.parse(await readFile(join(second.path, '.alteroid-extract.json'), 'utf8')),
    ).toBeTypeOf('object');
  });

  it('同じ名前で sha が違えば別のディレクトリになる（古い版を上書きしない）', async () => {
    const root = await newRoot();
    const a = await extractPlugin(root, basePlugin());
    const b = await extractPlugin(
      root,
      basePlugin({ source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_B } }),
    );
    expect(a.path).not.toBe(b.path);
    expect((await readdir(join(root, 'plugins'))).sort()).toEqual([
      `demo@${SHA_A}`,
      `demo@${SHA_B}`,
    ]);
  });
});

describe('展開先の外へ出ない', () => {
  it('先に置かれた symlink（<name>@<sha>）の先へ書かない', async () => {
    const root = await newRoot();
    const outside = await newRoot();
    await mkdir(join(root, 'plugins'), { recursive: true, mode: 0o700 });
    await symlink(outside, join(root, 'plugins', `demo@${SHA_A}`));
    const result = await extractPlugin(root, basePlugin());
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(result.path)).isSymbolicLink()).toBe(false);
    expect(await extractedFiles(result)).toContain('skills/one/SKILL.md');
  });

  it('plugins ディレクトリが symlink なら展開しない', async () => {
    const root = await newRoot();
    const outside = await newRoot();
    await symlink(outside, join(root, 'plugins'));
    await expect(extractPlugin(root, basePlugin())).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it('../ を含む手書きの行は展開先の外へ出ない', async () => {
    const root = await newRoot();
    const crafted: StoredPlugin = {
      ...basePlugin(),
      files: [
        file('skills/one/SKILL.md', '# x\n'),
        file('skills/../../escape.txt', 'dummy-content'),
        file('../escape2.txt', 'dummy-content'),
        file('/abs-escape.txt', 'dummy-content'),
      ],
    };
    const result = await extractPlugin(root, crafted);
    expect(await extractedFiles(result)).toEqual(['skills/one/SKILL.md']);
    expect(result.removed.map((r) => r.reason)).toEqual([
      'invalid-path',
      'invalid-path',
      'invalid-path',
    ]);
    expect(await readdir(root)).toEqual(['plugins']);
    expect(await readdir(join(root, 'plugins'))).toEqual([`demo@${SHA_A}`]);
  });
});

describe('片づけ', () => {
  const dirName = (name: string, sha: string) => `${name}@${sha}`;

  it('今のストアに無い版と .tmp-* を消し、規則に合わないものは残す', async () => {
    const root = await newRoot();
    const keep = await extractPlugin(root, basePlugin());
    const old = await extractPlugin(
      root,
      basePlugin({ source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_B } }),
    );
    const gone = await extractPlugin(root, { ...basePlugin(), name: 'removed-one' });
    const plugins = join(root, 'plugins');
    const tmpName = `.tmp-demo@${SHA_A}-0123456789abcdef`;
    await mkdir(join(plugins, tmpName, 'inner'), { recursive: true });
    await writeFile(join(plugins, tmpName, 'inner', 'f'), 'dummy-content');
    await chmod(join(plugins, tmpName, 'inner'), 0o555);
    await chmod(join(plugins, tmpName), 0o555);
    await mkdir(join(plugins, 'human-made'));
    await writeFile(join(plugins, 'notes.txt'), 'dummy-content');
    await mkdir(join(plugins, `demo@${'A'.repeat(40)}`));
    await mkdir(join(plugins, `demo@${'a'.repeat(39)}`));
    await mkdir(join(plugins, '.tmp-human'));

    const result = await pruneExtractedPluginDirs(root, new Set([dirName('demo', SHA_A)]));
    expect(result.failed).toEqual([]);
    expect(result.removed.sort()).toEqual(
      [tmpName, dirName('demo', SHA_B), dirName('removed-one', SHA_A)].sort(),
    );
    expect((await readdir(plugins)).sort()).toEqual(
      [
        `.tmp-human`,
        `demo@${'A'.repeat(40)}`,
        `demo@${'a'.repeat(39)}`,
        dirName('demo', SHA_A),
        'human-made',
        'notes.txt',
      ].sort(),
    );
    expect(keep.path).toBe(join(plugins, dirName('demo', SHA_A)));
    expect(old.path).not.toBe(gone.path);
  });

  it('読み取り専用（0o555）でも消せる', async () => {
    const root = await newRoot();
    const old = await extractPlugin(root, basePlugin());
    expect(await mode(old.path)).toBe(0o555);
    const result = await pruneExtractedPluginDirs(root, new Set());
    expect(result.failed).toEqual([]);
    expect(await readdir(join(root, 'plugins'))).toEqual([]);
  });

  it('symlink は辿らずリンクだけを消す', async () => {
    const root = await newRoot();
    const outside = await newRoot();
    await writeFile(join(outside, 'keep.txt'), 'dummy-content');
    await mkdir(join(root, 'plugins'), { recursive: true });
    await symlink(outside, join(root, 'plugins', dirName('demo', SHA_B)));
    await pruneExtractedPluginDirs(root, new Set());
    expect(await readdir(join(root, 'plugins'))).toEqual([]);
    expect(await readdir(outside)).toEqual(['keep.txt']);
  });

  it('plugins ディレクトリが無ければ何もしない', async () => {
    const root = await newRoot();
    expect(await pruneExtractedPluginDirs(root, new Set())).toEqual({ removed: [], failed: [] });
  });

  it('ストアの list から残す版を決める（呼び手が展開する層だけ）', async () => {
    const root = await newRoot();
    const stores = createMemoryStores();
    const input = (name: string, scope: string, sha: string) =>
      ({
        name,
        scope,
        source: { kind: 'url', url: 'https://example.com/repo', sha },
        files: [file('skills/a/SKILL.md', '# x\n')],
        installedAt: '2026-10-07T00:00:00.000Z',
        installedBy: 'account-1',
      }) as PluginInput;
    await stores.plugins.put(input('all-one', 'all', SHA_A));
    await stores.plugins.put(input('runner-one', 'runner', SHA_A));
    await extractPlugin(root, { ...basePlugin(), name: 'runner-one' });
    await extractPlugin(root, { ...basePlugin(), name: 'all-one' });
    await extractPlugin(root, {
      ...basePlugin(),
      name: 'all-one',
      source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_B },
    });
    const result = await pruneExtractedPluginsAgainstStore(root, stores.plugins, ['all', 'app']);
    expect(result.removed.sort()).toEqual([`all-one@${SHA_B}`, `runner-one@${SHA_A}`].sort());
    expect(await readdir(join(root, 'plugins'))).toEqual([`all-one@${SHA_A}`]);
  });

  it('list が失敗したら何も消さずに投げる', async () => {
    const root = await newRoot();
    await extractPlugin(root, basePlugin());
    const store = {
      list: () => Promise.reject(new Error('list failed')),
    };
    await expect(pruneExtractedPluginsAgainstStore(root, store, ['all'])).rejects.toThrow(
      'list failed',
    );
    expect(await readdir(join(root, 'plugins'))).toEqual([`demo@${SHA_A}`]);
  });
});

describe('呼び手向けの関数', () => {
  async function seed() {
    const stores = createMemoryStores();
    const put = (name: string, scope: string, extra: Record<string, unknown> = {}) =>
      stores.plugins.put({
        name,
        scope,
        source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_A },
        files: [file('skills/a/SKILL.md', '# x\n'), file('hooks/hooks.json', '{}')],
        installedAt: '2026-10-07T00:00:00.000Z',
        installedBy: 'account-1',
        ...extra,
      } as PluginInput);
    await put('p-all', 'all');
    await put('p-app', 'app', { enableMcp: true });
    await put('p-runner', 'runner');
    return { stores, put };
  }

  it('対象の層に含まれる scope だけを展開し、runner のものは出ない', async () => {
    const root = await newRoot();
    const { stores } = await seed();
    const result = await extractPluginsForScopes({
      root,
      store: stores.plugins,
      scopes: ['all', 'app'],
    });
    expect(result.failures).toEqual([]);
    expect(result.plugins).toEqual([
      { name: 'p-all', path: join(root, 'plugins', `p-all@${SHA_A}`), skipMcpDiscovery: true },
      { name: 'p-app', path: join(root, 'plugins', `p-app@${SHA_A}`), skipMcpDiscovery: false },
    ]);
    expect((await readdir(join(root, 'plugins'))).sort()).toEqual([
      `p-all@${SHA_A}`,
      `p-app@${SHA_A}`,
    ]);
    expect(result.removed.map((r) => `${r.plugin}:${r.path}`).sort()).toEqual([
      'p-all:hooks/hooks.json',
      'p-app:hooks/hooks.json',
    ]);
  });

  it('1つの plugin の失敗で全体を止めず、get の失敗も個別に返す', async () => {
    const root = await newRoot();
    const { stores } = await seed();
    const store = {
      list: () => stores.plugins.list(),
      get: (name: string) =>
        name === 'p-all' ? Promise.reject(new Error('get failed')) : stores.plugins.get(name),
    };
    await mkdir(join(root, 'plugins'), { recursive: true });
    const result = await extractPluginsForScopes({ root, store, scopes: ['all', 'app'] });
    expect(result.plugins.map((p) => p.name)).toEqual(['p-app']);
    expect(result.failures).toEqual([{ name: 'p-all', stage: 'get', message: 'get failed' }]);
  });

  it('展開の失敗も個別に返す', async () => {
    const root = await newRoot();
    const { stores } = await seed();
    const store = {
      list: () => stores.plugins.list(),
      get: async (name: string) => {
        const found = await stores.plugins.get(name);
        return found !== null && name === 'p-all' ? { ...found, name: '../escape' } : found;
      },
    };
    const result = await extractPluginsForScopes({ root, store, scopes: ['all', 'app'] });
    expect(result.plugins.map((p) => p.name)).toEqual(['p-app']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ name: 'p-all', stage: 'extract' });
    expect(await readdir(root)).toEqual(['plugins']);
  });

  it('list の失敗は plugin 名なしの失敗として返す', async () => {
    const root = await newRoot();
    const store = {
      list: () => Promise.reject(new Error('list failed')),
      get: () => Promise.resolve(null),
    };
    const result = await extractPluginsForScopes({ root, store, scopes: ['all'] });
    expect(result).toEqual({
      plugins: [],
      removed: [],
      failures: [{ name: null, stage: 'list', message: 'list failed' }],
    });
  });

  it('get が null（list の後に消えた）なら失敗として返す', async () => {
    const root = await newRoot();
    const { stores } = await seed();
    const store = { list: () => stores.plugins.list(), get: () => Promise.resolve(null) };
    const result = await extractPluginsForScopes({ root, store, scopes: ['all'] });
    expect(result.plugins).toEqual([]);
    expect(result.failures).toEqual([
      { name: 'p-all', stage: 'get', message: 'plugin が見つからない' },
    ]);
  });
});
