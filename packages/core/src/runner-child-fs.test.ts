import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

// runner 本体が fs を開いたかを数える。名前だけ数えて、中身は本物へ通す（試験の準備に使う側は数え終えた後に動かす）。
// 子の uid の子プロセスで書く・読む経路では、runner 本体は何も開かない: uid の違いそのものは試験が root でないので再現できないので、
// 「書く・読む処理が子プロセスへ渡されている」ことをこの数で測る（#5259）。
const touched = vi.hoisted(() => ({ names: [] as string[] }));
type AnyFn = (...args: unknown[]) => unknown;
function spied(actual: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of names) {
    const original = actual[name] as AnyFn;
    wrapped[name] = (...args: unknown[]) => {
      touched.names.push(name);
      return original(...args);
    };
  }
  return wrapped;
}
vi.mock('node:fs/promises', async (importOriginal) =>
  spied(await importOriginal<Record<string, unknown>>(), [
    'mkdir',
    'writeFile',
    'open',
    'realpath',
    'chown',
  ]),
);
vi.mock('node:fs', async (importOriginal) =>
  spied(await importOriginal<Record<string, unknown>>(), [
    'lstatSync',
    'mkdirSync',
    'writeFileSync',
    'openSync',
    'realpathSync',
    'lchownSync',
  ]),
);

const { childFileWriter, childRolloutIo, localRolloutIo, CHILD_FS_SCRIPT } =
  await import('./runner-child-fs.js');
const { placePeersInCodexHome, placeResumeMaterialAsChild, placeSeedInConfigDir } =
  await import('./runner-resume-config-dir.js');
const { PeerRolloutMirror, resolveRolloutFile } = await import('./runner-peer-rollout.js');
const { sameUidSpawn, spawnedPids } = await import('./runner-child-fs.test-support.js');
const { spawn } = await import('node:child_process');

const THREAD = '0199c0a1-2b3c-7d4e-8f50-123456789abc';
const REL = `2026/10/25/rollout-2026-10-25T09-00-00-${THREAD}.jsonl`;
const KEY = { projectKey: '-work-project', sessionId: 'sess-1' };
const line = (ordinal: number, text = 'x') =>
  `${JSON.stringify({ timestamp: '2026-10-25T09:00:00.000Z', ordinal, type: 'response_item', payload: { text } })}\n`;

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('child-fs-');
  spawnedPids.length = 0;
});

