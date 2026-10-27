import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOX_SETTLE_MS_ENV_KEY, resolveInboxSettleMs } from './clone.js';
import { setup } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';
import type { InboxEvent } from './schema.js';
import { captureStderr, humanMessage } from './testing.js';

// 偽の時計で進める（実時間の待ちを足さない: scripts/wallclock-waits-ratchet.test.ts）
// `waitFor` は実時間の setTimeout を使うので、ここでは使わず `advance` で時計を進めて確かめる
const SETTLE_MS = 2500;
const ON = { inboxSettleMs: SETTLE_MS };
const OFF = { inboxSettleMs: 0 };

const report = (id: string, text: string): InboxEvent => ({
  type: 'manager_message',
  id,
  at: new Date().toISOString(),
  managerId: 'mgr-settle',
  kind: 'report',
  text,
});

const managerKind = (id: string, kind: 'question' | 'permission'): InboxEvent => ({
  type: 'manager_message',
  id,
  at: new Date().toISOString(),
  managerId: 'mgr-settle',
  kind,
  text: `${kind}の本文`,
  ...(kind === 'permission' ? { requestId: `req-${id}` } : {}),
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

describe('クローン — 暇なときの報告・外部の合図の束ね待ち', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('報告3件が待ちの間に届くと、1ターンに束ねられる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(300);
    s.clone.post(report('r2', '報告2本目'));
    await advance(300);
    s.clone.post(report('r3', '報告3本目'));
    // 待ちの間はターンを投げない
    await advance(1000);
    expect(turnInputs(s)).toHaveLength(0);

    await advance(SETTLE_MS);
    await settleAsync();
    const inputs = turnInputs(s);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('報告1本目');
    expect(inputs[0]).toContain('報告2本目');
    expect(inputs[0]).toContain('報告3本目');
    await s.clone.stop();
  });

  it('設定 0 では従来どおり、最初の1件が単独で即ターンになる（3件で2ターン）', async () => {
    const s = setup(undefined, undefined, {}, {}, OFF);
    s.clone.post(report('r1', '報告1本目'));
    // 1件目の取り出しと束ねの判定が済むまで進めてから続きを届ける: 同じ同期ブロックで投げると、束ねの判定が後続も拾うため
    await advance(1);
    s.clone.post(report('r2', '報告2本目'));
    s.clone.post(report('r3', '報告3本目'));
    await settleAsync();
    const inputs = turnInputs(s);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain('報告1本目');
    expect(inputs[0]).not.toContain('報告2本目');
    expect(inputs[1]).toContain('報告2本目');
    expect(inputs[1]).toContain('報告3本目');
    await s.clone.stop();
  });

  it('効きの数字: 300ms 間隔の報告3件は、設定 0 では複数ターン、既定では1ターン', async () => {
    const turnsFor = async (options: { inboxSettleMs: number }): Promise<number> => {
      const s = setup(undefined, undefined, {}, {}, options);
      s.clone.post(report('r1', '報告1本目'));
      await advance(300);
      s.clone.post(report('r2', '報告2本目'));
      await advance(300);
      s.clone.post(report('r3', '報告3本目'));
      await advance(SETTLE_MS + 500);
      await settleAsync();
      const turns = turnInputs(s).length;
      await s.clone.stop();
      return turns;
    };
    const off = await turnsFor(OFF);
    const on = await turnsFor(ON);
    expect(on).toBe(1);
    // 偽の SDK は即応答するので、設定 0 では間隔ごとに1ターンずつ走る
    expect(off).toBe(3);
  });

  it('外部の合図でも同様に束ねる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(external('e1', '外部の1本目'));
    await advance(200);
    s.clone.post(external('e2', '外部の2本目'));
    await advance(1000);
    expect(turnInputs(s)).toHaveLength(0);
    await advance(SETTLE_MS);
    await settleAsync();
    const inputs = turnInputs(s);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('外部の1本目');
    expect(inputs[0]).toContain('外部の2本目');
    await s.clone.stop();
  });

  it('待ちは最初の1件の到着から数える（最大でも設定値）', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '単発の報告'));
    await advance(SETTLE_MS - 500);
    await settleAsync();
    // `settleAsync` の 400ms を足しても、まだ期限前
    expect(turnInputs(s)).toHaveLength(0);
    await advance(SETTLE_MS);
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    await s.clone.stop();
  });

  it('人間の発言は待たず即時にターンになる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(humanMessage('こんにちは'));
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    await s.clone.stop();
  });

  it('待ち中に人間の発言が届くと、待ちを打ち切って即ターンになる', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(500);
    expect(turnInputs(s)).toHaveLength(0);
    s.clone.post(humanMessage('割り込み'));
    // 期限（2.5秒）には遠い 500ms 以内に走り出す
    await advance(500);
    expect(turnInputs(s).length).toBeGreaterThanOrEqual(1);
    await s.clone.stop();
  });

  it('許可確認（permission）と質問（question）は待たない', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(managerKind('p1', 'permission'));
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    s.clone.post(managerKind('q1', 'question'));
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(2);
    await s.clone.stop();
  });

  it('デーモン自身の知らせ（token-pool）は待たない', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post({
      type: 'external',
      id: 'tp1',
      at: new Date().toISOString(),
      source: 'token-pool',
      payload: { text: '戻った', tokenId: 't1', observedRecovery: false },
    });
    await settleAsync();
    expect(turnInputs(s)).toHaveLength(1);
    await s.clone.stop();
  });

  it('デーモン自身の知らせ（runner-registry・attachment-usage）は待ち、続く報告と同じ束に入る', async () => {
    for (const source of ['runner-registry', 'attachment-usage']) {
      const s = setup(undefined, undefined, {}, {}, ON);
      s.clone.post(external('n1', `${source}の知らせ`, source));
      await advance(300);
      s.clone.post(report('r1', `${source}の後の報告`));
      // 待ちの間はターンを投げない
      await advance(1000);
      expect(turnInputs(s)).toHaveLength(0);
      await advance(SETTLE_MS);
      await settleAsync();
      const inputs = turnInputs(s);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toContain(`${source}の知らせ`);
      expect(inputs[0]).toContain(`${source}の後の報告`);
      await s.clone.stop();
    }
  });

  it('効きの数字: runner-registry の知らせ + 300ms 後の報告は、設定 0 では2ターン、既定では1ターン', async () => {
    const turnsFor = async (options: { inboxSettleMs: number }): Promise<number> => {
      const s = setup(undefined, undefined, {}, {}, options);
      s.clone.post(external('n1', '器の入れ替えの知らせ', 'runner-registry'));
      await advance(300);
      s.clone.post(report('r1', 'restored の報告'));
      await advance(SETTLE_MS + 500);
      await settleAsync();
      const turns = turnInputs(s).length;
      await s.clone.stop();
      return turns;
    };
    expect(await turnsFor(OFF)).toBe(2);
    expect(await turnsFor(ON)).toBe(1);
  });

  it('待ち中に人間の発言が届くと、デーモン自身の知らせの待ちも打ち切る', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(external('n1', '器の入れ替えの知らせ', 'runner-registry'));
    await advance(500);
    expect(turnInputs(s)).toHaveLength(0);
    s.clone.post(humanMessage('割り込み'));
    await advance(500);
    expect(turnInputs(s).length).toBeGreaterThanOrEqual(1);
    await s.clone.stop();
  });

  it('待っている間に停止しても、タイマーが残らない', async () => {
    const s = setup(undefined, undefined, {}, {}, ON);
    s.clone.post(report('r1', '報告1本目'));
    await advance(300);
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);
    await s.clone.stop();
    await settleAsync();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('resolveInboxSettleMs', () => {
  it('未設定・空・空白のみは既定 2500ms（跡を出さない）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveInboxSettleMs({})).toBe(2500);
      expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: '' })).toBe(2500);
      expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: '  ' })).toBe(2500);
    });
    expect(lines.filter((line) => line.includes('束ね待ちの設定'))).toEqual([]);
  });

  it('正常値と 0（無効）はそのまま読む。小数は切り捨てる', () => {
    expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: '1000' })).toBe(1000);
    expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: '0' })).toBe(0);
    expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: '1500.9' })).toBe(1500);
  });

  it('数値でない・負数・上限超えは既定へ倒し、跡を残す（値そのものは載せない）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: 'abc' })).toBe(2500);
      expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: '-5' })).toBe(2500);
      expect(resolveInboxSettleMs({ [INBOX_SETTLE_MS_ENV_KEY]: '999999' })).toBe(2500);
    });
    const noted = lines.filter((line) => line.includes('束ね待ちの設定'));
    expect(noted).toHaveLength(3);
    expect(noted.join('\n')).not.toContain('999999');
  });
});
