import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  extractPlugin,
  extractedPluginDirName,
  extractPluginsForScopes,
  pruneExtractedPluginDirs,
  pruneExtractedPluginsAgainstStore,
  pruneRunnerPluginsOnBoot,
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

describe('frontmatter の許可リスト', () => {
  async function extractSkill(text: string, overrides: Record<string, unknown> = {}) {
    const root = await newRoot();
    const result = await extractPlugin(
      root,
      plugin([file('skills/one/SKILL.md', text)], overrides),
    );
    const path = join(result.path, 'skills/one/SKILL.md');
    const written = await readFile(path, 'utf8').catch(() => null);
    return { result, written };
  }

  it('行全体をインデントした書き方の hooks は展開しない', async () => {
    const { result, written } = await extractSkill(
      '---\n name: x\n hooks:\n  PreToolUse:\n   - hooks:\n      - type: command\n        command: dummy\n---\n',
    );
    expect(written).toBeNull();
    expect(result.removed).toEqual([
      { plugin: 'demo', path: 'skills/one/SKILL.md', reason: 'frontmatter-unreadable' },
    ]);
  });

  it('許可したキーだけを書き出し直す（値は 1 行のスカラーとブロックスカラー）', async () => {
    const text = [
      '---',
      'name: one',
      'description: |',
      '  line one',
      '',
      '  hooks: inside the block stays literal',
      'argument-hint: "[file]"',
      "when_to_use: 'when needed'",
      'model: sonnet',
      'disable-model-invocation: true',
      'user-invocable: false',
      '---',
      '# body',
      '',
    ].join('\n');
    const { result, written } = await extractSkill(text);
    expect(written).toBe(text);
    expect(result.removed).toEqual([]);
  });

  it('allowed-tools・tools・mcpServers・permissionMode・未知のキーを落とし、理由つきで返す', async () => {
    const text = [
      '---',
      'name: one',
      'allowed-tools: Bash(rm:*)',
      'tools:',
      '  - Bash',
      'mcpServers:',
      '  evil:',
      '    command: dummy',
      'permissionMode: bypassPermissions',
      'something-else: x',
      'description: dummy-content',
      '---',
      'body',
      '',
    ].join('\n');
    for (const enableMcp of [false, true]) {
      const { result, written } = await extractSkill(text, { enableMcp });
      expect(written).toBe('---\nname: one\ndescription: dummy-content\n---\nbody\n');
      const reasons = new Map(result.removed.map((r) => [r.path, r.reason]));
      for (const key of [
        'allowed-tools',
        'tools',
        'mcpServers',
        'permissionMode',
        'something-else',
      ]) {
        expect(reasons.get(`skills/one/SKILL.md#${key}`)).toBe('frontmatter-not-allowlisted');
      }
      expect(result.removed).toHaveLength(5);
    }
  });

  it('許可リストに無いキーの値が複数行・flow 形式・リストでも、次のキーまで落とす', async () => {
    const text =
      '---\nname: one\ntools: [\n  a,\n  b\n]\nmodel: x\nallowed-tools:\n- a\n- b\n---\nbody\n';
    const { written } = await extractSkill(text);
    expect(written).toBe('---\nname: one\nmodel: x\n---\nbody\n');
  });

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

  it('1行の値・大文字違い・CRLF も落とす', async () => {
    for (const line of ['hooks: {}', 'Hooks: x', 'hooks:', 'hooks: []']) {
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
      '---\n"hooks": {}\n---\nbody\n',
      "---\n'hooks': []\n---\nbody\n",
      '---\n  name: one\n---\nbody\n',
      '---\n- a\nname: one\n---\nbody\n',
      '---\nname: one\n  continued plain scalar\n---\nbody\n',
      '---\nname:\n  nested: x\n---\nbody\n',
      '---\ndescription: "unterminated\nname: one\n---\nbody\n',
      '---\ndescription: {a: 1}\n---\nbody\n',
      '---\ndescription: &anchor x\n---\nbody\n',
      '---\nname: one\nname: two\n---\nbody\n',
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
  it('<root>/plugins/<name>@<sha>-<要約12桁>/ に置き、同じ親に .tmp-* を残さない', async () => {
    const root = await newRoot();
    const result = await extractPlugin(root, basePlugin());
    expect(result.path).toBe(join(root, 'plugins', extractedPluginDirName(basePlugin())));
    expect(basename(result.path)).toMatch(new RegExp(`^demo@${SHA_A}-[0-9a-f]{12}$`));
    expect(await readdir(join(root, 'plugins'))).toEqual([basename(result.path)]);
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
    expect(await readdir(join(root, 'plugins'))).toEqual([basename(first.path)]);
  });

  it('同じ name@sha を別の内容・フラグで置き換えても、前の展開先を消さずに別の場所へ置く', async () => {
    const root = await newRoot();
    const first = await extractPlugin(root, basePlugin());
    const changedFiles = plugin([
      file('.claude-plugin/plugin.json', MANIFEST),
      file('skills/one/SKILL.md', '# changed\n'),
    ]);
    const second = await extractPlugin(root, changedFiles);
    expect(second.path).not.toBe(first.path);
    expect(await readFile(join(first.path, 'skills/one/SKILL.md'), 'utf8')).toContain('# body');
    expect(await readFile(join(second.path, 'skills/one/SKILL.md'), 'utf8')).toBe('# changed\n');

    const withMcp = plugin(
      [
        file('.claude-plugin/plugin.json', MANIFEST),
        file('.mcp.json', '{}'),
        file('skills/one/SKILL.md', '# changed\n'),
      ],
      { enableMcp: true },
    );
    const third = await extractPlugin(root, withMcp);
    expect(await extractedFiles(third)).toContain('.mcp.json');
    const fourth = await extractPlugin(root, { ...withMcp, enableMcp: false });
    expect(await extractedFiles(fourth)).not.toContain('.mcp.json');
    expect(await extractedFiles(third)).toContain('.mcp.json');
    const hooksOn = await extractPlugin(root, { ...withMcp, enableHooks: true });
    expect(new Set([first.path, second.path, third.path, fourth.path, hooksOn.path]).size).toBe(5);
    expect(await readdir(join(root, 'plugins'))).toHaveLength(5);
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
    expect((await readdir(join(root, 'plugins'))).sort()).toEqual(
      [basename(a.path), basename(b.path)].sort(),
    );
    expect(basename(a.path)).toContain(`demo@${SHA_A}`);
    expect(basename(b.path)).toContain(`demo@${SHA_B}`);
  });
});

describe('展開先の外へ出ない', () => {
  it('先に置かれた symlink（<name>@<sha>）の先へ書かない', async () => {
    const root = await newRoot();
    const outside = await newRoot();
    await mkdir(join(root, 'plugins'), { recursive: true, mode: 0o700 });
    await symlink(outside, join(root, 'plugins', extractedPluginDirName(basePlugin())));
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

  it('root の祖先が symlink でも展開・再展開・掃除ができる（macOS の /var → /private/var）', async () => {
    const real = await newRoot();
    const link = join(await newRoot(), 'link');
    await symlink(real, link);
    const root = join(link, 'nested');
    const first = await extractPlugin(root, basePlugin());
    expect(await extractedFiles(first)).toContain('skills/one/SKILL.md');
    expect((await extractPlugin(root, basePlugin())).path).toBe(first.path);
    expect(await readdir(join(real, 'nested', 'plugins'))).toEqual([basename(first.path)]);
    const result = await pruneExtractedPluginDirs(root, new Set());
    expect(result.failed).toEqual([]);
    expect(await readdir(join(root, 'plugins'))).toEqual([]);
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
    expect(await readdir(join(root, 'plugins'))).toEqual([basename(result.path)]);
  });
});

describe('片づけ', () => {
  const dirName = (name: string, sha: string) => `${name}@${sha}-${'0'.repeat(12)}`;

  it('今のストアに無い版と .tmp-* を消し、規則に合わないものは残す', async () => {
    const root = await newRoot();
    const keep = await extractPlugin(root, basePlugin());
    const old = await extractPlugin(
      root,
      basePlugin({ source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_B } }),
    );
    const gone = await extractPlugin(root, { ...basePlugin(), name: 'removed-one' });
    const plugins = join(root, 'plugins');
    const tmpName = `.tmp-${basename(keep.path)}-0123456789abcdef`;
    const legacy = `demo@${SHA_A}`;
    await mkdir(join(plugins, legacy));
    await mkdir(join(plugins, tmpName, 'inner'), { recursive: true });
    await writeFile(join(plugins, tmpName, 'inner', 'f'), 'dummy-content');
    await chmod(join(plugins, tmpName, 'inner'), 0o555);
    await chmod(join(plugins, tmpName), 0o555);
    await mkdir(join(plugins, 'human-made'));
    await writeFile(join(plugins, 'notes.txt'), 'dummy-content');
    // A ではなく C: 大文字小文字を区別しない fs（macOS の APFS）では `legacy`（demo@aaa…）と同じ名前になり、mkdir が EEXIST になるため。
    const upperSha = `demo@${'C'.repeat(40)}`;
    await mkdir(join(plugins, upperSha));
    await mkdir(join(plugins, `demo@${'a'.repeat(39)}`));
    await mkdir(join(plugins, '.tmp-human'));

    const result = await pruneExtractedPluginDirs(root, new Set([basename(keep.path)]));
    expect(result.failed).toEqual([]);
    expect(result.removed.sort()).toEqual(
      [tmpName, legacy, basename(old.path), basename(gone.path)].sort(),
    );
    expect((await readdir(plugins)).sort()).toEqual(
      [
        `.tmp-human`,
        upperSha,
        `demo@${'a'.repeat(39)}`,
        basename(keep.path),
        'human-made',
        'notes.txt',
      ].sort(),
    );
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
    const stored = (await stores.plugins.get('all-one'))!;
    const runnerOne = await extractPlugin(root, { ...stored, name: 'runner-one' });
    const current = await extractPlugin(root, stored);
    const otherSha = await extractPlugin(root, {
      ...stored,
      source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_B },
    });
    const otherContent = await extractPlugin(root, {
      ...stored,
      files: [file('skills/a/SKILL.md', '# y\n')],
      contentSha256: 'c'.repeat(64),
    });
    const result = await pruneExtractedPluginsAgainstStore(root, stores.plugins, ['all', 'app']);
    expect(result.removed.sort()).toEqual(
      [basename(otherSha.path), basename(otherContent.path), basename(runnerOne.path)].sort(),
    );
    expect(await readdir(join(root, 'plugins'))).toEqual([basename(current.path)]);
  });

  it('list が失敗したら何も消さずに投げる', async () => {
    const root = await newRoot();
    const extracted = await extractPlugin(root, basePlugin());
    const store = {
      list: () => Promise.reject(new Error('list failed')),
    };
    await expect(pruneExtractedPluginsAgainstStore(root, store, ['all'])).rejects.toThrow(
      'list failed',
    );
    expect(await readdir(join(root, 'plugins'))).toEqual([basename(extracted.path)]);
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
      {
        name: 'p-all',
        path: join(root, 'plugins', extractedPluginDirName((await stores.plugins.get('p-all'))!)),
        skipMcpDiscovery: true,
      },
      {
        name: 'p-app',
        path: join(root, 'plugins', extractedPluginDirName((await stores.plugins.get('p-app'))!)),
        skipMcpDiscovery: false,
      },
    ]);
    expect((await readdir(join(root, 'plugins'))).sort()).toEqual(
      result.plugins.map((p) => basename(p.path)).sort(),
    );
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

  it('要約から期待される展開先が marker つきで既にあれば get を呼ばず、取り除いた一覧も返す', async () => {
    const root = await newRoot();
    const { stores } = await seed();
    const first = await extractPluginsForScopes({
      root,
      store: stores.plugins,
      scopes: ['all', 'app'],
    });
    const gets: string[] = [];
    const store = {
      list: () => stores.plugins.list(),
      get: (name: string) => {
        gets.push(name);
        return stores.plugins.get(name);
      },
    };
    const second = await extractPluginsForScopes({ root, store, scopes: ['all', 'app'] });
    expect(gets).toEqual([]);
    expect(second).toEqual(first);
    expect(second.removed).toHaveLength(2);

    await stores.plugins.put({
      name: 'p-all',
      scope: 'all',
      source: { kind: 'url', url: 'https://example.com/repo', sha: SHA_A },
      files: [file('skills/a/SKILL.md', '# changed\n')],
      installedAt: '2026-10-07T00:00:00.000Z',
      installedBy: 'account-1',
    } as PluginInput);
    const third = await extractPluginsForScopes({ root, store, scopes: ['all', 'app'] });
    expect(gets).toEqual(['p-all']);
    expect(third.plugins[0]?.path).not.toBe(first.plugins[0]?.path);
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

describe('runner の起動時の片づけ', () => {
  const uid = process.getuid?.() ?? 0;
  const options = { dirMode: 0o755, expectedUid: uid };

  it('置き場が信頼できれば、前の器の展開物を消す', async () => {
    const root = await newRoot();
    await extractPlugin(root, basePlugin(), options);
    const lines: string[] = [];
    const result = await pruneRunnerPluginsOnBoot(root, options, (line) => lines.push(line));
    expect(result?.removed).toHaveLength(1);
    expect(await readdir(join(root, 'plugins'))).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('plugins が symlink なら、prune せずに理由を書く', async () => {
    const root = await newRoot();
    const outside = await newRoot();
    await mkdir(join(outside, `demo@${SHA_A}`));
    await symlink(outside, join(root, 'plugins'));
    const lines: string[] = [];
    expect(
      await pruneRunnerPluginsOnBoot(root, options, (line) => lines.push(line)),
    ).toBeUndefined();
    expect(await readdir(outside)).toEqual([`demo@${SHA_A}`]);
    expect(lines).toHaveLength(1);
  });

  it('所有者が期待と違えば、prune せずに理由を書く', async () => {
    const root = await newRoot();
    await extractPlugin(root, basePlugin(), options);
    const lines: string[] = [];
    const result = await pruneRunnerPluginsOnBoot(
      root,
      { dirMode: 0o755, expectedUid: uid + 1 },
      (line) => lines.push(line),
    );
    expect(result).toBeUndefined();
    expect(await readdir(join(root, 'plugins'))).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it('モードが違えば揃えてから消す', async () => {
    const root = await newRoot();
    await mkdir(join(root, 'plugins'), { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const lines: string[] = [];
    await pruneRunnerPluginsOnBoot(root, options, (line) => lines.push(line));
    expect((await stat(root)).mode & 0o777).toBe(0o755);
    expect((await stat(join(root, 'plugins'))).mode & 0o777).toBe(0o755);
  });
});

describe('片づけの chmod', () => {
  it('展開物の中の symlink の先は、書込み可へ戻さず辿らない', async () => {
    const root = await newRoot();
    const outside = await newRoot();
    await mkdir(join(outside, 'inner'));
    await chmod(join(outside, 'inner'), 0o500);
    await chmod(outside, 0o500);
    const extracted = await extractPlugin(root, basePlugin());
    await chmod(extracted.path, 0o700);
    await symlink(outside, join(extracted.path, 'link'));
    await chmod(extracted.path, 0o555);

    const result = await pruneExtractedPluginDirs(root, new Set());
    expect(result.failed).toEqual([]);
    expect(await readdir(join(root, 'plugins'))).toEqual([]);
    expect((await stat(outside)).mode & 0o777).toBe(0o500);
    expect((await stat(join(outside, 'inner'))).mode & 0o777).toBe(0o500);
    await chmod(outside, 0o700);
  });
});
