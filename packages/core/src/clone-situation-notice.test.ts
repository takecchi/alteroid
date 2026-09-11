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
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
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

/**
 * **鍵の材料が毎ターンの状況へ載る配線**（人間の決定 2026-09-07）。
 *
 * `describeTokenSituation` 自体は `situation.test.ts` が測る。ここが測るのは
 * **クローンが実際にそれを渡していること**と、**鍵が読めなくても状況ごと落ちない
 * こと**である —— `catch` を外まで広げると、鍵の読みが落ちた回に**委譲の本数も器の
 * 台数も消える。**
 *
 * ## 事故（これが無かったせいで起きた形）
 *
 * 巡回の番でクローンが**新しい委譲を1本も出さず**、こう書いた ——
 * 「枠が JST 19:30 まで塞がっているので、出しても1手も始まらずに落ちます」。
 * **その 19:30 は既に降りた鍵の reset で、現役は別の鍵で `ready` だった。**
 */
describe('状況の節に認証トークンの行が載る', () => {
  it('プールに行が在れば、現役と「見送らない」の1行が状況に出る', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'v-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'v-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: '2026-09-07T07:33:12.133Z',
    });
    const s = bootClone(stores, busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-token-line',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    expect(text).toContain('認証トークン: 現役は「second」');
    expect(text).toContain('枠を理由に仕事を見送らないこと');
    // **値は一度も通らない。**
    expect(text).not.toContain('v-a');
    expect(text).not.toContain('v-b');

    await s.clone.stop();
  });

  it('⭐ 鍵が読めなくても、委譲と器の数え上げは消えない', async () => {
    const stores = createMemoryStores();
    stores.tokens.list = () => Promise.reject(new Error('記憶ストアが落ちた'));
    const s = bootClone(stores, busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-token-unreadable',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    // 数え上げは残っている（ここが消えるのがいちばん悪い）。
    expect(text).toContain('委譲 全 3 本');
    expect(text).toContain('器 2 台');
    // 鍵は「読めなかった」と出る（0 で埋めない）。
    expect(text).toContain('プールを読めなかった');
    // **不変条件は落ちない。**
    expect(text).toContain('枠を理由に仕事を見送らないこと');

    await s.clone.stop();
  });
});

/**
 * **受信箱の滞留が毎ターンの状況へ載る配線**（#783 段0）。
 *
 * `describeSituation` / `summarizeInboxBacklog` 自体は `situation.test.ts` /
 * `inbox-backlog.test.ts` が測る。ここが測るのは**クローンが実際に
 * `inbox.pending()`（安いほう）を渡していること**と、**それが読めなくても
 * 状況ごと落ちないこと**——鍵の材料と同じ形の配線である。
 */
describe('状況の節に受信箱の滞留の行が載る（#783 段0）', () => {
  it('受信箱に未読があれば、状況の節にその行が出る', async () => {
    const stores = createMemoryStores();
    const s = bootClone(stores, busyPool());
    // **boot の後に直接ストアへ置く**（`s.clone.post()` を経由しない）。
    // `createClone` は起動時に `#restoreUnread()` で残っている未読を1回
    // 拾い直す（`store.ts` の `claimPending` の doc）——boot の**前**に
    // 置くと、この行がその拾い直しにすぐ乗って処理され、「このセッションが
    // 一度も触れていない、純粋な滞留」を模せない。boot の後に置くことで、
    // このイベントは（このテストの中では）誰にも配り直されない、本物の
    // 積み残しのまま残る。
    await stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-backlog',
        at: '2026-09-05T00:00:00.000Z',
        text: '未処理の発言',
        conversationId: 'conv-1',
      },
      '2026-09-05T00:00:00.000Z',
    );

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    // **1件** ——受信箱には `evt-backlog` と、いま処理している `evt-report`
    // 自身の2件が同時に載っているが、`evt-report` は「このターンが片付け
    // ようとしている分」なので引く（`#situationNoticeFor` の doc）。引かずに
    // 素の `pending()` をそのまま出すと、毎ターン自分自身を「1件溜まって
    // いる」と数えてしまい、この節の存在理由（詰まっているときだけ膨らむ）
    // が壊れる。
    expect(text).toContain('受信箱の未処理 1 件');
    expect(text).toContain('2026-09-05T00:00:00.000Z');
    // ターンが終われば `evt-report` は消え（`#forget`）、残るのは
    // `evt-backlog` だけ——`claimPending()` を呼んで裏取りする
    // （`deliveries` が 0 → 1 ＝ 一度も配られていなかったものの初回配達）。
    const claimed = await stores.inbox.claimPending();
    expect(claimed.map((r) => r.event.id)).toEqual(['evt-backlog']);
    expect(claimed[0]?.deliveries).toBe(1);

    await s.clone.stop();
  });

  it('受信箱が空なら、行そのものが出ない', async () => {
    const s = bootClone(createMemoryStores(), busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    expect(s.inputs.join('\n')).not.toContain('受信箱の未処理');

    await s.clone.stop();
  });

  it('⭐ 受信箱が読めなくても、委譲・器・鍵の数え上げは消えない（ターンを止めない）', async () => {
    const stores = createMemoryStores();
    stores.inbox.pending = () => Promise.reject(new Error('受信箱ストアが落ちた'));
    const s = bootClone(stores, busyPool());

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: AT,
      managerId: 'mgr-run',
      kind: 'report',
      text: '終わった',
    });
    await waitFor(() => s.inputs.length > 0, 'ターンが走ること');

    const text = s.inputs.join('\n');
    // 数え上げは残っている（ここが消えるのがいちばん悪い）。
    expect(text).toContain('委譲 全 3 本');
    expect(text).toContain('器 2 台');
    // **受信箱の行は「数えられなかった」と名乗る専用の1行になる**——鍵の
    // 「読めなかった」と同じ向き。⛔ 0件だったと見分けが付かなくなるので、
    // 行そのものを消しはしない（レビューで直った箇所。
    // `describeSituationInboxBacklog` の doc）。
    expect(text).toContain('受信箱の未処理を数えられなかった');

    await s.clone.stop();
  });
});
