import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPORT_SETTLE_MS_ENV_KEY, resolveReportSettleMs } from './clone.js';
import { setup } from './clone-test-harness.js';
import { Inbox } from './inbox.js';
import type { Setup } from './clone-test-harness.js';
import type { InboxEvent } from './schema.js';
import { captureStderr, humanMessage } from './testing.js';

// 偽の時計で進める（実時間の待ちを足さない: scripts/wallclock-waits-ratchet.test.ts）
const REPORT_MS = 30_000;
const EXTERNAL_MS = 2500;
const ON = { inboxSettleMs: EXTERNAL_MS, reportSettleMs: REPORT_MS };

const report = (id: string, text: string): InboxEvent => ({
  type: 'manager_message',
  id,
  at: new Date().toISOString(),
  managerId: 'mgr-report-settle',
  kind: 'report',
  text,
});

const managerKind = (id: string, kind: 'question' | 'permission'): InboxEvent => ({
  type: 'manager_message',
  id,
  at: new Date().toISOString(),
  managerId: 'mgr-report-settle',
  kind,
  text: `${kind}の本文`,
  ...(kind === 'permission' ? { requestId: `req-${id}` } : {}),
});

const synthesizedReport = (id: string, text: string): InboxEvent => ({
  type: 'manager_message',
  id,
  at: new Date().toISOString(),
  managerId: 'mgr-report-settle',
  kind: 'report',
  text,
  synthesized: true,
});

const external = (id: string, text: string, source = 'ci'): InboxEvent => ({
  type: 'external',
  id,
  at: new Date().toISOString(),
  source,
  payload: { text },
});

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// 非同期の連鎖（永続化・記帳）が落ち着くまで、時計を細かく進めて回す
async function settleAsync(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await advance(10);
}

const turnInputs = (s: Setup): string[] =>
  s.calls.filter((call) => call.kind === 'session').flatMap((call) => call.inputs);

