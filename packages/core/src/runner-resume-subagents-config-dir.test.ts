import { mkdir, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

// chown は記録だけして実際には移さない: 子の uid で置く経路が chown を呼ばないことを観測する
const chowned = vi.hoisted(() => [] as [string, number, number][]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chown: async (path: string, uid: number, gid: number) => {
      chowned.push([path, uid, gid]);
    },
  };
});

const { placeSeedInConfigDir, placeSubagentsInConfigDir, safeSubagentSubpath } =
  await import('./runner-resume-config-dir.js');
const { childFileWriter } = await import('./runner-child-fs.js');
const { sameUidSpawn } = await import('./runner-child-fs.test-support.js');

const KEY = { projectKey: '-work-project', sessionId: 'sess-1' };
const META = { type: 'agent_metadata', agentType: 'worker', cwd: '/work/project' };
const LINES = [
  { type: 'user', message: { role: 'user', content: '調べて' } },
  { type: 'assistant', message: { role: 'assistant', content: '済んだ' } },
];

let configDir: string;
let sessionDir: string;
beforeEach(async () => {
  chowned.length = 0;
  configDir = await makeTempDir('resume-subagents-');
  sessionDir = join(configDir, 'projects', KEY.projectKey, KEY.sessionId);
});

// 子が書ける設定ディレクトリの途中の段を symlink に差し替えられても、runner が辿って外へ書かない
describe('途中の段が symlink なら書かずに断る', () => {
  it('作業者の記録: <sessionId>/subagents が外を指す symlink なら、外へ何も作らない', async () => {
    const outside = await makeTempDir('resume-subagents-outside-');
    await mkdir(sessionDir, { recursive: true });
    await symlink(outside, join(sessionDir, 'subagents'));

    await expect(
      placeSubagentsInConfigDir(configDir, KEY, [
        { subpath: 'subagents/agent-a1', entries: [META, ...LINES] },
      ]),
    ).rejects.toThrow('symlink');
    expect(await readdir(outside)).toEqual([]);
  });

  it('主の記録: projects/<projectKey> が外を指す symlink なら、外へ何も作らない', async () => {
    const outside = await makeTempDir('resume-main-outside-');
    await mkdir(join(configDir, 'projects'), { recursive: true });
    await symlink(outside, join(configDir, 'projects', KEY.projectKey));

    await expect(placeSeedInConfigDir(configDir, KEY, LINES)).rejects.toThrow('symlink');
    expect(await readdir(outside)).toEqual([]);
  });
});

