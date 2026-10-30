import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  query as sdkQuery,
  HookCallback,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { captureStderr, createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { formatOutboxShutdownReport, Outbox, type OutboxShutdownSnapshot } from './app.js';
import { drainAndReportOutbox, waitForOutboxDrain } from './index.js';
import {
  connectedSubscriber,
  stuckSubscriber,
  writeAll,
} from './outbox-subscribers.test-support.js';

// #5692 段2: 畳む報告は、まだデーモンへ届けていない分（`pending` と同じ範囲）を、購読の有無を分けずに内訳つきで1か所に出す。
// 以前（#629）は「自分の待ち行列」と「購読側（一度も無い／いま／切れている）」の2か所に分けて書いていた。
// 守る事故: #629（7時間半詰まって未送出 477 件のまま焼き直した。畳むとき何が失われるかを名指しする）。

function session(id: string): RunnerEvent {
  return { type: 'session', managerId: `mgr-${id}`, sessionId: `sess-${id}` };
}

describe('Outbox.describeForShutdown / formatOutboxShutdownReport（#629）', () => {
  it('何も残っていなければ null（1行も書かない）', () => {
    const outbox = new Outbox();
    expect(formatOutboxShutdownReport(outbox.describeForShutdown())).toBeNull();
  });

  it('届けていない分を種別・managerId ごとに数え、archive を含む場合は archive と managerId が文面に出る。「残っている」ではなく「失われる」と書く', () => {
    const outbox = new Outbox();
    outbox.push({ type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' });
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: '生ログの控え' });
    outbox.push({ type: 'archive', managerId: 'mgr-2', body: '別マネージャーの控え' });
    outbox.push({ type: 'note', managerId: 'mgr-1', text: '何か起きた' });

    const snapshot = outbox.describeForShutdown();
    expect(snapshot.count).toBe(4);

    const archiveGroups = snapshot.groups.filter((group) => group.type === 'archive');
    expect(archiveGroups).toHaveLength(2);
    expect(archiveGroups.map((group) => group.managerId).sort()).toEqual(['mgr-1', 'mgr-2']);
    expect(archiveGroups.every((group) => group.count === 1)).toBe(true);

    const report = formatOutboxShutdownReport(snapshot);
    expect(report).not.toBeNull();
    expect(report).toContain('type=archive managerId=mgr-1');
    expect(report).toContain('type=archive managerId=mgr-2');
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
    expect(snapshot.groups).toHaveLength(1);
    const [group] = snapshot.groups;
    expect(group).toMatchObject({
      type: 'archive',
      managerId: 'mgr-1',
      count: 2,
      oldestAt: '2026-01-01T00:00:00.000Z',
    });
    expect(snapshot.oldestAt).toBe('2026-01-01T00:00:00.000Z');
    expect(formatOutboxShutdownReport(snapshot)).toContain('（最古 2026-01-01T00:00:00.000Z）');
  });

  it('hello イベントは managerId を持たないので、内訳の managerId が省かれる', () => {
    const outbox = new Outbox();
    outbox.push({ type: 'hello', runnerId: 'runner-x' });
    const snapshot = outbox.describeForShutdown();
    expect(snapshot.groups).toEqual([
      { type: 'hello', count: 1, oldestAt: expect.any(String) as unknown as string },
    ]);
    expect(snapshot.groups[0]).not.toHaveProperty('managerId');
  });

  it('0 件のスナップショットは null。件数があれば最古の時刻と内訳の行を出し、購読側の欄は持たない', () => {
    const none: OutboxShutdownSnapshot = { count: 0, groups: [] };
    expect(formatOutboxShutdownReport(none)).toBeNull();

    const some: OutboxShutdownSnapshot = {
      count: 2,
      oldestAt: '2026-01-01T00:00:00.000Z',
      groups: [
        { type: 'note', managerId: 'mgr-1', count: 2, oldestAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const report = formatOutboxShutdownReport(some);
    expect(report).not.toBeNull();
    expect(report).toContain('出来事が 2 件、このプロセスの終了と一緒に失われる');
    expect(report).toContain('（最古 2026-01-01T00:00:00.000Z）');
    expect(report).toContain('type=note managerId=mgr-1 count=2 oldest=2026-01-01T00:00:00.000Z');
    expect(report).not.toContain('購読側');
  });

  describe('購読の有無で内訳が変わらない（以前は「購読側は件数不明・内訳は取れない」だった。#629）', () => {
    it('読まなくなった購読が付いたままでも、届けていない分は内訳つきで名指しされる', () => {
      const outbox = new Outbox(() => '2026-01-01T00:00:00.000Z');
      const stuck = stuckSubscriber(outbox);
      outbox.push(session('1'));
      outbox.push({ type: 'archive', managerId: 'mgr-1', body: '生ログの控え' });
      outbox.push({ type: 'archive', managerId: 'mgr-1', body: '2件目' });

      const snapshot = outbox.describeForShutdown();
      expect(snapshot.count).toBe(3);
      expect(snapshot.oldestAt).toBe('2026-01-01T00:00:00.000Z');
      expect(snapshot.groups.find((group) => group.type === 'archive')).toMatchObject({
        managerId: 'mgr-1',
        count: 2,
      });
      const report = formatOutboxShutdownReport(snapshot);
      expect(report).toContain('出来事が 3 件、このプロセスの終了と一緒に失われる');
      expect(report).toContain('type=archive managerId=mgr-1 count=2');
      expect(report).not.toContain('件数は取れない');
      expect(report).not.toContain('内訳は取れない');
      stuck.detach();
    });

    it('購読が外れたあとも、届けていない分は同じ内訳で名指しされる（「件数不明」と書かない）', () => {
      const outbox = new Outbox();
      const stuck = stuckSubscriber(outbox);
      outbox.push({ type: 'archive', managerId: 'mgr-1', body: '生ログの控え' });
      stuck.detach();

      const snapshot = outbox.describeForShutdown();
      expect(snapshot.count).toBe(1);
      const report = formatOutboxShutdownReport(snapshot);
      expect(report).toContain('type=archive managerId=mgr-1');
      expect(report).not.toContain('件数不明');
      expect(report).not.toContain('件数は取れない');
    });

    it('購読していた接続が全部書き終えていれば、0 件なので何も書かない（切れていたことを理由に書かない）', () => {
      const outbox = new Outbox();
      const detach = connectedSubscriber(outbox, () => undefined);
      outbox.push(session('1'));
      outbox.push(session('2'));
      detach();

      expect(outbox.pending).toBe(0);
      expect(formatOutboxShutdownReport(outbox.describeForShutdown())).toBeNull();
    });

    it('繋ぎ直しで読み返している最中の分も、届けていない分として数える（pending と同じ範囲）', () => {
      const outbox = new Outbox(() => '2026-01-01T00:00:00.000Z');
      outbox.push(session('1'));
      outbox.push(session('2'));
      outbox.push(session('3'));
      writeAll(outbox);
      expect(outbox.describeForShutdown().count).toBe(0);

      const subscription = outbox.subscribe({ lastEventId: 0, wake: () => undefined });
      expect(outbox.pending).toBe(3);
      expect(outbox.describeForShutdown().count).toBe(3);
      const first = subscription.peek();
      if (first === undefined) throw new Error('読み返す1件目が無い');
      subscription.wrote(first);
      expect(outbox.describeForShutdown().count).toBe(2);
      subscription.detach();
      // 外れたら、書き終えた連番の後ろだけ
      expect(outbox.describeForShutdown().count).toBe(0);
    });
  });
});

describe('Outbox.subscribed（#629）', () => {
  it('購読が付いていなければ false、subscribe すると true、detach で false に戻る', () => {
    const outbox = new Outbox();
    expect(outbox.subscribed).toBe(false);
    const detach = connectedSubscriber(outbox, () => undefined);
    expect(outbox.subscribed).toBe(true);
    detach();
    expect(outbox.subscribed).toBe(false);
  });
});

// 守る事故: #629（畳むとき、デーモンが取り切る前に口を閉じて、出し箱の中身を捨てた）。待ち時間は偽の時計で進める（実時間を待たない・待ち時間の引数を持たない）
describe('waitForOutboxDrain（#629）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 待たずに返る: 偽の時計だと、1回でも setTimeout を待てば進めない限り終わらない（= 試験が詰まって落ちる）
  it('購読が付いていなければ、pending が残っていても即座に返る（1ミリ秒も待たない）', async () => {
    vi.useFakeTimers();
    const outbox = new Outbox();
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: 'x' });
    expect(outbox.subscribed).toBe(false);
    expect(outbox.pending).toBeGreaterThan(0);

    const start = Date.now();
    await waitForOutboxDrain(outbox);
    expect(Date.now() - start).toBe(0);
  });

  it('購読が付いていても pending が既に0なら、タイムアウトを待たず即座に返る', async () => {
    vi.useFakeTimers();
    const outbox = new Outbox();
    const detach = connectedSubscriber(outbox, () => undefined);
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: 'x' });
    expect(outbox.pending).toBe(0);

    const start = Date.now();
    await waitForOutboxDrain(outbox);
    expect(Date.now() - start).toBe(0);
    detach();
  });

  it('購読が付いていて pending が残っていれば待ち、外から0になったら次の確認で返る', async () => {
    vi.useFakeTimers();
    const outbox = new Outbox();
    const stuck = stuckSubscriber(outbox);
    for (let i = 0; i < 3; i += 1) outbox.push(session(String(i)));
    expect(outbox.pending).toBe(3);

    let settled = false;
    const waitPromise = waitForOutboxDrain(outbox).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    stuck.drain();
    await vi.advanceTimersByTimeAsync(50);
    await waitPromise;
    expect(settled).toBe(true);
    stuck.detach();
  });

  it('購読は付いているが捌けないまま、3 秒のタイムアウトで諦める（例外は投げない）', async () => {
    vi.useFakeTimers();
    const outbox = new Outbox();
    const stuck = stuckSubscriber(outbox);
    outbox.push(session('1'));

    let settled = false;
    const waitPromise = waitForOutboxDrain(outbox).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waitPromise;
    expect(settled).toBe(true);
    stuck.detach();
  });

  it('待っている途中で購読が外れたら、タイムアウトを待たずに諦める', async () => {
    vi.useFakeTimers();
    const outbox = new Outbox();
    const stuck = stuckSubscriber(outbox);
    outbox.push(session('1'));

    let settled = false;
    const waitPromise = waitForOutboxDrain(outbox).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    stuck.detach();
    await vi.advanceTimersByTimeAsync(50);
    await waitPromise;
    expect(settled).toBe(true);
  });
});

