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
  // Issue #1851（`daemon start --force`）が使う2つ。`rename` は状態ファイルの
  // 退避、`stat` は退避先の名前が既に使われていないかの確認。
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
    // デーモンが SIGKILL やクラッシュで死に、daemon.json だけが残った状態。
    // その PID を OS が別のプロセスへ再利用している（= 生きているが別人、
    // または応答があった上での否定・接続拒否で「居ない」と確定できた）。
    const h = harness({ verify: async () => 'absent' });

    expect(await stopDaemon(h.deps)).toBe('stale');
    expect(h.killed).toEqual([]);
    expect(h.shutdownRequests).toBe(0);
    // 二度と同じ取り違えをしないよう、腐った記録は片付ける
    expect(h.cleared).toBe(1);
  });

  // ⭐ Issue #1818 の核 — 「確かめられなかった」（unknown）は「居ない」
  // （absent）ではない。以前は `stop()` が呼ぶ側で `boolean` へ畳んでいたため
  // ここが `absent` と区別できず、`clearInfo()` まで進んで状態ファイルを
  // 消していた——生きているかもしれない本物のデーモンの記録を、確かめられ
  // なかっただけで消してしまう形。`StopDeps.verify` が3値を返すようになった
  // 今は、`unknown` のときは PID にも状態ファイルにも触らない。
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
    // 本人確認済みなので SIGTERM 自体は許されるが、無限には送らない
    expect(h.killed.every((pid) => pid === INFO.pid)).toBe(true);
    expect(h.killed.length).toBeLessThanOrEqual(1);
  });

  // Issue #1818 — 停止要求後のループでも、`unknown`（確かめられなかった）を
  // 「止まった」（absent）へ畳まない。最初の確認だけ `present` を返して
  // 停止要求まで進ませ、以降はずっと `unknown` を返し続ける——本物のデーモンが
  // 生きているのか、既に止まったのかを一度も確定できない状況を模している。
  // ここで状態ファイルを片付けてしまうと、`unresponsive` の意味（応答が
  // 見えている・記録は生かしたまま）が壊れる。
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
  // `rm` の呼び出し履歴も前のテストから持ち越さない——下の
  // 「stop() — verify() の3値目」の describe が `rm` の呼び有無を見る
  // （Issue #1818）。実装（`async () => undefined`）は変えずに履歴だけ消す。
  vi.mocked(rm).mockClear();
  // Issue #1851（`daemon start --force`）— `rename` の履歴もクリアし、`stat`
  // は既定で「無い」（ENOENT）に戻す。個別のテストが必要なぶんだけ上書きする。
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

  // ⭐ Issue #1851 — `--force` の回復経路（状態ファイルの退避 → 起こし直し）は
  // 明示のフラグを付けたときだけ通る道であって、`chat` などが毎回通る
  // `ensureRunning()` からは絶対に踏まないこと。`rename` が一度も呼ばれて
  // いなければ、`quarantineRuntimeFile()`（`startWithRecovery` 専用）を
  // 経由していないと言える——`ensureRunning()` の中身のどこにも
  // `startWithRecovery` という名前が無いことは型のうえでも自明だが、ここでは
  // 実行時の副作用で固定する。
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
  // 【経緯・反転した期待値】 元の題は「verify() の3値化後も StopDeps.verify
  // （boolean）契約は変えない（#1765 段2の対象外）」で、下の1本は
  // 「unknown（確かめられなかった）は false 側へ畳まれ、stale として
  // 扱われる（従来どおり）」を期待値にしていた。当時の理由（`stop()` は
  // `stopDaemon` へ `verify` を `boolean` の契約で渡す。`unknown` を
  // `false` へ畳むのは、この PR より前からの `stopDaemon` の挙動と1文字も
  // 変えていない——`start()` 側の安全側の変更〔spawn しない〕とは別の対象
  // である）は、`false` 側が「居ないと確定できた」ときの `clearInfo()`
  // （状態ファイルの削除）と共有されていることを見落としていた。
  // `unknown` もこの経路を通って状態ファイルが消え、直後の
  // `ensureRunning()` が `absent`（`unknown` ではない）と読んで `start()`
  // の安全弁を素通りし、2本目の daemon を spawn してしまっていた
  // （Issue #1818。15回目の横断レビューで見つかった #1779 の見落とし、
  // 実害そのもの）。ここで期待値を反転する — `StopDeps.verify` は3値の
  // まま渡し、`unknown` は `stale` ではなく `unknown` を返し、状態ファイル
  // には触れない。
  it('unknown（確かめられなかった）は stale に畳まれず、状態ファイルにも触れない unknown を返す（Issue #1818 で修正）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network blip')));

    expect(await stop()).toBe('unknown');
    expect(rm).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ 疑い（#1765 の残課題。t8 の横断レビューで追加）——#1779 が
   * `start()`/`ensureRunning()` に足した「確かめられなければ2本目を
   * 起こさない」安全弁（`presence: 'unknown'` の分岐）は、`stop()` を
   * 経由すると素通りできる。
   *
   * `stop()` は `verify()` の `unknown` を `false` へ畳み、
   * `stopDaemon` の `clearInfo()`（`rm(runtimeFile())`）で状態ファイルを
   * 消してから `'stale'` を返す——本人確認できなかっただけで、本物の
   * デーモンが生きているかどうかは何も分かっていない。この直後に
   * `ensureRunning()`（`chat` などから毎回呼ばれる）が走ると、状態
   * ファイルは既に無いので `status()` は `presence: 'absent'` を返す
   * ——`'unknown'` ではない。`start()` の安全弁は `presence === 'unknown'`
   * のときだけ発動するので、`'absent'` はこの弁を素通りして spawn まで
   * 進む。**「確かめられなかった」が、状態ファイルを消したことで
   * 「居ないと確定した」にすり替わっている**——取れない軸を0の行として
   * 扱わない、という #1779 自身の設計原則が、`stop → ensureRunning` の
   * 経路では守られていない。
   *
   * fetch は一貫して同じ理由（ネットワークの不調）で失敗し続ける——
   * 本物のデーモンが実際にはまだ生きていて、単に応答が遅いだけの場合と
   * 区別できない状況を模している。
   *
   * 【Issue #1818 の修正後】 `stop()` はもう `unknown` を `stale` に
   * 畳まない——`clearInfo()`（`rm`）を呼ばず、`'unknown'` をそのまま返す。
   * だから状態ファイルは実際には消えない。ここでは「消えた後の世界」を
   * `readFile` のモックで模す代わりに、**状態ファイルが実際にそのまま
   * 残っている**という、修正後に正しい前提のまま `ensureRunning()` を
   * 呼ぶ——`readFile` は `INFO` を返し続け、`fetch` も同じ理由で失敗し
   * 続ける。この前提でも spawn されないことを確かめる（`start()` の
   * 安全弁が `presence: 'unknown'` を受け取って効くこと）。
   */
  it('⭐ stop() が unknown を確かめられないまま返した直後、ensureRunning() も確かめられないまま2本目を spawn しない（Issue #1818）', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(INFO));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(new Error('network blip（本物は生きているが応答が遅いだけ、を模す）')),
    );

    expect(await stop()).toBe('unknown');
    // 状態ファイルを消していない——`ensureRunning()` が読む前提そのもの。
    expect(rm).not.toHaveBeenCalled();

    await ensureRunning().catch(() => undefined);

    expect(
      spawn,
      '本人確認できていない（本物が生きているかもしれない）のに2本目を起こしていないか',
    ).not.toHaveBeenCalled();
  });
});

