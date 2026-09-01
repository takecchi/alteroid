import type {
  query as sdkQuery,
  AgentDefinition,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool, MANAGER_MODEL, WORKER_AGENT_NAME, WORKER_MODEL } from './manager.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  type RunnerAnswerCommand,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerPlacementResources,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * Issue #485（M5）の未着手項目「1 runner 構成と能力・プロトコルが同じである
 * ことの回帰テスト」（PR7）。M5 のゴールは逐語で「runner を増やしても、能力も
 * プロトコルも1台構成と同じままでいる」である。
 *
 * **中心にある分岐は `RunnerRegistry#select` の `if (open.length === 1) return
 * first;`（`runner-protocol.ts`）。** 直上のコメントは「1台しか無いなら聞きに
 * 行かない。答えは変わらないのに、委譲を起こす経路へ往復1回分の待ちを足すだけ
 * である」——**この「答えは変わらない」という等価性の主張は、コメントとしては
 * 在ったがテストとしては無かった。** 1台のときは資源の点数計算
 * （`chooseByResources`/`#place`）を一度も呼ばず先頭を即答し、複数台のときだけ
 * 全台へ `resources()` を聞いて回る——**この2本の経路が同じ答えを出すことを、
 * どこも突き合わせていなかった。**
 *
 * ここで固定するのは3つの面である。
 *
 * 1. **配置の規約**——「常に置き先を返す・定員で断らない」ことと、上の2経路
 *    （N=1 の即答 / N>1 の資源計算）が同じ勝者を選ぶこと
 * 2. **ルーティング**——`manager_id → runner_id` の貼り付きが、台数を1台→3台へ
 *    変えても同じ形（宛先だけに届き、他は1度も受けない）のままであること
 * 3. **能力・プロトコルの等価性**——委譲→許可確認→回答→報告を通した実セッション
 *    で、能力（`model` / `tools` / `maxTurns` / `permissionMode` /
 *    `settingSources` / `agents`）とプロトコル（`outcome` / 許可確認の質問の
 *    `text` / `managers` の数）が、1台構成と3台構成で**直接** `toEqual` できる
 *    ことを固定する（定数と照合するだけでは、両方が同じ値へ揃って壊れる形を
 *    見落とす）。
 *
 * **書かないもの**（移送 PR5 待ち。比べる対象がまだ存在しない）——受け入れ基準4
 * （1台停止→別 runner で継続）の体験の等価性、workspace locator が
 * shared-volume / git のときの等価性。MCP の口（`manager_start` /
 * `manager_send` / `runner_list`）の等価性も、上の3つを優先し、ここでは扱わない。
 */

// ---------------------------------------------------------------------------
// 1. 配置の規約——N=1 の即答経路と N>1 の資源計算経路が同じ勝者を選ぶ
// ---------------------------------------------------------------------------

/**
 * 偽 runner。**`resources()` の応え方だけを外から決められる**
 * （`runner-placement.test.ts` の `FakeRunner` と同じ作法。あちらは「資源の
 * 使い方」を1台ずつ見るが、ここは「1台のときと複数台のときで同じ勝者を選ぶか」
 * という*突き合わせ*を見るので、別ファイルとして持つ）。
 */
class PlacementFakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  /** 聞かれた回数。**N=1 の即答経路では1度も聞かれないはず**（`asked === 0`）。 */
  asked = 0;

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    this.asked += 1;
    return this.report;
  }

  async ping(): Promise<void> {}
  async connect(): Promise<void> {}
  async start(): Promise<void> {}
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

async function placementRegistryOf(...runners: PlacementFakeRunner[]): Promise<RunnerRegistry> {
  const registry = createRunnerRegistry();
  for (const runner of runners) {
    await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
  }
  return registry;
}

