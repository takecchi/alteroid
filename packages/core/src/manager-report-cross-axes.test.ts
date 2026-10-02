import { describe, expect, it } from 'vitest';

import type { ManagerDenial, ManagerPool, ManagerSendResult, ManagerSummary } from './manager.js';
import { createProfileService } from './profile-service.js';
import { createCloneTools, type ToolContext } from './tools.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **Issue #1847 専用の足場。**
 *
 * `tools.test.ts` の `harness()` と役目は同じだが、この歯専用に複製してある
 * （`manager-closed-failed-cgroup-events.test.ts` の doc と同じ理由——
 * duplicated on purpose）。`manager_list` と `manager_report` を同じ
 * `ManagerSummary` に対して続けて呼び、同じ3軸（枠(利用上限)で止まっている／
 * runner 消失／未push観測）が両方の面に同じ字面で出ることだけを測る——
 * `manager.ts` 本体（台帳の書き込み経路）は経由しない。
 */
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
    async appraise(managerId: string) {
      return {
        outcome: 'absent' as const,
        detail: `${managerId} というマネージャーは台帳に居ない。`,
        previous: null,
      };
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
  /**
   * **軸1: 枠(利用上限)で止まっている。** `manager_list` と同じ字面
   * （`describeUsageStopped` 1箇所が生成元）が `manager_report` にも出る
   * こと、時刻も一致することを測る。
   */
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

  /** ⭐ **陰性対照**。`usageStoppedAt` が無ければ `manager_report` も1文字も足さない。 */
  it('usageStoppedAt が無ければ manager_report も1文字も足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('枠(利用上限)で止まっている');
  });

  /**
   * **#1857 との合流点。** `describeUsageStopped`（生成元は1箇所、`manager_list`
   * と共有）は status で文言を分けるようになった（Issue #1796）——`stopped`
   * （畳まれたターンが在る回はこの値になる。`manager.ts` の `case 'report'`
   * の `stopped` 早期return分岐が `lastFoldedTurn` だけを書く）では「セッション
   * は生きている」と言い切らない。`manager_report` はその生成元をそのまま
   * 呼ぶだけ（`tools.ts` に foldedTurn 専用の分岐は無い）なので、単に
   * reuse するだけでここが正しく振る舞うことを固定する——`describeUsageStopped`
   * 側の歯（`tools-usage-stopped.test.ts`）は `manager_list` しか測っていない。
   *
   * **アサーションの文言は意図して読点の有無で分けてある**（`tools-usage-stopped.test.ts`
   * の同名の歯と同じ理由）——健全な回の文言は「セッションは生きているので、
   * 鍵が回れば」（読点あり）、`stopped` の文言は「セッションは生きているので
   * 鍵が回れば」（読点なし、否定文の中の引用）で、読点を落とすと後者にも
   * 誤って一致してしまう。
   */
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
    // **畳まれたターン自体の表示（#1862）も同時に壊れていないことを確かめる**
    // ——同じ応答に両方の注記が並ぶので、片方の実装がもう片方を消していないか。
    expect(reply).toContain('停止後に届いた畳まれた本文');
    expect(reply).toContain('停止後に届いた、畳まれたターンの中身');
  });

  /**
   * **軸2: runner が名簿から消えている。** 生成元は `describeRunnerVanished`
   * 1箇所——`manager_list` と `manager_report` は同じ文言を共有する。
   */
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

  /** ⭐ **陰性対照**。`runnerVanished` が無ければ `manager_report` も1文字も足さない。 */
  it('runnerVanished が無ければ manager_report も1文字も足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('宛先の runner が名簿から消えている');
  });

  /**
   * **軸3: 未push観測。** `manager_list` はこの行の先頭に一覧表示専用の
   * 2字下げを埋め込んで返す（`describeUnpushedWorkObservation` の doc）。
   * `manager_report` はその飾りだけを落とした同じ文言を出す——中身
   * （由来の説明・branch 名）は1文字も変えていないことを測る。
   */
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
      // 経路は観測の `source` から言う。器の入れ替え・枠落ちでも更新されうるので、
      // 「枠落ちでは更新されない」と決め打ちしない（#1266、PR #2545）。
      expect(reply).toContain('manager_list 自身では更新されない');
      expect(reply).not.toContain('枠落ち');
      // 探索の起点の絶対パスは出さない（`unpushedWorkTreeSchema` の doc）。
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

  /** ⭐ **陰性対照**。未push観測が無ければ `manager_report` も1文字も足さない。 */
  it('未push観測が無ければ manager_report も1文字も足さない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastReport = '途中経過';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).not.toContain('未push観測');
  });

  /**
   * **報告が一度も届いていない回（body が空）でも、3軸は独立して出る。**
   * 「報告が空だからこちらも出さない」にはしない——`describeManagerSystemError`
   * / `describeDenials` と同じ理由（この回こそ、依頼者が委譲の生死を判断する
   * のに必要な材料が集まる場所である）。
   */
  it('報告が一度も無い回でも、3軸は manager_report に出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    // lastReport はセットしない——「まだ書いていない」を模す。
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

  /**
   * **`part: 'request'` では3軸も出さない。** 依頼文はそもそも報告では
   * ないので、他の軸（`failure` / `systemError` / `denied` / `unobserved`）
   * と同じ線——セッションの状態観測は依頼文の応答には混ぜない。
   */
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
