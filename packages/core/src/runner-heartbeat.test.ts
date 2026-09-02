import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

/**
 * runner の生存判定（roadmap M5）。
 *
 * ここで固定したいのは、**黙って死んだ器を名簿が自分で見つけられる**ことである。
 * SSE の `hello` は器が礼儀正しく落ちたときにしか届かない — 電源が抜けた器も、
 * ネットワークだけが切れた器も、ストリームは開いたまま何も言わなくなる。
 * その沈黙を拾うのがこの層で、`hello` の**置き換えではなく補完**である。
 *
 * **時計は手で進める。** 実時間を待つ形にすると、判定の猶予（30秒）を確かめる
 * テストがそのまま 30秒かかり、CI が遅く・不安定になる。
 */

/** 偽 runner。**`/health` の応え方だけを外から決められる**（他は名簿が触らない）。 */
class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  /**
   * **既定は `true`（既存テストの前提を変えない）。** `false` に差し替えると
   * 「`/health` から一度も `runnerId` を受け取れていない」状態を再現できる
   * （#330 の歯のために足した）。
   */
  runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  /** `/health` を叩かれた回数。名乗りが本当に飛んでいるかを見る。 */
  pings = 0;
  /** `'ok'` = 応える / `'error'` = 即座にこける / `'hang'` = 黙ったまま返さない。 */
  reply: 'ok' | 'error' | 'hang' = 'ok';
  closed = false;
  /**
   * `list()`（`GET /managers`。#579 で生存確認からも叩かれるようになった口）の
   * 応え方。**`reply` とは独立**——`/health` は答えるが `/managers` だけ黙る、
   * という組み合わせを再現できないと「生死の材料にしない」ことを確かめられない。
   * `'ok'` = `sessionsToReturn` を返す / `'error'` = 即座にこける /
   * `'hang'` = 黙ったまま返さない。
   */
  listReply: 'ok' | 'error' | 'hang' = 'ok';
  /** `listReply === 'ok'` のとき `list()` が返す managerId の一覧。 */
  sessionsToReturn: string[] = [];
  /** `list()` を叩かれた回数。 */
  listCalls = 0;
  /** 直近の `list()` 呼び出しへ渡された `signal`（期限で中断されるかを見る）。 */
  lastListSignal: AbortSignal | undefined;

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  async ping(): Promise<void> {
    this.pings += 1;
    if (this.reply === 'ok') return;
    if (this.reply === 'error') throw new Error('fetch failed');
    // **黙って死んだ器。** 繋がってはいるが、いつまでも返事が返らない。
    await new Promise<never>(() => undefined);
  }

  // ここから下は名簿が触らない口。**生死判定の材料にしない**ので空でよい。
  async connect(): Promise<void> {}
  async start(): Promise<void> {}
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(options?: { signal?: AbortSignal }): Promise<RunnerManagerState[]> {
    this.listCalls += 1;
    this.lastListSignal = options?.signal;
    if (this.listReply === 'error') throw new Error('managers fetch failed');
    if (this.listReply === 'hang') {
      // **黙って死んだ器と同じ形。** `/health` とは別に、この口だけが黙る。
      await new Promise<never>(() => undefined);
    }
    return this.sessionsToReturn.map((managerId) => ({
      managerId,
      status: 'running',
      cwd: '/work/project',
      request: '',
      waiting: [],
    }));
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runner の生存判定', () => {
  it('10秒ごとに /health を叩き、30秒応答が無ければ onLost が1回だけ出る', async () => {
    const lost: { label: string; runnerId?: string }[] = [];
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    // 名乗りは10秒ごと。**1回の取りこぼしでは落とさない**（瞬きで宛先を失わない）。
    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.pings).toBe(1);
    expect(lost).toEqual([]);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toEqual([]);

    // 3回分＝30秒。ここで初めて「落ちた」と判定する。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toMatchObject([{ label: 'http://runner:4518', runnerId: 'runner-a' }]);
    expect(registry.entries()).toMatchObject([{ state: 'lost' }]);

    // **何度も出さない。** 落ちたことは1度の出来事であって、状態は `entries()` で見る。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lost).toHaveLength(1);
    // 黙り続けている理由は窓に出したまま（`GET /runners` から見える）。
    expect(registry.entries()[0]?.error).toContain('fetch failed');

    await registry.stop();
  });

  /**
   * **#330 の罠そのもの。** `runnerId` は常に文字列を持つ（`HttpRunner` の既定値
   * `'runner-primary'`）ので、`entry.client !== null` だけを根拠に出すと、
   * `/health` から一度も `runnerId` を受け取れていない相手についても「受け取った
   * 値」の顔で出てしまう。`runnerIdKnown: false` は、まさにその「聞けていない」
   * 状態を表す。
   */
  it('runnerId を聞けていない runner が黙っても、runnerId を出さない（#330）', async () => {
    const lost: { label: string; runnerId?: string }[] = [];
    const runner = new FakeRunner('runner-primary');
    runner.runnerIdKnown = false;
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);

    expect(lost).toMatchObject([{ label: 'http://runner:4518' }]);
    // **既定値 `'runner-primary'` が「聞けた値」の顔で出ていないことを名指しで見る。**
    expect(lost[0]).not.toHaveProperty('runnerId');

    await registry.stop();
  });

  /**
   * **黙って死んだ器は「拒否する」のではなく「何も返さない」。**
   *
   * 期限を置かずに待つと、返らない1台の後ろに全台が並び、1台の沈黙が名簿全体の
   * 生死判定を止める。名乗りは全台へ同時に投げ、1台ずつ期限で切る。
   */
  it('返らない1台が、他の1台の名乗りを止めない', async () => {
    const lost: { label: string }[] = [];
    const silent = new FakeRunner('runner-silent');
    const answering = new FakeRunner('runner-alive');
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: '沈黙する器', open: async () => silent });
    await registry.register({ label: '応える器', open: async () => answering });

    silent.reply = 'hang';

    // **同時に投げている証拠。** 順番待ちなら、返らない1台の後ろで2台目は
    // まだ叩かれていない。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(silent.pings).toBe(1);
    expect(answering.pings).toBe(1);

    // 沈黙は5秒で切り上げる。まだ「落ちた」ではない（30秒には足りない）。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toEqual([]);
    expect(registry.entries()).toMatchObject([
      { label: '沈黙する器', state: 'connected' },
      { label: '応える器', state: 'connected' },
    ]);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(lost).toMatchObject([{ label: '沈黙する器' }]);
    // 応える器は巻き添えにならない。名乗りも毎回届いている。
    expect(registry.entries()).toMatchObject([
      { label: '沈黙する器', state: 'lost' },
      { label: '応える器', state: 'connected' },
    ]);
    expect(answering.pings).toBe(4);

    await registry.stop();
  });

  /**
   * **戻ってきた器を宛先へ戻す。**
   *
   * 落ちたと判定したまま二度と使わない形にすると、器の再デプロイのたびに宛先が
   * 1台ずつ減る（回復を認めないのは能力の削除である）。同時に、遷移で持っている
   * ことの証明でもある — 経過時間の再計算だけなら、2度目の沈黙は観測できない。
   */
  it('黙った器が戻れば宛先に戻り、また黙れば改めて onLost が出る', async () => {
    const lost: { label: string }[] = [];
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lost).toHaveLength(1);
    expect(await registry.list()).toEqual([]);

    // 器が戻ってきた。**次の名乗りで宛先に戻る。**
    runner.reply = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);
    expect(registry.entries()[0]?.error).toBeUndefined();
    expect(await registry.list()).toHaveLength(1);

    // 2度目の沈黙も、ちゃんと1回の出来事として出る。
    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lost).toHaveLength(2);
    expect(registry.entries()).toMatchObject([{ state: 'lost' }]);

    await registry.stop();
  });

  /**
   * **対になる歯（#485 PR-2）。** 上の「黙った器が戻れば宛先に戻り」は `lost`
   * （`alive: false`）の回復である。`vacating` は「黙った」のではなく「空けると
   * 決めた」だけなので、`alive` は `true` のまま——heartbeat が何度成功しても
   * `#markSeen` の早期 return（`if (entry.alive) { …; return; }`）を通るだけで
   * `state` には触らない。
   *
   * **これは `Registry#vacate` の実装（`entry.alive` を触らない）が持つ約束の
   * 直接の検算である。** もし `vacate()` が `lost` と同じ形で `alive` を
   * `false` へ倒していたら、次の成功した heartbeat が「戻ってきた」と誤読し、
   * この歯は `state: 'connected'`（黙って踏み潰された `vacating`）を見て落ちる。
   */
  it('vacating な器は、heartbeat が何度成功しても connected へ黙って戻らない（#485 PR-2）', async () => {
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner:4518', open: async () => runner });
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);

    registry.vacate('runner-a');
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);

    // **器は生きたまま応え続ける。** `lost` と違い、名乗り自体は途切れない。
    runner.reply = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.pings).toBe(1);
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);

    // 何周しても同じ。**時間が経てば戻る、という性質のものではない。**
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);
    expect(await registry.list()).toEqual([]);

    await registry.stop();
  });

  /**
   * **もう一つの対になる歯（#485 PR-2 のレビューで見つかった穴）。**
   *
   * 上の歯が固定したのは「heartbeat が途切れずに成功し続ける」経路である。
   * だが `vacate()` は `alive` を触らないため、`#markSilent`（黙った判定）の
   * 側は素通しになる——`entry.alive` が `true` のままなので
   * `if (!entry.alive) return;` を通り抜け、30秒（`HEARTBEAT_LOST_MS`）
   * 途切れると `state` が `'vacating'` から `'lost'` へ**上書き**され、
   * `alive` が `false` になる。
   *
   * その後器が戻ると、今度は `#markSeen` の `if (entry.alive)` が偽になって
   * いるので早期 return を通らず、「黙っていた器が戻ってきた」の分岐
   * （`entry.alive = true; entry.state = 'connected';`）を踏む——**空けると
   * 決めた宛先が、黙って置き先に戻る。** #485 が塞ごうとしている形そのもの
   * （運用者が「空けた、あとは消すだけ」と思っている器へ新しい委譲が入る）で、
   * Railway の再デプロイ中に普通に起きる長さの断（30秒）で踏む。
   */
  it('vacating な器は、30秒以上の断のあと復帰しても connected へ黙って戻らない（#485 PR-2）', async () => {
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    registry.vacate('runner-a');
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);

    // **30秒以上の断。** `#markSilent` が黙った判定をする猶予そのもの。
    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);
    // **黙っている間、`vacating` のままであってよい。** `lost` へ上書きされて
    // いても `list()` からは変わらず外れる（`lost` も `vacating` も並ばない）
    // ので、この時点ではまだ症状が見えない——次の「戻った」でだけ症状が出る。

    // 器が戻ってきた。
    runner.reply = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);

    // **⚠️ ここが本体。** 空けると決めた宛先が、黙って `connected`（置き先）へ
    // 戻ってはいけない。
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);
    expect(await registry.list()).toEqual([]);

    await registry.stop();
  });

  /**
   * **落ちたと判定した器へ新しい委譲を置かない。**
   *
   * 名簿からは消さない（人間には見えている必要がある）が、置き先としては数えない。
   * 沈黙へ投げ込むのは「黙って引き下がる」の裏返しである。
   */
  it('落ちた runner は新しい委譲の宛先から外れる（名簿には残る）', async () => {
    const runner = new FakeRunner('runner-a');
    // 猶予を使わずに答えさせる（ここで見たいのは宛先に選ばれるかどうかだけ）。
    const registry = createRunnerRegistry([], { selectWaitMs: 0 });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    expect((await registry.select({})).runnerId).toBe('runner-a');

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);

    // **状態を添えて失敗する。** 「宛先が居ない」ことを隠さない。
    await expect(registry.select({})).rejects.toThrow(/http:\/\/runner:4518 は lost/);
    expect(await registry.list()).toEqual([]);
    // それでも名簿には残る（`GET /runners` の材料）。
    expect(registry.entries()).toMatchObject([{ label: 'http://runner:4518', state: 'lost' }]);

    await registry.stop();
  });

  it('stop() で名乗りを聞くのをやめる', async () => {
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.pings).toBe(1);

    await registry.stop();
    // 畳み残すと、止めたはずの名簿が背景で runner を叩き続ける。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.pings).toBe(1);
  });
});

