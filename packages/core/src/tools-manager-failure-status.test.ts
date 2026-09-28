import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * Issue #1882: `manager_list` の `failureLine`（`describeManagerFailure`、
 * `tools.ts`）と `manager_report` の `⚠ 直近のターンは報告ではなく失敗で
 * 終わっている` の行が、委譲の `status` によらず「セッションは生きているので、
 * 原因が解ければ manager_send で続きから進む」と言い切っていた。`lastFailure`
 * は `manager.ts` の `case 'report'` が次の report まで消さない欄なので、
 * 枠(429)などで畳まれた直後にセッションそのものが `failed` / `lost` /
 * `stopped` として終端しても、この行だけ古い前提（「生きている」）を言い続ける
 * ——`describeUsageStopped`（Issue #1796）が直したのと同じ形の穴が、
 * `lastFailure` の欄には独立に残っていた。
 *
 * **`tools-usage-stopped.test.ts` と同じ理由で、`tools.test.ts` の harness は
 * 使わない。** 最小限の `ManagerPool` を自前で組み立てる。
 */
function minimalManagerPool(): { pool: ManagerPool; managers: ManagerSummary[] } {
  const managers: ManagerSummary[] = [];
  const notUsedHere = (name: string) => () => {
    throw new Error(`この歯では ManagerPool.${name}() を使わない想定である`);
  };
  const pool: ManagerPool = {
    async start(input) {
      const summary: ManagerSummary = {
        managerId: `mgr-${managers.length + 1}`,
        status: 'running',
        live: true,
        cwd: input.cwd ?? '/work',
        request: input.request,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        waiting: [],
      };
      managers.push(summary);
      return summary;
    },
    send: notUsedHere('send') as ManagerPool['send'],
    abort: notUsedHere('abort') as ManagerPool['abort'],
    appraise: notUsedHere('appraise') as ManagerPool['appraise'],
    async list() {
      return managers.map((manager) => ({ ...manager }));
    },
    denials() {
      return [];
    },
    runners: notUsedHere('runners') as ManagerPool['runners'],
    pushHealthOf: notUsedHere('pushHealthOf') as ManagerPool['pushHealthOf'],
    runnerBacklog() {
      return [];
    },
    runnerIdOf: notUsedHere('runnerIdOf') as ManagerPool['runnerIdOf'],
    transcript: notUsedHere('transcript') as ManagerPool['transcript'],
    unpushedWork: notUsedHere('unpushedWork') as ManagerPool['unpushedWork'],
    runningManagerOwning: notUsedHere(
      'runningManagerOwning',
    ) as ManagerPool['runningManagerOwning'],
    restore: notUsedHere('restore') as ManagerPool['restore'],
    resumeStoppedByUsage: notUsedHere(
      'resumeStoppedByUsage',
    ) as ManagerPool['resumeStoppedByUsage'],
    reattachRunner: notUsedHere('reattachRunner') as ManagerPool['reattachRunner'],
    relocateFrom: notUsedHere('relocateFrom') as ManagerPool['relocateFrom'],
    vacate: notUsedHere('vacate') as ManagerPool['vacate'],
    probeTurnEnds: notUsedHere('probeTurnEnds') as ManagerPool['probeTurnEnds'],
    flushWithheldReports: notUsedHere(
      'flushWithheldReports',
    ) as ManagerPool['flushWithheldReports'],
    settleStalledUsageWakes: notUsedHere(
      'settleStalledUsageWakes',
    ) as ManagerPool['settleStalledUsageWakes'],
    renotifyStalledDenials: notUsedHere(
      'renotifyStalledDenials',
    ) as ManagerPool['renotifyStalledDenials'],
    stop: notUsedHere('stop') as ManagerPool['stop'],
  };
  return { pool, managers };
}

