import { afterEach, describe, expect, it, vi } from 'vitest';

import { HELD_FORCE_FOLD_AFTER_MS, HeldMessages } from './held-messages.js';
import { createManagerPool } from './manager.js';
import { FOLD_NOTICE_COMMANDS_MAX } from './manager-notices.js';
import { createProfileService } from './profile-service.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Job } from './schema.js';
import { StaleTokenFold } from './stale-token-fold.js';
import { createMemoryStores } from './testing.js';
import { WithheldReportsStore } from './withheld-reports-store.js';

/*
 * 段F（`Pool#foldStaleTokenBeforeDelivery`）を、純関数へ切り出す前に外から縛る試験。
 *
 * **この試験の期待値は「仕様を先に書いたもの」ではない。** 今の出力を `toMatchInlineSnapshot` で取り（`-u`）、目で読んで確かめたもので、
 * 動きを変えずに切り出すための「いまの振る舞い」の写しである。食い違いを見つけたらここを直すのではなく、先に本体を疑うこと。
 *
 * 協力者のうち `StaleTokenFold#fold` は `vi.spyOn(StaleTokenFold.prototype, 'fold')` で差し替え、渡る引数の全欄を見る。
 * 時計は注入（`now`）。実時間・実 I/O・固定の少ない tick での待ちは使わない（microtask の周回は `Promise.resolve()` を上限つきで流して数える）。
 */

const ID = 'mgr-fold-pin';
const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const HELD = HELD_FORCE_FOLD_AFTER_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

type FoldOptions = NonNullable<Parameters<StaleTokenFold['fold']>[3]>;
type FoldResult = Awaited<ReturnType<StaleTokenFold['fold']>>;

afterEach(() => {
  vi.restoreAllMocks();
});

interface Setup {
  /** 預かりの `heldAt`（先頭が `oldestHeldAt`） */
  held?: string[];
  /** 台帳の `usageStoppedAt`（あると起動時に `#usageStopped` の印が立つ） */
  usageStoppedAt?: string;
  /** 台帳の `workerLimitStopped`（枠の印を立てずに、使用量の起こし直しの経路へ入るため） */
  workerLimit?: boolean;
  pendingFoldNotice?: Job['pendingFoldNotice'];
  /** resume が「生きていた旧プロセスへ流した」と返す（指紋が一致した回の追いつかせ方が返事に出る） */
  reusedLiveSession?: boolean;
  awaitingSince?: string;
  /** `fold` の返り値（関数なら呼ばれた回の `options` と通し番号から作る） */
  fold?: FoldResult | ((options: FoldOptions, call: number) => FoldResult);
  /** `fold` が返る前に待つ（microtask の周回を数える試験で、返す瞬間を決める） */
  gate?: Promise<void>;
}