// 守る事故: #629（7時間半詰まって未送出 477 件のまま焼き直した。畳むとき何が失われるかを stderr に名指しする）
describe('drainAndReportOutbox（#629）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('購読が無ければ待たずに、残っているものを stderr へ書く', async () => {
    vi.useFakeTimers();
    const outbox = new Outbox();
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: '生ログ' });
    outbox.push({ type: 'report', managerId: 'mgr-1', text: '報告', status: 'done' });

    const start = Date.now();
    const written = await captureStderr(() => drainAndReportOutbox(outbox));
    expect(Date.now() - start).toBe(0);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('type=archive managerId=mgr-1');
    expect(written[0]).toContain('type=report managerId=mgr-1');
  });

  it('何も残っていなければ stderr へ1行も書かない', async () => {
    const outbox = new Outbox();
    const written = await captureStderr(() => drainAndReportOutbox(outbox));
    expect(written).toHaveLength(0);
  });

  it('購読が付いていれば 3 秒待ってから、捌けなかった分を名指しして書く', async () => {
    vi.useFakeTimers();
    const outbox = new Outbox(() => '2026-01-01T00:00:00.000Z');
    const stuck = stuckSubscriber(outbox);
    outbox.push({ type: 'archive', managerId: 'mgr-1', body: '生ログ' });

    const written = await captureStderr(async () => {
      let settled = false;
      const done = drainAndReportOutbox(outbox).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('出来事が 1 件、このプロセスの終了と一緒に失われる');
    expect(written[0]).toContain('type=archive managerId=mgr-1');
    expect(written[0]).not.toContain('内訳は取れない');
    stuck.detach();
  });
});

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
  dir = makeTempDirSync('alteroid-shutdown-report-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('購読が付いていないまま畳む経路（Host#shutdown()）を通ると archive が箱に残る（#629）', () => {
  it('購読を一度も付けていない Outbox へ、shutdown() 後に archive が積まれている', async () => {
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

    expect(outbox.subscribed).toBe(false);
    await host.shutdown();

    const snapshot = outbox.describeForShutdown();
    const archiveGroup = snapshot.groups.find((group) => group.type === 'archive');
    expect(archiveGroup).toBeDefined();
    expect(archiveGroup?.managerId).toBe('mgr-shutdown');

    const report = formatOutboxShutdownReport(snapshot);
    expect(report).toContain('type=archive managerId=mgr-shutdown');
  });

  it('購読が付いていれば（脚が繋がっていれば）、shutdown() 後の drainAndReportOutbox は捌けるのを待って書かずに済ませられる', async () => {
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

    const delivered: unknown[] = [];
    const detach = connectedSubscriber(outbox, (event) => delivered.push(event));

    await host.shutdown();
    expect(outbox.subscribed).toBe(true);

    const written = await captureStderr(() => drainAndReportOutbox(outbox));

    expect(delivered.some((event) => (event as { type?: string }).type === 'archive')).toBe(true);
    expect(written).toHaveLength(0);
    detach();
  });
});
