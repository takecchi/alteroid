import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  childUserOf,
  DONE_TREE_REAP_AFTER_MINUTES_ENV_KEY,
  doneTreeReapAfterMsOf,
  listenPlanOf,
  RECLAIM_ENV_KEY,
  reclaimScanOf,
  socketOwnerOf,
  tokenSha256Of,
} from './index.js';

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

  it('空白だけは未指定と同じ・前後の空白は落としてから畳む', () => {
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN: ' ', ALTEROID_RUNNER_TOKEN_SHA256: '\t' })).toBe(
      undefined,
    );
    expect(tokenSha256Of({ ALTEROID_RUNNER_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN_SHA256);
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
    // `promisify(execFile)` を経由しない: 別名越しの呼びは `env` を指定したかを lint が見られないため（#1971）
    return new Promise<string>((resolve, reject) => {
      execFile(
        '/bin/sh',
        [join(REPO_ROOT, 'docker', name)],
        { env: { PATH: `${dir}:${process.env.PATH ?? ''}`, ...env } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
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
    snapshot: () => ({
      live: new Set<number>(),
      knownTerminated: new Set<number>(),
      ownerListed: new Set<number>(),
      abandonedOwnerListed: new Set<number>(),
      anyTrackedDelegations: true,
    }),
  };

  it('未設定なら reclaim（撃つ）として観測し、view と引き取り手はそのまま乗る', () => {
    expect(reclaimScanOf({}, CHILD, view, null)).toEqual({
      childUid: 1001,
      mode: 'reclaim',
      view,
      delegationSubreaper: null,
    });
    expect(reclaimScanOf({}, CHILD, view, '/usr/bin/tini')).toEqual({
      childUid: 1001,
      mode: 'reclaim',
      view,
      delegationSubreaper: '/usr/bin/tini',
    });
    expect(reclaimScanOf({}, CHILD, view, null)).toEqual(
      reclaimScanOf({ [RECLAIM_ENV_KEY]: 'reclaim' }, CHILD, view, null),
    );
  });

  it('observe を明示すれば、同じ view のまま撃たない構えになる', () => {
    expect(reclaimScanOf({ [RECLAIM_ENV_KEY]: 'observe' }, CHILD, view, null)).toEqual({
      childUid: 1001,
      mode: 'observe',
      view,
      delegationSubreaper: null,
    });
  });

  it('空文字も未設定と同じく reclaim', () => {
    expect(reclaimScanOf({ [RECLAIM_ENV_KEY]: '' }, CHILD, view, null)).toEqual({
      childUid: 1001,
      mode: 'reclaim',
      view,
      delegationSubreaper: null,
    });
  });

  it('off なら欄ごと出さない（undefined）', () => {
    expect(reclaimScanOf({ [RECLAIM_ENV_KEY]: 'off' }, CHILD, view, null)).toBeUndefined();
  });

  it('知らない値なら落とす（黙って既定へ倒れない）', () => {
    expect(() => reclaimScanOf({ [RECLAIM_ENV_KEY]: 'Off' }, CHILD, view, null)).toThrow(
      /知らない値/,
    );
  });

  it('降ろす UID が無い器では観測しない（取れない軸に数を作らない）', () => {
    expect(reclaimScanOf({}, undefined, view, null)).toBeUndefined();
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

  it.each(['0', '-5', '1.5', '6h', 'Off', 'abc', '1 0', '1e3', '99999999999999999999'])(
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

  it('GID が空文字なら UID に揃える（置いていないのと同じ）', () => {
    expect(
      socketOwnerOf({ ALTEROID_RUNNER_SOCKET_UID: '1000', ALTEROID_RUNNER_SOCKET_GID: '' }),
    ).toEqual({ uid: 1000, gid: 1000 });
  });

  it.each(['abc', '1.5', '-1', '10 00', '1e3', '99999999999999999999'])(
    'UID が非負の整数でない値（%s）なら、黙って chown を飛ばさず落とす',
    (value) => {
      expect(() => socketOwnerOf({ ALTEROID_RUNNER_SOCKET_UID: value })).toThrow(
        /ALTEROID_RUNNER_SOCKET_UID は非負の整数/,
      );
    },
  );

  it.each(['abc', '1.5', '-1'])('GID が非負の整数でない値（%s）なら落とす', (value) => {
    expect(() =>
      socketOwnerOf({ ALTEROID_RUNNER_SOCKET_UID: '1000', ALTEROID_RUNNER_SOCKET_GID: value }),
    ).toThrow(/ALTEROID_RUNNER_SOCKET_GID は非負の整数/);
  });
});

describe('listenPlanOf（待ち受けの口）', () => {
  it('置かない・空文字のポートは 4518（空を 0＝任意のポートに読まない）', () => {
    expect(listenPlanOf({})).toEqual({ kind: 'tcp', port: 4518, hostname: '127.0.0.1' });
    expect(listenPlanOf({ ALTEROID_RUNNER_PORT: '' })).toEqual({
      kind: 'tcp',
      port: 4518,
      hostname: '127.0.0.1',
    });
  });

  it('空白だけのポート・BIND は置いていないのと同じ（既定の 4518・127.0.0.1）', () => {
    expect(listenPlanOf({ ALTEROID_RUNNER_PORT: '  ', ALTEROID_RUNNER_BIND: ' ' })).toEqual({
      kind: 'tcp',
      port: 4518,
      hostname: '127.0.0.1',
    });
  });

  it('前後の空白は落として読む（ポート・BIND・ソケット）', () => {
    expect(listenPlanOf({ ALTEROID_RUNNER_PORT: ' 4600 ', ALTEROID_RUNNER_BIND: ' :: ' })).toEqual({
      kind: 'tcp',
      port: 4600,
      hostname: '::',
    });
    expect(listenPlanOf({ ALTEROID_RUNNER_SOCKET: ' /run/x.sock ' })).toMatchObject({
      kind: 'socket',
      path: '/run/x.sock',
    });
  });

  it('1〜65535 の整数はそのまま使い、BIND は置かない・空文字なら 127.0.0.1', () => {
    expect(listenPlanOf({ ALTEROID_RUNNER_PORT: '1', ALTEROID_RUNNER_BIND: '' })).toMatchObject({
      port: 1,
      hostname: '127.0.0.1',
    });
    expect(
      listenPlanOf({ ALTEROID_RUNNER_PORT: '65535', ALTEROID_RUNNER_BIND: '::' }),
    ).toMatchObject({ port: 65535, hostname: '::' });
  });

  it.each(['0', '65536', '-1', 'abc', '4518.5', '45 18', '1e3', '04518'])(
    '1〜65535 の整数でないポート（%s）は落とす',
    (value) => {
      expect(() => listenPlanOf({ ALTEROID_RUNNER_PORT: value })).toThrow(
        /ALTEROID_RUNNER_PORT は 1〜65535 の整数/,
      );
    },
  );

  it('ソケットを置けばソケットで待ち受け、TCP の変数は読まない（不正なポートでも落ちない）', () => {
    expect(
      listenPlanOf({
        ALTEROID_RUNNER_SOCKET: '/run/alteroid/runner.sock',
        ALTEROID_RUNNER_SOCKET_UID: '1000',
        ALTEROID_RUNNER_SOCKET_GID: '1000',
        ALTEROID_RUNNER_PORT: 'abc',
      }),
    ).toEqual({
      kind: 'socket',
      path: '/run/alteroid/runner.sock',
      owner: { uid: 1000, gid: 1000 },
    });
  });

  it('ソケットの持ち主が不正なら、ソケットの口を組む時点で落ちる', () => {
    expect(() =>
      listenPlanOf({ ALTEROID_RUNNER_SOCKET: '/run/x.sock', ALTEROID_RUNNER_SOCKET_UID: 'abc' }),
    ).toThrow(/ALTEROID_RUNNER_SOCKET_UID/);
  });
});

describe('childUserOf（#3807）', () => {
  // runner 自身の UID は本物（process.getuid()）。降ろす先は、それと必ず食い違う値にする: 実行ユーザーに左右されないため。
  const OWN = process.getuid?.() ?? 0;
  const CHILD = OWN + 1000;

  it('未設定なら降ろさない', () => {
    expect(childUserOf({})).toBeUndefined();
    expect(childUserOf({ ALTEROID_RUNNER_CHILD_UID: '' })).toBeUndefined();
  });

  it('正しい値は通す。GID は UID に揃え、別々に置けばそのまま使う', () => {
    expect(childUserOf({ ALTEROID_RUNNER_CHILD_UID: String(CHILD) })).toEqual({
      uid: CHILD,
      gid: CHILD,
    });
    expect(
      childUserOf({
        ALTEROID_RUNNER_CHILD_UID: String(CHILD),
        ALTEROID_RUNNER_CHILD_GID: '2000',
        ALTEROID_RUNNER_CHILD_HOME: '/home/child',
      }),
    ).toEqual({ uid: CHILD, gid: 2000, home: '/home/child' });
  });

  it('runner 自身と同じ UID は、境界にならないので断る', () => {
    expect(() => childUserOf({ ALTEROID_RUNNER_CHILD_UID: String(OWN) })).toThrow(/自身の UID/);
  });

  it.each(['abc', '-1', '1.5', '0x10', '1e3'])('UID が非負の整数でない（%s）なら断る', (value) => {
    expect(() => childUserOf({ ALTEROID_RUNNER_CHILD_UID: value })).toThrow(
      /ALTEROID_RUNNER_CHILD_UID は非負の整数/,
    );
  });

  it.each(['abc', '-1', '1.5'])('GID が非負の整数でない（%s）なら断る', (value) => {
    expect(() =>
      childUserOf({ ALTEROID_RUNNER_CHILD_UID: String(CHILD), ALTEROID_RUNNER_CHILD_GID: value }),
    ).toThrow(/ALTEROID_RUNNER_CHILD_GID は非負の整数/);
  });
});

// 退役から3週間を過ぎたので、起動時の「もう読まない」の知らせは外す（#5805）。変数は今までどおり読まない
describe('退役した層の provider の変数（#5805）', () => {
  it('runner の起動は、退役した変数の知らせを出さない', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('retiredLayerProviderNotices');
    expect(source).not.toContain('reportRetiredLayerProviderEnv');
  });
});
