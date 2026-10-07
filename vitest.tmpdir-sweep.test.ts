import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isStaleVitestTmpDir,
  readVitestOwnTmpDir,
  safeRemoveVitestTmpDir,
  sweepStaleVitestTmpDirs,
  VITEST_TMPDIR_NAME,
  type SweepFs,
  type SweepStat,
} from './vitest.tmpdir-sweep.js';
import { makeTempDirSync } from './vitest.tmpdir.js';

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const OLD = NOW - 7 * HOUR;
const NEW = NOW - 1 * HOUR;
const NAME = '8FOgp61s3yAhI6CGF6OCz';
const HEX = 'a'.repeat(40);

type Node =
  | { kind: 'dir'; mtimeMs: number; children: string[] }
  | { kind: 'file'; mtimeMs: number }
  | { kind: 'link'; mtimeMs: number };

function fakeFs(tree: Record<string, Node>): SweepFs {
  const stat = (p: string): SweepStat => {
    const n = tree[p];
    if (!n) throw new Error(`ENOENT ${p}`);
    return {
      isDirectory: () => n.kind === 'dir',
      isFile: () => n.kind === 'file',
      isSymbolicLink: () => n.kind === 'link',
      mtimeMs: n.mtimeMs,
    };
  };
  return {
    lstat: stat,
    readdir: (p) => {
      const n = tree[p];
      if (!n || n.kind !== 'dir') throw new Error(`ENOTDIR ${p}`);
      return n.children;
    },
  };
}

function goodTree(
  name = NAME,
  over: Record<string, Node> = {},
): { dir: string; tree: Record<string, Node> } {
  const dir = `/t/${name}`;
  const tree: Record<string, Node> = {
    [dir]: { kind: 'dir', mtimeMs: OLD, children: ['client', 'ssr'] },
    [`${dir}/client`]: { kind: 'dir', mtimeMs: OLD, children: [HEX] },
    [`${dir}/ssr`]: { kind: 'dir', mtimeMs: OLD, children: [HEX] },
    [`${dir}/client/${HEX}`]: { kind: 'file', mtimeMs: OLD },
    [`${dir}/ssr/${HEX}`]: { kind: 'file', mtimeMs: OLD },
    ...over,
  };
  return { dir, tree };
}

describe('isStaleVitestTmpDir（#3039）', () => {
  it('条件をすべて満たせば true', () => {
    const { dir, tree } = goodTree();
    expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW)).toBe(true);
  });

  it('ssr だけ（node 環境のみの回）でも true', () => {
    const { dir, tree } = goodTree();
    (tree[dir] as { children: string[] }).children = ['ssr'];
    expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW)).toBe(true);
  });

  it('名前が 21 文字でなければ false', () => {
    for (const name of ['short', NAME + 'x', 'has.dot.in.name.xxxxx', 'alteroid-example-abc12']) {
      const { dir, tree } = goodTree(name);
      expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW), name).toBe(false);
    }
  });

  it('client / ssr 以外のエントリが 1 つでもあれば false', () => {
    const { dir, tree } = goodTree();
    (tree[dir] as { children: string[] }).children = ['client', 'ssr', 'other'];
    expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW)).toBe(false);
  });

  it('空のディレクトリは false', () => {
    const { dir, tree } = goodTree();
    (tree[dir] as { children: string[] }).children = [];
    expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW)).toBe(false);
  });

  it('40 桁 16 進でないファイル名があれば false', () => {
    for (const bad of ['b'.repeat(39), 'B'.repeat(40), 'g'.repeat(40), 'a'.repeat(41)]) {
      const { dir, tree } = goodTree();
      (tree[`${dir}/ssr`] as { children: string[] }).children = [bad];
      tree[`${dir}/ssr/${bad}`] = { kind: 'file', mtimeMs: OLD };
      expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW), bad).toBe(false);
    }
  });

  it('通常ファイルでないもの（ディレクトリ・symlink）が混じれば false', () => {
    for (const kind of ['dir', 'link'] as const) {
      const { dir, tree } = goodTree();
      tree[`${dir}/ssr/${HEX}`] =
        kind === 'dir'
          ? { kind: 'dir', mtimeMs: OLD, children: [] }
          : { kind: 'link', mtimeMs: OLD };
      expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW), kind).toBe(false);
    }
  });

  it('トップまたはサブディレクトリの mtime が 6 時間以内なら false', () => {
    for (const target of ['', '/client', '/ssr']) {
      const { dir, tree } = goodTree();
      tree[dir + target] = { ...(tree[dir + target] as Node), mtimeMs: NEW } as Node;
      expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW), target).toBe(false);
    }
  });

  it('トップが symlink なら false', () => {
    const { dir, tree } = goodTree();
    tree[dir] = { kind: 'link', mtimeMs: OLD };
    expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW)).toBe(false);
  });

  it('サブディレクトリが symlink なら false', () => {
    const { dir, tree } = goodTree();
    tree[`${dir}/client`] = { kind: 'link', mtimeMs: OLD };
    expect(isStaleVitestTmpDir(dir, fakeFs(tree), NOW)).toBe(false);
  });
});

