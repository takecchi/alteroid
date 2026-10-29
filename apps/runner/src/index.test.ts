import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  childUserOf,
  DONE_TREE_REAP_AFTER_MINUTES_ENV_KEY,
  doneTreeReapAfterMsOf,
  RECLAIM_ENV_KEY,
  reclaimScanOf,
  reportRetiredLayerProviderEnv,
  socketOwnerOf,
  tokenSha256Of,
} from './index.js';

const run = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOKEN = 'the-shared-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

describe('tokenSha256Of', () => {
  it('素の合鍵だけが置かれていたら畳む（デーモンと同じ値を置けばよい）', () => {
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN: TOKEN })).toBe(TOKEN_SHA256);
  });

  it('sha256 を直に渡す形も引き続き通る', () => {
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN_SHA256: TOKEN_SHA256 })).toBe(TOKEN_SHA256);
  });

  it('両方あって一致しているなら通る', () => {
    expect(
      tokenSha256Of({ ALTEROID_RUNNER_TOKEN: TOKEN, ALTEROID_RUNNER_TOKEN_SHA256: TOKEN_SHA256 }),
    ).toBe(TOKEN_SHA256);
  });

  it('食い違っていたら落とす（黙って片方を選ぶと 401 が出続けて噛み合わない）', () => {
    expect(() =>
      tokenSha256Of({ ALTEROID_RUNNER_TOKEN: TOKEN, ALTEROID_RUNNER_TOKEN_SHA256: 'deadbeef' }),
    ).toThrow(/食い違っている/);
  });

  it('空文字は未指定と同じに扱う', () => {
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN: '', ALTEROID_RUNNER_TOKEN_SHA256: '' })).toBe(
      undefined,
    );
  });
});