async function open(setup: Setup = {}) {
  vi.restoreAllMocks();
  const rec = {
    on: false,
    nowLogging: false,
    log: [] as string[],
    folds: [] as { options: FoldOptions }[],
    holds: [] as { message: string; reason: string; foldDueAt: number | undefined }[],
    dueCalls: [] as { oldestHeldAt: string | undefined; awaitingSince: string | undefined }[],
    persisted: [] as unknown[],
    sent: [] as string[],
    resumed: [] as string[],
    dropHeldOnGet: false,
    sinceFold: -1,
    nanAtNowAfterFold: undefined as number | undefined,
    record: undefined as { job: Job } | undefined,
  };
  const stores = createMemoryStores();
  const job: Job = {
    id: ID,
    managerId: ID,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T01:00:00.000Z',
    status: 'done',
    summary: '検証',
    request: '検証して',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    ...(setup.held === undefined
      ? {}
      : {
          heldMessages: setup.held.map((heldAt, index) => ({
            text: `伝言${String(index)}`,
            heldAt,
            reason: '預かり',
          })),
        }),
    ...(setup.usageStoppedAt === undefined ? {} : { usageStoppedAt: setup.usageStoppedAt }),
    ...(setup.workerLimit === true ? { workerLimitStopped: { preRotationKey: false } } : {}),
    ...(setup.pendingFoldNotice === undefined
      ? {}
      : { pendingFoldNotice: setup.pendingFoldNotice }),
  };
  await stores.jobs.putJob(job);
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async send(_managerId, text) {
      if (rec.on) rec.log.push('runner.send');
      rec.sent.push(text);
      return true;
    },
    async resume(command) {
      if (rec.on) rec.log.push('runner.resume');
      rec.resumed.push(command.message ?? '');
      return setup.reusedLiveSession === true
        ? { cwd: command.cwd, reusedLiveSession: true }
        : { cwd: command.cwd };
    },
  });
  const registry = createRunnerRegistry([runner]);
  const clock = { now: T0 };
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ tokenId: 'tok-a', generation: 1 }),
    now: () => {
      if (rec.on && rec.nowLogging) rec.log.push('now');
      if (rec.sinceFold >= 0) {
        rec.sinceFold += 1;
        if (rec.sinceFold === rec.nanAtNowAfterFold) return Number.NaN;
      }
      return clock.now;
    },
  });
  await pool.restore();

  vi.spyOn(WithheldReportsStore.prototype, 'awaitingBackgroundOf').mockImplementation(() => {
    if (rec.on) rec.log.push('awaitingBackgroundOf');
    return setup.awaitingSince === undefined
      ? undefined
      : ({
          tasks: 1,
          withheldReports: 1,
          breakdown: {},
          since: setup.awaitingSince,
        } as never);
  });
  let call = 0;
  vi.spyOn(StaleTokenFold.prototype, 'fold').mockImplementation(async (record, _r, _m, options) => {
    rec.record = record;
    const taken = options ?? {};
    if (rec.on) rec.log.push('fold');
    rec.folds.push({ options: { ...taken } });
    call += 1;
    if (setup.gate !== undefined) await setup.gate;
    const fold = setup.fold ?? {};
    const result = typeof fold === 'function' ? fold(taken, call) : fold;
    if (rec.on) rec.log.push('fold:return');
    rec.sinceFold = 0;
    return result;
  });
  const originalHold = HeldMessages.prototype.hold;
  vi.spyOn(HeldMessages.prototype, 'hold').mockImplementation(function (
    this: HeldMessages,
    ...args: Parameters<HeldMessages['hold']>
  ) {
    if (rec.on) rec.log.push('hold');
    rec.holds.push({ message: args[1], reason: args[2], foldDueAt: args[3] });
    return originalHold.apply(this, args);
  });
  const originalDue = HeldMessages.prototype.foldDueAt;
  vi.spyOn(HeldMessages.prototype, 'foldDueAt').mockImplementation(function (
    this: HeldMessages,
    ...args: Parameters<HeldMessages['foldDueAt']>
  ) {
    if (rec.on) rec.log.push('foldDueAt');
    rec.dueCalls.push({ oldestHeldAt: args[0], awaitingSince: args[1] });
    return originalDue.apply(this, args);
  });
  // 届け直しが宛先を引く間に預かりが空になった競合（段F は `oldestHeldAt` を読み直す）を作る
  const originalGet = registry.get.bind(registry);
  vi.spyOn(registry, 'get').mockImplementation((runnerId) => {
    if (rec.dropHeldOnGet && rec.record !== undefined) {
      rec.record.job.heldMessages = undefined;
      rec.dropHeldOnGet = false;
    }
    return originalGet(runnerId);
  });
  const originalPut = stores.jobs.putJob.bind(stores.jobs);
  vi.spyOn(stores.jobs, 'putJob').mockImplementation(async (written) => {
    if (rec.on && rec.sinceFold >= 0) {
      if (rec.nowLogging) rec.log.push('persist');
      rec.nowLogging = false;
      rec.persisted.push(structuredClone(written.pendingFoldNotice ?? null));
    }
    await originalPut(written);
  });

  const start = (): void => {
    rec.on = true;
    rec.nowLogging = true;
  };
  return {
    rec,
    clock,
    stores,
    pool,
    start,
    /** 呼び元（人・クローン）の送信 */
    async callerSend() {
      start();
      const result = await pool.send(ID, '続きを頼む');
      rec.on = false;
      return result;
    },
    /** 預かりの見回り（`pollRetry: true` の届け直し） */
    async poll() {
      start();
      await pool.deliverHeldMessages();
      rec.on = false;
    },
    /** 預かりがある委譲への送信（列の後ろへ積み、`pollRetry: false` の届け直しを試す） */
    async queuedSend() {
      return await this.callerSend();
    },
    /** 鍵の回転（`mode: 'usage-rotation'`） */
    async rotate() {
      start();
      const nudged = await pool.resumeStoppedByUsage();
      rec.on = false;
      return nudged;
    },
    async close() {
      await pool.stop();
    },
  };
}

const DECLINED: FoldResult = { declined: { outcome: 'declined', detail: '断った（D-DETAIL）' } };

// ---------------------------------------------------------------------------------------------
// fold へ渡る引数
// ---------------------------------------------------------------------------------------------

