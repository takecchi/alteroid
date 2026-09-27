import { describe, expect, it } from 'vitest';

import type { ManagerDenial, ManagerPool, ManagerSendResult, ManagerSummary } from './manager.js';
import { createProfileService } from './profile-service.js';
import { createCloneTools, type ToolContext } from './tools.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **Issue #1797 / #1798 専用の足場。**
 *
 * `tools.test.ts` の `harness()` と役目は同じだが、この歯専用に複製してある
 * （`manager-closed-failed-cgroup-events.test.ts` の doc と同じ理由——
 * duplicated on purpose）。`manager_report` の「畳まれたターン」経路だけを
 * 測るのに要る最小限だけを持つ——`manager.ts` 本体は経由せず、`ManagerPool`
 * を直接の偽物で差し替えて `ManagerSummary` の欄をそのまま操作する
 * （Issue #1797/#1798 自身の再現方法と同じ——台帳の書き込み経路ではなく、
 * 表示側 `tools.ts` の `manager_report` が受け取った値だけを見る）。
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
    async vacate() {},
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

describe('manager_report: 畳まれたターン（lastFoldedTurn）の回の見出し・注記（#1797 / #1798）', () => {
  /**
   * **#1797 の再現そのもの。** Issue 本文の逐語の値をそのまま使う——
   * `lastReportAt` / `lastReportStatus` は畳まれる前の無関係な古い値、
   * `lastFoldedTurn` は停止後に届いた新しい本文。直した後は、見出しの齢欄
   * （`reportAgeStatus`）にその古い `lastReportAt` が出ないこと、かつ
   * ⚠ drift 注記が「running → stopped」という無関係な食い違いを語らないこと
   * を確かめる。
   */
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

    // 畳まれる前の古い齢は出ない。
    expect(reply).not.toContain('2026-09-01T00:00:00.000Z');
    // 見出しはいまの status を言う。
    expect(reply).toContain('いまの status: `stopped`');
    // 受信時刻は label 側に既に出ている。
    expect(reply).toContain('2026-09-16T00:20:00.000Z');
  });

  /**
   * **#1797: ⚠ drift は、畳まれる前の無関係な status 食い違いを語らない。**
   * Issue 本文の再現は `lastReportStatus: 'running'` と `status: 'stopped'`
   * という食い違いを作ってあったが、これは畳まれる前の別のターンの食い違いで、
   * いま読んでいる畳まれた本文とは無関係——直した後は drift 注記そのものが
   * 出ないことを確かめる（foldedTurn は `status === 'stopped'` の間だけ
   * 書かれる欄なので、いまの status も `stopped` のままなら drift は無い）。
   */
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

  /**
   * **#1797 の裏——drift は「消す」のではなく「その回の材料で組む」。**
   * foldedTurn は `status === 'stopped'` の間だけ書かれる欄なので、書かれた
   * 瞬間の status は構造的に `'stopped'` だったと分かる。もし本当に
   * `status` がその後 `stopped` から離れていれば（例: `manager_send` で
   * 起こし直された）、それは意味のある drift なので、消さずに出す。
   */
  it('⚠ drift は、foldedTurn 到着後に status が動いていれば、その動きを正しく語る（#1797）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.lastFoldedTurn = {
      text: '停止後に届いた畳まれた本文',
      at: '2026-09-16T00:20:00.000Z',
    };
    // 起こし直された後を模す——foldedTurn はまだ残っているが、status は
    // 既に `running` へ動いている（`manager.ts` の `send()` は
    // `lastFoldedTurn` を消さない）。
    target.status = 'running';

    const reply = await h.call('manager_report', { managerId: target.managerId });

    expect(reply).toContain('この報告が台帳へ書かれた時点で');
    expect(reply).toContain('`stopped`');
    expect(reply).toContain('`running`');
  });

  /**
   * **#1798 の再現そのもの。** `lastFailure` は畳まれる前の無関係な古い失敗
   * で、実際に下へ出る本文は普通の発話（`lastFoldedTurn.text`）。直した後は
   * 「この行の下に出る本文は runner が包んだエラー文…であって報告ではない」
   * という予告そのものが出ないこと（＝本文の種類を誤って予告しない）を確かめる。
   */
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
    // 実際の本文はそのまま出る。
    expect(reply).toContain('停止後に届いた畳まれた本文（失敗ではなく普通の発話）');
  });

  /**
   * **監査で見つけた同根の食い違い: denialNote（`describeDenials` の
   * followUp 判定）。** `found.lastReportAt` は `case 'report'` の
   * `stopped` 分岐では更新されないので、foldedTurn がある回に渡すと
   * 「拒否の後の報告はまだ届いていない」と誤判定しうる——実際には
   * foldedTurn（拒否より後に届いた本文）が届いている。直した後は
   * `foldedTurn.at` を使って正しく「届いている」側に倒れることを確かめる。
   */
  it('denialNote は、foldedTurn がある回に foldedTurn.at を「拒否の後の到着」の材料として使う（監査で発見・#1797/#1798 と同根）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0]!;
    target.status = 'stopped';
    // lastReportAt はセットしない——畳まれる前の報告が無い（または古すぎて
    // 消えている）ことを模す。
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

  /**
   * **監査の結果（直していない3つ）: systemErrorNote / cgroupEventsNote /
   * unobservedNote は、到達可能な経路では foldedTurn と食い違わない。**
   * いずれも `found.status === 'failed'`（`unobserved` は `'lost'` も）を
   * ガードに持つが、foldedTurn は `status === 'stopped'` の間だけ書かれ、
   * その分岐も対応する `case 'closed'` の早期 return も `status` を動かさない
   * ——`status` が `stopped` から離れるのは `send()` が直接 `'running'` へ
   * 書く経路だけで、`'failed'`/`'lost'` へは行かない。この歯はその前提を
   * 固定する——`status: 'stopped'` のまま foldedTurn が在っても3つとも
   * 1文字も出ないことを確かめる。
   */
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
