import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

// chown は記録だけして実際には移さない: 試験は子の uid を持たないので、渡した相手と対象を観測する
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

const { placePeersInCodexHome, safePeerRolloutRelPath } =
  await import('./runner-resume-config-dir.js');

const THREAD = '0199c0a1-2b3c-7d4e-8f50-123456789abc';
const REL = `2026/10/25/rollout-2026-10-25T09-00-00-${THREAD}.jsonl`;
const line = (ordinal: number, text = 'x') => ({
  timestamp: '2026-10-25T09:00:00.000Z',
  ordinal,
  type: 'response_item',
  payload: { text },
});
const seed = (over: Partial<{ relPath: string; threadId: string; entries: unknown[] }> = {}) => ({
  peerId: 'peer-aaaa',
  threadId: THREAD,
  relPath: REL,
  entries: [line(0), line(1)],
  ...over,
});

let codexHome: string;
beforeEach(async () => {
  chowned.length = 0;
  codexHome = await makeTempDir('resume-peers-codex-home-');
});

describe('placePeersInCodexHome: peer の rollout を CODEX_HOME/sessions/ へ戻す', () => {
  it('sessions/<relPath> に、1行1件の JSON で 0600 で置く（thread/resume が探すファイル名のまま）', async () => {
    const result = await placePeersInCodexHome(codexHome, [seed()]);

    expect(result).toMatchObject({ placed: ['peer-aaaa'], present: [], rejected: [] });
    const file = join(codexHome, 'sessions', REL);
    expect(await readFile(file, 'utf8')).toBe(
      `${JSON.stringify(line(0))}\n${JSON.stringify(line(1))}\n`,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('ordinal で重複を落とし、ordinal の順に並べる。メタの行と ordinal の無い行は書かない', async () => {
    const meta = { type: 'alteroid_peer_meta', provider: 'codex', threadId: THREAD, relPath: REL };
    const result = await placePeersInCodexHome(codexHome, [
      seed({
        entries: [meta, line(2, 'c'), line(0, 'a'), line(1, 'b'), line(1, 'b-dup'), { type: 'x' }],
      }),
    ]);

    expect(result.droppedLines).toBe(1);
    const written = (await readFile(join(codexHome, 'sessions', REL), 'utf8'))
      .trim()
      .split('\n')
      .map((text) => JSON.parse(text) as { ordinal: number; payload: { text: string } });
    expect(written.map((entry) => [entry.ordinal, entry.payload.text])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
  });

  it('既にファイルが在れば上書きしない（Codex が書き続けた最新が在る）', async () => {
    const file = join(codexHome, 'sessions', REL);
    await mkdir(join(codexHome, 'sessions', '2026/10/25'), { recursive: true });
    await writeFile(file, 'newer\n');

    const result = await placePeersInCodexHome(codexHome, [seed()]);

    expect(result.present).toEqual(['peer-aaaa']);
    expect(await readFile(file, 'utf8')).toBe('newer\n');
  });

  it('作った段だけ子へ渡す（既に在る CODEX_HOME の持ち主は変えない）', async () => {
    const owner = { uid: 1234, gid: 5678 };
    await placePeersInCodexHome(codexHome, [seed()], owner);

    const chownedPaths = chowned.map(([path]) => path);
    expect(chownedPaths).not.toContain(codexHome);
    expect(chownedPaths).toContain(join(codexHome, 'sessions'));
    expect(chownedPaths).toContain(join(codexHome, 'sessions', REL));
    expect(chowned.every(([, uid, gid]) => uid === 1234 && gid === 5678)).toBe(true);
  });

  it('sessions が外を指す symlink なら、書かずに断り、外へ何も作らない', async () => {
    const outside = await makeTempDir('resume-peers-outside-');
    await symlink(outside, join(codexHome, 'sessions'));

    await expect(placePeersInCodexHome(codexHome, [seed()])).rejects.toThrow('symlink');
    expect(await readdir(outside)).toEqual([]);
  });

  it('日付の段が外を指す symlink なら、書かずに断り、外へ何も作らない', async () => {
    const outside = await makeTempDir('resume-peers-outside-');
    await mkdir(join(codexHome, 'sessions', '2026', '10'), { recursive: true });
    await symlink(outside, join(codexHome, 'sessions', '2026', '10', '25'));

    await expect(placePeersInCodexHome(codexHome, [seed()])).rejects.toThrow('symlink');
    expect(await readdir(outside)).toEqual([]);
  });

  it('危ない relPath・ファイル名の peer は置かずに rejected へ返す（auth.json などは作らない）', async () => {
    const bad = [
      '../auth.json',
      '/etc/cron.d/rollout-x-' + THREAD + '.jsonl',
      `2026/../../rollout-x-${THREAD}.jsonl`,
      `rollout-x-${THREAD}.jsonl\0`,
      'auth.json',
      `2026/10/25/config-${THREAD}.jsonl`,
      `2026/10/25/rollout-x-${THREAD}.json`,
      'rollout-x-other-thread.jsonl',
      `2026//rollout-x-${THREAD}.jsonl`,
    ];
    for (const relPath of bad) {
      const result = await placePeersInCodexHome(codexHome, [seed({ relPath })]);
      expect(result.rejected, relPath).toEqual(['peer-aaaa']);
      expect(result.placed, relPath).toEqual([]);
    }
    expect(await readdir(codexHome)).toEqual([]);
  });

  it('threadId が段として使えない形（/ や ..）なら断る', async () => {
    expect(
      safePeerRolloutRelPath(join(codexHome, 'sessions'), 'rollout-x-../a.jsonl', '../a'),
    ).toBe(undefined);
    expect(safePeerRolloutRelPath(join(codexHome, 'sessions'), REL, THREAD)).toBe(REL);
  });
});