describe('器の起動スクリプト', () => {
  let dir: string;

  function fake(name: string, body: string): void {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  beforeEach(() => {
    dir = makeTempDirSync('alteroid-launch-');
    fake('node', 'printf "%s\\n" "$@"\nenv');
    fake('tini', '[ "$1" = "--" ] && shift\nexec "$@"');
  });

  async function launch(name: string, env: NodeJS.ProcessEnv) {
    const { stdout } = await run('/bin/sh', [join(REPO_ROOT, 'docker', name)], {
      env: { PATH: `${dir}:${process.env.PATH ?? ''}`, ...env },
    });
    return stdout;
  }

  function pretendRoot(): void {
    fake('id', 'echo 0');
    fake('getent', 'echo "node:x:1000:1000::/home/node:/bin/bash"');
    fake('setpriv', 'printf "setpriv %s\\n" "$*"\nenv');
  }

  it('alteroid-runner: 素の合鍵を sha256 へ畳み、素の値は exec の先へ渡さない', async () => {
    const out = await launch('alteroid-runner', { ALTEROID_RUNNER_TOKEN: TOKEN });

    expect(out).toContain(`ALTEROID_RUNNER_TOKEN_SHA256=${TOKEN_SHA256}`);
    // `=` まで含めて見る: SHA256 の行に引っかからないため。
    expect(out).not.toContain(`ALTEROID_RUNNER_TOKEN=${TOKEN}`);
    expect(out.split('\n')).not.toContain(`ALTEROID_RUNNER_TOKEN=${TOKEN}`);
  });

  it('alteroid-runner: runner の実体を exec する', async () => {
    const out = await launch('alteroid-runner', { ALTEROID_RUNNER_TOKEN: TOKEN });
    expect(out.split('\n')[0]).toBe('/app/apps/runner/dist/index.js');
  });

  it('alteroid-runner: 素の合鍵と sha256 が食い違っていたら起動しない', async () => {
    await expect(
      launch('alteroid-runner', {
        ALTEROID_RUNNER_TOKEN: TOKEN,
        ALTEROID_RUNNER_TOKEN_SHA256: 'deadbeef',
      }),
    ).rejects.toThrow(/食い違っている/);
  });

  it('alteroid-runner: sha256 だけの構成はそのまま通す', async () => {
    const out = await launch('alteroid-runner', { ALTEROID_RUNNER_TOKEN_SHA256: TOKEN_SHA256 });
    expect(out).toContain(`ALTEROID_RUNNER_TOKEN_SHA256=${TOKEN_SHA256}`);
  });

  it('alteroid-runner: pid 1 を tini にして node を起こす。-g は付けない（#315。60秒の drain を潰さないため）', async () => {
    // ここだけ `tini` を引数をそのまま吐くものに差し替える: 素通し版だと `tini` 自身の引数（`--` の位置・`-g`）が消えるため。
    fake('tini', 'printf "%s\\n" "$@"');
    const out = await launch('alteroid-runner', { ALTEROID_RUNNER_TOKEN: TOKEN });
    const args = out.split('\n').filter((line) => line.length > 0);

    expect(args).toEqual(['--', 'node', '/app/apps/runner/dist/index.js']);
    expect(args).not.toContain('-g');
  });

  it('alteroidd: 非 root ならそのままデーモンを exec する', async () => {
    const out = await launch('alteroidd', {});
    expect(out.split('\n')[0]).toBe('/app/apps/daemon/dist/index.js');
  });

  it('alteroidd: root なら node へ降ろし、降りた先の pid 1 は tini（#4478。ゾンビを回収させる）', async () => {
    pretendRoot();
    const out = await launch('alteroidd', { HOME: '/root' });
    expect(out.split('\n')[0]).toBe(
      'setpriv --reuid=node --regid=node --init-groups tini -- node /app/apps/daemon/dist/index.js',
    );
  });

  it('alteroidd: 降ろすときは HOME も差し替える（root の home のままだと SDK が設定を書けない）', async () => {
    pretendRoot();
    const out = await launch('alteroidd', { HOME: '/root' });

    expect(out).toContain('HOME=/home/node');
    expect(out.split('\n')).not.toContain('HOME=/root');
    expect(out).toContain('USER=node');
    expect(out).toContain('LOGNAME=node');
  });
});

describe('reclaimScanOf（孤児の観測を切る口）', () => {
  const CHILD = { uid: 1001, gid: 1001 };

  const view = {
    liveSessionPidsOf: () => new Set<number>(),
    knownTerminatedSessionPidsOf: () => new Set<number>(),
    ownerListedSessionPidsOf: () => new Set<number>(),
    abandonedOwnerListedSessionPidsOf: () => new Set<number>(),
    anyTrackedDelegationsOf: () => true,
  };

  it('未設定なら reclaim（撃つ）として観測し、view はそのまま乗る', () => {
    expect(reclaimScanOf({}, CHILD, view)).toEqual({ childUid: 1001, mode: 'reclaim', view });
    expect(reclaimScanOf({}, CHILD, view)).toEqual(
      reclaimScanOf({ [RECLAIM_ENV_KEY]: 'reclaim' }, CHILD, view),
    );
  });

  it('observe を明示すれば、同じ view のまま撃たない構えになる', () => {
    expect(reclaimScanOf({ [RECLAIM_ENV_KEY]: 'observe' }, CHILD, view)).toEqual({
      childUid: 1001,
      mode: 'observe',
      view,
    });
  });

  it('空文字も未設定と同じく reclaim', () => {
    expect(reclaimScanOf({ [RECLAIM_ENV_KEY]: '' }, CHILD, view)).toEqual({
      childUid: 1001,
      mode: 'reclaim',
      view,
    });
  });

  it('off なら欄ごと出さない（undefined）', () => {
    expect(reclaimScanOf({ [RECLAIM_ENV_KEY]: 'off' }, CHILD, view)).toBeUndefined();
  });

  it('知らない値なら落とす（黙って既定へ倒れない）', () => {
    expect(() => reclaimScanOf({ [RECLAIM_ENV_KEY]: 'Off' }, CHILD, view)).toThrow(/知らない値/);
  });

  it('降ろす UID が無い器では観測しない（取れない軸に数を作らない）', () => {
    expect(reclaimScanOf({}, undefined, view)).toBeUndefined();
  });
});

describe('doneTreeReapAfterMsOf（終わって久しい done の担当の木を撃つ期限。#5157）', () => {
  const key = DONE_TREE_REAP_AFTER_MINUTES_ENV_KEY;

  it('置かない・空文字は既定の6時間', () => {
    expect(doneTreeReapAfterMsOf({})).toBe(6 * 60 * 60_000);
    expect(doneTreeReapAfterMsOf({ [key]: '' })).toBe(6 * 60 * 60_000);
  });

  it('off は無効（undefined）', () => {
    expect(doneTreeReapAfterMsOf({ [key]: 'off' })).toBeUndefined();
  });

  it('正の整数は分として ms に直す', () => {
    expect(doneTreeReapAfterMsOf({ [key]: '1' })).toBe(60_000);
    expect(doneTreeReapAfterMsOf({ [key]: '90' })).toBe(90 * 60_000);
  });

  it.each(['0', '-5', '1.5', '6h', 'Off', 'abc', ' 10', '1e3', '99999999999999999999'])(
    '正の整数でも off でもない値（%s）は黙って既定へ倒さず落とす',
    (value) => {
      expect(() => doneTreeReapAfterMsOf({ [key]: value })).toThrow(/知らない値/);
    },
  );
});

describe('socketOwnerOf', () => {
  it('ALTEROID_RUNNER_SOCKET_UID が未設定なら持ち主を変えない（uid 0 へ chown しに行かない）', () => {
    expect(socketOwnerOf({})).toBeUndefined();
    expect(socketOwnerOf({ ALTEROID_RUNNER_SOCKET_UID: '' })).toBeUndefined();
    expect(socketOwnerOf({ ALTEROID_RUNNER_SOCKET_GID: '1000' })).toBeUndefined();
  });

  it('UID だけなら GID は UID に揃える', () => {
    expect(socketOwnerOf({ ALTEROID_RUNNER_SOCKET_UID: '1000' })).toEqual({ uid: 1000, gid: 1000 });
  });

  it('UID と GID が別々に置かれていればそのまま使う', () => {
    expect(
      socketOwnerOf({ ALTEROID_RUNNER_SOCKET_UID: '1000', ALTEROID_RUNNER_SOCKET_GID: '2000' }),
    ).toEqual({ uid: 1000, gid: 2000 });
  });
});

describe('childUserOf（#3807）', () => {
  // 自身の UID を明示する: 実行ユーザーに左右されないため。
  const ROOT = 0;

  it('未設定なら降ろさない', () => {
    expect(childUserOf({}, ROOT)).toBeUndefined();
    expect(childUserOf({ ALTEROID_RUNNER_CHILD_UID: '' }, ROOT)).toBeUndefined();
  });

  it('正しい値は通す。GID は UID に揃え、別々に置けばそのまま使う', () => {
    expect(childUserOf({ ALTEROID_RUNNER_CHILD_UID: '1000' }, ROOT)).toEqual({
      uid: 1000,
      gid: 1000,
    });
    expect(
      childUserOf(
        {
          ALTEROID_RUNNER_CHILD_UID: '1000',
          ALTEROID_RUNNER_CHILD_GID: '2000',
          ALTEROID_RUNNER_CHILD_HOME: '/home/child',
        },
        ROOT,
      ),
    ).toEqual({ uid: 1000, gid: 2000, home: '/home/child' });
  });

  it('runner 自身と同じ UID（0）は、境界にならないので断る', () => {
    expect(() => childUserOf({ ALTEROID_RUNNER_CHILD_UID: '0' }, ROOT)).toThrow(/自身の UID/);
    expect(() => childUserOf({ ALTEROID_RUNNER_CHILD_UID: '1000' }, 1000)).toThrow(/自身の UID/);
  });

  it.each(['abc', '-1', '1.5', '0x10', '1e3'])('UID が非負の整数でない（%s）なら断る', (value) => {
    expect(() => childUserOf({ ALTEROID_RUNNER_CHILD_UID: value }, ROOT)).toThrow(
      /ALTEROID_RUNNER_CHILD_UID は非負の整数/,
    );
  });

  it.each(['abc', '-1', '1.5'])('GID が非負の整数でない（%s）なら断る', (value) => {
    expect(() =>
      childUserOf({ ALTEROID_RUNNER_CHILD_UID: '1000', ALTEROID_RUNNER_CHILD_GID: value }, ROOT),
    ).toThrow(/ALTEROID_RUNNER_CHILD_GID は非負の整数/);
  });
});

describe('reportRetiredLayerProviderEnv（もう読まない層の provider の変数。2026-10-07 の決定）', () => {
  it('置かれていなければ何も書かない', () => {
    const lines: string[] = [];
    reportRetiredLayerProviderEnv({ ALTEROID_MANAGER_MODEL: 'opus' }, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('ALTEROID_MANAGER_PROVIDER が残っていれば、名前を出して1行（値は出さない。起動は止めない）', () => {
    const lines: string[] = [];
    reportRetiredLayerProviderEnv({ ALTEROID_MANAGER_PROVIDER: 'codex' }, (line) =>
      lines.push(line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^alteroid-runner: ALTEROID_MANAGER_PROVIDER はもう読みません/);
    expect(lines[0]).toContain('CODEX_API_KEY');
    expect(lines[0]?.endsWith('\n')).toBe(true);
  });

  it('ALTEROID_MANAGER_PEERS が残っていても1行出す（2026-10-08 に退役。peer は Codex の資格で開く。#4118）', () => {
    const lines: string[] = [];
    reportRetiredLayerProviderEnv({ ALTEROID_MANAGER_PEERS: 'codex' }, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^alteroid-runner: ALTEROID_MANAGER_PEERS はもう読みません/);
  });

  it('runner の起動はこれを呼ぶ（配線）', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain('reportRetiredLayerProviderEnv(process.env);');
  });
});