describe('段F: fold へ渡る引数の全欄（待ちの数え始めと上限）', () => {
  it('預かりの届け直し（見回り）: waitedLongEnough は預かりと背景待ちの早いほうから HELD_FORCE_FOLD_AFTER_MS ちょうどで真になり、skipUnchangedDeclineRecord は pollRetry に従う', async () => {
    const cases: Record<string, Setup> = {
      '預かりがちょうど上限前（>= の境界）': { held: [iso(T0 - HELD)] },
      預かりが上限の1ms手前: { held: [iso(T0 - HELD + 1)] },
      預かりが上限を1ms超過: { held: [iso(T0 - HELD - 1)] },
      '預かりは新しく背景待ちが上限前（早いほうを採る）': {
        held: [iso(T0)],
        awaitingSince: iso(T0 - HELD),
      },
      預かりは新しく背景待ちが1ms手前: { held: [iso(T0)], awaitingSince: iso(T0 - HELD + 1) },
      '預かりが上限前で背景待ちは新しい（早いほうは預かり）': {
        held: [iso(T0 - HELD)],
        awaitingSince: iso(T0),
      },
      '背景待ちの時刻が読めない（預かりは新しい）': { held: [iso(T0)], awaitingSince: 'garbage' },
      '背景待ちの時刻が読めず預かりが上限前（読めない側は数えない）': {
        held: [iso(T0 - HELD)],
        awaitingSince: 'garbage',
      },
      '預かりの先頭だけを見る（2通目が古くても先頭の新しさで数える）': {
        held: [iso(T0), iso(T0 - HELD - 1000)],
      },
    };
    const seen: Record<string, FoldOptions> = {};
    for (const [label, setup] of Object.entries(cases)) {
      const s = await open({ ...setup, fold: DECLINED });
      await s.poll();
      expect(s.rec.folds).toHaveLength(1);
      seen[label] = s.rec.folds[0]?.options ?? {};
      await s.close();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "背景待ちの時刻が読めず預かりが上限前（読めない側は数えない）": {
          "foldBackgroundAfterWait": true,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "背景待ちの時刻が読めない（預かりは新しい）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "預かりがちょうど上限前（>= の境界）": {
          "foldBackgroundAfterWait": true,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "預かりが上限の1ms手前": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "預かりが上限を1ms超過": {
          "foldBackgroundAfterWait": true,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "預かりが上限前で背景待ちは新しい（早いほうは預かり）": {
          "foldBackgroundAfterWait": true,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "預かりの先頭だけを見る（2通目が古くても先頭の新しさで数える）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "預かりは新しく背景待ちが1ms手前": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
        "預かりは新しく背景待ちが上限前（早いほうを採る）": {
          "foldBackgroundAfterWait": true,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
      }
    `);
  });

  it('預かりの届け直し: 宛先を引く間に預かりが空になっていたら（oldestHeldAt が無い）、背景待ちが上限を過ぎていても waitedLongEnough は偽', async () => {
    const s = await open({ held: [iso(T0)], awaitingSince: iso(T0 - HELD), fold: DECLINED });
    await s.poll();
    s.rec.dropHeldOnGet = true;
    s.rec.folds.length = 0;
    await s.poll();
    expect(s.rec.folds.map((fold) => fold.options)).toMatchInlineSnapshot(`
      [
        {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": true,
        },
      ]
    `);
    await s.close();
  });

  it('呼び元の送信: 背景待ちが上限を過ぎていても、mode が held-delivery でなければ waitedLongEnough は偽で、rotationFoldDueAt も付かない', async () => {
    const s = await open({ awaitingSince: iso(T0 - HELD - 1), fold: DECLINED });
    await s.callerSend();
    expect(s.rec.folds.map((fold) => fold.options)).toMatchInlineSnapshot(`
      [
        {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": false,
        },
      ]
    `);
    await s.close();
  });

  it('預かりへ積んだ後の届け直し（呼び元の送信が列の後ろへ積んで試す）: pollRetry は偽なので skipUnchangedDeclineRecord は偽', async () => {
    const s = await open({ held: [iso(T0 - HELD)], fold: DECLINED });
    const result = await s.queuedSend();
    expect(s.rec.folds.map((fold) => fold.options)).toMatchInlineSnapshot(`
      [
        {
          "foldBackgroundAfterWait": true,
          "foldBackgroundIfHeldTokenNotReady": false,
          "skipUnchangedDeclineRecord": false,
        },
      ]
    `);
    // 断りは held-delivery では預け直さず（holdable が偽）、`declined` をそのまま返す。列へ積む hold は1回だけ
    expect(s.rec.holds.map((hold) => hold.reason)).toMatchInlineSnapshot(`
      [
        "先に預かった伝言がまだ届いていない",
      ]
    `);
    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "mgr-fold-pin へはまだ届けられない（断った（D-DETAIL））。預かっている 2 通は捨てずに持っている（最初の預かり 2026-10-19T11:45:00.000Z）。届けられるようになったら自動で届け、届けたら知らせる。送り直さないこと（二重に届く）。",
        "outcome": "held",
      }
    `);
    await s.close();
  });

  it('鍵の回転: foldBackgroundIfHeldTokenNotReady は真、rotationFoldDueAt は「待ちの数え始め + 上限」で、いまがそれ以降なら付かない（>= の境界）', async () => {
    const cases: Record<string, Setup> = {
      '印の時刻が上限の1ms手前（上限は1ms先）': { usageStoppedAt: iso(T0 - HELD + 1) },
      '印の時刻がちょうど上限前（上限はいま。付かない）': { usageStoppedAt: iso(T0 - HELD) },
      '印の時刻が上限を1ms超過（付かない）': { usageStoppedAt: iso(T0 - HELD - 1) },
      '印は新しく背景待ちが古い（早いほう）': {
        usageStoppedAt: iso(T0 - 500),
        awaitingSince: iso(T0 - 1000),
      },
      '印が古く背景待ちが新しい（早いほう）': {
        usageStoppedAt: iso(T0 - 1000),
        awaitingSince: iso(T0 - 500),
      },
      '印は立たず背景待ちだけ（作業者の落ちの経路）': {
        workerLimit: true,
        awaitingSince: iso(T0 - 1000),
      },
      'どちらも無い（待ちの数え始めが無いので待たない）': { workerLimit: true },
      印はあるが背景待ちの時刻が読めない: {
        usageStoppedAt: iso(T0 - 1000),
        awaitingSince: 'garbage',
      },
      印は立たず背景待ちの時刻も読めない: { workerLimit: true, awaitingSince: 'garbage' },
      '背景待ちが上限を過ぎていても waitedLongEnough は偽（held-delivery ではない）': {
        usageStoppedAt: iso(T0),
        awaitingSince: iso(T0 - HELD - 5),
      },
    };
    const seen: Record<string, FoldOptions> = {};
    for (const [label, setup] of Object.entries(cases)) {
      const s = await open({ ...setup, fold: DECLINED });
      await s.rotate();
      expect(s.rec.folds).toHaveLength(1);
      seen[label] = s.rec.folds[0]?.options ?? {};
      await s.close();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "どちらも無い（待ちの数え始めが無いので待たない）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "skipUnchangedDeclineRecord": false,
        },
        "印が古く背景待ちが新しい（早いほう）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "rotationFoldDueAt": 1792412099000,
          "skipUnchangedDeclineRecord": false,
        },
        "印の時刻がちょうど上限前（上限はいま。付かない）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "skipUnchangedDeclineRecord": false,
        },
        "印の時刻が上限の1ms手前（上限は1ms先）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "rotationFoldDueAt": 1792411200001,
          "skipUnchangedDeclineRecord": false,
        },
        "印の時刻が上限を1ms超過（付かない）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "skipUnchangedDeclineRecord": false,
        },
        "印はあるが背景待ちの時刻が読めない": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "rotationFoldDueAt": 1792412099000,
          "skipUnchangedDeclineRecord": false,
        },
        "印は新しく背景待ちが古い（早いほう）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "rotationFoldDueAt": 1792412099000,
          "skipUnchangedDeclineRecord": false,
        },
        "印は立たず背景待ちだけ（作業者の落ちの経路）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "rotationFoldDueAt": 1792412099000,
          "skipUnchangedDeclineRecord": false,
        },
        "印は立たず背景待ちの時刻も読めない": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "skipUnchangedDeclineRecord": false,
        },
        "背景待ちが上限を過ぎていても waitedLongEnough は偽（held-delivery ではない）": {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "skipUnchangedDeclineRecord": false,
        },
      }
    `);
  });

  it('鍵の回転: 枠の印（#usageStopped）が下りていれば、台帳の usageStoppedAt を素通しにしない', async () => {
    // 作業者の落ちの経路で入る（印は立たない）。1回目で fold に渡る像を得てから、台帳の欄だけを手で立て直して2回目を打つ
    const s = await open({ workerLimit: true, fold: DECLINED });
    await s.rotate();
    const record = s.rec.record;
    if (record === undefined) throw new Error('fold へ像が渡っていない');
    record.job.usageStoppedAt = iso(T0 - 1000);
    s.rec.folds.length = 0;
    await s.rotate();
    expect(s.rec.folds.map((fold) => fold.options)).toMatchInlineSnapshot(`
      [
        {
          "foldBackgroundAfterWait": false,
          "foldBackgroundIfHeldTokenNotReady": true,
          "skipUnchangedDeclineRecord": false,
        },
      ]
    `);
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 断った枝
// ---------------------------------------------------------------------------------------------

describe('段F: 断った枝（declined）', () => {
  const stuckOf = (backgroundTasks: number | undefined, blockers: string[]) =>
    ({
      declined: { outcome: 'declined', detail: '断った（D-DETAIL）' },
      declinedReason: '理由（R-REASON）',
      stuck: {
        blockers,
        ...(backgroundTasks === undefined ? {} : { backgroundTasks }),
        backgroundCommands: [],
      },
    }) satisfies FoldResult;

  it('呼び元の送信（預かれる）: 断った本文を hold へ渡し、背景処理だけが理由の回（blockers が1本・backgroundTasks > 0）だけ foldDueAt を渡す', async () => {
    const cases: Record<string, FoldResult> = {
      'stuck 無し': {
        declined: { outcome: 'declined', detail: '断った（D-DETAIL）' },
        declinedReason: '理由（R-REASON）',
      },
      '背景処理1本・blockers 1本': stuckOf(1, ['b']),
      '背景処理2本・blockers 1本（> 0 の境界）': stuckOf(2, ['b']),
      背景処理0本: stuckOf(0, ['b']),
      背景処理の本数が不明: stuckOf(undefined, ['b']),
      'blockers 2本': stuckOf(1, ['b', 'c']),
      'blockers 0本': stuckOf(1, []),
    };
    const seen: Record<string, unknown> = {};
    for (const [label, fold] of Object.entries(cases)) {
      const s = await open({ awaitingSince: iso(T0 - 1000), fold });
      const result = await s.callerSend();
      seen[label] = {
        outcome: result.outcome,
        dueCalls: s.rec.dueCalls,
        holds: s.rec.holds.map((hold) => ({
          reason: hold.reason,
          foldDueAt: hold.foldDueAt === undefined ? undefined : iso(hold.foldDueAt),
        })),
      };
      await s.close();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "blockers 0本": {
          "dueCalls": [],
          "holds": [
            {
              "foldDueAt": undefined,
              "reason": "理由（R-REASON）",
            },
          ],
          "outcome": "held",
        },
        "blockers 2本": {
          "dueCalls": [],
          "holds": [
            {
              "foldDueAt": undefined,
              "reason": "理由（R-REASON）",
            },
          ],
          "outcome": "held",
        },
        "stuck 無し": {
          "dueCalls": [],
          "holds": [
            {
              "foldDueAt": undefined,
              "reason": "理由（R-REASON）",
            },
          ],
          "outcome": "held",
        },
        "背景処理0本": {
          "dueCalls": [],
          "holds": [
            {
              "foldDueAt": undefined,
              "reason": "理由（R-REASON）",
            },
          ],
          "outcome": "held",
        },
        "背景処理1本・blockers 1本": {
          "dueCalls": [
            {
              "awaitingSince": "2026-10-19T11:59:59.000Z",
              "oldestHeldAt": undefined,
            },
          ],
          "holds": [
            {
              "foldDueAt": "2026-10-19T12:14:59.000Z",
              "reason": "理由（R-REASON）",
            },
          ],
          "outcome": "held",
        },
        "背景処理2本・blockers 1本（> 0 の境界）": {
          "dueCalls": [
            {
              "awaitingSince": "2026-10-19T11:59:59.000Z",
              "oldestHeldAt": undefined,
            },
          ],
          "holds": [
            {
              "foldDueAt": "2026-10-19T12:14:59.000Z",
              "reason": "理由（R-REASON）",
            },
          ],
          "outcome": "held",
        },
        "背景処理の本数が不明": {
          "dueCalls": [],
          "holds": [
            {
              "foldDueAt": undefined,
              "reason": "理由（R-REASON）",
            },
          ],
          "outcome": "held",
        },
      }
    `);
  });

  it('declinedReason が無ければ declined.detail を預かりの理由にし、断った本文（message）をそのまま hold へ渡す', async () => {
    const s = await open({
      fold: { declined: { outcome: 'declined', detail: '断った（D-DETAIL）' } },
    });
    const result = await s.callerSend();
    expect(s.rec.holds.map(({ message, reason }) => ({ message, reason }))).toMatchInlineSnapshot(`
      [
        {
          "message": "続きを頼む",
          "reason": "断った（D-DETAIL）",
        },
      ]
    `);
    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "断った（D-DETAIL）

      この伝言は捨てずに預かった（mgr-fold-pin の預かり 1 通目。期限 2026-10-20T12:00:00.000Z）。届けられるようになったら（背景処理・確認待ちが片付いて新しい鍵で起こし直せたとき・抱えている鍵が使えるようになったとき・器が替わって resume から入るとき）、預かった順に自動で届け、届けたら知らせる。送り直さないこと（二重に届く）。続けて送った伝言は、預かりの後ろに並べてまとめて届ける。残っている背景処理を捨ててよいなら manager_stop → manager_start で後継を起こす（預かりは本文ごと返す）。",
        "outcome": "held",
      }
    `);
    await s.close();
  });

  it('背景待ちが無い回の foldDueAt は、いまを預かりの時刻として数える（oldestHeldAt も awaitingSince も渡らない）', async () => {
    const s = await open({ fold: stuckOf(1, ['b']) });
    await s.callerSend();
    expect(s.rec.dueCalls).toMatchInlineSnapshot(`
      [
        {
          "awaitingSince": undefined,
          "oldestHeldAt": undefined,
        },
      ]
    `);
    expect(s.rec.holds.map((hold) => hold.foldDueAt)).toMatchInlineSnapshot(`
      [
        1792412100000,
      ]
    `);
    await s.close();
  });

  it('鍵の回転は預かりに回さない（hold を呼ばず、断りは skipped として戻る）', async () => {
    const s = await open({ usageStoppedAt: iso(T0 - 1000), fold: stuckOf(1, ['b']) });
    const nudged = await s.rotate();
    expect(nudged).toMatchInlineSnapshot(`[]`);
    expect(s.rec.holds).toMatchInlineSnapshot(`[]`);
    expect(s.rec.dueCalls).toMatchInlineSnapshot(`[]`);
    await s.close();
  });

  it('onStuck は「待ちの上限を過ぎた見回りの回に、stuck があるとき」だけ呼ばれる（呼ばれると預かりの知らせが日誌に残る）', async () => {
    const stuck = stuckOf(1, ['b']);
    const noStuck: FoldResult = { declined: { outcome: 'declined', detail: '断った（D-DETAIL）' } };
    const cases: Record<string, Setup> = {
      '上限を過ぎた・stuck 有り': { held: [iso(T0 - HELD)], fold: stuck },
      '上限の1ms手前・stuck 有り': { held: [iso(T0 - HELD + 1)], fold: stuck },
      '上限を過ぎた・stuck 無し': { held: [iso(T0 - HELD)], fold: noStuck },
      '預かりは新しいが背景待ちが上限を過ぎた・stuck 有り': {
        held: [iso(T0)],
        awaitingSince: iso(T0 - HELD),
        fold: stuck,
      },
    };
    const seen: Record<string, boolean> = {};
    for (const [label, setup] of Object.entries(cases)) {
      const s = await open(setup);
      await s.poll();
      const entries = await s.stores.journal.list({ types: ['decision'] });
      seen[label] = entries.some((entry) => JSON.stringify(entry).includes('クローンへ知らせた'));
      await s.close();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "上限の1ms手前・stuck 有り": false,
        "上限を過ぎた・stuck 有り": true,
        "上限を過ぎた・stuck 無し": false,
        "預かりは新しいが背景待ちが上限を過ぎた・stuck 有り": true,
      }
    `);
  });

  it('呼び元の送信と鍵の回転は onStuck を持たないので、上限を過ぎた背景待ちでも stuck を渡さず落ちない', async () => {
    const caller = await open({ awaitingSince: iso(T0 - HELD - 1), fold: stuckOf(1, ['b']) });
    expect((await caller.callerSend()).outcome).toMatchInlineSnapshot(`"held"`);
    await caller.close();
    const rotation = await open({
      usageStoppedAt: iso(T0 - HELD - 1),
      fold: stuckOf(1, ['b']),
    });
    expect(await rotation.rotate()).toMatchInlineSnapshot(`[]`);
    await rotation.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 畳んだ後の pendingFoldNotice
// ---------------------------------------------------------------------------------------------

describe('段F: 畳んだ後の pendingFoldNotice の組み立て', () => {
  const OLD: NonNullable<Job['pendingFoldNotice']> = {
    backgroundTasks: 3,
    peers: 1,
    commands: ['古い1', '古い2', '古い3'],
    at: '2026-10-19T11:00:00.000Z',
  };
  const names = (count: number, prefix: string): string[] =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1)}`);

  async function notice(setup: Setup): Promise<unknown> {
    const s = await open(setup);
    await s.callerSend();
    const persisted = s.rec.persisted;
    await s.close();
    return persisted[0];
  }

  it('既存の notice が無い回: 本数だけ・peer だけ・両方、peers は 0 なら欄ごと無く、commands は返ってきたときだけ付く（at はいま）', async () => {
    const cases: Record<string, FoldResult> = {
      '畳んだ背景処理 2 本だけ': { foldedBackground: 2 },
      'peer 1 本だけ（背景処理は 0 本と数える）': { foldedPeers: 1 },
      '背景処理 1 本と peer 2 本': { foldedBackground: 1, foldedPeers: 2 },
      'peer が 0 本（欄ごと無い）': { foldedBackground: 1, foldedPeers: 0 },
      '背景処理 0 本だけ（それでも notice を書く）': { foldedBackground: 0 },
      コマンド付き: { foldedBackground: 1, foldedBackgroundCommands: ['pnpm dev'] },
      '空のコマンド列（返ってきたので commands: [] が付く）': {
        foldedBackground: 1,
        foldedBackgroundCommands: [],
      },
    };
    const seen: Record<string, unknown> = {};
    for (const [label, fold] of Object.entries(cases)) seen[label] = await notice({ fold });
    expect(seen).toMatchInlineSnapshot(`
      {
        "peer 1 本だけ（背景処理は 0 本と数える）": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 0,
          "peers": 1,
        },
        "peer が 0 本（欄ごと無い）": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 1,
        },
        "コマンド付き": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 1,
          "commands": [
            "pnpm dev",
          ],
        },
        "畳んだ背景処理 2 本だけ": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 2,
        },
        "空のコマンド列（返ってきたので commands: [] が付く）": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 1,
          "commands": [],
        },
        "背景処理 0 本だけ（それでも notice を書く）": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 0,
        },
        "背景処理 1 本と peer 2 本": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 1,
          "peers": 2,
        },
      }
    `);
  });

  it('既存の notice がある回: 本数と peers は足し、commands は既存の後ろへ新しいものを連ねる（at は新しい）', async () => {
    const cases: Record<string, FoldResult> = {
      '背景処理 2 本と peer 1 本を足す': {
        foldedBackground: 2,
        foldedPeers: 1,
        foldedBackgroundCommands: ['新1'],
      },
      '背景処理だけを足す（peers は既存のまま）': { foldedBackground: 2 },
      'peer だけを足す（本数は既存のまま）': { foldedPeers: 4 },
      'コマンドが返らない（既存のコマンドを残す）': { foldedBackground: 1 },
    };
    const seen: Record<string, unknown> = {};
    for (const [label, fold] of Object.entries(cases)) {
      seen[label] = await notice({ pendingFoldNotice: OLD, fold });
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "peer だけを足す（本数は既存のまま）": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 3,
          "commands": [
            "古い1",
            "古い2",
            "古い3",
          ],
          "peers": 5,
        },
        "コマンドが返らない（既存のコマンドを残す）": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 4,
          "commands": [
            "古い1",
            "古い2",
            "古い3",
          ],
          "peers": 1,
        },
        "背景処理 2 本と peer 1 本を足す": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 5,
          "commands": [
            "古い1",
            "古い2",
            "古い3",
            "新1",
          ],
          "peers": 2,
        },
        "背景処理だけを足す（peers は既存のまま）": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 5,
          "commands": [
            "古い1",
            "古い2",
            "古い3",
          ],
          "peers": 1,
        },
      }
    `);
  });

  it('既存の notice に peers が無い・commands が無い回: 足した結果の peers が 0 なら欄が無く、既存の commands が無く新しいのも無ければ commands も無い', async () => {
    const seen = {
      'peers も commands も無い既存へ背景処理を足す': await notice({
        pendingFoldNotice: { backgroundTasks: 1, at: '2026-10-19T11:00:00.000Z' },
        fold: { foldedBackground: 2 },
      }),
      '既存に commands が無く新しいコマンドが付く': await notice({
        pendingFoldNotice: { backgroundTasks: 1, at: '2026-10-19T11:00:00.000Z' },
        fold: { foldedBackground: 2, foldedBackgroundCommands: ['新1'] },
      }),
    };
    expect(seen).toMatchInlineSnapshot(`
      {
        "peers も commands も無い既存へ背景処理を足す": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 3,
        },
        "既存に commands が無く新しいコマンドが付く": {
          "at": "2026-10-19T12:00:00.000Z",
          "backgroundTasks": 3,
          "commands": [
            "新1",
          ],
        },
      }
    `);
  });

  it('commands は slice(0, FOLD_NOTICE_COMMANDS_MAX) で切る（境界: ちょうど・1 つ超過・既存だけで超過）', async () => {
    const max = FOLD_NOTICE_COMMANDS_MAX;
    const seen: Record<string, unknown> = {};
    const existing = (count: number): NonNullable<Job['pendingFoldNotice']> => ({
      backgroundTasks: 1,
      commands: names(count, '古'),
      at: '2026-10-19T11:00:00.000Z',
    });
    const run = async (label: string, before: number, added: number) => {
      const result = (await notice({
        pendingFoldNotice: existing(before),
        fold: { foldedBackground: 1, foldedBackgroundCommands: names(added, '新') },
      })) as { commands: string[] };
      seen[`${label}（既存 ${String(before)} + 新規 ${String(added)}）`] = result.commands;
    };
    await run('ちょうど上限', max - 2, 2);
    await run('1 つ超過', max - 2, 3);
    await run('既存だけで上限を超える', max + 2, 1);
    await run('既存が上限ちょうどで新規あり', max, 2);
    expect(max).toMatchInlineSnapshot(`5`);
    expect(seen).toMatchInlineSnapshot(`
      {
        "1 つ超過（既存 3 + 新規 3）": [
          "古1",
          "古2",
          "古3",
          "新1",
          "新2",
        ],
        "ちょうど上限（既存 3 + 新規 2）": [
          "古1",
          "古2",
          "古3",
          "新1",
          "新2",
        ],
        "既存が上限ちょうどで新規あり（既存 5 + 新規 2）": [
          "古1",
          "古2",
          "古3",
          "古4",
          "古5",
        ],
        "既存だけで上限を超える（既存 7 + 新規 1）": [
          "古1",
          "古2",
          "古3",
          "古4",
          "古5",
        ],
      }
    `);
  });

  it('畳んだ事実が無い（foldedBackground も foldedPeers も無い）回は notice に触らない（既存の notice の at も本数も変わらない）', async () => {
    const s = await open({ pendingFoldNotice: OLD, fold: {} });
    await s.callerSend();
    expect(s.rec.log).toMatchInlineSnapshot(`
      [
        "now",
        "awaitingBackgroundOf",
        "fold",
        "fold:return",
        "now",
        "persist",
        "runner.resume",
      ]
    `);
    expect(s.rec.persisted).toMatchInlineSnapshot(`
      [
        {
          "at": "2026-10-19T11:00:00.000Z",
          "backgroundTasks": 3,
          "commands": [
            "古い1",
            "古い2",
            "古い3",
          ],
          "peers": 1,
        },
        null,
      ]
    `);
    // 既存の notice は触られず（`at` が古いまま）、そのまま届ける本文の断り書きになる
    expect(s.rec.resumed).toMatchInlineSnapshot(`
      [
        "（alteroid より: 鍵の入れ替えのため、起こしっぱなしだった背景処理 3 本をセッションごと畳んで、新しい鍵で起こし直した。この背景処理の結果は二度と届かない（古いセッションと一緒に畳んだ）。古い背景処理のプロセスは runner が止める（止まるまで1分ほどかかることがある）。途中までの出力は、起こしたときの Bash の結果にある出力ファイルに残っていれば読める。同じ処理をやり直す前に、古い処理がまだ動いていないかを、作業ツリーの未コミットの変更が増えていないか（git status）・.git/index.lock が残っていないか・作業ツリーのファイルの最後の更新時刻と出力ファイルの末尾が動いていないかで確かめること（ps・/proc・env は使わない。他のプロセスの資格が出力に載る）。待たずに、いま自分で状態を確かめて（CI・作業者の結果・dev サーバ）、続きを進めよ。もう終わっていたなら、そう報告して終えること。畳んだ背景処理のコマンド（分かった分）: \`古い1\` / \`古い2\` / \`古い3\`。背景で走っていた peer 1 本は畳まずに預けてあり、まだ続いている。止まりどころは起こし直した後に届くので、peer_run でやり直さないこと）

      続きを頼む",
      ]
    `);
    await s.close();
  });

  it('foldedBackgroundCommands だけが返っても（背景処理も peer も無い）notice は書かない', async () => {
    const s = await open({ fold: { foldedBackgroundCommands: ['pnpm dev'] } });
    await s.callerSend();
    expect(s.rec.persisted).toMatchInlineSnapshot(`
      [
        null,
        null,
      ]
    `);
    await s.close();
  });

  it('台帳へ書けなくても（#persist が拒否されても）進み、届く', async () => {
    const s = await open({ fold: { foldedBackground: 1 } });
    // fold が返った後の1回目の時計は notice の at、2回目が #persist の updatedAt。ここを不正な時刻にして #persist を拒否させる
    s.rec.nanAtNowAfterFold = 2;
    const result = await s.callerSend();
    expect(result.outcome).toMatchInlineSnapshot(`"delivered"`);
    expect(s.rec.resumed).toHaveLength(1);
    await s.close();
  });
});

