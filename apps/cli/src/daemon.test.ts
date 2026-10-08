import { createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ openSync: vi.fn(() => 1) }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  stat: vi.fn(async () => {
    throw enoent();
  }),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock('./paths.js', () => ({
  stateDir: () => '/home/test/.alteroid/state',
  alteroidRoot: () => '/home/test/.alteroid',
}));

import { spawn } from 'node:child_process';
import { readFile, rename, rm, stat } from 'node:fs/promises';

import {
  ensureRunning,
  start,
  startWithRecovery,
  sessionRefusalOf,
  status,
  stop,
  storageOf,
  stopDaemon,
  type DaemonRuntimeInfo,
  type Presence,
  type StopDeps,
} from './daemon.js';

const INFO: DaemonRuntimeInfo = {
  pid: 4242,
  port: 4517,
  startedAt: '2026-08-12T00:00:00.000Z',
  token: 'token-of-the-real-daemon',
};

interface Harness {
  deps: StopDeps;
  killed: number[];
  shutdownRequests: number;
  cleared: number;
}

function harness(overrides: Partial<StopDeps> = {}): Harness {
  const state = { killed: [] as number[], shutdownRequests: 0, cleared: 0 };

  const deps: StopDeps = {
    readInfo: async () => INFO,
    verify: async () => 'present',
    async requestShutdown() {
      state.shutdownRequests += 1;
    },
    terminate(pid) {
      state.killed.push(pid);
    },
    async clearInfo() {
      state.cleared += 1;
    },
    wait: async () => undefined,
    ...overrides,
  };

  return {
    deps,
    get killed() {
      return state.killed;
    },
    get shutdownRequests() {
      return state.shutdownRequests;
    },
    get cleared() {
      return state.cleared;
    },
  };
}

describe('alteroid daemon stop', () => {
  it('状態ファイルが無ければ何もしない', async () => {
    const h = harness({ readInfo: async () => null });

    expect(await stopDaemon(h.deps)).toBe('not-running');
    expect(h.killed).toEqual([]);
  });

  it('本人確認できたら停止を要求し、居なくなったら記録を片付ける', async () => {
    let presence: Presence = 'present';
    const h = harness({
      verify: async () => presence,
      async requestShutdown() {
        presence = 'absent';
      },
    });

    expect(await stopDaemon(h.deps)).toBe('stopped');
    expect(h.killed).toEqual([]);
    expect(h.cleared).toBe(1);
  });

  it('本人確認できない PID には絶対にシグナルを送らない（PID 再利用で無関係なプロセスを殺さない）', async () => {
    const h = harness({ verify: async () => 'absent' });

    expect(await stopDaemon(h.deps)).toBe('stale');
    expect(h.killed).toEqual([]);
    expect(h.shutdownRequests).toBe(0);
    expect(h.cleared).toBe(1);
  });

  it('⭐ 本人確認できなかったら（unknown）、PID にも状態ファイルにも触らず unknown を返す（Issue #1818）', async () => {
    const h = harness({ verify: async () => 'unknown' });

    expect(await stopDaemon(h.deps)).toBe('unknown');
    expect(h.killed).toEqual([]);
    expect(h.shutdownRequests).toBe(0);
    expect(h.cleared).toBe(0);
  });

  it('停止要求が失敗しても、本人確認済みならシグナルで押せる', async () => {
    let presence: Presence = 'present';
    const h = harness({
      verify: async () => presence,
      requestShutdown: async () => {
        throw new Error('接続できない');
      },
      terminate(pid) {
        expect(pid).toBe(INFO.pid);
        presence = 'absent';
      },
    });

    expect(await stopDaemon(h.deps)).toBe('stopped');
  });

  it('応答し続けて止まらないなら unresponsive を返す（黙って殺し続けない）', async () => {
    const h = harness({ verify: async () => 'present' });

    expect(await stopDaemon(h.deps)).toBe('unresponsive');
    expect(h.killed.every((pid) => pid === INFO.pid)).toBe(true);
    expect(h.killed.length).toBeLessThanOrEqual(1);
  });

  it('⭐ 停止要求後、ずっと unknown のままでも状態ファイルは片付けない（Issue #1818）', async () => {
    let calls = 0;
    const h = harness({
      verify: async () => {
        calls += 1;
        return calls === 1 ? 'present' : 'unknown';
      },
    });

    expect(await stopDaemon(h.deps)).toBe('unresponsive');
    expect(h.cleared).toBe(0);
    expect(h.killed.length).toBeLessThanOrEqual(1);
  });
});

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

