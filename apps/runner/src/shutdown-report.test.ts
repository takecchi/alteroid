import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  query as sdkQuery,
  HookCallback,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatOutboxShutdownReport, Outbox, type OutboxShutdownSnapshot } from './app.js';
import { drainAndReportOutbox, DRAIN_POLL_INTERVAL_MS, waitForOutboxDrain } from './index.js';

/**
 * #634 — 脚が落ちたまま runner を焼き直すと、溜まっていた出来事（`archive`
 * を含む）が名指しされずに消えることへの対応。
 *
 * 3つの層を分けて測る:
 * 1. `Outbox.describeForShutdown` / `formatOutboxShutdownReport`（純粋な
 *    整形ロジック——`RunnerEvent` を直接組み立てて `push()` するだけで測れる）
 * 2. `waitForOutboxDrain` / `drainAndReportOutbox`（`index.ts` の待ち・書く
 *    ロジック——`write` を注入してテストする。本番は `writeStderrSync`）
 * 3. 実物の統合——`createRunnerHost`（`@alteroid/core`）と本物の `Outbox` を
 *    組み合わせ、listener を付けずに `Host#shutdown()` を通すと `archive` が
 *    箱に残ることを確かめる
 */

describe('Outbox.describeForShutdown / formatOutboxShutdownReport（#634）', () => {
  it('何も残っていなければ null（1行も書かない）', () => {
    const outbox = new Outbox();
    expect(formatOutboxShutdownReport(outbox.describeForShutdown())).toBeNull();
  });

  it('#queue の内訳を種別・managerId ごとに数え、archive を含む場合は archive と managerId が文面に出る。「残っている」ではなく「失われる」と書く', () => {
    const outbox = new Outbox();
    outbox.push({ type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' });
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: '生ログの控え' });
    outbox.push({ type: 'archive', managerId: 'mgr-2', body: '別マネージャーの控え' });
    outbox.push({ type: 'note', managerId: 'mgr-1', text: '何か起きた' });

    const snapshot = outbox.describeForShutdown();
    expect(snapshot.queue.count).toBe(4);
    expect(snapshot.subscriber).toEqual({ status: 'never-subscribed' });

    const archiveGroups = snapshot.queue.groups.filter((group) => group.type === 'archive');
    expect(archiveGroups).toHaveLength(2);
    expect(archiveGroups.map((group) => group.managerId).sort()).toEqual(['mgr-1', 'mgr-2']);
    expect(archiveGroups.every((group) => group.count === 1)).toBe(true);

    const report = formatOutboxShutdownReport(snapshot);
    expect(report).not.toBeNull();
    // ⚠️ ここが基準そのもの — archive と managerId が文面に必ず出ること。
    expect(report).toContain('type=archive managerId=mgr-1');
    expect(report).toContain('type=archive managerId=mgr-2');
    // ⚠️ ここも基準そのもの — 「残っている」だけでなく「失われる」と読める
    // 字が出ること（依頼者第一基準:「失われたなら、失われたことが分かる」）。
    expect(report).toContain('出来事が 4 件、このプロセスの終了と一緒に失われる');
    expect(report).toContain('process.exit(0)');
    expect(report).toContain('プロセス内メモリだけ');
  });

  it('同じ種別・managerId の複数件は1組にまとまり、いちばん古い queuedAt を持つ', () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const outbox = new Outbox(() => now.toISOString());
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: '1件目' });
    now = new Date('2026-01-01T00:00:10.000Z');
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: '2件目' });

    const snapshot = outbox.describeForShutdown();
    expect(snapshot.queue.groups).toHaveLength(1);
    const [group] = snapshot.queue.groups;
    expect(group).toMatchObject({
      type: 'archive',
      managerId: 'mgr-1',
      count: 2,
      oldestAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('hello イベントは managerId を持たないので、内訳の managerId が省かれる', () => {
    const outbox = new Outbox();
    outbox.push({ type: 'hello', runnerId: 'runner-x' });
    const snapshot = outbox.describeForShutdown();
    expect(snapshot.queue.groups).toEqual([
      { type: 'hello', count: 1, oldestAt: expect.any(String) as unknown as string },
    ]);
    expect(snapshot.queue.groups[0]).not.toHaveProperty('managerId');
  });

  it('購読側（#probe）の内訳は取れない旨を文面に出す。「一度も無い」とは別の文面', () => {
    const noSubscriber: OutboxShutdownSnapshot = {
      queue: { count: 0, groups: [] },
      subscriber: { status: 'never-subscribed' },
    };
    expect(formatOutboxShutdownReport(noSubscriber)).toBeNull();

    const withSubscriber: OutboxShutdownSnapshot = {
      queue: { count: 0, groups: [] },
      subscriber: { status: 'subscribed', count: 2, oldestAt: '2026-01-01T00:00:00.000Z' },
    };
    const report = formatOutboxShutdownReport(withSubscriber);
    expect(report).not.toBeNull();
    expect(report).toContain('購読側が抱えている分: 2 件');
    expect(report).toContain('内訳は取れない');
    expect(report).not.toContain('購読が一度も無い');
  });

  /**
   * #634 コーディネーター指摘(2) — 「一度も購読が無い」と「購読されていた
   * が、いま切れている」を同じ `null` で潰さない。3状態それぞれの文面を
   * 固定する。
   */
  describe('購読側の3状態（一度も無い／いま購読されている／切れている）を混同しない', () => {
    it('一度も購読が無い: never-subscribed', () => {
      const outbox = new Outbox();
      expect(outbox.describeForShutdown().subscriber).toEqual({ status: 'never-subscribed' });
    });

    it('いま購読されている（#probe あり）: subscribed に件数・最古時刻が乗る', () => {
      const outbox = new Outbox();
      const detach = outbox.attach(
        () => undefined,
        () => ({ count: 3, oldestAt: '2026-01-01T00:00:00.000Z' }),
      );
      expect(outbox.describeForShutdown().subscriber).toEqual({
        status: 'subscribed',
        count: 3,
        oldestAt: '2026-01-01T00:00:00.000Z',
      });
      detach();
    });

    it('いま購読されている（#probe 無し）: subscribed だが件数は乗らない（0とは違う）', () => {
      const outbox = new Outbox();
      const detach = outbox.attach(() => undefined);
      expect(outbox.describeForShutdown().subscriber).toEqual({ status: 'subscribed' });
      detach();
    });

    it('過去に購読されていたが、いま切れている: detached。件数は取れない（0 を書かない）', () => {
      const outbox = new Outbox();
      const detach = outbox.attach(
        () => undefined,
        () => ({ count: 5, oldestAt: '2026-01-01T00:00:00.000Z' }),
      );
      detach();
      const snapshot = outbox.describeForShutdown();
      expect(snapshot.subscriber).toEqual({ status: 'detached' });
      // ⚠️ ここが基準そのもの — 5件という古い値を引きずらないこと
      // （detach 前の #probe の値を絶対に読まない）。
      expect(snapshot.subscriber).not.toHaveProperty('count');
    });

    it('文面: never-subscribed は「該当なし」、detached は「件数は取れない」、subscribed（#probe あり）は件数を出す——3つとも別の字面', () => {
      const never = formatOutboxShutdownReport({
        queue: {
          count: 1,
          groups: [{ type: 'note', managerId: 'mgr-1', count: 1, oldestAt: 'x' }],
        },
        subscriber: { status: 'never-subscribed' },
      });
      const detached = formatOutboxShutdownReport({
        queue: {
          count: 1,
          groups: [{ type: 'note', managerId: 'mgr-1', count: 1, oldestAt: 'x' }],
        },
        subscriber: { status: 'detached' },
      });
      const subscribed = formatOutboxShutdownReport({
        queue: {
          count: 1,
          groups: [{ type: 'note', managerId: 'mgr-1', count: 1, oldestAt: 'x' }],
        },
        subscriber: { status: 'subscribed', count: 2, oldestAt: 'y' },
      });

      expect(never).toContain('購読が一度も無いので該当なし');
      expect(detached).toContain('過去に購読されていたが、いま切れている');
      expect(detached).toContain('件数は取れない');
      expect(subscribed).toContain('購読側が抱えている分: 2 件');

      // 3つとも文面が違うこと（混同していないことの直接証拠）。
      expect(new Set([never, detached, subscribed]).size).toBe(3);
    });

    /**
     * `#queue` が空でも、`detached` なら黙らない（依頼者第4基準——静かに
     * 失敗する形を作りこまない）。0件だったと決めつけない。
     */
    it('#queue が0件でも、detached なら黙らずに「件数不明」と書く', () => {
      const outbox = new Outbox();
      const detach = outbox.attach(() => undefined);
      detach();
      expect(outbox.pending).toBe(0);

      const snapshot = outbox.describeForShutdown();
      expect(snapshot.queue.count).toBe(0);
      expect(snapshot.subscriber).toEqual({ status: 'detached' });

      const report = formatOutboxShutdownReport(snapshot);
      expect(report).not.toBeNull();
      expect(report).toContain('残っているものは無いが');
      expect(report).toContain('切れており');
      expect(report).toContain('0件だったとは言い切れない');
    });
  });
});