describe('クローン — 暇なときの報告の束ね待ち（固定窓 30 秒）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('30 秒の窓に連続して届いた報告は、1ターンに束ねられる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(10_000);
    s.clone.post(report('r2', '報告2本目'));
    await advance(10_000);
    s.clone.post(report('r3', '報告3本目'));
    // 窓が閉じるまでターンを投げない
    await advance(9000);
    expect(turnInputs(s)).toHaveLength(0);

    await advance(2000);
    await settleAsync();
    const inputs = turnInputs(s);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('報告1本目');
    expect(inputs[0]).toContain('報告2本目');
    expect(inputs[0]).toContain('報告3本目');
    await s.clone.stop();
  });

  it('窓の外（30 秒より後）の報告は別ターンになる。窓は後続の報告で延びない', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(20_000);
    // 窓の途中の報告は束ねる。ここで窓が延びるなら、次の報告（35 秒時点）も同じ束に入ってしまう
    s.clone.post(report('r2', '報告2本目'));
    await advance(15_000);
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);

    s.clone.post(report('r3', '窓の外の報告'));
    await advance(REPORT_MS + 500);
    await settleAsync();
    const inputs = turnInputs(s);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain('報告1本目');
    expect(inputs[0]).toContain('報告2本目');
    expect(inputs[0]).not.toContain('窓の外の報告');
    expect(inputs[1]).toContain('窓の外の報告');
    await s.clone.stop();
  });

  it('窓の途中で人間の発言が届くと、窓を打ち切って即ターンになる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(5000);
    expect(turnInputs(s)).toHaveLength(0);
    s.clone.post(humanMessage('割り込み'));
    // 期限（30 秒）には遠い 500ms 以内に走り出す
    await advance(500);
    expect(turnInputs(s).length).toBeGreaterThanOrEqual(1);
    await s.clone.stop();
  });

  it('質問（question）と許可確認（permission）の報告種別は待たない', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(managerKind('p1', 'permission'));
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    s.clone.post(managerKind('q1', 'question'));
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(2);
    await s.clone.stop();
  });

  it('窓の途中で質問が届くと、窓を打ち切って即ターンになる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(5000);
    expect(turnInputs(s)).toHaveLength(0);
    s.clone.post(managerKind('q1', 'question'));
    await advance(500);
    expect(turnInputs(s).length).toBeGreaterThanOrEqual(1);
    await s.clone.stop();
  });

  it('窓の途中で外部の合図（runner-registry の知らせ）が届くと、窓を打ち切って即ターンになる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(5000);
    expect(turnInputs(s)).toHaveLength(0);
    s.clone.post(external('e1', 'runner-registryの知らせ', 'runner-registry'));
    await advance(500);
    expect(turnInputs(s).length).toBeGreaterThanOrEqual(1);
    await s.clone.stop();
  });

  // 機構が合成した担当の失敗・停止の知らせの本物の形（manager.ts の `#emit`）: manager_message・kind: 'report'・synthesized: true
  it('窓の途中で合成の失敗の知らせ（kind: report・synthesized: true）が届くと、窓を打ち切って即ターンになる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(5000);
    expect(turnInputs(s)).toHaveLength(0);
    s.clone.post(synthesizedReport('f1', '担当が落ちた'));
    await advance(500);
    expect(turnInputs(s).length).toBeGreaterThanOrEqual(1);
    await s.clone.stop();
  });

  it('合成の失敗の知らせが先に届いても 30 秒の窓では待たない（従来の 2.5 秒の窓のまま）', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(synthesizedReport('f1', '担当が落ちた'));
    await advance(EXTERNAL_MS - 500);
    expect(turnInputs(s)).toHaveLength(0);
    await advance(1000);
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    await s.clone.stop();
  });

  it('待ちに入る前に待ち行列へ積まれていた人間の発言・蒸留・合成の知らせでは、待たずに戻る', async () => {
    // 報告の窓の述語（`!isPlainReport`）と同じ形
    const notPlainReport = (event: InboxEvent): boolean =>
      event.type !== 'manager_message' || event.kind !== 'report' || event.synthesized === true;
    const cases: [string, InboxEvent][] = [
      ['人間の発言', humanMessage('先に届いた発言')],
      ['蒸留', { type: 'distill', id: 'd1', at: new Date().toISOString(), reason: 'shutdown' }],
      ['合成の失敗の知らせ', synthesizedReport('f1', '担当が落ちた')],
    ];
    for (const [, event] of cases) {
      const inbox = new Inbox();
      inbox.push(event);
      let settled = false;
      void inbox.settle(REPORT_MS, notPlainReport).then(() => {
        settled = true;
      });
      await advance(1);
      expect(settled).toBe(true);
    }
    // 当たらないものが積まれているだけなら、期限まで待つ
    const inbox = new Inbox();
    inbox.push(report('r2', '先に積まれた報告'));
    let settled = false;
    void inbox.settle(REPORT_MS, notPlainReport).then(() => {
      settled = true;
    });
    await advance(REPORT_MS - 1);
    expect(settled).toBe(false);
    await advance(2);
    expect(settled).toBe(true);
  });

  it('報告の窓を 0 にすると、従来どおり最初の1件が単独で即ターンになる', async () => {
    const s = setup(
      undefined,
      undefined,
      {},
      {},
      { inboxSettleMs: EXTERNAL_MS, reportSettleMs: 0 },
    );
    s.clone.post(report('r1', '報告1本目'));
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    expect(turnInputs(s)[0]).toContain('報告1本目');
    await s.clone.stop();
  });

  it('外部の合図の窓は報告の窓の影響を受けず、2.5 秒のまま', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(external('e1', '外部の1本目'));
    await advance(EXTERNAL_MS - 500);
    expect(turnInputs(s)).toHaveLength(0);
    await advance(1000);
    await settleAsync();
    const inputs = turnInputs(s);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('外部の1本目');
    await s.clone.stop();
  });

  it('窓の途中で停止すると、30 秒を待たずに抜ける（タイマーも残らない）', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(1000);
    let stopped = false;
    const stopping = s.clone.stop().then(() => {
      stopped = true;
    });
    await advance(1000);
    expect(stopped).toBe(true);
    await stopping;
    await settleAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('セッションがある状態で窓の途中に停止しても、shutdown の蒸留が窓を打ち切って 30 秒待たせない', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(humanMessage('セッションを起こす'));
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    s.clone.post(report('r1', '報告1本目'));
    await advance(1000);
    let stopped = false;
    const stopping = s.clone.stop().then(() => {
      stopped = true;
    });
    await advance(2000);
    expect(stopped).toBe(true);
    await stopping;
  });
});

describe('resolveReportSettleMs', () => {
  it('未設定・空・空白のみは既定 30000ms（跡を出さない）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveReportSettleMs({})).toBe(30_000);
      expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '' })).toBe(30_000);
      expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '  ' })).toBe(30_000);
    });
    expect(lines.filter((line) => line.includes('報告の束ね待ちの設定'))).toEqual([]);
  });

  it('正常値と 0（無効）と上限 120000 はそのまま読む。小数は切り捨てる', () => {
    expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '60000' })).toBe(60_000);
    expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '0' })).toBe(0);
    expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '120000' })).toBe(120_000);
    expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '1500.9' })).toBe(1500);
  });

  it('数値でない・負数・上限超えは既定へ倒し、跡を残す（値そのものは載せない）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: 'abc' })).toBe(30_000);
      expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '-5' })).toBe(30_000);
      expect(resolveReportSettleMs({ [REPORT_SETTLE_MS_ENV_KEY]: '999999' })).toBe(30_000);
    });
    const noted = lines.filter((line) => line.includes('報告の束ね待ちの設定'));
    expect(noted).toHaveLength(3);
    expect(noted.join('\n')).not.toContain('999999');
  });
});