describe('readVitestOwnTmpDir（#3039）', () => {
  it('tmpdir() 直下の 21 文字名だけ受ける。それ以外は undefined（何も消さない）', () => {
    const ok = join(tmpdir(), NAME);
    expect(readVitestOwnTmpDir({ vitest: { _tmpDir: ok } })).toBe(ok);
    expect(readVitestOwnTmpDir({ vitest: { _tmpDir: tmpdir() } })).toBeUndefined();
    expect(readVitestOwnTmpDir({ vitest: { _tmpDir: join(tmpdir(), 'x', NAME) } })).toBeUndefined();
    expect(readVitestOwnTmpDir({ vitest: { _tmpDir: join('/other', NAME) } })).toBeUndefined();
    expect(readVitestOwnTmpDir({ vitest: { _tmpDir: 42 } })).toBeUndefined();
    expect(readVitestOwnTmpDir({ vitest: {} })).toBeUndefined();
    expect(readVitestOwnTmpDir(undefined)).toBeUndefined();
  });
});

describe('safeRemoveVitestTmpDir の線（#3039）', () => {
  const calls: string[] = [];
  const rm = (p: string) => void calls.push(p);
  const run = (target: unknown, base: string) => {
    calls.length = 0;
    const ok = safeRemoveVitestTmpDir(target, { base, rm });
    return { ok, calls: [...calls] };
  };

  it('基点が空・/・相対パスなら rm を 1 度も呼ばない', () => {
    for (const base of ['', '/', '//', 'tmp', './tmp', '../tmp']) {
      expect(run(`/${NAME}`, base), base).toEqual({ ok: false, calls: [] });
      expect(run(join(base, NAME), base), base).toEqual({ ok: false, calls: [] });
    }
  });

  it('対象が基点の外・基点そのもの・2 階層下なら rm を呼ばない', () => {
    for (const target of [
      `/t/../x/${NAME}`,
      `/other/${NAME}`,
      '/t',
      '/t/',
      `/t/sub/${NAME}`,
      `/t/${NAME}/${NAME}`,
      `/t/..`,
      `/t/${NAME}/..`,
      '',
      undefined,
      42,
    ]) {
      expect(run(target, '/t'), String(target)).toEqual({ ok: false, calls: [] });
    }
  });

  it('名前が 21 文字規則に当たらなければ呼ばない', () => {
    expect(run('/t/not-a-vitest-dir', '/t')).toEqual({ ok: false, calls: [] });
  });

  it('基点の直下の 21 文字名だけ rm を 1 度呼ぶ', () => {
    expect(run(`/t/${NAME}`, '/t')).toEqual({ ok: true, calls: [`/t/${NAME}`] });
    expect(run(`/t/./${NAME}`, '/t/')).toEqual({ ok: true, calls: [`/t/${NAME}`] });
  });

  it('sweep も基点が / なら何も消さない（注入 fs と注入 rm）', () => {
    const { tree } = goodTree();
    calls.length = 0;
    const fs = fakeFs({
      ...tree,
      '/': { kind: 'dir', mtimeMs: OLD, children: [NAME] },
      [`/${NAME}`]: tree[`/t/${NAME}`]!,
    });
    expect(sweepStaleVitestTmpDirs(undefined, { root: '/', fs, nowMs: NOW, rm })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('sweepStaleVitestTmpDirs（実 fs、#3039）', () => {
  it('古い取り残しだけ消し、新しいもの・自分のもの・余計なものがあるもの・無関係なものは残す', () => {
    const root = makeTempDirSync('alteroid-sweep-test-');
    const old = new Date(Date.now() - 7 * HOUR);
    const mk = (name: string, aged: boolean, extra?: string) => {
      const d = join(root, name);
      mkdirSync(join(d, 'ssr'), { recursive: true });
      writeFileSync(join(d, 'ssr', HEX), 'x');
      if (extra) writeFileSync(join(d, extra), 'x');
      if (aged) {
        utimesSync(join(d, 'ssr'), old, old);
        utimesSync(d, old, old);
      }
      return d;
    };
    const stale = mk('aaaaaaaaaaaaaaaaaaaaa', true);
    mk('bbbbbbbbbbbbbbbbbbbbb', false);
    const own = mk('ccccccccccccccccccccc', true);
    mk('ddddddddddddddddddddd', true, 'note.txt');
    mkdirSync(join(root, 'keep-me'));
    const removed = sweepStaleVitestTmpDirs(own, { root });
    expect(removed).toEqual([stale]);
    expect(readdirSync(root).sort()).toEqual(
      ['bbbbbbbbbbbbbbbbbbbbb', 'ccccccccccccccccccccc', 'ddddddddddddddddddddd', 'keep-me'].sort(),
    );
  });
});

describe('vitest を実際に 1 回起こして 21 文字ディレクトリが残らない（#3039）', () => {
  it('正常終了後、専用 TMPDIR に nanoid 名のディレクトリが無い', () => {
    const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
    const sandbox = makeTempDirSync('alteroid-vitest-tmpdir-e2e-');
    // 親の env を丸ごと渡さず、vitest の子が起動に要る鍵だけを明示する。
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? sandbox,
      TMPDIR: sandbox,
    };
    const r = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--root',
        repoRoot,
        '--maxWorkers=1',
        'vitest.config.test.ts',
      ],
      { env, encoding: 'utf8', timeout: 120_000, cwd: repoRoot },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const left = readdirSync(sandbox).filter((n) => VITEST_TMPDIR_NAME.test(n));
    expect(left, `${r.stdout}\n${r.stderr}`).toEqual([]);
  }, 150_000);
});
