import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone, SITUATION_FULL_EVERY_TURNS } from './clone.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores as createBaseMemoryStores } from './testing.js';

// 生ログの大きさを返す預け先（pg の `measureSize` の代わり）。既定は「生ログが実在する」。
// 読み戻しは生ログが実在する（測れて 0 より大きい）ときだけなので、読み戻す試験はこの既定で動く
type MeasureSize = () => Promise<number | null>;
let measureRawLog: MeasureSize = () => Promise.resolve(4096);
function createMemoryStores(): Stores {
  const stores = createBaseMemoryStores();
  stores.sessions.getProjectKey = () => Promise.resolve('proj');
  return {
    ...stores,
    sessionTranscriptTail: {
      readTail: () => Promise.resolve(null),
      measureSize: () => measureRawLog(),
    },
  };
}

// 再起動（クローンを作り直す）と resume をまたいで、「いまの全体」の畳みが続くこと。
// 控えは `stores.sessions` の `setFoldState` に預け、resume で同じ session_id が戻ったときだけ読み戻す（`fold-state.ts`）。
//
// 前のプロセスは `stop()` しない（落ちた形）: `stop()` は最後に蒸留のターンを1つ回し、その終わりが直前のターンの控えを「確定した」と数えて預けるため、
// 預けるのは1ターン前の控え、という本来の形が試験に出ない。後始末（afterEach）で止める。
const AT = '2026-09-05T00:00:00.000Z';
const READINGS_HEAD = '**「手が空いている」は「空き枠」ではない**';
const FOLDED_SITUATION = 'いまの全体: 前のターンと変化なし';

function summary(id: string, status: ManagerSummary['status'], live: boolean): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: AT,
    updatedAt: AT,
    waiting: [],
  };
}

function pool(): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: notImplemented,
    send: notImplemented,
    abort: notImplemented,
    list: () =>
      Promise.resolve([summary('mgr-run', 'running', true), summary('mgr-idle', 'done', true)]),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      Promise.resolve({
        runners: ['connected', 'vacating'].map((state, index) => ({
          label: `runner-${index}`,
          state: state as 'connected',
          since: AT,
          managers: [],
          revision: { status: 'unheard' as const },
        })),
        unassigned: [],
        daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
      }),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

interface BootOptions {
  /** init で返す session_id（resume しても別の id で始まる回を作る）。 */
  sessionId?: string;
  /** この番号（セッション内で1始まり）の入力の後に compact_boundary を流す。 */
  compactAfterInput?: number;
  /** この番号の入力の result の前に、生ログのミラーが1束を捨てた合図（mirror_error）を流す。`subpath` を付けると副次の鍵の欠け。 */
  mirrorErrorAtInput?: number;
  mirrorErrorSubpath?: string;
  /** この番号の入力を、失敗した result で終える。 */
  failAtInput?: number;
  /** ターンの終わりの文脈量（閾値 200,000）。呼び出し順（1始まり）で変えられる。 */
  totalTokens?: (observation: number) => number;
}

interface Boot {
  clone: CloneHost;
  inputs: string[];
  resumes: (string | undefined)[];
}

const live: CloneHost[] = [];
afterEach(async () => {
  measureRawLog = () => Promise.resolve(4096);
  for (const clone of live.splice(0)) await clone.stop();
});