/** 子プロセスの中身を直接叩く（入出力の形と終了コードを確かめる）。 */
function runScript(
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD_FS_SCRIPT], {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('子プロセスの中身（CHILD_FS_SCRIPT）の入出力', () => {
  it('write: 段を 0700 で作り、0600 で書く。既にあれば present で上書きしない。応答に自分の pid を返す', async () => {
    const file = join(dir, 'a', 'b', 'x.jsonl');
    const first = await runScript(
      JSON.stringify({ op: 'write', files: [{ path: file, body: 'one\n' }] }),
    );
    expect(first.code).toBe(0);
    const parsed = JSON.parse(first.stdout) as { results: unknown[]; pid: number };
    expect(parsed.results).toEqual([{ status: 'placed' }]);
    expect(parsed.pid).not.toBe(process.pid);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'a'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'a', 'b'))).mode & 0o777).toBe(0o700);

    const second = await runScript(
      JSON.stringify({ op: 'write', files: [{ path: file, body: 'two\n' }] }),
    );
    expect((JSON.parse(second.stdout) as { results: unknown[] }).results).toEqual([
      { status: 'present' },
    ]);
    expect(await readFile(file, 'utf8')).toBe('one\n');
  });

  it('write: 末尾が symlink でも辿って書かない（wx）。段が通れなければファイルごとに error と code を返し、他は続ける', async () => {
    const target = join(dir, 'target');
    await writeFile(target, 'keep');
    await symlink(target, join(dir, 'link.jsonl'));
    await writeFile(join(dir, 'plain'), 'file');
    const result = await runScript(
      JSON.stringify({
        op: 'write',
        files: [
          { path: join(dir, 'link.jsonl'), body: 'x' },
          { path: join(dir, 'plain', 'under.jsonl'), body: 'x' },
          { path: join(dir, 'ok.jsonl'), body: 'x' },
        ],
      }),
    );
    expect(result.code).toBe(0);
    const results = (JSON.parse(result.stdout) as { results: { status: string; code?: string }[] })
      .results;
    expect(results[0]).toEqual({ status: 'present' });
    expect(results[1]?.status).toBe('error');
    expect(typeof results[1]?.code).toBe('string');
    expect(results[2]).toEqual({ status: 'placed' });
    expect(await readFile(target, 'utf8')).toBe('keep');
  });

  it('入力が読めない・op が不明・path が絶対でないときは終了コード 2 で、stdout に何も出さない', async () => {
    for (const input of [
      'not json',
      JSON.stringify({ op: 'nope' }),
      JSON.stringify({ op: 'write', files: [{ path: 'relative', body: 'x' }] }),
    ]) {
      const result = await runScript(input);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    }
  });

  it('realpath と read: 実体のパス・errno の code・offset からの読み・大きさを返す', async () => {
    const real = join(dir, 'real.jsonl');
    await writeFile(real, 'abcdef\n');
    await symlink(real, join(dir, 'link.jsonl'));
    const resolved = await runScript(
      JSON.stringify({ op: 'realpath', paths: [join(dir, 'link.jsonl'), join(dir, 'none')] }),
    );
    const { results } = JSON.parse(resolved.stdout) as { results: Record<string, string>[] };
    expect(results[0]?.path).toBe(await (await import('node:fs/promises')).realpath(real));
    expect(results[1]).toEqual({ code: 'ENOENT' });

    const read = await runScript(JSON.stringify({ op: 'read', file: real, offset: 2, length: 3 }));
    const body = JSON.parse(read.stdout) as { ok: boolean; size: number; data: string };
    expect(body.size).toBe(7);
    expect(Buffer.from(body.data, 'base64').toString('utf8')).toBe('cde');

    const past = JSON.parse(
      (await runScript(JSON.stringify({ op: 'read', file: real, offset: 99, length: 3 }))).stdout,
    ) as { ok: boolean; size: number; data: string };
    expect(past).toMatchObject({ ok: true, size: 7, data: '' });

    const missing = JSON.parse(
      (
        await runScript(
          JSON.stringify({ op: 'read', file: join(dir, 'none'), offset: 0, length: 1 }),
        )
      ).stdout,
    ) as { ok: boolean; code: string };
    expect(missing).toEqual(expect.objectContaining({ ok: false, code: 'ENOENT' }));
  });
});

