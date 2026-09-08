import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { RunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **`manager.ts` → `RunnerRegistry#noteManagerFailed` の配線を、振る舞いで固定する。**
 *
 * #712 の直しは2つの半分から出来ている。
 *
 * 1. 名簿（`RunnerRegistry`）が `noteManagerFailed` を持ち、直近の失敗を配置の
 *    点数の分母へ足し戻す —— `runner-placement.test.ts` が測っている
 * 2. `manager.ts` が、委譲が `failed` で落ちた**その瞬間**に、その器の
 *    `runnerId` でその口を実際に呼ぶ —— **ここを測る歯がこれまで無かった**
 *
 * **1だけでは輪は塞がらない。** `manager.ts` の `case 'closed'` から
 * `this.#runners.noteManagerFailed(record.job.runnerId)` の呼び出しを丸ごと
 * 消しても、`runner-placement.test.ts`（名簿を直接叩いて点数を測る）と
 * `apps/runner/src/health-managers-on-failure.test.ts`（`/health` の
 * `managers` が減ることを測る）はどちらも1文字も動かず緑のままである——
 * どちらも「配線された `noteManagerFailed` が実際に呼ばれたか」を見ていない。
 * **輪が戻ったことは点数からしか読めない**（`noteManagerFailed` の doc の
 * 逐語）ので、配線が抜けても誰も気づけない。この歯が塞ぐのはその穴である。
 *
 * ## 測ること（3本のうち2本）
 *
 * 1. ⭐ `failed` で落ちた委譲は、その器の `runnerId` で呼ばれる（本題）
 * 2. `done` で正常に終わった委譲では呼ばれない（「正当に速く終わった委譲」を
 *    器の不調として数えない）
 *
 * ## 3本目（`runnerId` が記録されていない委譲では呼ばれない）は書いていない
 *
 * **読んで確かめた。** `manager.ts` が `record.job.runnerId` に値を書く場所は
 * 2箇所しかない —— 新規の `start()` はレコードを組み立てるオブジェクトリテラル
 * の中で最初から `runnerId: runner.runnerId` を持たせており、`#resume()` は
 * `await runner.resume(...)` が例外を投げずに返った直後、他の何もawaitしない
 * 地点で同期的に `record.job.runnerId = runner.runnerId` を書く。**どちらの
 * 経路でも、`case 'closed'` を発火させうる生きたセッションが始まる前に
 * `runnerId` が確定している。** `runner.start()` / `runner.resume()` 自体が
 * 例外を投げた回はこの代入へ到達する前に呼び出し元（`start()` 本体、
 * `#restoreJobs` の try/catch）が直接処理し、`#onEvent` の `case 'closed'` を
 * 一度も通らない。
 *
 * 唯一 `runnerId` が空のまま `#records` に載る形（`#restoreJobs` が復元する、
 * `runnerId` を持たない古いジョブが、resume させる開いた runner を1台も
 * 見つけられなかった場合）はある（`manager-relocate.test.ts` の
 * 「`job.runnerId` が無い古いジョブは移送しない」と同じ土台）が、その場合は
 * `#resumeOnce` が一度も呼ばれず、生きたセッションも一度も立たないので、
 * その後どうやっても `closed` イベントがそのレコードへ届く経路が無い——
 * 届けるには `#onEvent` を直接呼ぶ以外に手が無く、それは private フィールド
 * （`class` の `#` 構文）なのでテストからは呼べない。**捏造した足場（無理に
 * 到達させるための書き換え）を用意すれば緑にはできるが、それは実際に起こる
 * 経路を測ることにならない**——このファイルでは見送った。
 */

/**
 * 合図があるまで1件も出さず、合図でどちらの終わり方にも倒せる偽 SDK。
 *
 * `health-managers-on-failure.test.ts` の `heldSdk` と同じ形（最初の `next()`
 * を保留したまま返し、セッションが立った状態を作ってから落とし方をこちらが
 * 握る）だが、あちらは `failNth` しか持たない。ここでは `finishNth` も足して
 * ある —— 保留していた `next()` の約束を `{ done: true }` で解決すると、
 * `runner.ts` の `#read()` の `for await` がエラーを経由せずに終わり、
 * `#recoverFromFailedResume` が `'not-a-resume-failure'` を返す既定の枝
 * （`#finish('done', …)`）へ倒れる —— これが `done` の作り方である。
 */
function controllableSdk(): {
  fn: typeof sdkQuery;
  /** 開いた順の n 番目を、エラーで落とす（→ closed.status: 'failed'）。 */
  failNth: (index: number, error: unknown) => void;
  /** 開いた順の n 番目を、正常に終わらせる（→ closed.status: 'done'）。 */
  finishNth: (index: number) => void;
} {
  const settlers: {
    resolve: (result: IteratorResult<never>) => void;
    reject: (error: unknown) => void;
  }[] = [];

  const fn = ((): Query => {
    let resolve!: (result: IteratorResult<never>) => void;
    let reject!: (error: unknown) => void;
    // **同じ promise を毎回返す。** 一度も resolve/reject しなければ `#read()`
    // は最初の1件を待ったまま止まる ＝ セッションは立ったままになる。
    const held = new Promise<IteratorResult<never>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    settlers.push({ resolve, reject });
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (): Promise<IteratorResult<never>> => held,
      return: (): Promise<IteratorResult<never>> =>
        Promise.resolve({ done: true, value: undefined }),
    };
    return Object.assign(stream, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  const settlerOf = (index: number) => {
    const settler = settlers[index];
    if (settler === undefined) throw new Error('その番号のセッションは開いていない');
    return settler;
  };

  return {
    fn,
    failNth: (index, error) => settlerOf(index).reject(error),
    finishNth: (index) => settlerOf(index).resolve({ done: true, value: undefined }),
  };
}

/**
 * `RunnerRegistry`（本物、`createRunnerRegistry()`）をそのまま包み、
 * `noteManagerFailed` の呼び出しだけを記録してから本物へ委譲する。
 *
 * **`{ ...real }` のスプレッドでは包めない。** `real` はクラスのインスタンス
 * で、メソッドはプロトタイプに在るためスプレッドではコピーされない（実測して
 * 確かめた——スプレッドした版は9メンバとも `undefined` になる）。だから9つの
 * メンバを名前で明示的に委譲するオブジェクトリテラルを書く。
 */
function watchNoteManagerFailed(real: RunnerRegistry): {
  registry: RunnerRegistry;
  /** `noteManagerFailed` が呼ばれた順の `runnerId`。 */
  noted: string[];
} {
  const noted: string[] = [];
  const registry: RunnerRegistry = {
    list: () => real.list(),
    get: (runnerId) => real.get(runnerId),
    select: (input) => real.select(input),
    register: (source) => real.register(source),
    unregister: (label) => real.unregister(label),
    vacate: (runnerId) => real.vacate(runnerId),
    noteManagerFailed: (runnerId) => {
      noted.push(runnerId);
      real.noteManagerFailed(runnerId);
    },
    entries: () => real.entries(),
    subscribe: (onOpen) => real.subscribe(onOpen),
    stop: () => real.stop(),
  };
  return { registry, noted };
}

const RUNNER_ID = 'runner-under-test';

function setup() {
  const sdk = controllableSdk();
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const real = createRunnerRegistry([
    createLocalRunner({
      runnerId: RUNNER_ID,
      workspacePath: '/work/project',
      queryFn: sdk.fn,
      env: { PATH: '/usr/bin' },
    }),
  ]);
  const { registry, noted } = watchNoteManagerFailed(real);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });
  return { pool, stores, sdk, noted, registry };
}

describe('manager.ts → RunnerRegistry#noteManagerFailed の配線（#712）', () => {
  it('failed で落ちた委譲は、その器の runnerId で noteManagerFailed が呼ばれる', async () => {
    const { pool, stores, sdk, noted, registry } = setup();
    const started = await pool.start({ request: '調べて' });

    sdk.failNth(0, new Error('合成した起動失敗（本物の資源枯渇は再現しない）'));

    // **呼ばれたこと自体を待つ。** 台帳の `status` 経由で間接的に確かめると、
    // 「配線を消した」変更が `status: 'failed'` の代入だけ生き残らせて緑に
    // なりうる——見たいのは `noteManagerFailed` が実際に呼ばれたかである。
    await vi.waitFor(() => {
      if (noted.length === 0) throw new Error('noteManagerFailed がまだ呼ばれていない');
    });

    // **渡された runnerId の値まで見る。** 呼ばれたことだけでは、無関係な
    // runnerId を渡して素通りさせる直しも緑になる。
    expect(noted).toEqual([RUNNER_ID]);

    // 前提の確認: 本当に `failed` の枝を通ったこと（`lost` や `done` ではない）。
    const job = (await stores.jobs.listJobs()).find((j) => j.id === started.managerId);
    expect(job?.status).toBe('failed');
    expect(job?.runnerId).toBe(RUNNER_ID);

    await pool.stop();
    await registry.stop();
  });

  it('done で正常に終わった委譲では呼ばれない（正当に速く終わった委譲を器の不調として数えない）', async () => {
    const { pool, stores, sdk, noted, registry } = setup();
    const started = await pool.start({ request: '調べて' });

    sdk.finishNth(0);

    // **`done` になったことを待ってから確かめる。** これで「まだ届いていない
    // だけ」を「呼ばれなかった」と取り違えない。
    const job = await vi.waitFor(async () => {
      const found = (await stores.jobs.listJobs()).find((j) => j.id === started.managerId);
      if (found?.status !== 'done') throw new Error('まだ closed(done) が届いていない');
      return found;
    });
    expect(job.runnerId).toBe(RUNNER_ID);

    expect(noted).toEqual([]);

    await pool.stop();
    await registry.stop();
  });
});