describe('Outbox.subscribed（#634）', () => {
  it('listener が付いていなければ false、attach すると true、detach で false に戻る', () => {
    const outbox = new Outbox();
    expect(outbox.subscribed).toBe(false);
    const detach = outbox.attach(() => undefined);
    expect(outbox.subscribed).toBe(true);
    detach();
    expect(outbox.subscribed).toBe(false);
  });

  it('detach 後も subscribed は false のまま——describeForShutdown 側の「一度は購読された」記憶とは別の軸', () => {
    const outbox = new Outbox();
    const detach = outbox.attach(() => undefined);
    detach();
    expect(outbox.subscribed).toBe(false);
    // `subscribed` は「いま」だけを見る。「一度でも購読されたか」は
    // `describeForShutdown().subscriber.status` の側が持つ。
    expect(outbox.describeForShutdown().subscriber).toEqual({ status: 'detached' });
  });
});

describe('waitForOutboxDrain（#634）', () => {
  it('listener が付いていなければ、pending が残っていても即座に返る（1ミリ秒も待たない）', async () => {
    const outbox = new Outbox();
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: 'x' });
    expect(outbox.subscribed).toBe(false);
    expect(outbox.pending).toBeGreaterThan(0);

    const start = Date.now();
    await waitForOutboxDrain(outbox, 5_000);
    const elapsed = Date.now() - start;
    // 待っていれば `DRAIN_POLL_INTERVAL_MS` 以上かかるはず——それより十分
    // 短ければ「待たなかった」と読める。
    expect(elapsed).toBeLessThan(DRAIN_POLL_INTERVAL_MS);
  });

  it('listener が付いていても pending が既に0なら、タイムアウトを待たず即座に返る', async () => {
    const outbox = new Outbox();
    // listener 付きの push() はそのまま listener へ渡り、#queue には積まれ
    // ない（`Outbox.pending` の doc）——`#probe` も渡していないので pending
    // は常に0のままである。
    const detach = outbox.attach(() => undefined);
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: 'x' });
    expect(outbox.pending).toBe(0);

    const start = Date.now();
    await waitForOutboxDrain(outbox, 5_000);
    expect(Date.now() - start).toBeLessThan(DRAIN_POLL_INTERVAL_MS);
    detach();
  });

  it('listener が付いていて pending が残っていれば待ち、外から0になったら即座に返る', async () => {
    const outbox = new Outbox();
    let pendingCount = 3;
    const detach = outbox.attach(
      () => undefined,
      () => ({ count: pendingCount }),
    );
    expect(outbox.pending).toBe(3);

    const waitPromise = waitForOutboxDrain(outbox, 5_000);
    // ポーリング間隔の少し後で「捌けた」ことにする。
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS * 2));
    pendingCount = 0;

    const start = Date.now();
    await waitPromise;
    // 捌けた後、次のポーリングまでの遅延だけで返るはず（タイムアウトの
    // 5000ms 全部を使い切らない）。
    expect(Date.now() - start).toBeLessThan(5_000);
    detach();
  });

  it('listener は付いているが捌けないまま、タイムアウトで諦める（例外は投げない）', async () => {
    const outbox = new Outbox();
    const detach = outbox.attach(
      () => undefined,
      () => ({ count: 1 }),
    );
    const start = Date.now();
    await waitForOutboxDrain(outbox, DRAIN_POLL_INTERVAL_MS * 3);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(DRAIN_POLL_INTERVAL_MS * 2);
    detach();
  });

  it('待っている途中で listener が外れたら、タイムアウトを待たずに諦める', async () => {
    const outbox = new Outbox();
    const detach = outbox.attach(
      () => undefined,
      () => ({ count: 1 }),
    );
    const waitPromise = waitForOutboxDrain(outbox, 5_000);
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS * 2));
    detach();

    const start = Date.now();
    await waitPromise;
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe('drainAndReportOutbox（#634）', () => {
  it('listener が無ければ待たずに、残っているものを注入した write へ書く', async () => {
    const outbox = new Outbox();
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: '生ログ' });
    outbox.push({ type: 'report', managerId: 'mgr-1', text: '報告', status: 'done' });

    const written: string[] = [];
    const start = Date.now();
    await drainAndReportOutbox(outbox, { write: (line) => written.push(line) });
    expect(Date.now() - start).toBeLessThan(DRAIN_POLL_INTERVAL_MS);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('type=archive managerId=mgr-1');
    expect(written[0]).toContain('type=report managerId=mgr-1');
  });

  it('何も残っていなければ write は1度も呼ばれない', async () => {
    const outbox = new Outbox();
    const written: string[] = [];
    await drainAndReportOutbox(outbox, { write: (line) => written.push(line) });
    expect(written).toHaveLength(0);
  });

  it('listener が付いていれば waitMs の分だけ待ってから書く', async () => {
    const outbox = new Outbox();
    const detach = outbox.attach(
      () => undefined,
      () => ({ count: 1, oldestAt: '2026-01-01T00:00:00.000Z' }),
    );
    const written: string[] = [];
    const start = Date.now();
    await drainAndReportOutbox(outbox, {
      waitMs: DRAIN_POLL_INTERVAL_MS * 3,
      write: (line) => written.push(line),
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(DRAIN_POLL_INTERVAL_MS * 2);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('購読側が抱えている分: 1 件');
    expect(written[0]).toContain('内訳は取れない');
    detach();
  });
});

