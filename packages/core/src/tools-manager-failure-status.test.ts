import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

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

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).toContain('billing_error');
    expect(reply).toContain('assistant_error');
    expect(reply).toContain('2026-09-27T01:23:45.000Z');
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

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
  });
});
