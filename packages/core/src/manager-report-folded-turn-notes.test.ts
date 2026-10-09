import { describe, expect, it } from 'vitest';

import type { ManagerDenial, ManagerPool, ManagerSendResult, ManagerSummary } from './manager.js';
import { createProfileService } from './profile-service.js';
import { createCloneTools, type ToolContext } from './tools.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface Harness {
  stores: Stores;
  running: ManagerSummary[];
  denied: Map<string, ManagerDenial[]>;
  call(name: string, args: unknown): Promise<string>;
}

function harness(): Harness {
  const stores = createMemoryStores();
  const running: ManagerSummary[] = [];
  const denied = new Map<string, ManagerDenial[]>();
  let started = 0;

  const managers: ManagerPool = {
    async start(input) {
      started += 1;
      const summary: ManagerSummary = {
        managerId: `mgr-${started}`,
        status: 'running',
        live: true,
        cwd: input.cwd ?? '/work',
        request: input.request,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        waiting: [],
        runnerId: input.runnerId ?? 'runner-test',
      };
      running.push(summary);
      return summary;
    },
    async send(managerId, message): Promise<ManagerSendResult> {
      return { outcome: 'answered', detail: `${managerId} へ ${message}` };
    },
    async list() {
      return running.map((manager) => ({ ...manager }));
    },
    denials(managerId: string) {
      return denied.get(managerId) ?? [];
    },
    pushHealthOf() {
      return undefined;
    },
    async transcript() {
      return { kind: 'missing' as const };
    },
    async unpushedWork() {
      return { kind: 'unavailable' as const, reason: '(この歯では使わない)' };
    },
    runningManagerOwning() {
      return undefined;
    },
    async restore() {
      return [];
    },
    async resumeStoppedByUsage() {
      return [];
    },
    async reattachRunner() {},
    relocateFrom() {},
    async vacate() {
      return {};
    },
    async abort(managerId: string) {
      const found = running.find((manager) => manager.managerId === managerId);
      if (!found) return { outcome: 'absent' as const, detail: '居ない' };
      found.status = 'stopped';
      found.live = false;
      return { outcome: 'stopped' as const, detail: '止めた', sessionGone: true };
    },
    async runners() {
      return { runners: [], unassigned: [], daemonRevision: { status: 'unknown' } };
    },
    runnerBacklog() {
      return [];
    },
    async runnerIdOf(managerId: string) {
      return running.find((manager) => manager.managerId === managerId)?.runnerId;
    },
    async probeTurnEnds() {},
    async flushWithheldReports() {},
    async settleStalledUsageWakes() {
      return [];
    },
    async renotifyStalledDenials() {},
    async stop() {},
  };

  const runners = {
    async list() {
      return [];
    },
    async get() {
      return null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;

  const context: ToolContext = {
    stores,
    emit: () => {},
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers,
    profile: createProfileService({ stores, runners }),
  };

  const tools = createCloneTools(context);

  return {
    stores,
    running,
    denied,
    async call(name, args) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

describe('manager_report: 畳まれたターン（lastFoldedTurn）の回の見出し・注記（#1797 / #1798）', () => {
  it('見出しの齢欄は、foldedTurn がある回に古い lastReportAt を出さない（#1797）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReportAt = '2026-09-01T00:00:00.000Z';
    target.lastReportStatus = 'running';
    target.status = 'stopped';
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-16T00:20:00.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('2026-09-01T00:00:00.000Z');
    expect(reply).toContain('いまの status: `stopped`');
    expect(reply).toContain('2026-09-16T00:20:00.000Z');
  });

  it('⚠ drift は、foldedTurn がある回に畳まれる前の無関係な food.lastReportStatus を語らない（#1797）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReportAt = '2026-09-01T00:00:00.000Z';
    target.lastReportStatus = 'running';
    target.status = 'stopped';
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-16T00:20:00.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('この報告が台帳へ書かれた時点で');
    expect(reply).not.toContain('26日');
  });

  it('⚠ drift は、foldedTurn 到着後に status が動いていれば、その動きを正しく語る（#1797）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-16T00:20:00.000Z',
    };
    target.status = 'running';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('この報告が台帳へ書かれた時点で');
    expect(reply).toContain('`stopped`');
    expect(reply).toContain('`running`');
  });

  it('failureNote は、foldedTurn がある回に「本文はエラー文」と予告しない（#1798）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastFailure = {
      code: 'rate_limit',
      via: 'assistant_error',
      at: '2026-08-20T00:00:00.000Z',
    };
    target.status = 'stopped';
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文（失敗ではなく普通の発話）',
      at: '2026-09-16T00:20:00.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('この行の下に出る本文は runner が包んだエラー文');
    expect(reply).not.toContain('⚠ 直近のターンは報告ではなく失敗で終わっている');
    expect(reply).not.toContain('rate_limit');
    expect(reply).toContain('停止後に届いた畳まれた本文（失敗ではなく普通の発話）');
  });

  it('denialNote は、foldedTurn がある回に foldedTurn.at を「拒否の後の到着」の材料として使う（監査で発見・#1797/#1798 と同根）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.status = 'stopped';
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-20T00:00:00.000Z',
    };
    h.denied.set(target.managerId, [
      { tool: 'Bash', count: 1, lastAt: '2026-09-15T00:00:00.000Z' },
    ]);

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('後にも報告が届いている');
    expect(reply).not.toContain('まだ届いていない');
  });

  it('systemErrorNote / cgroupEventsNote / unobservedNote は、到達可能な foldedTurn の回（status: stopped）では出ない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.status = 'stopped';
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-16T00:20:00.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('セッションは器の資源による落ち方で畳まれた');
    expect(reply).not.toContain('セッションは失敗で畳まれた');
    expect(reply).not.toContain('起きていなかった');
    expect(reply).not.toContain('届いている本文は');
  });
});