// ---------------------------------------------------------------------------
// 実物の統合: 本物の Outbox + 本物の Host（createRunnerHost）
// ---------------------------------------------------------------------------

interface FakeSession {
  postToolUse(input: unknown): Promise<unknown>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let finish: (() => void) | null = null;

    sessions.push({
      async postToolUse(input) {
        const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        return hook(input as never, undefined, { signal: new AbortController().signal } as never);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-shutdown-report',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-shutdown-report-'));
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
  rmSync(dir, { recursive: true, force: true });
});

describe('listener が付いていないまま畳む経路（Host#shutdown()）を通ると archive が箱に残る（#634）', () => {
  it('listener を一度も attach していない Outbox へ、shutdown() 後に archive が積まれている', async () => {
    const outbox = new Outbox();
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-shutdown-report-test',
      workspacePath: '/work/project',
      emit: (event) => outbox.push(event),
      queryFn: fn,
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-shutdown', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');

    const transcriptPath = join(dir, 'transcript.jsonl');
    const body = '畳む直前に控えた生ログ（shutdown-report テスト）';
    writeFileSync(transcriptPath, body, 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });

    // **ここが基準そのもの** — listener を一度も付けずに Host#shutdown() を
    // 通す（脚が落ちたまま runner が焼き直される、という #634 の前提そのもの）。
    expect(outbox.subscribed).toBe(false);
    await host.shutdown();

    const snapshot = outbox.describeForShutdown();
    const archiveGroup = snapshot.queue.groups.find((group) => group.type === 'archive');
    expect(archiveGroup).toBeDefined();
    expect(archiveGroup?.managerId).toBe('mgr-shutdown');

    const report = formatOutboxShutdownReport(snapshot);
    expect(report).toContain('type=archive managerId=mgr-shutdown');
  });

  it('listener が付いていれば（脚が繋がっていれば）、shutdown() 後の drainAndReportOutbox は捌けるのを待って書かずに済ませられる', async () => {
    const outbox = new Outbox();
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-shutdown-report-connected-test',
      workspacePath: '/work/project',
      emit: (event) => outbox.push(event),
      queryFn: fn,
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-shutdown-2', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');

    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, '脚が繋がっているケースの生ログ', 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });

    // listener を付ける — push() された出来事はそのまま listener へ渡り、
    // #queue には積まれない（実際に配れている状態を模す）。
    const delivered: unknown[] = [];
    const detach = outbox.attach((event) => delivered.push(event));

    await host.shutdown();
    expect(outbox.subscribed).toBe(true);

    const written: string[] = [];
    await drainAndReportOutbox(outbox, { write: (line) => written.push(line) });

    // listener が直接受け取っているので #queue は空——「待って捌けた」結果、
    // 書くべきものが無い（`push()` が listener 付きのとき `#queue` を経由
    // しないのと同じ非対称。`Outbox.pending` の doc）。
    expect(delivered.some((event) => (event as { type?: string }).type === 'archive')).toBe(true);
    expect(written).toHaveLength(0);
    detach();
  });
});