function harness() {
  const stores = createMemoryStores();
  const { pool, managers } = minimalManagerPool();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool,
  });
  return {
    managers,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

const ALIVE_CLAIM = 'セッションは生きているので、原因が解ければ manager_send で続きから進む';

function withLastFailure(target: ManagerSummary): ManagerSummary {
  target.lastReport = '（このターンは応答を返さずに終わった: billing_error）';
  target.lastFailure = {
    code: 'billing_error',
    via: 'assistant_error',
    at: '2026-09-27T01:23:45.000Z',
  };
  return target;
}

describe('manager_list: lastFailure の注記は status で言い分ける（Issue #1882）', () => {
  it('status: running（陽性対照）では「セッションは生きている」と言い切ってよい', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'running';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain(ALIVE_CLAIM);
  });

  it('status: done（陽性対照。仕様どおり status は動かさない側）では「セッションは生きている」と言い切ってよい', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'done';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain(ALIVE_CLAIM);
  });

  it('status: failed では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'failed';

    const reply = await h.call('manager_list', {});

    // 直近のターンが失敗で終わっている事実そのものは引き続き出す。
    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain('billing_error');
    expect(reply).toContain('assistant_error');
    expect(reply).toContain('2026-09-27T01:23:45.000Z');
    // **しかし「セッションは生きている」と言い切らない**——status が既に
    // セッションの死を確定させているので、これは事実と食い違う。
    expect(reply).not.toContain(ALIVE_CLAIM);
    expect(reply).toContain('status: failed');
  });

  it('status: lost では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'lost';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).not.toContain(ALIVE_CLAIM);
    expect(reply).toContain('status: lost');
  });

  /**
   * `abort()` は `lastFailure` に触れない——`describeUsageStopped` の
   * `usageStoppedAt` と同じ形で、枠などで失敗していた委譲がそのまま
   * 人間・クローンに止められると印が残ったまま `status: 'stopped'` になる。
   * `isManagerOutcomeUnobserved`（`failed` / `lost`）はこの回を含まないので
   * 別枝が要る（`describeUsageStopped` の `stopped` 分岐と同じ理由）。
   */
  it('status: stopped では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'stopped';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).not.toContain(ALIVE_CLAIM);
    expect(reply).toContain('status: stopped');
  });

  /**
   * Issue #1882 の追記: `manager_send`（`manager.ts` の `send()`）は `status`
   * を見ずに `#load()` / `#resume()` を通るので、`stopped` でも resume は
   * 実際に試みられる。`stopped` でも「起こし直すには manager_send で resume
   * を試みるしかなく、届く保証は無い」まで言う——`describeUsageStopped` の
   * `stopped` 枝と揃える。
   */
  it('status: stopped でも、起こし直しは resume を試みるしかなく届く保証が無いことを言う', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'stopped';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain(
      '起こし直すには manager_send で resume を試みるしかなく、届く保証は無い',
    );
  });
});

describe('manager_report: lastFailure の注記は status で言い分ける（Issue #1882）', () => {
  it('status: running（陽性対照）では「セッションは生きている」と言い切ってよい', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'running';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain(ALIVE_CLAIM);
  });

  it('status: failed では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'failed';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain('billing_error');
    expect(reply).not.toContain(ALIVE_CLAIM);
    expect(reply).toContain('status: failed');
  });

  it('status: lost では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'lost';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain(ALIVE_CLAIM);
    expect(reply).toContain('status: lost');
  });

  it('status: stopped では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'stopped';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain(ALIVE_CLAIM);
    expect(reply).toContain('status: stopped');
  });

  /**
   * **終端した2枝では `RESTART_BEFORE_CHECK_ADVICE` を付けない**（このファイル
   * `tools.ts` の `describeManagerFailure` doc「## ⚠️ Issue #1882」）。二重起動の
   * 注意は「本当に死んでいるか確認できていない」ときにしか成り立たず、
   * `failed` / `lost` / `stopped` は `isLive()` が確認済みで死んでいる側である
   * （`describeUsageStopped` の終端2枝と同じ判断）。
   */
  it('status: failed では RESTART_BEFORE_CHECK_ADVICE の文言を付けない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'failed';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('確かめる前に manager_start で起こし直さないこと');
  });

  it('status: running では引き続き RESTART_BEFORE_CHECK_ADVICE の文言を付ける', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'running';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('確かめる前に manager_start で起こし直さないこと');
  });
});

/**
 * Issue #1882 のレビュー指摘: `manager_list` の `failureLine` は `manager_report`
 * と違い、`lastFoldedTurn`（停止後に届いた、畳まれたターンの本文。Issue #1038）
 * が在る回にも `describeManagerFailure` を呼んでいた。`manager.ts` の
 * `case 'report'` は `record.job.status === 'stopped'` の間 `lastFoldedTurn`
 * だけを書いて早期 return するので、`lastFoldedTurn` が在る回の `lastFailure`
 * は必ず畳まれる**前**の、無関係な古いターンを指す——`describeManagerFailure`
 * の「直近のターンは報告ではなく失敗で終わっている」という言い切りは、より
 * 新しいターン（畳まれたもの）が既に在る以上、「直近」の部分がそもそも事実と
 * 違う。`manager_report` は #1798 でこの回を `null` にする（`foldedTurn !==
 * undefined` のガード）よう直っているが、`manager_list` 側の `failureLine` は
 * 同じガードを持っていなかった。
 */
describe('manager_list: lastFoldedTurn が在る回は failureLine を出さない（Issue #1882 レビュー指摘）', () => {
  it('lastFoldedTurn が在れば、lastFailure が立っていても⚠を出さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'stopped';
    target.lastFoldedTurn = { text: '停止後に届いた畳まれた本文', at: '2026-09-28T00:00:00.000Z' };

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
  });

  it('lastFoldedTurn が無ければ、従来どおり⚠を出す（陽性対照）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    withLastFailure(target);
    target.status = 'stopped';
    // lastFoldedTurn はセットしない。

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
  });
});
