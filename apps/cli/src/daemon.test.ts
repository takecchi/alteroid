import { createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `verify()`（本人確認）が `status()` → `start()` に3値（居る／居ない／確かめ
// られなかった）を伝えることを、実際の `fetch` / ファイル読み書きを差し替えて
// 確かめる（#1765 段2）。`stopDaemon` の既存のテスト（下の
// describe('alteroid daemon stop')）は `StopDeps` の DI だけで完結しており、
// これらのモジュールモックには触れない。
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ openSync: vi.fn(() => 1) }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock('./paths.js', () => ({
  stateDir: () => '/home/test/.alteroid/state',
  alteroidRoot: () => '/home/test/.alteroid',
}));

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import {
  ensureRunning,
  start,
  status,
  stop,
  stopDaemon,
  type DaemonRuntimeInfo,
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
    verify: async () => true,
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
    let alive = true;
    const h = harness({
      verify: async () => alive,
      async requestShutdown() {
        alive = false;
      },
    });

    expect(await stopDaemon(h.deps)).toBe('stopped');
    expect(h.killed).toEqual([]);
    expect(h.cleared).toBe(1);
  });

  it('本人確認できない PID には絶対にシグナルを送らない（PID 再利用で無関係なプロセスを殺さない）', async () => {
    // デーモンが SIGKILL やクラッシュで死に、daemon.json だけが残った状態。
    // その PID を OS が別のプロセスへ再利用している（= 生きているが別人）。
    const h = harness({ verify: async () => false });

    expect(await stopDaemon(h.deps)).toBe('stale');
    expect(h.killed).toEqual([]);
    expect(h.shutdownRequests).toBe(0);
    // 二度と同じ取り違えをしないよう、腐った記録は片付ける
    expect(h.cleared).toBe(1);
  });

  it('停止要求が失敗しても、本人確認済みならシグナルで押せる', async () => {
    let alive = true;
    const h = harness({
      verify: async () => alive,
      requestShutdown: async () => {
        throw new Error('接続できない');
      },
      terminate(pid) {
        expect(pid).toBe(INFO.pid);
        alive = false;
      },
    });

    expect(await stopDaemon(h.deps)).toBe('stopped');
  });

  it('応答し続けて止まらないなら unresponsive を返す（黙って殺し続けない）', async () => {
    const h = harness({ verify: async () => true });

    expect(await stopDaemon(h.deps)).toBe('unresponsive');
    // 本人確認済みなので SIGTERM 自体は許されるが、無限には送らない
    expect(h.killed.every((pid) => pid === INFO.pid)).toBe(true);
    expect(h.killed.length).toBeLessThanOrEqual(1);
  });
});

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

/**
 * `fetch`（undici）が接続拒否のとき実際に投げる形（実測: Node 22.23.3 —
 * 閉じたポートへ本物の `fetch` を打って確認した。`TypeError: fetch failed`
 * の `cause` に `code: 'ECONNREFUSED'` を持つ素の `Error` が載る）。モックで
 * 高速に境界を確かめるための合成値——実物との突き合わせは下の
 * 「本物の閉じたポート」テストが別に持つ。
 */
function connectionRefusedError(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
    }),
  });
}

