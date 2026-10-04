import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * Issue #1796: `manager_list` の `usageStoppedLine`（`describeUsageStopped`、
 * `tools.ts`）が、委譲の `status` によらず「セッションは生きているので、鍵が
 * 回ればこの委譲は続く」と言い切っていた。`status: 'failed'` / `'lost'` の
 * ように、セッションそのものが既に畳まれている委譲でもこの断定は変わらず、
 * 事実と食い違う（同じ応答の中で `systemErrorLine` が「セッションは失敗で
 * 畳まれた」と言っているのに、隣の行は「セッションは生きている」と言う）。
 *
 * **既存の `tools.test.ts` の harness は使わない。** あちら（#1796 とは別の
 * 作業者が `manager_report` の組み立てを直している最中）へ手を入れると
 * 衝突するため、この歯だけに要る最小限の `ManagerPool` を自前で組み立てる。
 * `manager_list` の実装が実際に呼ぶのは `list()` と `runnerBacklog()` の
 * 2つだけ（`tools.ts` の manager_list ハンドラを確認済み）——それ以外は
 * 呼ばれたら気づけるよう例外を投げる。
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
    async list() {
      // 本物の `list()` と同じく、呼び手が控えた前の状態が後から書き換わら
      // ないよう写しを返す（`tools.test.ts` の harness と同じ作法）。
      return managers.map((manager) => ({ ...manager }));
    },
    denials() {
      // manager_list は各行の拒否注記のために毎回これを読む——投げると
      // 全ての歯が同じ理由で落ちる（`denialLine`。`tools.ts`）。この歯では
      // 拒否そのものは測らないので、常に空で返す。
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

describe('manager_list: usageStoppedAt の注記は status で言い分ける（Issue #1796）', () => {
  it('status: running（陽性対照）では「セッションは生きている」と言い切ってよい', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.status = 'running';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).toContain('セッションは生きている');
  });

  it('status: failed では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.status = 'failed';

    const reply = await h.call('manager_list', {});

    // 枠で止まった事実そのものは引き続き出す。
    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).toContain('2026-09-25T01:23:45.000Z');
    // **しかし「セッションは生きている」と言い切らない**——status が
    // 既にセッションの死を確定させているので、これは事実と食い違う。
    expect(reply).not.toContain('セッションは生きているので、鍵が回ればこの委譲は続く');
  });

  it('status: lost では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.status = 'lost';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).not.toContain('セッションは生きているので、鍵が回ればこの委譲は続く');
  });

  /**
   * `abort()` は `usageStoppedAt` に触れない（`manager.ts` の `#confirmStoppedAndReleaseLease`
   * を確認済み）——枠で止まっていた委譲がそのまま人間・クローンに止められると、
   * 印が残ったまま `status: 'stopped'` になる。**`isManagerOutcomeUnobserved`
   * （`failed` / `lost`）はこの回を含まない**——最初の実装（PR #1857 の下書き）は
   * ここを見落として `stopped` を除いており、この歯を実際に反転して確かめた
   * （直す前は「セッションは生きている」を言ったままだった）。「望んだ終端か」と
   * 「セッションが生きているか」は別の軸で、`stopped` も `failed`/`lost` と同じく
   * `isLive()` が確認済みで死んでいると扱う側である（`manager.ts` の `isLive()`
   * の doc「`stopped` も `lost` と同じ列に置く」）。
   */
  it('status: stopped では「セッションは生きている」と言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.status = 'stopped';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('⚠ 枠(利用上限)で止まっている');
    expect(reply).not.toContain('セッションは生きているので、鍵が回ればこの委譲は続く');
  });

  /**
   * Issue #1882 の追記: `manager_send`（`manager.ts` の `send()`）は `status`
   * を見ずに `#load()` で `ManagerRecord` を作り直すので、`stopped` でも
   * resume は実際に試みられる——`isManagerOutcomeUnobserved` の枝は前から
   * 「起こし直すには manager_send で resume を試みるしかなく、届く保証は
   * 無い」と言っていたが、`stopped` の枝はここを持たず「ここでは成り立たない」
   * で言い切って終わっていた。
   */
  it('status: stopped でも、起こし直しは resume を試みるしかなく届く保証が無いことを言う', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.managers[0];
    if (!target) throw new Error('準備に失敗');
    target.usageStoppedAt = '2026-09-25T01:23:45.000Z';
    target.status = 'stopped';

    const reply = await h.call('manager_list', {});

    expect(reply).toContain(
      '起こし直すには manager_send で resume を試みるしかなく、届く保証は無い',
    );
  });
});