describe('失敗の扱い: 子プロセスが落ちたら投げる（黙って落とさない）', () => {
  it('子プロセスが非 0 で終わる・起こせないと、writer も reader も投げる', async () => {
    const crashing = (options: Parameters<typeof sameUidSpawn>[0]) =>
      spawn(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(7)'], {
        env: {},
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    await expect(
      childFileWriter(crashing, process.env)([{ path: join(dir, 'x'), body: 'x' }]),
    ).rejects.toThrow(/終了コード 7.*boom/);
    await expect(
      childRolloutIo(crashing, process.env).readChunk(join(dir, 'x'), 0, 1),
    ).rejects.toThrow(/終了コード 7/);
    const missing = () =>
      spawn(join(dir, 'no-such-binary'), [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    await expect(
      childFileWriter(missing, process.env)([{ path: join(dir, 'x'), body: 'x' }]),
    ).rejects.toThrow();
  });

  it('主の記録が置けなければ placeResumeMaterialAsChild は投げ、作業者の記録だけ失敗なら subagentFailure に返す', async () => {
    const failing = async (): Promise<never[]> => {
      throw new Error('子プロセスが落ちた');
    };
    await expect(
      placeResumeMaterialAsChild(dir, KEY, [{ type: 'user' }], [], failing),
    ).rejects.toThrow('子プロセスが落ちた');

    const seedOkSubFails = async () => [
      { status: 'placed' as const },
      { status: 'error' as const, code: 'EACCES' },
    ];
    const result = await placeResumeMaterialAsChild(
      dir,
      KEY,
      [{ type: 'user' }],
      [{ subpath: 'subagents/agent-a1', entries: [{ type: 'user' }] }],
      seedOkSubFails,
    );
    expect(result.seed).toBe('placed');
    expect(result.subagentFailure).toContain('EACCES');

    const seedFails = async () => [{ status: 'error' as const, code: 'EACCES' }];
    await expect(
      placeResumeMaterialAsChild(dir, KEY, [{ type: 'user' }], [], seedFails),
    ).rejects.toThrow('EACCES');
  });
});

describe('陰性対照: 子の uid の子プロセスで書く経路では、runner 本体は fs を開かない（#5259）', () => {
  it('対照（歯の確認）: 子を降ろさない経路では runner 自身が fs を開く。数え方が効いている証拠', async () => {
    await mkdir(join(dir, 'home'));
    touched.names.length = 0;
    await placeSeedInConfigDir(join(dir, 'home'), KEY, [{ type: 'user' }]);
    expect(touched.names).toEqual(expect.arrayContaining(['lstatSync', 'mkdir', 'writeFile']));
  });

  it('検めた後・書く前に段を symlink へ差し替えても、書いたのは別プロセス（子）で、runner 本体は何も開かない・段の検め（lstat）もしない', async () => {
    const configDir = join(dir, 'home');
    const outside = await makeTempDir('child-fs-outside-');
    await mkdir(join(configDir, 'projects'), { recursive: true });
    // 子プロセスを起こす直前（＝計画の後・書く前）に、段を外を指す symlink に差し替える
    const { renameSync, symlinkSync } = await import('node:fs');
    const swapThenSpawn: typeof sameUidSpawn = (options) => {
      renameSync(join(configDir, 'projects'), join(configDir, 'projects-real'));
      symlinkSync(outside, join(configDir, 'projects'));
      return sameUidSpawn(options);
    };
    const writer = childFileWriter(swapThenSpawn, process.env);

    touched.names.length = 0;
    const placed = await placeSeedInConfigDir(configDir, KEY, [{ type: 'user' }], writer);
    const runnerTouched = [...touched.names];

    expect(placed).toBe('placed');
    // 書いた処理は別のプロセス
    expect(spawnedPids).toHaveLength(1);
    expect(spawnedPids[0]).not.toBe(process.pid);
    // runner 本体は、mkdir・書き込み・段の検め（lstat）・chown のどれも呼んでいない
    expect(runnerTouched).toEqual([]);
    // 試験は子を降ろせない（同じ uid）ので、symlink の先へ子が書く。実運用では子が書けない先には届かない
    expect(
      await readFile(join(outside, KEY.projectKey, `${KEY.sessionId}.jsonl`), 'utf8'),
    ).toContain('user');
  });

  it('子の uid の子プロセスは、まとめて1本だけ起こす: seed と作業者5件と peer 3件でも、置く処理は 1 回ずつ', async () => {
    const configDir = join(dir, 'home');
    const subagents = [1, 2, 3, 4, 5].map((n) => ({
      subpath: `subagents/agent-${String(n)}`,
      entries: [{ type: 'user', n }],
    }));
    touched.names.length = 0;
    const writer = childFileWriter(sameUidSpawn, process.env);
    const result = await placeResumeMaterialAsChild(
      configDir,
      KEY,
      [{ type: 'user' }],
      subagents,
      writer,
    );
    expect(result.subagents.placed).toBe(5);
    expect(spawnedPids).toHaveLength(1);

    spawnedPids.length = 0;
    const peers = ['a', 'b', 'c'].map((id) => ({
      peerId: `peer-${id}`,
      threadId: THREAD,
      relPath: `2026/10/25/rollout-2026-10-25T09-00-0${id === 'a' ? 0 : id === 'b' ? 1 : 2}-${THREAD}.jsonl`,
      entries: [JSON.parse(line(0)) as unknown],
    }));
    const peerResult = await placePeersInCodexHome(join(dir, 'codex'), peers, writer);
    expect(peerResult.placed).toHaveLength(3);
    expect(spawnedPids).toHaveLength(1);
    expect(touched.names).toEqual([]);
  });

  it('読む経路: sessions を symlink に差し替えても、読んだのは別プロセス（子）で、runner 本体は open・realpath をしない', async () => {
    const codexHome = join(dir, 'codex');
    const outside = await makeTempDir('child-fs-rollout-outside-');
    await mkdir(join(outside, '2026/10/25'), { recursive: true });
    const outsideRollout = join(outside, REL);
    await writeFile(outsideRollout, line(0, 'from-outside'));
    await mkdir(codexHome);
    await symlink(outside, join(codexHome, 'sessions'));
    const io = childRolloutIo(sameUidSpawn, process.env);

    touched.names.length = 0;
    const resolved = await resolveRolloutFile(
      codexHome,
      join(codexHome, 'sessions', REL),
      THREAD,
      io,
    );
    const chunk = await io.readChunk(outsideRollout, 0, 1024);

    expect(spawnedPids).toHaveLength(2);
    expect(spawnedPids.every((pid) => pid !== process.pid)).toBe(true);
    expect(touched.names).toEqual([]);
    // 試験は子を降ろせないので、同じ uid の子は読めてしまう（実運用では子が読めない root のファイルは読めない）。
    // 名前・実体の検めは親の側に残っている: sessions の実体が外なので通る（これは symlink 先が子の読める場所のときの挙動）
    expect(resolved.ok).toBe(true);
    expect(chunk.data.toString('utf8')).toContain('from-outside');
  });

  it('対照（歯の確認）: 子を降ろさない読みでは runner 自身が realpath・open する', async () => {
    const rollout = join(dir, 'sessions', REL);
    await mkdir(join(dir, 'sessions', '2026/10/25'), { recursive: true });
    await writeFile(rollout, line(0));
    touched.names.length = 0;
    await resolveRolloutFile(dir, rollout, THREAD, localRolloutIo);
    await localRolloutIo.readChunk(rollout, 0, 10);
    expect(touched.names).toEqual(expect.arrayContaining(['realpath', 'open']));
  });
});

describe('PeerRolloutMirror を子の uid の読み口で動かす', () => {
  it('増えた行だけを、子プロセス経由で読んで預ける（1回の collect は子プロセス1本）。名前の検めは残る', async () => {
    const codexHome = join(dir, 'codex');
    const rollout = join(codexHome, 'sessions', REL);
    await mkdir(join(codexHome, 'sessions', '2026/10/25'), { recursive: true });
    await writeFile(join(codexHome, 'auth.json'), 'secret-credential');
    await writeFile(rollout, line(0) + line(1));
    const mirrored: unknown[] = [];
    const notes: string[] = [];
    const mirror = new PeerRolloutMirror({
      codexHome: () => codexHome,
      mainKey: () => ({ projectKey: 'p', sessionId: 's' }),
      mirror: (_key, entries) => mirrored.push(...entries),
      note: (text) => notes.push(text),
      io: childRolloutIo(sameUidSpawn, process.env),
    });
    const info = {
      peerId: 'peer-aaaa',
      provider: 'codex',
      threadId: THREAD,
      transcriptLocation: rollout,
      resumed: false,
    };
    touched.names.length = 0;
    await mirror.track(info);
    expect(spawnedPids).toHaveLength(1);
    await mirror.collect('peer-aaaa');
    expect(spawnedPids).toHaveLength(2);
    expect(mirrored).toHaveLength(3);

    // 試験自身の書き込みは数えない: 数えるのは mirror が動いている間だけ
    expect(touched.names).toEqual([]);
    await writeFile(rollout, line(0) + line(1) + line(2));
    touched.names.length = 0;
    mirrored.length = 0;
    await mirror.collect('peer-aaaa');
    expect(mirrored.map((entry) => (entry as { ordinal?: number }).ordinal)).toEqual([2]);
    expect(touched.names).toEqual([]);

    // 資格のファイルは、子プロセスを起こす前に名前で断る
    const before = spawnedPids.length;
    await mirror.track({
      ...info,
      peerId: 'peer-bbbb',
      transcriptLocation: join(codexHome, 'auth.json'),
    });
    expect(spawnedPids).toHaveLength(before);
    expect(JSON.stringify(notes)).toMatch(/ファイル名が rollout-/);
    expect(await readdir(codexHome)).toContain('auth.json');
  });
});