// Issue #1851（#1823 の帰結）— `verify()` がずっと unknown を返す状況では、
// `stop()` も `start()` も状態ファイルに触れず CLI からは回復できない。
// `alteroid daemon start --force` はそれを明示のフラグの下でだけ回復する。
// **既定の安全弁（`start()` / `ensureRunning()`）は1文字も変えていない** —
// 上の全 describe がそのことを既に固定している。ここで見るのは
// `startWithRecovery()` という**別の入口**の中身だけである。
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
    // 呼び順: (1) startWithRecovery 冒頭の status() → absent
    //         (2) start() 冒頭の status() → absent（同じくファイルが無い）
    //         (3) spawn 後のポーリング → 見つかる
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

  // ⭐ 本 Issue の核 — unknown のときだけ、状態ファイルを退避してから
  // 起こし直す。元のファイルは消えず（`rm` は呼ばれない）、別名で残る。
  it('⭐ unknown（確かめられなかった）なら状態ファイルを退避し、起こし直す。元のファイルは rm しない', async () => {
    // 呼び順: (1) startWithRecovery 冒頭の status() → unknown（fetch が失敗）
    //         (2) start() 冒頭の status() → absent（退避済みなので読めない）
    //         (3) spawn 後のポーリング → 新しい記録が見つかり本人確認できる
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
    // pid の生存表示そのものは下の describe が個別に見る——ここでは
    // `process.kill` の戻り値には触れず、実物のまま呼ばせる（無害:
    // signal 0 は存在確認だけで、実在しない pid 4242 に対しては ESRCH で
    // 例外になるだけである）。

    const outcome = await startWithRecovery();

    expect(outcome.kind).toBe('recovered');
    if (outcome.kind !== 'recovered') throw new Error('unreachable');
    expect(outcome.previousPid).toBe(INFO.pid);
    expect(outcome.quarantinedTo).toMatch(/daemon\.json\.stale-\d{4}-\d{2}-\d{2}T/);
    expect(outcome.quarantinedTo).not.toContain(':'); // ファイル名に使える形
    // 退避＝rename であって削除ではない。`rm`（clearInfo 側の消去）は呼ばない。
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rm).not.toHaveBeenCalled();
    const [renamedFrom, renamedTo] = vi.mocked(rename).mock.calls[0] ?? [];
    expect(renamedFrom).toBe('/home/test/.alteroid/state/daemon.json');
    expect(renamedTo).toBe(outcome.quarantinedTo);
    // 退避したあとは start() が absent 経路として1本だけ spawn する。
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
    // 最初の候補（サフィックス無し）だけ「既に在る」と応答し、2番目以降は無い。
    let calls = 0;
    vi.mocked(stat).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return {} as never; // 存在する
      throw enoent();
    });

    const outcome = await startWithRecovery();

    expect(outcome.kind).toBe('recovered');
    if (outcome.kind !== 'recovered') throw new Error('unreachable');
    // 衝突したので、素のタイムスタンプではなく `-1` 付きの名前に倒れている。
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
      // 表示だけ——止める（SIGTERM 等の実シグナル）呼び出しは無い。
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

// 記憶の置き場は、無認証の `/health` ではなく資格が要る `/status` から取る（#2869）。
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
