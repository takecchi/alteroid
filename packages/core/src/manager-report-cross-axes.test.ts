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

describe('manager_report は manager_list の3軸を継承する（Issue #1847）', () => {
  it('usageStoppedAt: manager_list と manager_report の両方に同じ字面で出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';
    target.lastReportAt = '2026-09-25T01:20:00.000Z';
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';

    const list = await h.call('manager_list', {});
    const report = await h.call('manager_report', { managerId: target.managerId });

    for (const reply of [list, report]) {
      expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
      expect(reply).toContain('2026-09-25T01:23:45.000Z');
    }
  });

  it('usageStoppedAt が無ければ manager_report も1文字も足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('枠(利用上限)で止まっている');
  });

  // 否定のアサーションは読点を含めたまま残す: 健全な回の文言は「ので、鍵が回れば」（読点あり）、
  // stopped の文言は読点なしの引用なので、読点を落とすと後者にも一致してしまう。
  it('usageStoppedAt + 畳まれたターン（status: stopped）の回は、manager_report も「セッションは生きている」と言わない（#1796/#1847の合流）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.status = 'stopped';
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-26T00:00:00.000Z',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).toContain('2026-09-25T01:23:45.000Z');
    expect(reply).toContain('status: stopped');
    expect(reply).not.toContain('セッションは生きているので、鍵が回ればこの委譲は続く');
    expect(reply).toContain('停止後に届いた畳まれた本文');
    expect(reply).toContain('停止後に届いた、畳まれたターンの中身');
  });

  it('runnerVanished: manager_list と manager_report の両方に同じ字面で出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';
    target.runnerVanished = true;

    const list = await h.call('manager_list', {});
    const report = await h.call('manager_report', { managerId: target.managerId });

    for (const reply of [list, report]) {
      expect(reply).toContain('⚠ 宛先の runner が名簿から消えている');
      expect(reply).toContain(`この委譲の走り始めは ${target.startedAt}`);
      expect(reply).toContain('lost ではない');
    }
  });

  it('runnerVanished が無ければ manager_report も1文字も足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('宛先の runner が名簿から消えている');
  });

  it('未push観測（observed）: manager_list と manager_report の両方に同じ中身で出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      source: 'stop-refusal',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
    };

    const list = await h.call('manager_list', {});
    const report = await h.call('manager_report', { managerId: target.managerId });

    for (const reply of [list, report]) {
      expect(reply).toContain('未push観測');
      expect(reply).toContain('feat/example');
      expect(reply).toContain('manager_stop');
      expect(reply).toContain('非force');
      expect(reply).toContain('manager_list 自身では更新されない');
      expect(reply).not.toContain('枠落ち');
      expect(reply).not.toContain('/workspace/mgr-1/repo');
    }
  });

  it('未push観測（unavailable）: manager_report にも reason が出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';
    target.lastUnpushedWorkObservation = {
      kind: 'unavailable',
      at: '2026-09-20T00:00:00.000Z',
      reason: 'この runner はこの口を持たない（古い版、またはテストの偽物）。',
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('未push観測');
    expect(reply).toContain('取れなかった');
    expect(reply).toContain('この runner はこの口を持たない（古い版、またはテストの偽物）。');
  });

  it('未push観測が無ければ manager_report も1文字も足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('未push観測');
  });

  it('作業ツリー0本で探索の失敗も無い観測は manager_report でも省き、読み残しが在れば出す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      cwd: '/workspace/mgr-1',
      worktrees: [],
    };
    const empty = await h.call('manager_report', { managerId: target.managerId });
    expect(empty).not.toContain('未push観測');

    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      cwd: '/workspace/mgr-1',
      worktrees: [],
      unreadableDirCount: 1,
    };
    const incomplete = await h.call('manager_report', { managerId: target.managerId });
    expect(incomplete).toContain('未push観測');
  });

  it('報告が一度も無い回でも、3軸は manager_report に出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.runnerVanished = true;
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
    };

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).toContain('⚠ 宛先の runner が名簿から消えている');
    expect(reply).toContain('未push観測');
  });

  it('manager_report は part=request では3軸を出さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: '依頼の本文' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.runnerVanished = true;
    target.lastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-20T00:00:00.000Z',
      cwd: '/workspace/mgr-1/repo',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
    };

    const reply = await h.call('manager_report', {
      managerId: target.managerId,
      part: 'request',
    });

    expect(reply).not.toContain('枠(利用上限)で止まっている');
    expect(reply).not.toContain('宛先の runner が名簿から消えている');
    expect(reply).not.toContain('未push観測');
  });
});