/**
 * runner が抱えているセッションの観測（#579。`GET /managers`）。
 *
 * これは生死判定（上の `describe`）とは別の口である。**目的も別**——生死は
 * 「宛先が答えるか」を見るだけだが、こちらは「答えた宛先が、いまどの委譲を
 * 持っているか」を見る。10秒ごとの `#beat` が名乗り（`/health`）を確かめた
 * *後で*この口も引くので、`entries()` に `sessions` / `sessionsObservedAt` が
 * 載る（`manager.ts` の `Pool#noteMissingSessions` がこれを読んで
 * `sessionMissingSince` を立てる——そちらの歯は `manager.test.ts` に在る）。
 *
 * **`list()` が投げても生死は倒れない。** `/managers` だけが詰まった器から
 * 仕事を取り上げないことを、ここで直接固定する。
 */
describe('runner が抱えているセッションの観測（#579）', () => {
  it('10秒ごとの beat が list() も叩き、entries() に sessions と sessionsObservedAt が載る（観測時刻は beat の時刻）', async () => {
    vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
    const runner = new FakeRunner('runner-a');
    runner.sessionsToReturn = ['mgr-1', 'mgr-2'];
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runner.listCalls).toBe(1);
    expect(registry.entries()).toMatchObject([
      {
        sessions: ['mgr-1', 'mgr-2'],
        // **観測時刻は beat の時刻である。** 応答が返った時刻ではない
        // （`Registry#probeSessions` の doc）。
        sessionsObservedAt: '2026-08-27T09:00:10.000Z',
      },
    ]);

    await registry.stop();
  });

  it('list() が投げても生死を倒さない（state は connected のままで onLost も出ない）', async () => {
    const lost: { label: string }[] = [];
    const runner = new FakeRunner('runner-a');
    runner.listReply = 'error';
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    // 生死判定の猶予（30秒）を大きく超えても、/health は答え続けている限り倒れない。
    await vi.advanceTimersByTimeAsync(60_000);

    expect(lost).toEqual([]);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);
    // 聞けなかっただけで、聞きに行くのはやめていない。
    expect(runner.listCalls).toBeGreaterThan(0);

    await registry.stop();
  });

  it('list() が投げた回は前の観測を消さない（1周目の sessions が2周目の失敗後も同じ値のまま残る）', async () => {
    const runner = new FakeRunner('runner-a');
    runner.sessionsToReturn = ['mgr-1'];
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    // 1周目: 答える。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()).toMatchObject([{ sessions: ['mgr-1'] }]);
    const firstObservedAt = registry.entries()[0]?.sessionsObservedAt;
    expect(firstObservedAt).toBeDefined();

    // 2周目: 投げる。**それでも前の観測を消さない。**
    runner.listReply = 'error';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registry.entries()).toMatchObject([
      // `undefined` へ戻っていない——値も観測時刻も1周目のまま。
      { sessions: ['mgr-1'], sessionsObservedAt: firstObservedAt },
    ]);

    await registry.stop();
  });

  it('一度も list() が答えていない間は sessions が undefined（空配列で埋めない）', async () => {
    const runner = new FakeRunner('runner-a');
    runner.listReply = 'error';
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    // 登録直後（heartbeat がまだ1周もしていない）。
    expect(registry.entries()[0]).not.toHaveProperty('sessions');
    expect(registry.entries()[0]).not.toHaveProperty('sessionsObservedAt');

    // 1周目も投げる。**「聞けなかった」を「1本も無かった」（空配列）に化けさせない。**
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()[0]).not.toHaveProperty('sessions');
    expect(registry.entries()[0]).not.toHaveProperty('sessionsObservedAt');

    await registry.stop();
  });

  it('list() が返らないとき、5秒（HEARTBEAT_PROBE_MS）で signal を中断し、次の周でまた list() が呼ばれる（錠が外れている）', async () => {
    const runner = new FakeRunner('runner-a');
    runner.listReply = 'hang';
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.listCalls).toBe(1);
    const firstSignal = runner.lastListSignal;
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    // 期限（5秒）に達するまでは、まだ中断していない。
    await vi.advanceTimersByTimeAsync(4_000);
    expect(firstSignal?.aborted).toBe(false);

    // 期限を過ぎた。**渡した signal が中断される。**
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstSignal?.aborted).toBe(true);

    // 中断で `sessionsProbing` の錠が外れている——次の10秒境界でまた聞きに行く。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner.listCalls).toBe(2);

    await registry.stop();
  });
});