function connectionRefusedError(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
    }),
  });
}

async function findClosedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else if (port === undefined) reject(new Error('OS がポートを割り当てなかった'));
        else resolve(port);
      });
    });
  });
}

beforeEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(spawn)
    .mockReset()
    .mockReturnValue({ unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
  vi.mocked(rm).mockClear();
  vi.mocked(rename).mockClear();
  vi.mocked(stat)
    .mockReset()
    .mockImplementation(async () => {
      throw enoent();
    });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verify（本人確認）と status() — 3値目「確かめられなかった」（#1765 段2）', () => {
  it('状態ファイルが無ければ absent（居ない）', async () => {
    vi.mocked(readFile).mockRejectedValue(enoent());

    expect(await status()).toEqual({ presence: 'absent', info: null });
  });

  it('応答があり operator: true なら present（居る）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    expect(await status()).toEqual({ presence: 'present', info: INFO });
  });

  it('応答はあるが operator ではない（本人ではないと確定できる）なら absent', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: false }) }),
    );

    expect((await status()).presence).toBe('absent');
  });

  it('応答が !ok（401等。応答があった上での否定）でも absent', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    expect((await status()).presence).toBe('absent');
  });

  it('⭐ fetch が例外を投げたら absent ではなく unknown（居ないと確定していない）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    expect((await status()).presence).toBe('unknown');
  });

  it('⭐ 1.5秒タイムアウト相当の例外も absent ではなく unknown', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('signal timed out', 'TimeoutError')),
    );

    expect((await status()).presence).toBe('unknown');
  });

  it('応答の JSON が壊れていて読めなくても unknown（居ないと確定できていない）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    );

    expect((await status()).presence).toBe('unknown');
  });

  it('⭐ 接続拒否（ECONNREFUSED）は unknown ではなく absent（#1765 の回帰修正）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionRefusedError()));

    expect((await status()).presence).toBe('absent');
  });

  it('分類の境界: cause.code が ECONNREFUSED 以外（例: ECONNRESET）なら unknown', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    const notRefused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(notRefused));

    expect((await status()).presence).toBe('unknown');
  });

  it('分類の境界: cause が Error ではない値なら unknown', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    const weird = Object.assign(new TypeError('fetch failed'), { cause: 'not an error object' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(weird));

    expect((await status()).presence).toBe('unknown');
  });

  it('⭐⭐ 本物の閉じたポートへ fetch すると absent になる（モックではなく実物の Node/undici の挙動で固定）', async () => {
    const closedPort = await findClosedPort();
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...INFO, port: closedPort }));

    expect((await status()).presence).toBe('absent');
  });
});