function boot(stores: Stores, options: BootOptions = {}): Boot {
  const inputs: string[] = [];
  const resumes: (string | undefined)[] = [];
  const sessionId = options.sessionId ?? 'sess-fake';
  let observations = 0;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    resumes.push(params.options?.resume);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      let sessionInputs = 0;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        sessionInputs += 1;
        inputs.push(String(message.message.content));
        if (options.compactAfterInput === sessionInputs) {
          yield {
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
            session_id: sessionId,
            uuid: `uuid-compact-${String(sessionInputs)}`,
          } as unknown as SDKMessage;
        }
        if (options.mirrorErrorAtInput === sessionInputs) {
          yield {
            type: 'system',
            subtype: 'mirror_error',
            error: '書けない',
            key: {
              projectKey: 'proj',
              sessionId,
              ...(options.mirrorErrorSubpath === undefined
                ? {}
                : { subpath: options.mirrorErrorSubpath }),
            },
            session_id: sessionId,
            uuid: `uuid-mirror-${String(sessionInputs)}`,
          } as unknown as SDKMessage;
        }
        const failed = options.failAtInput === sessionInputs;
        yield {
          type: 'result',
          subtype: failed ? 'error_during_execution' : 'success',
          ...(failed ? { is_error: true, errors: ['落ちた'] } : {}),
          result: 'ok',
          session_id: sessionId,
          uuid: `uuid-result-${String(sessionInputs)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      getContextUsage: async () => {
        observations += 1;
        return {
          categories: [],
          totalTokens: options.totalTokens?.(observations) ?? 10_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 1,
          autoCompactThreshold: 200_000,
          isAutoCompactEnabled: true,
        };
      },
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const clone = createClone({
    reportSettleMs: 2500,
    stores,
    queryFn: fn,
    env: {},
    managers: pool(),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  live.push(clone);
  return { clone, inputs, resumes };
}

let sequence = 0;
async function humanTurn(b: Boot, label: string): Promise<string> {
  sequence += 1;
  const before = b.inputs.length;
  b.clone.post({
    type: 'human_message',
    id: `evt-fold-${String(sequence)}`,
    at: AT,
    text: `発言 ${label}`,
    conversationId: 'conv-1',
  });
  await waitFor(() => b.inputs.length > before, `${label} の入力`);
  return b.inputs[before] ?? '';
}

// 預け入れは待たれずに走る（ターンを遅らせない）ので、預け先に載るまで待つ
async function waitForPersistedCounter(stores: Stores, turnsSinceFull: number): Promise<void> {
  await waitFor(
    async () => {
      const raw = await stores.sessions.getFoldState();
      return (
        raw !== null &&
        (JSON.parse(raw) as { turnsSinceFull: number }).turnsSinceFull === turnsSinceFull
      );
    },
    `周期の数え ${String(turnsSinceFull)} の控えの預け入れ`,
  );
}

const waitForNoFoldState = (stores: Stores, label: string): Promise<void> =>
  waitFor(async () => (await stores.sessions.getFoldState()) === null, label);

// 1ターン目に全文を出して周期の数えを 0 へ戻す。k ターン目の終わりの数えは k-1。
// 預けるのは1ターン前の控えなので、k ターン回った後に預け先にあるのは k-2（k ≥ 2）
async function runTurns(
  stores: Stores,
  turns: number,
  options: BootOptions = {},
): Promise<{ a: Boot; inputs: string[] }> {
  const a = boot(stores, options);
  const inputs: string[] = [];
  for (let n = 1; n <= turns; n += 1) inputs.push(await humanTurn(a, `A${String(n)}`));
  await waitForPersistedCounter(stores, turns - 2);
  return { a, inputs };
}

describe('畳みの控えを resume をまたいで続ける（再起動）', () => {
  it('⭐ 同じ session_id で resume した最初のターンは、「いまの全体」を畳んだまま続く', async () => {
    const stores = createMemoryStores();
    const { inputs } = await runTurns(stores, 2);
    expect(inputs[0]).toContain(READINGS_HEAD);
    expect(inputs[1]).toContain(FOLDED_SITUATION);

    const b = boot(stores);
    const third = await humanTurn(b, 'B1');

    expect(b.resumes).toEqual(['sess-fake']);
    expect(third).toContain(FOLDED_SITUATION);
    expect(third).not.toContain(READINGS_HEAD);
  });

  // 読み戻しの前に、その会話の生ログの大きさを測る。pg の `measureSize` は該当行が無いと 0 を返し、`#resumeCandidateWithinBudget` は 0 も null も resume してよいとみなす。
  // その resume が空の会話を開くなら、畳んだ最初の入力（「前と変化なし」）が指す全文はどこにも載っていない
  describe('生ログが実在するときだけ読み戻す（measureSize）', () => {
    it('⭐ measureSize が 0（該当行なし）なら、読み戻さず全文（控えは預け先から消える）', async () => {
      const stores = createMemoryStores();
      await runTurns(stores, 2);
      measureRawLog = () => Promise.resolve(0);

      const b = boot(stores);
      const first = await humanTurn(b, 'B1');

      // resume 自体は今までどおり同じ id で開く（`#resumeCandidateWithinBudget` は変えない）
      expect(b.resumes).toEqual(['sess-fake']);
      expect(first).toContain(READINGS_HEAD);
      expect(first).not.toContain(FOLDED_SITUATION);
      await waitForNoFoldState(stores, '生ログ無しの控えの削除');
    });

    it('⭐ measureSize が null（測れない）なら、読み戻さず全文', async () => {
      const stores = createMemoryStores();
      await runTurns(stores, 2);
      measureRawLog = () => Promise.resolve(null);

      const b = boot(stores);
      const first = await humanTurn(b, 'B1');

      expect(b.resumes).toEqual(['sess-fake']);
      expect(first).toContain(READINGS_HEAD);
      await waitForNoFoldState(stores, '測れない控えの削除');
    });

    it('⭐ measureSize が投げても、読み戻さず全文（起動は止まらない）', async () => {
      const stores = createMemoryStores();
      await runTurns(stores, 2);
      measureRawLog = () => Promise.reject(new Error('測れない'));

      const b = boot(stores);
      const first = await humanTurn(b, 'B1');

      expect(first).toContain(READINGS_HEAD);
    });

    it('⭐ measureSize が正の値なら、読み戻して畳んだまま続く', async () => {
      const stores = createMemoryStores();
      await runTurns(stores, 2);
      measureRawLog = () => Promise.resolve(1);

      const b = boot(stores);
      const first = await humanTurn(b, 'B1');

      expect(first).toContain(FOLDED_SITUATION);
      expect(first).not.toContain(READINGS_HEAD);
    });
  });

  // 生ログのミラー（SessionStore への書き込み）が1束を捨てると、SDK が `mirror_error` を返す。
  // その会話の生ログには欠けがあるので、控えは預けない・預けた分は消す
  describe('生ログのミラーが落ちた会話は読み戻さない', () => {
    it('⭐ 本流のミラーが落ちた回の後は、控えを預けず、再起動しても全文', async () => {
      const stores = createMemoryStores();
      const { a } = await runTurns(stores, 2, { mirrorErrorAtInput: 3 });
      await humanTurn(a, 'A3');
      await waitForNoFoldState(stores, 'ミラー失敗で控えが消える');
      // 落ちた後のターンでも預けない（預ければ、欠けた生ログを指す控えが復活する）
      await humanTurn(a, 'A4');
      await humanTurn(a, 'A5');
      expect(await stores.sessions.getFoldState()).toBeNull();

      const b = boot(stores);
      const first = await humanTurn(b, 'B1');

      expect(first).toContain(READINGS_HEAD);
    });

    it('副次の鍵（subpath 付き）のミラーが落ちても、本流の控えは読み戻す', async () => {
      const stores = createMemoryStores();
      const { a } = await runTurns(stores, 2, {
        mirrorErrorAtInput: 3,
        mirrorErrorSubpath: 'subagents/agent-1',
      });
      await humanTurn(a, 'A3');
      await waitForPersistedCounter(stores, 1);

      const b = boot(stores);
      const first = await humanTurn(b, 'B1');

      expect(first).toContain(FOLDED_SITUATION);
    });
  });

  it('預けた控えが無い再起動では、最初のターンは今までどおり全文', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setCloneSessionId('sess-fake');

    const b = boot(stores);
    const first = await humanTurn(b, 'B1');

    expect(b.resumes).toEqual(['sess-fake']);
    expect(first).toContain(READINGS_HEAD);
  });

  it('⭐ 保存してある session_id が控えの id と違えば、読み戻さず全文', async () => {
    const stores = createMemoryStores();
    await runTurns(stores, 2);
    // 別の会話へ resume する形（控えは sess-fake の会話に載っている全文を指している）
    await stores.sessions.setCloneSessionId('sess-other');

    const b = boot(stores, { sessionId: 'sess-other' });
    const first = await humanTurn(b, 'B1');

    expect(b.resumes).toEqual(['sess-other']);
    expect(first).toContain(READINGS_HEAD);
  });

  it('⭐ resume したのに別の session_id で始まった（init の id が違う）なら、次のターンは全文へ戻す', async () => {
    const stores = createMemoryStores();
    await runTurns(stores, 2);

    const b = boot(stores, { sessionId: 'sess-new' });
    await humanTurn(b, 'B1');
    const second = await humanTurn(b, 'B2');

    // 畳んだ入力は init より前に送り済みで取り返せないが、控えは捨てられ、以後は新しい会話に全文を載せ直す
    expect(second).toContain(READINGS_HEAD);
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-new');
  });

  it('⭐ 預けた控えが壊れていれば、読み戻さず全文（起動は止まらず、控えは預け先から消える）', async () => {
    for (const broken of ['{壊れた', '{"v":1}', '{"v":2,"sessionId":"sess-fake"}', '[]', '"x"']) {
      const stores = createMemoryStores();
      await stores.sessions.setCloneSessionId('sess-fake');
      await stores.sessions.setFoldState(broken);

      const b = boot(stores);
      const first = await humanTurn(b, 'B1');

      expect(first, broken).toContain(READINGS_HEAD);
      // 使えなかった控えは預け先からも消える（次の起動が同じ控えを読み直さない）
      await waitForNoFoldState(stores, '壊れた控えの削除');
    }
  });

  it('⭐ 要約（compact_boundary）が走った後の控えは読み戻さない', async () => {
    const stores = createMemoryStores();
    const { a } = await runTurns(stores, 2, { compactAfterInput: 3 });
    await humanTurn(a, 'A3');
    // 要約が会話に走った時点で、預けた控えは捨てられる
    await waitForNoFoldState(stores, '要約で控えが消える');

    const b = boot(stores);
    const first = await humanTurn(b, 'B1');

    expect(first).toContain(READINGS_HEAD);
  });

  it('⭐ 失敗したターンの後の控えは読み戻さない', async () => {
    const stores = createMemoryStores();
    const { a } = await runTurns(stores, 2, { failAtInput: 3 });
    await humanTurn(a, 'A3');
    await waitForNoFoldState(stores, '失敗で控えが消える');

    const b = boot(stores);
    const first = await humanTurn(b, 'B1');

    expect(first).toContain(READINGS_HEAD);
  });

  it('⭐ 預けるのは1ターン前の控え: 2ターン目の終わりに預け先にあるのは、1ターン目の終わりの状態', async () => {
    const stores = createMemoryStores();
    await runTurns(stores, 2);

    const stored = JSON.parse((await stores.sessions.getFoldState()) ?? 'null') as {
      turnsSinceFull: number;
    };

    // 2ターン目の終わりの数えは 1。預けてあるのは 0（1ターン目の終わり）
    expect(stored.turnsSinceFull).toBe(0);
  });

  it('⭐ 文脈量が閾値に近い（要約が走りうる）なら、読み戻した最初のターンも全文', async () => {
    const stores = createMemoryStores();
    // 3ターン目の終わりに閾値 200,000 へ近づく。預けるのは1ターン前の控えだが、使用量の観測は最新のものを載せる
    await runTurns(stores, 3, { totalTokens: (n) => (n >= 3 ? 199_000 : 10_000) });

    const b = boot(stores);
    const first = await humanTurn(b, 'B1');

    expect(first).toContain(READINGS_HEAD);
  });

  async function nextTurnAfterRestart(turns: number): Promise<string> {
    const stores = createMemoryStores();
    await runTurns(stores, turns);
    const b = boot(stores);
    return humanTurn(b, 'B1');
  }

  it(`⭐ ${String(SITUATION_FULL_EVERY_TURNS)} ターン周期の数えも再起動をまたぐ: ${String(SITUATION_FULL_EVERY_TURNS)} ターン回った会話の次の回は全文`, async () => {
    // 数え直さなければ、この回は畳まれたまま周期が遅れる
    const next = await nextTurnAfterRestart(SITUATION_FULL_EVERY_TURNS);

    expect(next).toContain(READINGS_HEAD);
  });

  it(`周期の手前（${String(SITUATION_FULL_EVERY_TURNS - 1)} ターン回った会話の次の回）では、再起動しても畳んだまま`, async () => {
    const next = await nextTurnAfterRestart(SITUATION_FULL_EVERY_TURNS - 1);

    expect(next).toContain(FOLDED_SITUATION);
    expect(next).not.toContain(READINGS_HEAD);
  });

  it('控えの預け入れが失敗しても、ターンは落ちない', async () => {
    const stores = createMemoryStores();
    stores.sessions.setFoldState = () => Promise.reject(new Error('書けない'));

    const a = boot(stores);
    const first = await humanTurn(a, 'A1');
    const second = await humanTurn(a, 'A2');
    await humanTurn(a, 'A3');

    expect(first).toContain(READINGS_HEAD);
    expect(second).toContain(FOLDED_SITUATION);
  });

  it('セッション id を捨てる（setCloneSessionId(null)）と、預けた控えも消える', async () => {
    const stores = createMemoryStores();
    await runTurns(stores, 2);
    expect(await stores.sessions.getFoldState()).not.toBeNull();

    await stores.sessions.setCloneSessionId(null);

    expect(await stores.sessions.getFoldState()).toBeNull();
  });
});