// 規則は SDK が `listSubkeys` を使って戻す実装（`sdk.mjs` の `M9e`）と同じ:
// `agent_metadata` の行は jsonl に入れず、最後の1件の `type` を除いた JSON を `<subpath>.meta.json` へ。どちらも 0600
describe('placeSubagentsInConfigDir: 作業者の記録を主の記録の隣に SDK と同じ形で置く', () => {
  it('<sessionId>/<subpath>.jsonl と .meta.json に分けて置く（agent_metadata は jsonl に入れない）', async () => {
    const result = await placeSubagentsInConfigDir(configDir, KEY, [
      { subpath: 'subagents/agent-a1', entries: [META, ...LINES] },
    ]);

    expect(result).toEqual({ placed: 1, rejected: [] });
    const jsonl = join(sessionDir, 'subagents', 'agent-a1.jsonl');
    expect(await readFile(jsonl, 'utf8')).toBe(
      LINES.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    );
    expect((await stat(jsonl)).mode & 0o777).toBe(0o600);
    const meta = join(sessionDir, 'subagents', 'agent-a1.meta.json');
    expect(await readFile(meta, 'utf8')).toBe(
      JSON.stringify({ agentType: 'worker', cwd: '/work/project' }),
    );
    expect((await stat(meta)).mode & 0o777).toBe(0o600);
  });

  it('agent_metadata が複数あれば最後の1件を使う（SDK と同じ）', async () => {
    await placeSubagentsInConfigDir(configDir, KEY, [
      {
        subpath: 'subagents/agent-a1',
        entries: [
          { type: 'agent_metadata', agentType: 'old' },
          ...LINES,
          { ...META, agentType: 'new' },
        ],
      },
    ]);

    expect(
      JSON.parse(await readFile(join(sessionDir, 'subagents', 'agent-a1.meta.json'), 'utf8')),
    ).toEqual({
      agentType: 'new',
      cwd: '/work/project',
    });
  });

  it('agent_metadata だけなら jsonl は作らず .meta.json だけを置く（SDK と同じ）', async () => {
    await placeSubagentsInConfigDir(configDir, KEY, [
      { subpath: 'subagents/agent-a1', entries: [META] },
    ]);

    expect(await readdir(join(sessionDir, 'subagents'))).toEqual(['agent-a1.meta.json']);
  });

  it('入れ子の subpath（subagents/workflows/<id>/agent-x）は段を作って置く', async () => {
    await placeSubagentsInConfigDir(configDir, KEY, [
      { subpath: 'subagents/workflows/w1/agent-x', entries: LINES },
    ]);

    expect(
      await readFile(join(sessionDir, 'subagents', 'workflows', 'w1', 'agent-x.jsonl'), 'utf8'),
    ).toContain('調べて');
  });

  it('既に在るファイルは上書きしない（CLI が書き続けたほうが新しい）', async () => {
    await placeSubagentsInConfigDir(configDir, KEY, [
      { subpath: 'subagents/agent-a1', entries: LINES },
    ]);
    const result = await placeSubagentsInConfigDir(configDir, KEY, [
      { subpath: 'subagents/agent-a1', entries: [{ type: 'user', message: 'older' }] },
    ]);

    expect(result.placed).toBe(0);
    expect(await readFile(join(sessionDir, 'subagents', 'agent-a1.jsonl'), 'utf8')).toContain(
      '済んだ',
    );
  });

  // 反転（#5259）: これまでは「作った段だけ runner（root）が子へ chown する」ことを確かめていた。子を別 UID で起こす構成は、子の uid の子プロセスで置く
  // ようにしたので持ち主は最初から子で、chown は要らない（symlink を辿る root の窓ごと無くなる）。置く中身・mode・入れ子の段は変わらない。
  it('writer（子の uid の子プロセス）を渡すと、runner は chown せず、同じ中身・0600・入れ子の段で置く', async () => {
    await mkdir(join(configDir, 'projects', KEY.projectKey), { recursive: true });

    const result = await placeSubagentsInConfigDir(
      configDir,
      KEY,
      [{ subpath: 'subagents/workflows/w1/agent-a1', entries: [META, ...LINES] }],
      childFileWriter(sameUidSpawn, process.env),
    );

    expect(result).toEqual({ placed: 1, rejected: [] });
    expect(chowned).toEqual([]);
    const jsonl = join(sessionDir, 'subagents', 'workflows', 'w1', 'agent-a1.jsonl');
    expect(await readFile(jsonl, 'utf8')).toBe(LINES.map((l) => `${JSON.stringify(l)}\n`).join(''));
    expect((await stat(jsonl)).mode & 0o777).toBe(0o600);
    expect((await stat(join(sessionDir, 'subagents'))).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(
        await readFile(
          join(sessionDir, 'subagents', 'workflows', 'w1', 'agent-a1.meta.json'),
          'utf8',
        ),
      ),
    ).toEqual({ agentType: 'worker', cwd: '/work/project' });
  });

  it('writer を渡したとき、既に在るファイルは上書きしない（wx）', async () => {
    const writer = childFileWriter(sameUidSpawn, process.env);
    await placeSubagentsInConfigDir(
      configDir,
      KEY,
      [{ subpath: 'subagents/agent-a1', entries: LINES }],
      writer,
    );
    const result = await placeSubagentsInConfigDir(
      configDir,
      KEY,
      [{ subpath: 'subagents/agent-a1', entries: [{ type: 'user', message: 'newer' }] }],
      writer,
    );
    expect(result.placed).toBe(0);
    expect(await readFile(join(sessionDir, 'subagents', 'agent-a1.jsonl'), 'utf8')).toContain(
      '済んだ',
    );
  });

  it('危ない subpath（.. ・絶対パス・NUL・subagents/ で始まらない）は置かずに返し、他は置く', async () => {
    const bad = [
      'subagents/../../escape',
      '../escape',
      '/etc/passwd',
      'subagents/\0x',
      'other/agent-a1',
      '',
      'subagents/..',
    ];
    const result = await placeSubagentsInConfigDir(configDir, KEY, [
      ...bad.map((subpath) => ({ subpath, entries: LINES })),
      { subpath: 'subagents/agent-ok', entries: LINES },
    ]);

    expect(result).toEqual({ placed: 1, rejected: bad });
    expect(await readdir(sessionDir)).toEqual(['subagents']);
    expect(await readdir(join(sessionDir, 'subagents'))).toEqual(['agent-ok.jsonl']);
    expect(await readdir(join(configDir, 'projects', KEY.projectKey))).toEqual([KEY.sessionId]);
  });

  it('projectKey・sessionId がパスの1段でなければ投げる', async () => {
    await expect(
      placeSubagentsInConfigDir(configDir, { projectKey: '../x', sessionId: 's' }, []),
    ).rejects.toThrow();
  });
});

describe('safeSubagentSubpath', () => {
  it('subagents/ で始まる相対パスだけを通す', () => {
    expect(safeSubagentSubpath('/c/projects/p/s', 'subagents/agent-a')).toBe('subagents/agent-a');
    expect(safeSubagentSubpath('/c/projects/p/s', 'subagents\\..\\x')).toBe(undefined);
    expect(safeSubagentSubpath('/c/projects/p/s', 'C:\\x')).toBe(undefined);
  });
});
