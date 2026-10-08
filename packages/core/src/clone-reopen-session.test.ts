import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { EXCHANGE_KIND_DECISION_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ReopenSessionOptions } from './host.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeGatedSdk, fakeSdk, waitFor, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

// 人間の操作でクローンのセッションを resume せずに開き直す口（#4173）の、外から見える結果。
describe('クローン — セッションの開き直し（reopenSession）', () => {
  const actor = 'アカウント alice';
  const reason = 'safeguards に弾かれ続けている';

  async function selfLines(stores: Stores): Promise<string[]> {
    const rows = (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return rows.filter((row) => row.with === 'self').map((row) => row.text);
  }

  function build(options: { gated?: boolean; failSideQuery?: boolean; stores?: Stores } = {}) {
    const stores = options.stores ?? createMemoryStores();
    const gated = options.gated === true ? fakeGatedSdk() : undefined;
    const plain = options.gated === true ? undefined : fakeSdk();
    const base = (gated?.fn ?? plain?.fn) as ReturnType<typeof fakeSdk>['fn'];
    const calls = (gated?.calls ?? plain?.calls) as FakeCall[];
    let sideQueryCount = 0;
    const queryFn: typeof base = (args) => {
      if (typeof args.prompt === 'string') sideQueryCount += 1;
      if (options.failSideQuery === true && typeof args.prompt === 'string') {
        throw new Error('枠が閉じている');
      }
      return base(args);
    };
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    const sideQueries = (): number => sideQueryCount;
    const reopen = (reopenOptions: ReopenSessionOptions) => {
      if (clone.reopenSession === undefined) throw new Error('reopenSession が無い');
      return clone.reopenSession(reopenOptions);
    };
    return { clone, stores, calls, events, sideQueries, reopen, release: gated?.release };
  }

  async function plantTranscript(call: FakeCall, body: string): Promise<void> {
    const dir = await makeTempDir('alteroid-reopen-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, body, 'utf8');
    const hook = call.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  // 壁時計で待たない（`scripts/wallclock-waits-ratchet.test.ts`）。この区間だけ時計を進めて、
  // 積まれた非同期の後片付け（日誌の書き込みなど）を流しきる。
  // 退避（生ログの読み出し）は実 IO なので時計では進まない。退避の結果の日誌行を待つ。
  const waitForSalvage = (stores: Stores): Promise<void> =>
    waitFor(
      async () =>
        (await selfLines(stores)).some((line) =>
          line.startsWith(`${EXCHANGE_KIND_DECISION_PREFIX}開き直す前の生ログ`),
        ),
      '開き直す前の退避が終わること',
    );

  const settle = async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await vi.advanceTimersByTimeAsync(80);
    } finally {
      vi.useRealTimers();
    }
  };

  it('セッションが無いとき now を返し、resume 素材は捨てられ、次に開くセッションは resume しない', async () => {
    const s = build();
    await s.stores.sessions.setCloneSessionId('old-session-1');

    const result = await s.reopen({ reason, distill: false, actor });

    expect(result.outcome).toBe('now');
    expect(result.previousSessionId).toBe('old-session-1');
    expect(result.runningManagers).toBe(0);
    expect(await s.stores.sessions.getCloneSessionId()).toBeNull();

    s.clone.post(humanMessage('やあ'));
    await waitFor(() => s.events.some((event) => event.type === 'done'), 'ターンが通ること');
    await s.clone.stop();
    expect((s.calls[0] as FakeCall).options.resume).toBeUndefined();
  });

  it('走っているターンは最後まで走り、deferred の境界の後に開くセッションは resume しない', async () => {
    const s = build({ gated: true });
    s.clone.post(humanMessage('一つ目'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) > 0, 'ターンが走り出すこと');

    const result = await s.reopen({ reason, distill: false, actor });
    expect(result.outcome).toBe('deferred');
    expect(result.previousSessionId).toBe('sess-fake');
    expect(await s.stores.sessions.getCloneSessionId()).toBeNull();

    // 走っているターンは殺されない: 失敗の報告は出ず、答えが返る
    await settle();
    expect(s.events.some((event) => event.type === 'error')).toBe(false);
    s.release?.();
    await waitFor(
      () => s.events.some((event) => event.type === 'done'),
      '走っていたターンが終わること',
    );
    expect(s.events.some((event) => event.type === 'error')).toBe(false);

    await settle();
    s.clone.post(humanMessage('二つ目'));
    await waitFor(() => s.calls.length > 1, '新しいセッションが開くこと');
    await s.clone.stop();
    expect((s.calls[1] as FakeCall).options.resume).toBeUndefined();
  });

  it('新しいセッションの最初のターンの入力に断りが1度だけ載り、2ターン目には載らない', async () => {
    const s = build();
    s.clone.post(humanMessage('一つ目'));
    await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
    await plantTranscript(s.calls[0] as FakeCall, '古い生ログ');

    await s.reopen({ reason, distill: false, actor });
    await waitForSalvage(s.stores);

    s.clone.post(humanMessage('二つ目'));
    await waitFor(
      () => (s.calls[1]?.inputs.length ?? 0) > 0,
      '新しいセッションが最初の入力を受けること',
    );
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 2,
      '2本目が通ること',
    );
    s.clone.post(humanMessage('三つ目'));
    await waitFor(() => (s.calls[1]?.inputs.length ?? 0) > 1, '2ターン目が入ること');
    await s.clone.stop();

    const archiveId = (await s.stores.archive.list())[0]?.id as string;
    const first = (s.calls[1] as FakeCall).inputs[0] as string;
    expect(first).toContain(actor);
    expect(first).toContain(reason);
    expect(first).toContain('sess-fake');
    expect(first).toContain(archiveId);
    expect(first).toContain('conversation_read');
    expect(first).toContain('また弾かれうる');
    expect(first).not.toContain('すべき');
    expect((s.calls[1] as FakeCall).inputs[1]).not.toContain('resume せずに');
  });

  it('セッションが無かった now でも、次に開くセッションへ断りを添える', async () => {
    const s = build();
    await s.stores.sessions.setCloneSessionId('old-session-2');
    await s.reopen({ reason, distill: false, actor });

    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) > 0, '最初の入力が入ること');
    await s.clone.stop();

    expect((s.calls[0] as FakeCall).inputs[0]).toContain('old-session-2');
    expect((s.calls[0] as FakeCall).inputs[0]).toContain('resume せずに');
  });

  it('distill: false なら生ログは退避され、蒸留のサイドクエリは呼ばれず、墓標も立たない', async () => {
    const s = build({ failSideQuery: true });
    s.clone.post(humanMessage('やあ'));
    await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
    await plantTranscript(s.calls[0] as FakeCall, '弾かれた生ログ');
    const before = s.sideQueries();

    const result = await s.reopen({ reason, distill: false, actor });
    expect(result.outcome).toBe('deferred');
    await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');
    await settle();
    const entries = await s.stores.archive.list();
    expect(await s.stores.archive.read(entries[0]?.id as string)).toEqual({
      kind: 'body',
      body: '弾かれた生ログ',
    });
    expect(s.sideQueries()).toBe(before);
    expect(await s.stores.sessions.getTranscriptGrave()).toBeNull();
    const lines = await selfLines(s.stores);
    expect(lines.some((line) => line.includes('蒸留に失敗した'))).toBe(false);
    await s.clone.stop();
  });

  it('distill: true なら退避のあと蒸留が呼ばれる（落ちれば墓標が立つ）', async () => {
    const s = build({ failSideQuery: true });
    s.clone.post(humanMessage('やあ'));
    await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
    await plantTranscript(s.calls[0] as FakeCall, '生ログ');
    const before = s.sideQueries();

    await s.reopen({ reason, distill: true, actor });
    await waitFor(() => s.sideQueries() > before, '蒸留のサイドクエリが呼ばれること');
    await waitFor(
      async () => (await s.stores.sessions.getTranscriptGrave()) !== null,
      '蒸留が落ちて墓標が立つこと',
    );
    const lines = await selfLines(s.stores);
    expect(lines.some((line) => line.includes('開き直す前の蒸留に失敗した'))).toBe(true);
    await s.clone.stop();
  });

  it('日誌に、開き直しを受けた行と、新しいセッションで開き直した行が残る', async () => {
    const s = build();
    s.clone.post(humanMessage('一つ目'));
    await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
    await plantTranscript(s.calls[0] as FakeCall, '古い生ログ');

    await s.reopen({ reason, distill: false, actor });
    await waitForSalvage(s.stores);
    const received = (await selfLines(s.stores)).filter((line) =>
      line.startsWith(`${EXCHANGE_KIND_DECISION_PREFIX}人間の操作でセッションの開き直しを受けた`),
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toContain(actor);
    expect(received[0]).toContain(reason);
    expect(received[0]).toContain('sess-fake');
    expect(received[0]).toContain('蒸留: しない');
    expect(received[0]).toContain('deferred');

    s.clone.post(humanMessage('二つ目'));
    await waitFor(
      async () =>
        (await selfLines(s.stores)).some((line) =>
          line.startsWith(`${EXCHANGE_KIND_DECISION_PREFIX}開き直した: sess-fake → `),
        ),
      '開き直した行が残ること',
    );
    s.clone.post(humanMessage('三つ目'));
    await settle();
    await s.clone.stop();

    const archiveId = (await s.stores.archive.list())[0]?.id as string;
    const reopened = (await selfLines(s.stores)).filter((line) => line.includes('開き直した: '));
    // 最初の init でだけ1行（3つ目の発言では増えない）
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toContain(`退避: ${archiveId}`);
    // 退避の結果は init の行とは別に、退避した時点でも残る（init が先に来ても archive id が失われない）
    const salvaged = (await selfLines(s.stores)).filter((line) =>
      line.startsWith(
        `${EXCHANGE_KIND_DECISION_PREFIX}開き直す前の生ログ（古い session id: sess-fake）`,
      ),
    );
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0]).toContain(`退避: ${archiveId}`);
  });

  it('退避するものが無かったときは、そう書く（退避できたとは書かない）', async () => {
    const s = build();
    await s.stores.sessions.setCloneSessionId('old-session-3');
    await s.reopen({ reason, distill: false, actor });
    s.clone.post(humanMessage('やあ'));
    await waitFor(
      async () =>
        (await selfLines(s.stores)).some((line) => line.includes('退避するものが無かった')),
      '退避するものが無かったという行が残ること',
    );
    await s.clone.stop();
    const line = (await selfLines(s.stores)).find((entry) => entry.includes('開き直した: '));
    expect(line).toContain('old-session-3 → sess-fake');
    expect(line).not.toContain('退避: ');
  });
});
