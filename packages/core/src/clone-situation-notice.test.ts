import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { JobStatus } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 「いまの全体」がターンの入口（`clone.ts` の `#runTurn`）に**実際に載る**か
 * （`situation.ts`）。
 *
 * **ここで測るのは配線だけである。** 数え方と字面は `situation.test.ts` が
 * 別に固定している——1本の歯で両方を見ると、落ちたときにどちらが壊れたのか
 * 判別できない。
 *
 * ## なぜ起点を複数まわすのか
 *
 * この節が塞ぐ穴は「**起点によっては全体が1文字も載らない**」ことそのもので
 * ある（digest を持つ3つの起点にしか載っていなかった）。だから
 * `manager_message`（報告）と `human_message` の両方を通す——`#runTurn` が
 * 1か所であることに寄りかかった実装なので、1か所を測れば十分に見えるが、
 * **「1か所である」という前提が壊れたときにこそ落ちてほしい歯**である。
 */

interface Fake {
  fn: typeof sdkQuery;
  /** SDK へ渡った本文（＝クローンが実際に読んだプロンプト）。 */
  inputs: string[];
}

/** SDK の代わり（`clone-turn-input.test.ts` の `fakeSdk` と同じ骨格）。 */
function fakeSdk(): Fake {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

function summary(
  id: string,
  status: JobStatus,
  live: boolean,
  awaitingBackground?: { tasks: number; withheldReports: number; breakdown: string; since: string },
): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
    ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
  };
}

/**
 * `ManagerPool` のスタブ。**`list()` と `runners()` だけを本物にする**——
 * それ以外は呼ばれない前提で投げる（`clone.test.ts` の `throwingPool` と
 * 同じ作法。呼ばれたら歯が落ちる形なので、黙って別の経路を通ることが無い）。
 */
function stubPool(input: {
  managers: ManagerSummary[] | (() => never);
  runnerStates: RunnerLiveness[] | (() => never);
}): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () =>
      typeof input.managers === 'function'
        ? Promise.reject(new Error('list() が壊れている（実測を模す）'))
        : Promise.resolve(input.managers),
    denials: () => [],
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      typeof input.runnerStates === 'function'
        ? Promise.reject(new Error('runners() が壊れている（実測を模す）'))
        : Promise.resolve({
            runners: input.runnerStates.map((state, index) => ({
              label: `runner-${index}`,
              state,
              since: '2026-09-05T00:00:00.000Z',
              managers: [],
              revision: { status: 'unheard' as const },
            })),
            unassigned: [],
            daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
          }),
    transcript: notImplemented,
    restore: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

function bootClone(stores: Stores, managers: ManagerPool): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({ stores, queryFn: fake.fn, env: {}, managers });
  return { ...fake, clone };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const AT = '2026-09-05T00:00:00.000Z';
const BG = { tasks: 3, withheldReports: 1, breakdown: 'local_agent×3', since: AT };

/** マネージャー3本（走行中1・背景処理待ち1・手が空いている1）と器2台。 */
function busyPool(): ManagerPool {
  return stubPool({
    managers: [
      summary('mgr-run', 'running', true),
      summary('mgr-bg', 'done', true, BG),
      summary('mgr-idle', 'done', true),
    ],
    runnerStates: ['connected', 'vacating'],
  });
}

describe('いまの全体は、ターンの入口に必ず載る（起点を問わない）', () => {
  /**
   * **本命の起点。** `manager_message` のプロンプト（`managerPrompt` /
   * `managerReportBatchPrompt`）には、直す前は稼働本数も器の状態も1文字も
   * 入っていなかった。
   */
  it('マネージャーの報告で起きたターンにも載る', async () => {
    const s = bootClone(createMemoryStores(), busyPool());
    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'マネージャーの報告のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain('[system] いまの全体');
    expect(text).toContain('委譲 全 3 本');
    expect(text).toContain('背景処理待ち 1');
    expect(text).toContain('手が空いている 1');
    expect(text).toContain('器 2 台: connected 1 / vacating 1。');

    await s.clone.stop();
  });

  it('人間の発言で起きたターンにも載る', async () => {
    const s = bootClone(createMemoryStores(), busyPool());
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    expect(s.inputs.join('\n')).toContain('手が空いている 1');

    await s.clone.stop();
  });

  /**
   * **蒸留には載せない**（`#commitmentNoticeFor` の `distill` の弾き方と同じ
   * 形）。記憶へ移すためだけの内部ターンで、`stop()` 経由の蒸留はこの直後に
   * プロセスが消える——畳んでいる最中に「手が空いているものが1本ある」と
   * 渡すのは、新しい仕事を始めさせることでしかない。
   */
  it('蒸留のターンには載せない', async () => {
    const s = bootClone(createMemoryStores(), busyPool());
    // セッションが無いと蒸留は起きない（`#handle` の `'distill'` 分岐）。
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');
    // **先に、その文字列が現れうることを確かめる。** これが無いと下の
    // `not.toContain` は空振りで真になる。
    expect(s.inputs[0]).toContain('[system] いまの全体');

    s.clone.post({ type: 'distill', id: 'evt-distill', at: AT, reason: 'shutdown' });
    await waitFor(() => s.inputs.length > 1, '蒸留のターン');

    expect(s.inputs[1]).not.toContain('[system] いまの全体');

    await s.clone.stop();
  });
});

describe('数えられなかったときは、行を消さず 0 でも埋めない', () => {
  /**
   * **「数えられて0本」と「数えられなかった」を潰さない。** 0 で埋めると
   * 「全部片付いている」と読める——いちばん見落としたい向きへ倒れる
   * （`runner-swap-notice.ts` が `'none-affected'` と `'ledger-unreadable'` を
   * 型で分けているのと同じ理由）。
   */
  it('list() が投げても、ターンは進み、数えられなかったと名乗る', async () => {
    const s = bootClone(
      createMemoryStores(),
      stubPool({
        managers: () => {
          throw new Error('unused');
        },
        runnerStates: ['connected'],
      }),
    );
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain('数えられなかった');
    expect(text).toContain('list() が壊れている（実測を模す）');
    // **0 の一覧へ倒れていないこと。** 倒れると「全部片付いている」と読める。
    expect(text).not.toContain('委譲 全 0 本');
    expect(text).not.toContain('手が空いている 0');
    // それでもターン自体は進む（断り書きのためにターンを止めない）。
    expect(text).toContain('やあ');

    await s.clone.stop();
  });

  it('runners() が投げても同じく名乗る（器の側だけが読めない回）', async () => {
    const s = bootClone(
      createMemoryStores(),
      stubPool({
        managers: [summary('mgr-idle', 'done', true)],
        runnerStates: () => {
          throw new Error('unused');
        },
      }),
    );
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    const text = s.inputs.join('\n');
    expect(text).toContain('数えられなかった');
    expect(text).toContain('runners() が壊れている（実測を模す）');
    // **委譲の側だけ数えて器を 0 台と書かない。** 片方が読めたことを理由に
    // 半分だけ出すと、読み手には「器が1台も無い」と見える。
    expect(text).not.toContain('器 0 台');

    await s.clone.stop();
  });
});