describe('配置の規約は runner 台数で変わらない（M5 ゴール / PR7）', () => {
  it('資源が最も空いている器を、1台構成の即答経路と3台構成の資源計算経路の両方で同じに選ぶ', async () => {
    // best は「明らかに最良」の1台。1台構成ではこれ単独で登録し、3台構成では
    // **先頭ではなく最後**（`decoyTight`・`decoyBusy` の後）に登録する——登録順の
    // 先頭を返す壊れ方（`runner-placement.test.ts` の1本目と同じ懸念）と、
    // 「たまたま最後に登録したから選ばれた」の両方を、この配置で潰す。
    const bestReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    };
    const decoyTightReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 31_000_000_000, source: 'cgroup' },
      managers: 5,
    };
    const decoyBusyReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 20_000_000_000, source: 'cgroup' },
      managers: 9,
    };

    // --- N=1: best 単独。即答経路（#select の `open.length === 1` 分岐）を通る。
    const solo = new PlacementFakeRunner('runner-best', bestReport);
    const soloRegistry = await placementRegistryOf(solo);
    const chosenAt1 = await soloRegistry.select({});
    expect(chosenAt1.runnerId).toBe('runner-best');
    // **即答経路であることの裏付け。** 資源計算を通っていれば `resources()` が
    // 呼ばれているはずなので、`asked === 0` は「答えは変わらないのに往復を足さない」
    // という分岐直上のコメントの主張そのものである。
    expect(solo.asked).toBe(0);
    await soloRegistry.stop();

    // --- N=3: decoy 2台 + best。資源計算経路（`chooseByResources`）を通る。
    const decoyTight = new PlacementFakeRunner('runner-decoy-tight', decoyTightReport);
    const decoyBusy = new PlacementFakeRunner('runner-decoy-busy', decoyBusyReport);
    const best = new PlacementFakeRunner('runner-best', bestReport);
    const fleetRegistry = await placementRegistryOf(decoyTight, decoyBusy, best);
    const chosenAt3 = await fleetRegistry.select({});
    expect(chosenAt3.runnerId).toBe('runner-best');
    // 資源計算経路であることの裏付け——全台へ同時に聞く（`#place` の doc）。
    expect([decoyTight.asked, decoyBusy.asked, best.asked]).toEqual([1, 1, 1]);
    await fleetRegistry.stop();

    // **これが本題。** 定数 'runner-best' と個別に照合するだけでは、1台構成用の
    // 期待値と3台構成用の期待値を書き手が別々に決め打ちできてしまい、両方が
    // 揃って同じ間違った値へ壊れる形（例: どちらの経路も登録順の先頭を返す
    // ように壊れ、たまたま『先頭 = best』な配置だけをテストしていた場合）を
    // 見落とす。ここで2つの実行結果を直接突き合わせることで、「答えは変わら
    // ない」という主張そのものを固定する。
    expect(chosenAt3.runnerId).toBe(chosenAt1.runnerId);
  });

  it('全台が資源を使い切っていても、1台構成・3台構成のどちらも置き先を返す（定員で断らない）', async () => {
    // `runner-placement.test.ts`「全部が使い切っていても置き先を返す」の台数
    // パラメタライズ版。**ここが定員との分かれ目**（north_star 禁止2）——資源が
    // 無いことは配置の材料が無いというだけで、断る理由にはならない。台数を
    // 変えてもこの規約が揺らがないことを見る。
    const full: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 32_000_000_000, source: 'cgroup' },
      managers: 3,
    };

    const solo = new PlacementFakeRunner('runner-full-solo', full);
    const soloRegistry = await placementRegistryOf(solo);
    await expect(soloRegistry.select({})).resolves.toMatchObject({ runnerId: 'runner-full-solo' });
    await soloRegistry.stop();

    const a = new PlacementFakeRunner('runner-full-a', full);
    const b = new PlacementFakeRunner('runner-full-b', full);
    const c = new PlacementFakeRunner('runner-full-c', full);
    const fleetRegistry = await placementRegistryOf(a, b, c);
    // **例外を投げない**ことだけを見る——どれが選ばれるかは同点のときの実装の
    // 詳細（登録順の先）で、この歯の主題ではない。
    await expect(fleetRegistry.select({})).resolves.toMatchObject({});
    await fleetRegistry.stop();
  });
});

// ---------------------------------------------------------------------------
// 2. ルーティング——manager_id → runner_id の貼り付きが台数で変わらない
// ---------------------------------------------------------------------------

/**
 * 偽 runner。**「誰が何を受けたか」を全部記録する**
 * （`runner-sticky.test.ts` の `StickyRunner` と同じ作法。あちらは3台固定で
 * ルーティングそのものを固定するが、ここは**1台と3台を同じコードで
 * パラメタライズし、同じ形の保証が同じ形で成立することを見る**ので、別ファイル
 * として持つ——`manager.test.ts` の1台構成のルーティングと `runner-sticky.
 * test.ts` の3台構成のルーティングは、これまで別ファイル・別の書き方だった）。
 */
class RoutingFakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly sends: { managerId: string; text: string }[] = [];
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  readonly answers: { managerId: string; answer: RunnerAnswerCommand }[] = [];
  #onEvent: ((event: RunnerEvent) => void) | null = null;

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  /** この器から、指定した managerId 宛の許可確認をクローンへ流す。 */
  ask(managerId: string, requestId: string, summary: string): void {
    if (this.#onEvent === null) {
      throw new Error(`${this.runnerId} はまだ connect していない（ask を流せない）`);
    }
    this.#onEvent({
      type: 'ask',
      managerId,
      requestId,
      kind: 'permission',
      summary,
      askedAt: new Date().toISOString(),
    });
  }

  /** `send` / `resume` / `stop` / `answer` の合計。「1度も受けていない」を1つの数で言う。 */
  get receivedCount(): number {
    return this.sends.length + this.resumes.length + this.stops.length + this.answers.length;
  }

  hold(managerId: string): void {
    this.sessions.set(managerId, {
      managerId,
      status: 'running',
      cwd: this.workspacePath,
      request: `${managerId} の依頼`,
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  }

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.#onEvent = onEvent;
  }
  async start(command: { managerId: string }): Promise<void> {
    this.hold(command.managerId);
  }
  async resume(command: RunnerResumeCommand): Promise<void> {
    this.resumes.push(command);
    this.hold(command.managerId);
  }
  async send(managerId: string, text: string): Promise<void> {
    this.sends.push({ managerId, text });
  }
  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    this.answers.push({ managerId, answer });
    this.#onEvent?.({ type: 'settled', managerId, requestId: answer.requestId });
    return { delivered: true };
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    return [...this.sessions.values()];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

interface RoutingFleet {
  pool: ReturnType<typeof createManagerPool>;
  registry: RunnerRegistry;
  stores: Stores;
  inbox: InboxEvent[];
  runners: RoutingFakeRunner[];
  close: () => Promise<void>;
}

function jobFor(managerId: string, runnerId: string): Job {
  const at = '2026-08-01T00:00:00.000Z';
  return {
    id: managerId,
    managerId,
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: `${managerId} の仕事`,
    request: `${managerId} の依頼`,
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId,
  };
}

/** `size` 台の名簿を作り、各台に1本ずつ台帳のジョブを置いて `restore()` で繋ぐ。 */
async function routingFleetOf(size: number): Promise<RoutingFleet> {
  const runners = Array.from(
    { length: size },
    (_, index) => new RoutingFakeRunner(`runner-${index}`),
  );
  const registry = createRunnerRegistry();
  for (const runner of runners) {
    await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
  }
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });

  for (const runner of runners) {
    const managerId = `mgr-on-${runner.runnerId}`;
    await stores.jobs.putJob(jobFor(managerId, runner.runnerId));
    runner.hold(managerId);
  }
  await pool.restore();

  return {
    pool,
    registry,
    stores,
    inbox,
    runners,
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe.each([1, 3])(
  'manager_id → runner_id のルーティングは runner %i 台構成でも変わらない',
  (size) => {
    // **標的は常に「名簿の最後の器」にする。** 3台構成で先頭固定の壊れ方
    // （`#runnerOf` が名簿の先頭だけを見る形）を拾うためで、1台構成では
    // 「最後の器」＝「唯一の器」に一致する——同じ選び方が両方の台数で意味を持つ。
    function targetOf(fleet: RoutingFleet): RoutingFakeRunner {
      const target = fleet.runners.at(-1);
      if (target === undefined) throw new Error('fleet が空');
      return target;
    }

    it('send は台帳の runnerId が指す器へ届き、他の器は1度も受けない（managers の数も変わらない）', async () => {
      const fleet = await routingFleetOf(size);
      const target = targetOf(fleet);
      const others = fleet.runners.filter((runner) => runner !== target);
      const managerId = `mgr-on-${target.runnerId}`;

      // **managers の数——プロトコル側の突き合わせ項目。** 台数を増やしても、
      // 1本しか積んでいない台帳が2本以上に見えるような壊れ方（配ってしまう実装）
      // が無いことを、一覧の本数そのもので見る。
      expect((await fleet.pool.list()).length).toBe(size);

      const result = await fleet.pool.send(managerId, '続きを進めて');

      expect(result.outcome).toBe('delivered');
      expect(target.sends).toEqual([{ managerId, text: '続きを進めて' }]);
      for (const other of others) expect(other.receivedCount).toBe(0);

      await fleet.close();
    });

    it('許可確認の回答は台帳の runnerId が指す器にだけ届く（質問の text も変わらない）', async () => {
      const fleet = await routingFleetOf(size);
      const target = targetOf(fleet);
      const others = fleet.runners.filter((runner) => runner !== target);
      const managerId = `mgr-on-${target.runnerId}`;

      // **許可確認の質問の text——プロトコル側の突き合わせ項目。** 台数に関係なく
      // 同じ文言が同じ場所（`waiting[0].summary`）に出ることを見る。
      target.ask(managerId, 'req-equiv', 'Bash の実行許可: ls -la');
      await tick();
      const waitingBefore = (await fleet.pool.list()).find(
        (m) => m.managerId === managerId,
      )?.waiting;
      expect(waitingBefore).toEqual([
        {
          requestId: 'req-equiv',
          summary: 'Bash の実行許可: ls -la',
          kind: 'permission',
          askedAt: expect.any(String),
        },
      ]);

      const result = await fleet.pool.send(managerId, '許可します', {
        requestId: 'req-equiv',
        decision: 'allow',
      });

      expect(result.outcome).toBe('answered');
      expect(target.answers).toEqual([
        { managerId, answer: { requestId: 'req-equiv', message: '許可します', decision: 'allow' } },
      ]);
      for (const other of others) expect(other.receivedCount).toBe(0);

      await fleet.close();
    });
  },
);

// ---------------------------------------------------------------------------
// 3. 能力・プロトコルの等価性——委譲→許可確認→回答→報告を実セッションで通す
// ---------------------------------------------------------------------------

/**
 * SDK を実際に呼ばずにセッションの配線を検証する（`manager.test.ts` の
 * `fakeSdk()` を、この歯に要る最小限（`ask` と `report`）へ絞って複製した。
 * ここが要るのは「実際に組み立てられた `Options`」——`buildManagerSessionOptions`
 * を通した本物——を1台構成・3台構成それぞれから取り出して直接突き合わせる
 * ためで、`RunnerClient` を丸ごと偽装する上の2つの偽 runner では `Options` は
 * 見えない）。
 */
interface FakeSession {
  options: Options;
  ask(
    toolName: string,
    input: Record<string, unknown>,
    requestId?: string,
  ): Promise<PermissionResult>;
  report(text: string): Promise<void>;
}

function fakeSdkForOptions(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    let reports = 0;
    let asks = 0;
    const buffered: SDKMessage[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      options,
      async ask(toolName, input, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        const id = requestId ?? `req-${(asks += 1)}`;
        const result = await canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-${id}`,
          requestId: id,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した（返事が届かない）');
        return result;
      },
      async report(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(reports += 1)}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const _ of params.prompt as AsyncIterable<unknown>) {
          // クローンからの入力は、この歯では読み捨ててよい（配線の確認は不要）。
        }
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null as unknown as SDKMessage);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

/** 能力側（PR7 の突き合わせ項目）だけを抜き出す。関数フィールドは比較しない——同一の
 * オブジェクトになりようが無く（runner ごとに別クロージャ）、能力の等価性とは無関係。 */
function capabilitySnapshot(options: Options) {
  const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition | undefined;
  return {
    model: options.model,
    tools: options.tools,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    permissionMode: options.permissionMode,
    settingSources: options.settingSources,
    worker:
      worker === undefined
        ? undefined
        : { model: worker.model, tools: worker.tools, maxTurns: worker.maxTurns },
  };
}

const EQUIVALENCE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  ALTEROID_HOME: '/secret',
  // **`default` にする。** 既定の `auto` では `Bash` のような当たり障りのない
  // 道具は確認を出さない（`manager.test.ts`「既定では当たり障りのない道具で
  // 確認を出さない」）ので、`default` へ戻して許可確認の経路（プロトコル側の
  // 突き合わせ対象）を確実に通す。
  ALTEROID_MANAGER_PERMISSION_MODE: 'default',
};

interface EquivalenceResult {
  capability: ReturnType<typeof capabilitySnapshot>;
  /** プロトコル側。`outcome` / 許可確認の質問の `text` / `managers` の数。 */
  protocol: {
    askOutcome: string;
    questionText: string | undefined;
    answerOutcome: string;
    managersCount: number;
    lastReport: string | undefined;
  };
}

/** `count` 台の実 `LocalRunner`（本物の `buildManagerSessionOptions` を通す）で1本の委譲を通す。 */
async function runDelegationOn(count: number): Promise<EquivalenceResult> {
  const fleet = Array.from({ length: count }, (_, index) => {
    const { fn, sessions } = fakeSdkForOptions();
    const runner = createLocalRunner({
      runnerId: `runner-${index}`,
      workspacePath: '/work/project',
      queryFn: fn,
      env: EQUIVALENCE_ENV,
    });
    return { runner, sessions };
  });
  const registry = createRunnerRegistry(fleet.map((entry) => entry.runner));
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    // **本番と同じ1本道を通す**（`manager.test.ts` の `setup()` と同じ理由）。
    profile: createProfileService({ stores, runners: registry }),
  });

  const { managerId } = await pool.start({ request: 'デプロイして' });
  const used = fleet.find((entry) => entry.sessions.length > 0);
  if (used === undefined) {
    throw new Error(`${count} 台構成のどの runner もセッションを受けていない`);
  }
  const session = used.sessions[0];
  if (session === undefined) throw new Error('内部整合性エラー: session が無い');

  const asked = session.ask('Bash', { command: 'git push' }, 'req-equiv');
  await tick();
  const waiting = (await pool.list()).find((m) => m.managerId === managerId)?.waiting;
  const managersCount = (await pool.list()).length;

  const sendResult = await pool.send(managerId, '許可します', {
    requestId: 'req-equiv',
    decision: 'allow',
  });
  const askOutcome = (await asked).behavior;

  await session.report('デプロイした');
  const [summary] = await pool.list();

  const result: EquivalenceResult = {
    capability: capabilitySnapshot(session.options),
    protocol: {
      askOutcome,
      questionText: waiting?.[0]?.summary,
      answerOutcome: sendResult.outcome,
      managersCount,
      lastReport: summary?.lastReport,
    },
  };

  await pool.stop();
  await registry.stop();
  return result;
}

describe('能力・プロトコルの等価性（M5 ゴール本文 / PR7）', () => {
  it('委譲→許可確認→回答→報告を通しても、1台構成と3台構成の結果は直接一致する', async () => {
    const at1 = await runDelegationOn(1);
    const at3 = await runDelegationOn(3);

    // **本題。** 1台構成の実行結果と3台構成の実行結果を直接突き合わせる——
    // 固定した期待値（下）とだけ照合すると、両方が同じ誤った値へ揃って壊れる
    // 形（例: 台数が変わると `permissionMode` が実装の都合で変わってしまうが、
    // どちらの構成でもそれぞれ単独では「値がある」ようにしか見えない、という形）
    // を見落とす。
    expect(at3.capability).toEqual(at1.capability);
    expect(at3.protocol).toEqual(at1.protocol);

    // 能力側（PR7 の突き合わせ項目: model / tools / maxTurns / permissionMode /
    // settingSources / agents）。定数との照合はどちらの構成でも同じでなければ
    // ならない。
    for (const result of [at1, at3]) {
      expect(result.capability.model).toBe(MANAGER_MODEL);
      expect(result.capability.tools).toBeUndefined();
      expect(result.capability.allowedTools).toBeUndefined();
      expect(result.capability.disallowedTools).toBeUndefined();
      expect(result.capability.maxTurns).toBeUndefined();
      expect(result.capability.maxBudgetUsd).toBeUndefined();
      expect(result.capability.permissionMode).toBe('default');
      expect(result.capability.settingSources).toEqual(['user', 'project', 'local']);
      expect(result.capability.worker?.model).toBe(WORKER_MODEL);
      expect(result.capability.worker?.tools).toBeUndefined();
      expect(result.capability.worker?.maxTurns).toBeUndefined();

      // プロトコル側（PR7 の突き合わせ項目: outcome / 許可確認の質問の text /
      // managers の数）。
      expect(result.protocol.askOutcome).toBe('allow');
      expect(result.protocol.questionText).toBe('Bash の実行許可: {"command":"git push"}');
      expect(result.protocol.answerOutcome).toBe('answered');
      // **1本しか委譲していないので、台数によらず一覧は常に1本。**
      expect(result.protocol.managersCount).toBe(1);
      expect(result.protocol.lastReport).toBe('デプロイした');
    }
  });
});