describe('start() — 確かめられなかったときは2本目のデーモンを起こさない（#1765 段2）', () => {
  it('⭐ present（既に本人が居る）なら spawn せず、already-present として返す（Issue #4081）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    await expect(start()).resolves.toEqual({ kind: 'already-present', info: INFO });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('⭐ unknown（確かめられなかった）なら spawn せず、理由付きで拒否する（安全側）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));

    await expect(start()).rejects.toThrow(/確かめられませんでした/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('absent（記録が無い）なら spawn し、起動後に present になれば started として info を返す', async () => {
    vi.mocked(readFile)
      .mockRejectedValueOnce(enoent())
      // spawn 後のポーリングでは見つかる
      .mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    await expect(start()).resolves.toEqual({ kind: 'started', info: INFO });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('ensureRunning() は start() の結果の info だけを返す（種別を漏らさない）', async () => {
    vi.mocked(readFile)
      .mockRejectedValueOnce(enoent())
      .mockRejectedValueOnce(enoent())
      .mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    await expect(ensureRunning()).resolves.toEqual(INFO);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('⭐⭐ 接続拒否（モック）なら absent——start() は2本目として spawn に進む（#1765 の回帰修正）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionRefusedError()));

    await expect(start()).rejects.toThrow(/デーモンの起動を確認できませんでした/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('⭐⭐ 接続拒否（本物の閉じたポート）でも同じく spawn に進む（モックではなく実物の挙動で固定）', async () => {
    const closedPort = await findClosedPort();
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...INFO, port: closedPort }));

    await expect(start()).rejects.toThrow(/デーモンの起動を確認できませんでした/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('ensureRunning() — start() の安全側の判断をそのまま伝える（#1765 段2）', () => {
  it('unknown のときは spawn せず、start() と同じ理由で拒否する', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    await expect(ensureRunning()).rejects.toThrow(/確かめられませんでした/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('⭐ unknown のとき、状態ファイルの退避（rename）にも一切触れない — 回復経路を通らない（Issue #1851）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    await expect(ensureRunning()).rejects.toThrow(/確かめられませんでした/);
    expect(
      rename,
      'ensureRunning() は startWithRecovery() の退避処理を呼んではいけない',
    ).not.toHaveBeenCalled();
  });
});

describe('stop() — verify() の3値目（unknown）を、状態ファイルを消さずにそのまま伝える（Issue #1818）', () => {
  it('unknown（確かめられなかった）は stale に畳まれず、状態ファイルにも触れない unknown を返す（Issue #1818 で修正）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));

    expect(await stop()).toBe('unknown');
    expect(rm).not.toHaveBeenCalled();
  });

  it('⭐ stop() が unknown を確かめられないまま返した直後、ensureRunning() も確かめられないまま2本目を spawn しない（Issue #1818）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(new Error('network blip（本物は生きているが応答が遅いだけ、を模す）')),
    );

    expect(await stop()).toBe('unknown');
    expect(rm).not.toHaveBeenCalled();

    await ensureRunning().catch(() => undefined);

    expect(
      spawn,
      '本人確認できていない（本物が生きているかもしれない）のに2本目を起こしていないか',
    ).not.toHaveBeenCalled();
  });
});

describe('startWithRecovery() — --force の中身（Issue #1851）', () => {
  it('present（本人確認できた）なら退避しない・起こし直さない（二重起動しない）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    const outcome = await startWithRecovery();

    expect(outcome).toEqual({ kind: 'already-present', info: INFO });
    expect(rename).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('absent（居ないと確定）なら退避せず、今までどおりの経路（start()）で起こす', async () => {
    vi.mocked(readFile)
      .mockRejectedValueOnce(enoent())
      .mockRejectedValueOnce(enoent())
      .mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    const outcome = await startWithRecovery();

    expect(outcome).toEqual({ kind: 'started', info: INFO });
    expect(rename).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('⭐ unknown（確かめられなかった）なら状態ファイルを退避し、起こし直す。元のファイルは rm しない', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify(INFO))
      .mockRejectedValueOnce(enoent())
      .mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    const outcome = await startWithRecovery();

    expect(outcome.kind).toBe('recovered');
    if (outcome.kind !== 'recovered') throw new Error('unreachable');
    expect(outcome.previousPid).toBe(INFO.pid);
    expect(outcome.quarantinedTo).toMatch(/daemon\.json\.stale-\d{4}-\d{2}-\d{2}T/);
    expect(outcome.quarantinedTo).not.toContain(':');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rm).not.toHaveBeenCalled();
    const [renamedFrom, renamedTo] = vi.mocked(rename).mock.calls[0] ?? [];
    expect(renamedFrom).toBe('/home/test/.alteroid/state/daemon.json');
    expect(renamedTo).toBe(outcome.quarantinedTo);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('退避先の名前が既に在れば、上書きせず別の名前にする', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify(INFO))
      .mockRejectedValueOnce(enoent())
      .mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );
    let calls = 0;
    vi.mocked(stat).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return {} as never;
      throw enoent();
    });

    const outcome = await startWithRecovery();

    expect(outcome.kind).toBe('recovered');
    if (outcome.kind !== 'recovered') throw new Error('unreachable');
    expect(outcome.quarantinedTo).toMatch(/\.stale-.+-1$/);
    expect(rename).toHaveBeenCalledTimes(1);
    const [, renamedTo] = vi.mocked(rename).mock.calls[0] ?? [];
    expect(renamedTo).toBe(outcome.quarantinedTo);
  });

  describe('退避した記録の PID の生存表示（止めはしない。Issue #1851）', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('process.kill が例外を投げなければ「生きている」と表示する（止めない — terminate は呼ばない）', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify(INFO))
        .mockRejectedValueOnce(enoent())
        .mockResolvedValue(JSON.stringify(INFO));
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValueOnce(new Error('network blip'))
          .mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
      );
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

      const outcome = await startWithRecovery();

      expect(outcome.kind).toBe('recovered');
      if (outcome.kind !== 'recovered') throw new Error('unreachable');
      expect(outcome.previousPidAlive).toBe(true);
      expect(kill).toHaveBeenCalledWith(INFO.pid, 0);
      expect(kill).toHaveBeenCalledTimes(1);
    });

    it('process.kill が ESRCH を投げたら「居ない」と表示する', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify(INFO))
        .mockRejectedValueOnce(enoent())
        .mockResolvedValue(JSON.stringify(INFO));
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValueOnce(new Error('network blip'))
          .mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
      );
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });

      const outcome = await startWithRecovery();

      expect(outcome.kind).toBe('recovered');
      if (outcome.kind !== 'recovered') throw new Error('unreachable');
      expect(outcome.previousPidAlive).toBe(false);
    });

    it('process.kill が EPERM を投げたら（権限が無いだけで存在はする）「生きている」扱いにする', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify(INFO))
        .mockRejectedValueOnce(enoent())
        .mockResolvedValue(JSON.stringify(INFO));
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValueOnce(new Error('network blip'))
          .mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
      );
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });

      const outcome = await startWithRecovery();

      expect(outcome.kind).toBe('recovered');
      if (outcome.kind !== 'recovered') throw new Error('unreachable');
      expect(outcome.previousPidAlive).toBe(true);
    });
  });
});