// ---------------------------------------------------------------------------------------------
// fold の返り値のうち、段F が呼び元へ返す欄
// ---------------------------------------------------------------------------------------------

describe('段F: 戻り値の全欄', () => {
  it('古い鍵のまま旧セッションへ届けた回（staleDelivery）は、届けた世代と畳めなかった理由を返事に書く', async () => {
    const s = await open({ fold: { staleDelivery: { generation: 3, blockers: ['b1', 'b2'] } } });
    const result = await s.callerSend();
    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "追加指示として届けた（古い鍵（世代 3）のまま旧セッションへ届けた。畳めない理由（b1。b2）が残っているため、新しい鍵で起こし直していない。その鍵はいま使える状態（ready）だった）。",
        "outcome": "delivered",
      }
    `);
    await s.close();
  });

  it('fingerprintMatched は true のときだけ真と数える（欄が無ければ偽）', async () => {
    const seen: Record<string, unknown> = {};
    for (const [label, fold] of Object.entries({
      欄が無い: {} as FoldResult,
      真: { fingerprintMatched: true } as FoldResult,
    })) {
      // 旧プロセスへ流しただけの回は、指紋が一致したと数えたときだけ身元を覚え直し、「分からないまま」の文言が消える
      const s = await open({ fold, reusedLiveSession: true });
      seen[label] = { result: await s.callerSend(), resumed: s.rec.resumed.length };
      await s.close();
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "欄が無い": {
          "result": {
            "detail": "追加指示として届けた（生きた旧プロセスへ流した。新しい SDK は起こしていない。その鍵が現役かどうかは確かめていないので、この委譲の認証トークンの世代は「分からない」のままにしてある）。",
            "outcome": "delivered",
          },
          "resumed": 1,
        },
        "真": {
          "result": {
            "detail": "追加指示として届けた。",
            "outcome": "delivered",
          },
          "resumed": 1,
        },
      }
    `);
  });
});