/**
 * OS に一時的にポートを割り当てさせ、直後に close する——**割り当てられた
 * 瞬間から誰も listen していないことが確定している**ポート番号を得る
 * （小さな競合の窓はあるが、テストでは十分安定する標準的な手法）。
 */
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

  // ⭐ #1765 段2 の核 — 例外を「居ない」ではなく「確かめられなかった」にする
  it('⭐ fetch が例外を投げたら absent ではなく unknown（居ないと確定していない）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    expect((await status()).presence).toBe('unknown');
  });

  // ⭐ #1765 段2 の核 — `AbortSignal.timeout(1500)` によるタイムアウトも
  // 同じく unknown（`fetch` の実装が投げる形を model 化: DOMException /
  // TimeoutError）。
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

  // ⭐ #1765 の回帰修正 — デーモンが異常終了して状態ファイルだけが残った
  // ケース。そのポートには誰も listen していないので「居ないと確定できる」
  // ——これを unknown のままにすると、下の describe('start()') が固定する
  // とおり `start()` が永久に spawn を拒むようになっていた。
  it('⭐ 接続拒否（ECONNREFUSED）は unknown ではなく absent（#1765 の回帰修正）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionRefusedError()));

    expect((await status()).presence).toBe('absent');
  });

  // 分類の境界 — 接続拒否と紛らわしい形でも `cause.code` が
  // `ECONNREFUSED` でなければ unknown のまま（例: 相手はいたが接続を
  // 切られた `ECONNRESET`。「居ない」と「拒まれた」は別の情報である）。
  it('分類の境界: cause.code が ECONNREFUSED 以外（例: ECONNRESET）なら unknown', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    const notRefused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(notRefused));

    expect((await status()).presence).toBe('unknown');
  });

  // 分類の境界 — `cause` が `Error` ではない（`code` を持ちようがない）
  // 形でも unknown。`instanceof Error` の防御が無いと、`cause` が文字列や
  // オブジェクトのときに `(cause as any).code` が例外なく `undefined` と
  // 評価されて判定は結局 false になるが、**その前提を歯として固定する**。
  it('分類の境界: cause が Error ではない値なら unknown', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    const weird = Object.assign(new TypeError('fetch failed'), { cause: 'not an error object' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(weird));

    expect((await status()).presence).toBe('unknown');
  });

  // ⭐⭐ モックだけに頼らない——実際に閉じている TCP ポートへ本物の fetch を
  // 打ち、Node/undici が実際にどう例外を投げるかで固定する
  // （`connectionRefusedError()` が合成した形が現物と一致しているかの検算）。
  it('⭐⭐ 本物の閉じたポートへ fetch すると absent になる（モックではなく実物の Node/undici の挙動で固定）', async () => {
    const closedPort = await findClosedPort();
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...INFO, port: closedPort }));
    // fetch は stub しない — 実物の fetch が実物の閉じたポートへ繋ぎに行く

    expect((await status()).presence).toBe('absent');
  });
});

describe('start() — 確かめられなかったときは2本目のデーモンを起こさない（#1765 段2）', () => {
  it('present（既に本人が居る）なら spawn せずそのまま返す', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    await expect(start()).resolves.toEqual(INFO);
    expect(spawn).not.toHaveBeenCalled();
  });

  // ⭐ 本 Issue の実害そのもの — 従来は verify() の例外/タイムアウトが
  // `false`（居ない）に畳まれ、start() が既に生きているデーモンに対して
  // 2本目を spawn しうった。ここではそれが起きないことを歯にする。
  it('⭐ unknown（確かめられなかった）なら spawn せず、理由付きで拒否する（安全側）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));

    await expect(start()).rejects.toThrow(/確かめられませんでした/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('absent（記録が無い）なら spawn し、起動後に present になれば info を返す', async () => {
    vi.mocked(readFile)
      .mockRejectedValueOnce(enoent()) // start() 冒頭の status()
      .mockResolvedValue(JSON.stringify(INFO)); // spawn 後のポーリングでは見つかる
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ operator: true }) }),
    );

    await expect(start()).resolves.toEqual(INFO);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  // ⭐⭐ #1765 の回帰そのもの — デーモンが異常終了して状態ファイルだけが
  // 残ったケース。この修正の前は verify() の全例外（接続拒否を含む）が
  // unknown に畳まれ、start() が「確かめられなかった」として spawn を
  // 拒み続けていた——状態ファイルを手で消すまで二度と alteroidd を
  // 起こせなくなる回帰だった（`chat` のたびに `ensureRunning()` を通るので、
  // クラッシュのたびに CLI が使えなくなる形で表に出る）。
  it('⭐⭐ 接続拒否（モック）なら absent——start() は2本目として spawn に進む（#1765 の回帰修正）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectionRefusedError()));

    // 起動後のポーリングでも同じ理由で拒否され続ける（新しいデーモンは
    // 実際には上がらない）ので、ここで見るのは「spawn まで進んだか」で
    // あって「起動を確認できたか」ではない。
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
});

describe('stop() — verify() の3値化後も StopDeps.verify（boolean）契約は変えない（#1765 段2の対象外）', () => {
  // `stop()` は `stopDaemon` へ `verify` を `boolean` の契約で渡す。`unknown`
  // を `false` へ畳むのは、この PR より前からの `stopDaemon` の挙動と1文字も
  // 変えていない——`start()` 側の安全側の変更（spawn しない）とは別の対象
  // である（`daemon.ts` の `stop()` 冒頭のコメントを見よ）。
  it('unknown（確かめられなかった）は false 側へ畳まれ、stale として扱われる（従来どおり）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));

    expect(await stop()).toBe('stale');
  });
});