describe('storageOf（記憶の置き場を /status から取る）', () => {
  it('状態ファイルのトークンを付けて GET /status を打ち、storage を返す', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ storage: 'PostgreSQL db:5432/app' }) });
    vi.stubGlobal('fetch', fetchMock);

    expect(await storageOf(INFO)).toBe('PostgreSQL db:5432/app');
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:4517/status');
    expect(init.headers.authorization).toBe('Bearer token-of-the-real-daemon');
  });

  it('資格が通らない（401）・古いデーモン（404）・例外・空の storage は null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await storageOf(INFO)).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await storageOf(INFO)).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storage: '' }) }),
    );
    expect(await storageOf(INFO)).toBeNull();
    expect(await storageOf(null)).toBeNull();
  });
});

describe('sessionRefusalOf（安全分類器に弾かれ続けている状況を /status から取る）', () => {
  const refusal = {
    streak: 2,
    category: 'cyber',
    since: '2026-10-08T00:00:00.000Z',
    sessionId: 's-1',
    autoReopen: 'enabled',
  };

  it('cloneSessionRefusal を読んで返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ storage: 'x', cloneSessionRefusal: refusal }),
      }),
    );
    expect(await sessionRefusalOf(INFO)).toEqual(refusal);
  });

  it('欄が無い・形が読めない・聞けない・資格が通らないときは null（作り物を返さない）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storage: 'x' }) }),
    );
    expect(await sessionRefusalOf(INFO)).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ cloneSessionRefusal: { ...refusal, autoReopen: 'weird' } }),
      }),
    );
    expect(await sessionRefusalOf(INFO)).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await sessionRefusalOf(INFO)).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await sessionRefusalOf(INFO)).toBeNull();
    expect(await sessionRefusalOf(null)).toBeNull();
  });
});