// ---------------------------------------------------------------------------------------------
// 副作用の順序と await の位置
// ---------------------------------------------------------------------------------------------

describe('段F: 副作用の順序と microtask の周回（歯）', () => {
  /**
   * `fold` が返る瞬間を決め、各記録が何周目の microtask で出たかを数える（`Promise.resolve()` を上限つきで流す。実時間は使わない）。
   * `foldAt`: 送信を始めてから `fold` に入るまでの周回数（fold の前の `await` の数）。
   * `trace`: `fold` を返してからの周回数。`settled` は送信そのものが終わった周回（fold の後の `await` の数）。
   */
  async function traced(
    setup: Setup,
    options: { via?: 'callerSend' | 'poll'; nanAtNowAfterFold?: number } = {},
  ) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = await open({ ...setup, gate });
    s.rec.nanAtNowAfterFold = options.nanAtNowAfterFold;
    let settled = false;
    const driven = s[options.via ?? 'callerSend']().then(() => {
      settled = true;
    });
    const maxTicks = 300;
    let foldAt = 0;
    while (!s.rec.log.includes('fold') && foldAt < maxTicks) {
      await Promise.resolve();
      foldAt += 1;
    }
    if (!s.rec.log.includes('fold')) throw new Error('fold に届かない');
    const before = [...s.rec.log];
    release();
    const trace: [string, number][] = [];
    let seen = before.length;
    let tick = 0;
    for (; tick <= maxTicks && !settled; tick += 1) {
      while (seen < s.rec.log.length) {
        trace.push([s.rec.log[seen] ?? '', tick]);
        seen += 1;
      }
      await Promise.resolve();
    }
    if (!settled) throw new Error('送信が終わらない');
    while (seen < s.rec.log.length) {
      trace.push([s.rec.log[seen] ?? '', tick]);
      seen += 1;
    }
    trace.push(['settled', tick]);
    await driven;
    await s.close();
    return { foldAt, before, trace };
  }

  it('畳んだ事実があるとき: awaitingBackgroundOf → now → fold の後に now（at）→ persist → 届ける。各記録の周回数を縛る', async () => {
    expect(await traced({ fold: { foldedBackground: 1 } })).toMatchInlineSnapshot(`
      {
        "before": [
          "now",
          "awaitingBackgroundOf",
          "fold",
        ],
        "foldAt": 10,
        "trace": [
          [
            "fold:return",
            1,
          ],
          [
            "now",
            2,
          ],
          [
            "now",
            2,
          ],
          [
            "persist",
            2,
          ],
          [
            "runner.resume",
            15,
          ],
          [
            "settled",
            30,
          ],
        ],
      }
    `);
  });

  it('畳んだ事実が無いとき: persist を挟まず、そのまま届ける（persist の await の分だけ早い）', async () => {
    expect(await traced({ fold: {} })).toMatchInlineSnapshot(`
      {
        "before": [
          "now",
          "awaitingBackgroundOf",
          "fold",
        ],
        "foldAt": 10,
        "trace": [
          [
            "fold:return",
            1,
          ],
          [
            "now",
            3,
          ],
          [
            "persist",
            3,
          ],
          [
            "runner.resume",
            10,
          ],
          [
            "settled",
            25,
          ],
        ],
      }
    `);
  });

  it('台帳へ書けない回（#persist が拒否される）: 拒否を握って進み、その分の周回で届く', async () => {
    expect(await traced({ fold: { foldedBackground: 1 } }, { nanAtNowAfterFold: 2 }))
      .toMatchInlineSnapshot(`
      {
        "before": [
          "now",
          "awaitingBackgroundOf",
          "fold",
        ],
        "foldAt": 10,
        "trace": [
          [
            "fold:return",
            1,
          ],
          [
            "now",
            2,
          ],
          [
            "now",
            2,
          ],
          [
            "now",
            5,
          ],
          [
            "persist",
            5,
          ],
          [
            "runner.resume",
            12,
          ],
          [
            "settled",
            27,
          ],
        ],
      }
    `);
  });

  it('断って預かる回: awaitingBackgroundOf → now → fold → foldDueAt → hold の順（foldDueAt を hold の前に求める）', async () => {
    expect(
      await traced({
        awaitingSince: iso(T0 - 1000),
        fold: {
          declined: { outcome: 'declined', detail: 'D' },
          declinedReason: 'R',
          stuck: { blockers: ['b'], backgroundTasks: 1, backgroundCommands: [] },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "before": [
          "now",
          "awaitingBackgroundOf",
          "fold",
        ],
        "foldAt": 10,
        "trace": [
          [
            "fold:return",
            1,
          ],
          [
            "foldDueAt",
            2,
          ],
          [
            "now",
            2,
          ],
          [
            "hold",
            2,
          ],
          [
            "now",
            2,
          ],
          [
            "now",
            2,
          ],
          [
            "persist",
            2,
          ],
          [
            "settled",
            13,
          ],
        ],
      }
    `);
  });

  it('預かりの届け直しが断られた回: hold を呼ばず、declined をそのまま返して終わる（周回数も縛る）', async () => {
    expect(await traced({ held: [iso(T0 - HELD)], fold: DECLINED }, { via: 'poll' }))
      .toMatchInlineSnapshot(`
      {
        "before": [
          "now",
          "now",
          "awaitingBackgroundOf",
          "now",
          "fold",
        ],
        "foldAt": 10,
        "trace": [
          [
            "fold:return",
            1,
          ],
          [
            "settled",
            7,
          ],
        ],
      }
    `);
  });

  it('fold の引数を作る間の時計の読み方: 預かりの届け直しは待ちの判定で1回、鍵の回転は上限の比較で1回（上限が無ければ読まない）、呼び元は読まない', async () => {
    const seen: Record<string, string[]> = {};
    const upToFold = (log: string[]): string[] =>
      log.slice(log.indexOf('awaitingBackgroundOf'), log.indexOf('fold') + 1);
    const poll = await open({ held: [iso(T0 - HELD)], fold: DECLINED });
    await poll.poll();
    seen['預かりの届け直し'] = upToFold(poll.rec.log);
    await poll.close();
    const caller = await open({ fold: DECLINED });
    await caller.callerSend();
    seen['呼び元の送信'] = upToFold(caller.rec.log);
    await caller.close();
    const withDue = await open({ usageStoppedAt: iso(T0 - 1000), fold: DECLINED });
    await withDue.rotate();
    seen['鍵の回転（上限が付く）'] = upToFold(withDue.rec.log);
    await withDue.close();
    const noDue = await open({ workerLimit: true, fold: DECLINED });
    await noDue.rotate();
    seen['鍵の回転（待ちの数え始めが無い）'] = upToFold(noDue.rec.log);
    await noDue.close();
    expect(seen).toMatchInlineSnapshot(`
      {
        "呼び元の送信": [
          "awaitingBackgroundOf",
          "fold",
        ],
        "鍵の回転（上限が付く）": [
          "awaitingBackgroundOf",
          "now",
          "fold",
        ],
        "鍵の回転（待ちの数え始めが無い）": [
          "awaitingBackgroundOf",
          "fold",
        ],
        "預かりの届け直し": [
          "awaitingBackgroundOf",
          "now",
          "fold",
        ],
      }
    `);
  });
});
