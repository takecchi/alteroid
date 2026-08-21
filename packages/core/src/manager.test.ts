import type {
  query as sdkQuery,
  AgentDefinition,
  CanUseTool,
  HookCallbackMatcher,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGER_MODEL,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WITHHELD_ENV_KEYS,
  createManagerPool,
  type ManagerPool,
  type RunnerFleetOverview,
} from './manager.js';
import {
  MANAGER_MODEL_ENV_KEY,
  WORKER_MODEL_ENV_KEY,
  placedManagerModels,
  resolveManagerModel,
  resolveWorkerModel,
} from './runner.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerPlacementResources,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingJobWrite,
  failingJournalAppend,
} from './testing.js';
import type { UsageTotals } from './usage.js';

type WorkerWaitEvent = Extract<RunnerEvent, { type: 'worker_wait' }>;

/**
 * SDK を実際に呼ばずに委譲の配線を検証する。
 *
 * ここで固定したいのは北極星に由来する不変条件（モデル帯・`tools` を渡さないこと・
 * 上限を置かないこと・認証情報を配らないこと）と、エスカレーションが一本の経路で
 * 通ること。SDK 実呼び出しの確認は手動で行う。
 */
interface FakeSession {
  options: Options;
  inputs: string[];
  /** マネージャー側から「確認したい」と言う。返るのは SDK へ返す許可結果。 */
  ask(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<PermissionResult>;
  /** マネージャーが本文を1つ喋る（人間の画面に出るもの）。 */
  say(text: string, options?: { parentToolUseId?: string }): Promise<void>;
  /** マネージャー側の1ターンが終わる。 */
  report(text: string): Promise<void>;
  /** PostToolUse フックを鳴らす。 */
  usedTool(tool: string, extra?: Record<string, unknown>): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    let asks = 0;
    const buffered: SDKMessage[] = [];
    const inputs: string[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      options,
      inputs,
      async ask(toolName, input, signal, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        // SDK は1回の応答で並列に呼ばれた道具を、それぞれ別の request_id で
        // 同時に降ろしてくる。既定でも被らせない。
        const id = requestId ?? `req-${(asks += 1)}`;
        const result = await canUseTool(toolName, input, {
          signal: signal ?? new AbortController().signal,
          toolUseID: `tool-${id}`,
          requestId: id,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した（返事が届かない）');
        return result;
      },
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: sayOptions.parentToolUseId ?? null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text.length}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async report(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: 'uuid-result',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async usedTool(tool, extra = {}) {
        const matchers = options.hooks?.PostToolUse as HookCallbackMatcher[];
        for (const matcher of matchers) {
          for (const hook of matcher.hooks) {
            await hook(
              {
                hook_event_name: 'PostToolUse',
                tool_name: tool,
                tool_input: { a: 1 },
                transcript_path: '/tmp/does-not-exist.jsonl',
                ...extra,
              } as never,
              undefined,
              { signal: new AbortController().signal },
            );
          }
        }
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

      // クローンからの入力を読み続ける裏方（ここでは記録するだけ）
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
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

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  sessions: FakeSession[];
  inbox: InboxEvent[];
  runner: RunnerClient;
}

interface SetupOptions {
  stores?: Stores;
  withheldEnvKeys?: readonly string[];
  /** 差し替えると runner ごと入れ替えられる（HTTP 越しの検証に使う）。 */
  runner?: RunnerClient;
}

/**
 * デーモン側のプール＋同一プロセスの runner。
 *
 * SDK を握るのは runner なので、偽の `query` は runner に渡す。デーモンは
 * `RunnerRegistry` しか知らない（固定 URL も runner の内部も前提にしない）。
 */
function setup(
  env: NodeJS.ProcessEnv = { PATH: '/usr/bin', ALTEROID_HOME: '/secret' },
  options: SetupOptions = {},
): Setup {
  const { fn, sessions } = fakeSdk();
  const stores = options.stores ?? createMemoryStores();
  const inbox: InboxEvent[] = [];
  const runner =
    options.runner ??
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env,
      ...(options.withheldEnvKeys === undefined
        ? {}
        : { withheldEnvKeys: options.withheldEnvKeys }),
    });
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    // **本番と同じ1本道を通す。** 降ろし直しは更新と同じ列に入る必要があるので、
    // ここを省くと「重なったら壊れる」経路をテストが見なくなる。
    profile: createProfileService({ stores, runners: registry }),
  });
  return { pool, stores, sessions, inbox, runner };
}

describe('マネージャー', () => {
  it('層とモデル帯の対応、道具の配置を固定する（北極星の不変条件）', async () => {
    const s = setup();
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;

    // マネージャー = Opus / 作業者 = Sonnet。変更には人間の承認が要る（地雷5）
    expect(options.model).toBe(MANAGER_MODEL);
    expect(MANAGER_MODEL).toBe('opus');

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition;
    expect(worker.model).toBe(WORKER_MODEL);
    expect(WORKER_MODEL).toBe('sonnet');

    // `tools` を明示リストで絞らない（地雷1）。作業者は tools 省略 = 全継承
    expect(options.tools).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
    expect(worker.tools).toBeUndefined();
    expect(worker.disallowedTools).toBeUndefined();

    // ターン数・予算の上限で暴走を止めない（地雷2）
    expect(options.maxTurns).toBeUndefined();
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(worker.maxTurns).toBeUndefined();

    // 権限モードは人間が Claude Code を開いたときと同じ（Auto）。`canUseTool` の
    // 配線はそのまま残す（要件。既定で確認を出すかどうかだけが変わる）
    expect(options.permissionMode).toBe('auto');
    expect(typeof options.canUseTool).toBe('function');

    // 人間と同じ設定・同じ .mcp.json を渡す（下向きは同じものが見える）
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.cwd).toBe('/work/project');

    // Claude Code 既定のシステムプロンプトを置き換えない（置き換え = デグレード）
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });

    await s.pool.stop();
  });

  it('モデル帯の既定は環境変数で動かない。空・空白は既定に落ちる', () => {
    for (const env of [{}, { [MANAGER_MODEL_ENV_KEY]: '' }, { [MANAGER_MODEL_ENV_KEY]: '   ' }]) {
      expect(resolveManagerModel(env)).toBe(MANAGER_MODEL);
    }
    for (const env of [{}, { [WORKER_MODEL_ENV_KEY]: '' }, { [WORKER_MODEL_ENV_KEY]: '   ' }]) {
      expect(resolveWorkerModel(env)).toBe(WORKER_MODEL);
    }

    // 空文字が既定へ落ちることは器の都合でもある。compose は `${VAR:-}` で
    // 渡すので、未設定の変数は空文字として届く。ここを `!== undefined` で見ると
    // 空文字がそのまま SDK へ流れて起動時に落ちる。

    // 人間が置いた値だけが効く。既知の別名で関門を作らない（SDK が増やした
    // モデルを人間が選べなくなる＝能力の削除。north_star 禁止1）
    expect(resolveManagerModel({ [MANAGER_MODEL_ENV_KEY]: 'fable' })).toBe('fable');
    expect(resolveManagerModel({ [MANAGER_MODEL_ENV_KEY]: '  fable  ' })).toBe('fable');
    expect(resolveWorkerModel({ [WORKER_MODEL_ENV_KEY]: 'まだ無いモデル' })).toBe('まだ無いモデル');
  });

  it('置かれたかどうかは、既定と同じ値を置いた場合も「置いた」である', () => {
    expect(placedManagerModels({})).toEqual([]);
    expect(placedManagerModels({ [MANAGER_MODEL_ENV_KEY]: '  ' })).toEqual([]);

    // **値の比較で言い換えられない。** ここが答えているのは「差し替えの承認が
    // 置かれているか」であって「既定と違うか」ではない（起動ログに出す判断の材料）。
    expect(placedManagerModels({ [MANAGER_MODEL_ENV_KEY]: MANAGER_MODEL })).toEqual([
      { key: MANAGER_MODEL_ENV_KEY, value: MANAGER_MODEL, fallback: MANAGER_MODEL },
    ]);

    expect(
      placedManagerModels({
        [MANAGER_MODEL_ENV_KEY]: 'fable',
        [WORKER_MODEL_ENV_KEY]: 'haiku',
      }),
    ).toEqual([
      { key: MANAGER_MODEL_ENV_KEY, value: 'fable', fallback: MANAGER_MODEL },
      { key: WORKER_MODEL_ENV_KEY, value: 'haiku', fallback: WORKER_MODEL },
    ]);
  });

  it('差し替えた帯が、実際に SDK へ渡るマネージャーと作業者の両方に効く', async () => {
    const s = setup({
      PATH: '/usr/bin',
      [MANAGER_MODEL_ENV_KEY]: 'fable',
      [WORKER_MODEL_ENV_KEY]: 'haiku',
    });
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;
    expect(options.model).toBe('fable');

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition;
    expect(worker.model).toBe('haiku');

    await s.pool.stop();
  });

  it('マネージャーだけ差し替えても、作業者は巻き添えで動かない', async () => {
    // **作業者の `model` を省略すると SDK の既定は親の継承になる。** 省いてあると
    // マネージャーを差し替えた人が作業者まで一緒に動かすことになり、「切り出した
    // 実作業だけ安く回す」という階層の意味が消える（north_star の前提）。
    const s = setup({ PATH: '/usr/bin', [MANAGER_MODEL_ENV_KEY]: 'fable' });
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;
    expect(options.model).toBe('fable');

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition;
    expect(worker.model).toBe(WORKER_MODEL);
    expect(worker.model).toBe('sonnet');

    await s.pool.stop();
  });

  it('記憶ストアの所在を子プロセスへ渡さない（非対称な可視性は境界で守る）', async () => {
    const s = setup({ PATH: '/usr/bin', ALTEROID_HOME: '/secret', ALTEROID_PORT: '4517' });
    await s.pool.start({ request: '調べて' });

    const env = (s.sessions[0] as FakeSession).options.env ?? {};
    for (const key of WITHHELD_ENV_KEYS) expect(env[key]).toBeUndefined();
    // 一方で、人間が使っている環境そのものは削らない（PATH を落とすとただの故障）
    expect(env.PATH).toBe('/usr/bin');

    await s.pool.stop();
  });

  it('委譲はノンブロッキングで、複数を同時に走らせられる（受け入れ基準1）', async () => {
    const s = setup();

    const a = await s.pool.start({ request: 'A をやって' });
    const b = await s.pool.start({ request: 'B をやって', cwd: '/work/other' });

    expect(s.sessions).toHaveLength(2);
    expect((await s.pool.list()).map((m) => m.managerId).sort()).toEqual(
      [a.managerId, b.managerId].sort(),
    );

    // 交錯して届く報告を、どちらのものか分かる形で受信箱へ流す
    await (s.sessions[1] as FakeSession).report('B 終わった');
    await (s.sessions[0] as FakeSession).report('A 終わった');

    const reports = s.inbox.filter((event) => event.type === 'manager_message');
    expect(reports.map((event) => [event.managerId, event.text])).toEqual([
      [b.managerId, 'B 終わった'],
      [a.managerId, 'A 終わった'],
    ]);

    await s.pool.stop();
  });

  it('既定では当たり障りのない道具で確認を出さない（permissionMode: auto）', async () => {
    // 人間が Claude Code を開けば `Read` や `grep` でいちいち止まらない。層を
    // 下りた瞬間にそれが止まるならデグレード（north_star 禁止1）であって仕様ではない。
    const s = setup();
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;
    expect(options.permissionMode).toBe('auto');
    // 経路そのものは残す。既定で確認を出すかどうかだけを変えている。
    expect(typeof options.canUseTool).toBe('function');

    await s.pool.stop();
  });

  it('許可確認はクローンへ回り、返事が来るまでその仕事だけが止まる（受け入れ基準2）', async () => {
    // 都度確認へ戻した状態＝設定を戻せば従来どおり動くことの証明でもある。
    const s = setup({
      PATH: '/usr/bin',
      ALTEROID_HOME: '/secret',
      ALTEROID_MANAGER_PERMISSION_MODE: 'default',
    });
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;
    expect(session.options.permissionMode).toBe('default');

    const asked = session.ask('Bash', { command: 'git push' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // クローンの受信箱に許可確認として届く
    const event = s.inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission', managerId });
    expect((event as { requestId?: string }).requestId).toBeTruthy();

    // 止まっているのはこの仕事だけ（一覧からもそう見える）
    const waiting = (await s.pool.list()).find((m) => m.managerId === managerId);
    expect(waiting?.status).toBe('waiting_human');
    expect(waiting?.waiting[0]?.summary).toContain('Bash');

    // クローンが答えると、そこだけが再開する
    const result = await s.pool.send(managerId, 'よい', { decision: 'allow' });
    expect(result.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.status).toBe('running');

    // 誰が何を聞かれ、何と答えたかが日誌だけで追える（受け入れ基準4）
    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      managerId?: string;
      answer?: string;
    }[];
    expect(escalations.map((entry) => [entry.managerId, entry.answer])).toEqual([
      [managerId, '[allow] よい'],
      [managerId, undefined],
    ]);

    await s.pool.stop();
  });

  it('deny は理由付きでマネージャーへ返る（会話は続く。能力は削らない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Bash', { command: 'rm -rf /' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'それはやめて、代わりに一覧だけ見せて', { decision: 'deny' });

    expect(await asked).toMatchObject({
      behavior: 'deny',
      message: 'それはやめて、代わりに一覧だけ見せて',
    });

    await s.pool.stop();
  });

  it('AskUserQuestion にはクローンの言葉がそのまま回答として入る', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('AskUserQuestion', {
      questions: [
        { question: 'DB はどちらにする？', header: 'DB', options: [], multiSelect: false },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(s.inbox.find((e) => e.type === 'manager_message')).toMatchObject({
      kind: 'question',
      text: 'DB はどちらにする？',
    });

    await s.pool.send(managerId, 'PostgreSQL で');
    expect(await asked).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'DB はどちらにする？': 'PostgreSQL で' } },
    });

    await s.pool.stop();
  });

  it('返事待ちでないときの manager_send は追加指示として届く（会話に戻れる）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });

    const result = await s.pool.send(managerId, 'ついでにこれも見て');
    expect(result.outcome).toBe('delivered');

    await expect
      .poll(() => (s.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toEqual(['調べて', 'ついでにこれも見て']);

    await s.pool.stop();
  });

  it('マネージャーと作業者の全ツール実行が日誌に残る（受け入れ基準4）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '直して' });
    const session = s.sessions[0] as FakeSession;

    await session.usedTool('Edit');
    await session.usedTool('Bash', { agent_id: 'agent-1', agent_type: WORKER_AGENT_NAME });

    const entries = (await s.stores.journal.list({ types: ['tool_use'] })) as {
      actor: string;
      tool: string;
    }[];
    expect(entries.map((entry) => [entry.actor, entry.tool])).toEqual([
      [`worker:${managerId}:${WORKER_AGENT_NAME}`, 'Bash'],
      [`manager:${managerId}`, 'Edit'],
    ]);

    await s.pool.stop();
  });

  it('manager_id → runner_id → session_id → workspace が JobStore に残る（resume の足がかり）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '直して' });

    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-mgr');

    const job = (await s.stores.jobs.listJobs())[0];
    expect(job).toMatchObject({
      id: managerId,
      request: '直して',
      cwd: '/work/project',
      // 宛先（どの runner か）と workspace の所在まで残す。ここが欠けると、
      // runner が増えた瞬間に manager_send の宛先が決まらない。
      runnerId: 'runner-test',
      workspace: { kind: 'runner-volume', runnerId: 'runner-test', path: '/work/project' },
    });

    // **runner のローカルパスは台帳に持たない。** 生ログへは runner の API か、
    // 預かったアーカイブ／セッションから降りる（デーモンは runner の中を仮定しない）。
    await (s.sessions[0] as FakeSession).usedTool('Read');
    expect(job).not.toHaveProperty('transcriptPath');

    await s.pool.stop();
  });

  it('停止時に返事待ちを宙吊りにしない', async () => {
    const s = setup();
    await s.pool.start({ request: 'デプロイして' });
    const asked = (s.sessions[0] as FakeSession).ask('Bash', { command: 'git push' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await s.pool.stop();
    expect(await asked).toMatchObject({ behavior: 'deny' });
  });

  it('同時に複数を待っているとき、回答は requestId の宛先へ届く（取り違えない）', async () => {
    // 1回の応答で並列に道具を呼ぶと、確認は同時に複数降りてくる。宛先を見ずに
    // 先頭へ入れると、拒否のつもりの一言が別の質問の答えになり、拒否したかった
    // 道具は次の一言で通ってしまう。
    const s = setup();
    const { managerId } = await s.pool.start({ request: '整理して' });
    const session = s.sessions[0] as FakeSession;

    const question = session.ask('AskUserQuestion', {
      questions: [{ question: 'DB は？', header: 'DB', options: [], multiSelect: false }],
    });
    const danger = session.ask('Bash', { command: 'rm -rf /' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const waiting = (await s.pool.list()).find((m) => m.managerId === managerId)?.waiting ?? [];
    expect(waiting).toHaveLength(2);
    const dangerId = waiting.find((item) => item.summary.includes('Bash'))?.requestId as string;
    const questionId = waiting.find((item) => item.summary.includes('DB'))?.requestId as string;

    // 宛先を書かずに答えるのは拒む（推測して取り違えるより、聞き返す）
    const guessed = await s.pool.send(managerId, 'それは危険なのでやめて', { decision: 'deny' });
    expect(guessed.outcome).toBe('unknown');
    expect(guessed.detail).toContain('requestId');

    // 宛先を指せば、その1件だけが解ける
    await s.pool.send(managerId, 'それは危険なのでやめて', {
      decision: 'deny',
      requestId: dangerId,
    });
    expect(await danger).toMatchObject({ behavior: 'deny', message: 'それは危険なのでやめて' });

    await s.pool.send(managerId, 'PostgreSQL で', { requestId: questionId });
    expect(await question).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'DB は？': 'PostgreSQL で' } },
    });

    await s.pool.stop();
  });

  it('同じ確認が再送されても、待ちを二重に積まない（回答が二重に消費されない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    const first = session.ask('Bash', { command: 'ls' }, undefined, 'req-same');
    const again = session.ask('Bash', { command: 'ls' }, undefined, 'req-same');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    await s.pool.send(managerId, 'よい', { decision: 'allow', requestId: 'req-same' });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await again).toEqual({ behavior: 'allow' });

    await s.pool.stop();
  });

  it('decision を書き忘れても、日本語の拒否を承認と読み違えない', async () => {
    // 「それはやめて」の「やめ」の前に区切りは無い。語境界で探すと**見つからず**、
    // 見つからないことが allow として表に出る（拒否が承認になる最悪の壊れ方）。
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Bash', { command: 'git push --force' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'それはやめて、代わりに差分だけ見せて');

    expect(await asked).toMatchObject({ behavior: 'deny' });

    await s.pool.stop();
  });

  it('肯定の返事は通す（迷ったら止める、にはしない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Read', { file_path: '/work/a.ts' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'よい、そのまま進めて');

    expect(await asked).toEqual({ behavior: 'allow' });

    await s.pool.stop();
  });

  it('中断で解けた確認は待ち行列に残らない（次の指示を食い潰さない）', async () => {
    // マネージャー側の中断で宙吊りを解いたあと、その1件が行列に残っていると、
    // 次にクローンが送った「追加指示」が誰も待っていない返事として消える。
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    const aborter = new AbortController();
    const asked = session.ask('Bash', { command: 'ls' }, aborter.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    aborter.abort();
    expect(await asked).toMatchObject({ behavior: 'deny' });

    // 返事待ちは解けている
    const after = (await s.pool.list()).find((m) => m.managerId === managerId);
    expect(after?.status).toBe('running');
    expect(after?.waiting).toEqual([]);

    // 次の一言はちゃんと追加指示として届く
    expect((await s.pool.send(managerId, 'こっちを見て')).outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('居ないマネージャーへの送信は、黙って捨てずに理由を返す', async () => {
    const s = setup();
    expect((await s.pool.send('mgr-nope', 'やあ')).outcome).toBe('unknown');
    await s.pool.stop();
  });

  it('記憶ストアの接続情報を子プロセスへ渡さない（クラウド構成の本命の強制）', async () => {
    // ローカルではパス、クラウドでは DB 認証情報。**渡さなければ到達経路が無い**。
    // ツールを削って塞ぐのではなく、認証情報の配布範囲で守る（roadmap M4 受け入れ基準3）。
    const s = setup(
      {
        PATH: '/usr/bin',
        HOME: '/home/alteroid',
        ALTEROID_HOME: '/data/alteroid',
        ALTEROID_DATABASE_URL: 'postgres://alteroid:secret@db:5432/alteroid',
        CLAUDE_CODE_OAUTH_TOKEN: 'token-for-the-sdk',
      },
      { withheldEnvKeys: ['PGPASSWORD'] },
    );
    await s.pool.start({ request: '調べて' });

    const env = (s.sessions[0] as FakeSession).options.env ?? {};
    expect(env.ALTEROID_DATABASE_URL).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    for (const key of WITHHELD_ENV_KEYS) expect(env[key]).toBeUndefined();

    // 記憶ストアと関係のない環境は削らない。認証を落とせばマネージャーは
    // ただ動かなくなる = デグレードであって境界ではない。
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-for-the-sdk');
    expect(env.PATH).toBe('/usr/bin');

    await s.pool.stop();
  });
});

describe('デーモン再起動後（M4）', () => {
  const runningJob = {
    id: 'mgr-old',
    managerId: 'mgr-old',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-before-restart',
    lastReport: 'スキーマまで書いた',
  };

  it('走行中だったマネージャーを実際に resume し、続きを進めさせる（受け入れ基準2）', async () => {
    // **開き直すだけでは足りない。** 人間の不在で止まってよいのは承認待ちの仕事
    // だけであり（PRD「自律」）、器が落ちたことを理由に止まったままにはしない。
    // 「話しかけられるまで待つ」形にすると、自律運転中の再起動で仕事が永久に止まる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const s = setup(undefined, { stores });

    const restored = await s.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual(['mgr-old']);
    // session_id から SDK セッションが起き、続きの指示まで届いている
    expect(s.sessions).toHaveLength(1);
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');
    await expect
      .poll(() => (s.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toEqual(['[system] デーモンが再起動した。中断していた作業の続きを進めよ。']);

    // クローンが「続きがある」ことを知る経路は受信箱ただ1つ
    const notice = s.inbox.find((event) => event.type === 'manager_message');
    expect(notice).toMatchObject({ managerId: 'mgr-old', kind: 'report' });
    expect((notice as { text: string }).text).toContain('DB の移行をやって');
    expect((notice as { text: string }).text).toContain('スキーマまで書いた');

    // 一覧では走行中に戻っている（止まったまま live: true に見せない）
    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-old');
    // resume 後のセッション id は SDK が返す新しいもので上書きされる
    // （次の再起動でもそこから戻れるように、台帳は常に最新の id を持つ）。
    expect(listed).toMatchObject({ live: true, status: 'running', runnerId: 'runner-test' });

    await s.pool.stop();
  });

  it('返事待ちだったマネージャーには、確認が失われたことを伝えて再開させる', async () => {
    // 待っていた確認は器と一緒に消えている。黙って再開させると、マネージャーは
    // 返ってこない返事を待ち続ける。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const s = setup(undefined, { stores });

    await s.pool.restore();

    await expect
      .poll(() => (s.sessions[0] as FakeSession).inputs.join(''), { timeout: 2000 })
      .toContain('待っていた確認は器と一緒に失われている');

    await s.pool.stop();
  });

  it('runner に生きているセッションは resume せず、繋ぎ直すだけ（二重に起こさない）', async () => {
    // デーモンだけが再起動した場合、マネージャーは runner の中で手を動かし続けて
    // いる。ここで resume すると、走っているセッションを二重に起こすことになる。
    const stores = createMemoryStores();
    const first = setup(undefined, { stores });
    const { managerId } = await first.pool.start({ request: '長い仕事' });

    // 同じ runner に別のデーモンが繋ぎ直す（＝デーモンだけが入れ替わった。
    // runner は別プロセスなので、デーモンが消えてもセッションは生きている）。
    const second = setup(undefined, { stores, runner: first.runner });
    const restored = await second.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual([managerId]);
    // セッションは増えていない（resume していない）
    expect(first.sessions).toHaveLength(1);
    const notice = second.inbox.find((event) => event.type === 'manager_message');
    expect((notice as { text: string }).text).toContain('runner の中で走り続けている');

    await second.pool.stop();
  });

  it('待機中だった仕事は黙って引き取る（報告はしないが、話しかければ続く）', async () => {
    // `done` は死ではなく待機である。ここで拾わないと、一度再起動を跨いだ仕事は
    // 二度目の再起動で resume できなくなる（人間が開いたままの窓を勝手に閉じる形）。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-done', status: 'done' });
    const s = setup(undefined, { stores });

    expect(await s.pool.restore()).toEqual([]);
    expect(s.inbox).toEqual([]);
    expect(s.sessions).toHaveLength(0);

    expect((await s.pool.send('mgr-done', 'まだ続きがある')).outcome).toBe('delivered');
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');

    await s.pool.stop();
  });

  it('session_id の無い仕事は拾い直さない（戻る先が無い）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-nosession', sessionId: undefined });
    const s = setup(undefined, { stores });

    expect(await s.pool.restore()).toEqual([]);
    expect(s.inbox).toEqual([]);
    expect((await s.pool.send('mgr-nosession', 'やあ')).outcome).toBe('unknown');

    await s.pool.stop();
  });

  /**
   * **`stopped` は明示的に止められた終端であって、`done`（待機）ではない。**
   *
   * `restore()` / `#reattach()` は `running` / `waiting_human` のホワイトリストで
   * 自動の再開先を決めている（`stopped` は名指しで除外しなくても、このホワイト
   * リストに入っていない時点で自動では対象外になる）。ここでそれをロックする —
   * デーモンの再起動で、止めたはずのマネージャーが甦って `resume` されないこと。
   */
  it('stopped の仕事はデーモン再起動でも拾い直さない（明示的に止められた終端）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-stopped-restart', status: 'stopped' });
    const s = setup(undefined, { stores });

    const resumed = await s.pool.restore();

    // resumed に含まれない＝自動では再開の対象にしていない。
    expect(resumed).toEqual([]);
    // 起こし直しの通知（`#notifyRestored`）も出ていない。
    expect(s.inbox).toEqual([]);
    // runner へ resume が飛んでいない（飛んでいれば fake SDK にセッションが1本立つ）。
    expect(s.sessions).toHaveLength(0);

    await s.pool.stop();
  });

  /**
   * **`stopped` でも、明示的な `manager_send` は続きへ戻せる。**
   *
   * `schema.ts` の `jobStatusSchema` の doc は以前「話しかけても続かない」と
   * 書いていたが、これは誤りだった（2026-08-22 訂正）。`abort()` は
   * `job.sessionId` を消さない——デーモンが**自動では**起こし直さない（直前の
   * テスト）のと、人間・クローンが明示的に送ったときに戻せるかは別の話である。
   * `send()` は `record.attached` を見て `!record.attached` なら `#resumeOnce`
   * （`lost` / `failed` と同じ経路）へ入るので、`stopped` もここを通って続く。
   * ここを塞ぐと、人間が Claude Code のセッションを止めても `--resume` で戻せる
   * 能力を、この階層だけ持たないことになる（`docs/north_star.md` 禁止2・
   * 追加制限禁止）。
   */
  it('stopped の仕事でも、明示的な manager_send なら resume 経路を通って続く', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-stopped-send', status: 'stopped' });
    const s = setup(undefined, { stores });

    // 自動では拾い直さない（直前のテストと同じ確認。ここまでは同じ振る舞い）。
    expect(await s.pool.restore()).toEqual([]);
    expect(s.sessions).toHaveLength(0);

    const result = await s.pool.send('mgr-stopped-send', 'まだ続きがある');

    // session_id から resume 経路を通り、実際に SDK セッションが起きている。
    expect(result.outcome).toBe('delivered');
    expect(s.sessions).toHaveLength(1);
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');

    // 台帳も `running` へ戻る（`stopped` に固定されたままにはならない）。
    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-stopped-send');
    expect(listed?.status).toBe('running');

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションを、繋がっているからと live: true にしない', async () => {
    // 引き取り（`#restoreJobs`）は runner が名乗った状態をそのまま採る。runner の
    // 側では resume の失敗が確定してから（`#status = 'lost'`）そのセッションが
    // 一覧から消えるまでに実 I/O を挟むので、その隙間で引き取ると `lost` を名乗る
    // セッションを掴む。その像の `attached` は上流で `false` に倒すようにしたが、
    // **`live` の判定はそれに依存しない**（下の理由）。
    //
    // **「`lost` と `attached: true` が同時に立つ代入は無い」に寄りかからない。**
    // 代入を全部数え上げて成り立つ不変条件は、次に代入を足した人が黙って壊す。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'lost',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    const restored = await s.pool.restore();
    // 繋ぎ直してはいる（引き取りの経路を通ったことを固定する）。
    expect(restored.map((m) => m.managerId)).toEqual([runningJob.id]);
    expect(restored[0]?.live).toBe(false);

    const listed = (await s.pool.list()).find((m) => m.managerId === runningJob.id);
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションへ send すると resume 経路を通る（届かない runner.send() にしない）', async () => {
    // `attached: true` を固定していた頃は、ここで `send()` の `!record.attached` が
    // 偽になり `runner.send()` が直に呼ばれていた。しかし畳まれたセッションへの
    // `push` は `RunnerSession#push` が `#stopped` を見て黙って捨てる
    // （runner.ts）。つまり「届いた」という顔をして実は届いていなかった —
    // これがこの不具合の実害である。ここでは `runner.resume()`（`#resumeOnce`
    // の経路）が呼ばれたことを直接見て、そちらへ向いたことを固定する。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'lost',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    const result = await s.pool.send(runningJob.id, '続けて');

    // resume 経路を通った証拠は「resume が増えた」こと（fake の `send` は何も
    // 記録しないので、その不在ではなく resume の発生そのものを見る）。
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: 'sess-before-restart',
    });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションを引き取っても、「走り続けている」とは知らせない', async () => {
    // `#notifyRestored(record, 'attached')` は「runner の中で走り続けている」と
    // 断言する文面を受信箱へ流す。しかし `lost` は runner が「もう居ない」と
    // 名乗った状態そのものなので、この文面は嘘になる。`attached: true` を固定
    // していた頃はここが必ず届いていた（前のテストの実害と対になる、報告面の実害）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'lost',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(false);

    await s.pool.stop();
  });

  it('runner が failed と名乗ったセッションへ send すると resume 経路を通る（届かない runner.send() にしない）', async () => {
    // `failed` は `lost` と同じ形で畳まれている。`RunnerSession#finish('failed', ...)`
    // （runner.ts）も `#stopped = true` を先に立ててから一覧に残ったまま実 I/O
    // （アーカイブ送出）を挟むので、その隙間で引き取ると畳まれたセッションへ
    // `attached: true` を立てることになる。`lost` 版と同じ実害（届かない
    // `runner.send()` を届いたことにして `running` へ巻き戻す）が起きるはずが
    // 無いことを、`runner.resume()`（`#resumeOnce` の経路）が呼ばれたことで見る。
    // `failed` は「話しかければ直るかもしれない失敗」（runner.ts のコメント）
    // なので、resume を試みるのが正しい。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'failed',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    const result = await s.pool.send(runningJob.id, '続けて');

    // resume 経路を通った証拠は「resume が増えた」こと（fake の `send` は何も
    // 記録しないので、その不在ではなく resume の発生そのものを見る）。
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: 'sess-before-restart',
    });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('runner が failed と名乗ったセッションを引き取っても、「走り続けている」とは知らせない', async () => {
    // `#notifyRestored(record, 'attached')` は「runner の中で走り続けている」と
    // 断言する文面を受信箱へ流す。しかし `failed` も `lost` と同じく runner が
    // 「もう居ない」と名乗った状態そのものなので、この文面は嘘になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'failed',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(false);

    await s.pool.stop();
  });

  it('生きたまま待機している done へ send しても、セッションを二重に起こさない', async () => {
    // `done` は `lost` / `failed` と違って**2箇所から付く**。ここで確かめたいのは
    // 畳まれた方（`#finish('done', ...)`）ではなく、セッションを `#sessions` に
    // 生かしたまま `#status` だけを `'done'` にする方（1ターンが終わって次の
    // 指示を待っている状態）。`swappableRunner` は使わない — あの fake の
    // `resume` は無条件に alive を1本増やすので、`host.resume()` の短絡
    // （生きたセッションを見つけたら `push` して return する）を確かめられない。
    // 実 runner（`setup` の既定 = `createLocalRunner`）で、ホワイトリスト化した
    // `attached` 判定が「安全側に倒しても届く」ことまで見る。
    const stores = createMemoryStores();
    const first = setup(undefined, { stores });
    const { managerId } = await first.pool.start({ request: '長い仕事' });

    // 1ターン終える。runner 側は `#status` を `'done'` にするが、セッションは
    // `#sessions` に生きたまま残る（runner.ts の該当分岐）。
    await (first.sessions[0] as FakeSession).report('ここまでやった');
    await expect
      .poll(
        async () => {
          const jobs = await stores.jobs.listJobs();
          return jobs.find((job) => job.id === managerId)?.status;
        },
        { timeout: 2000 },
      )
      .toBe('done');

    // デーモンだけが再起動した想定。runner は同じものを渡す（生きたまま）。
    const second = setup(undefined, { stores, runner: first.runner });
    await second.pool.restore();

    const result = await second.pool.send(managerId, 'まだ続きがある');

    // セッションは増えていない（`host.resume()` が alive を見つけて `push` に
    // 短絡した証拠。新しいセッションが起きていれば `resume()` が作り直している）。
    expect(first.sessions).toHaveLength(1);
    expect(result.outcome).toBe('delivered');
    // 「resume 経路へ向いた」だけでなく、実際に文言が届いたことまで見る。
    // ここが「安全側に倒しても実害が無い」の全部である。
    await expect
      .poll(() => (first.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toContain('まだ続きがある');

    await second.pool.stop();
  });

  it('生きたまま待機している done を引き取っても、「走り続けている」とは知らせない', async () => {
    // 観測された実害そのもの: 通知は「走り続けている」と言うのに、`manager_list`
    // は `[done]`（待機）を返す。`done` を `attached: true` にしていた頃は、
    // 畳まれた方の `done`（実は死んでいる）でもこの通知が出ていた。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'done',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(false);

    await s.pool.stop();
  });

  it('done を安全側に倒しても、一覧の live: true は落ちない', async () => {
    // `attached: false` にしたことで「話しかけられるのに切れて見える」という
    // 逆向きの嘘が出ていないかを測る。`isLive()` は `record.job.sessionId` が
    // あれば `attached` を見ずに `true` を返すので、ここは崩れないはずである。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'done',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    const restored = await s.pool.restore();
    expect(restored[0]).toMatchObject({ status: 'done', live: true });

    const listed = (await s.pool.list()).find((m) => m.managerId === runningJob.id);
    expect(listed).toMatchObject({ status: 'done', live: true });

    await s.pool.stop();
  });

  it('runner が waiting_human と名乗ったセッションは、繋がっているままにする', async () => {
    // ホワイトリストの肯定側。`running` 側は既存テスト
    // （'runner に生きているセッションは resume せず、繋ぎ直すだけ'）が持っている
    // ので、ここでは `waiting_human` を固定する。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'waiting_human',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(true);

    await s.pool.stop();
  });

  it('戻る先が無い仕事は、話しかけた後も live: false のままである', async () => {
    // 上の `unknown` は「届かなかった」という**その場の返事**でしかない。届け
    // られなかった相手を一覧が `live: true` で見せ続けるなら、人間もクローンも
    // 送り直す先として選び続ける。**話しかけた後こそ嘘をつかせない。**
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-nosession', sessionId: undefined });
    const s = setup(undefined, { stores });

    expect((await s.pool.send('mgr-nosession', 'やあ')).outcome).toBe('unknown');

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-nosession');
    expect(listed).toMatchObject({ live: false });
    expect(listed?.sessionId).toBeUndefined();

    await s.pool.stop();
  });

  it('生ログは runner からデーモンへ上がり、そこから降りられる', async () => {
    // **runner は記憶ストアの鍵を持たない。** だから生ログを永続化するのは
    // デーモンであり、runner は預けるだけである。ここが切れると、器を作り直した
    // 後に manager_id から生ログへ降りられない（可観測性の最下段の欠落）。
    const appended: { projectKey: string; entries: unknown[] }[] = [];
    const sessionStore = {
      append: async (key: { projectKey: string }, entries: unknown[]) => {
        appended.push({ projectKey: key.projectKey, entries });
      },
      load: async (key: { projectKey: string; sessionId: string }) =>
        key.projectKey === 'proj-key' && key.sessionId === 'sess-mgr'
          ? [{ type: 'user', uuid: 'u1' }]
          : null,
    };
    const stores = { ...createMemoryStores(), sessionStore };
    const s = setup(undefined, { stores });
    const { managerId } = await s.pool.start({ request: '調べて' });

    // runner 側の SDK が生ログを預けると、デーモンの側に落ちる
    const passed = (s.sessions[0] as FakeSession).options.sessionStore as typeof sessionStore;
    expect(passed).toBeDefined();
    await passed.append({ projectKey: 'proj-key' }, [{ type: 'user', uuid: 'u1' }]);
    await expect.poll(() => appended.length, { timeout: 2000 }).toBe(1);

    // 生ログを引き当てる鍵（projectKey）も台帳に残る
    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.projectKey, { timeout: 2000 })
      .toBe('proj-key');

    // runner のファイルもアーカイブも無いが、預けた生ログから返せる
    expect(await s.pool.transcript(managerId)).toBe('{"type":"user","uuid":"u1"}\n');

    await s.pool.stop();
  });
});

/**
 * 器の入れ替えを再現できる runner。
 *
 * デーモンから見える顔（`RunnerClient`）だけで作る。HTTP 実装でも同一プロセス
 * 実装でも、デーモンが知っているのはこの形しかない。
 */
function swappableRunner(runnerId = 'runner-primary') {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const state = {
    alive: [] as RunnerManagerState[],
    resumes: [] as RunnerResumeCommand[],
    /**
     * `list()` が呼ばれた回数。
     *
     * **「resume が増えていない」だけでは、機構が動いて何もしなかったのか、
     * そもそも動かなかったのかを区別できない。** ここを見れば、生死を runner に
     * 聞きに行ったことまで確かめられる。
     */
    listCalls: 0,
    answers: [] as { managerId: string; requestId: string }[],
    /** 降ろされた実行環境プロファイル。名乗るたびに1本増える。 */
    profiles: [] as string[],
  };
  const runner: RunnerClient = {
    runnerId,
    workspacePath: '/work/project',
    async connect(onEvent) {
      // **ここで名乗らせない。** 本物（`apps/daemon/src/runner-client.ts` の
      // `connect`）は `void this.#pump(...)` で即 return し、名乗りは後から SSE に
      // 乗ってくる。同期的に名乗らせると、起動時の引き取りと名乗りの順序が現実と
      // 変わり、「引き取りが見た器」と「SSE が繋がった器」がずれる場合を作れない。
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume(command) {
      state.resumes.push(command);
      state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send() {
      /* この検証では使わない */
    },
    async answer(managerId, answer) {
      state.answers.push({ managerId, requestId: answer.requestId });
      // 新しい器はその request_id を知らない（＝解けない）。
      return state.alive.some((s) => s.waiting.some((w) => w.requestId === answer.requestId));
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      state.listCalls += 1;
      return [...state.alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile(script: string) {
      state.profiles.push(script);
      return { ok: true };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return {
    runner,
    state,
    /** 器を作り直す ＝ 中のセッションは消え、新しいストリームが名乗り直す。 */
    swap() {
      state.alive = [];
      emit?.({ type: 'hello', runnerId });
    },
    /** ストリームだけが切れて繋ぎ直す（器はそのまま）。 */
    reconnect() {
      emit?.({ type: 'hello', runnerId });
    },
    /** SDK のセッションが立った、と伝える（本物は `start` の直後に上がってくる）。 */
    session(managerId: string, sessionId: string) {
      const session = state.alive.find((s) => s.managerId === managerId);
      if (session) session.sessionId = sessionId;
      emit?.({ type: 'session', managerId, sessionId });
    },
    /** マネージャーが確認を上げる（デーモン側の待ち行列に積まれる）。 */
    ask(managerId: string, requestId: string, summary: string) {
      const session = state.alive.find((s) => s.managerId === managerId);
      session?.waiting.push({ requestId, summary });
      emit?.({ type: 'ask', managerId, requestId, kind: 'permission', summary });
    },
    /**
     * マネージャーの1ターンが終わって報告が上がる。
     *
     * `fields` は `contentless` / `failure` を差し込むための口
     * （`runner-protocol.ts` の `report` イベントの doc）。**固定値のスタブに
     * しない** — 渡さなければ両方省略される既存の振る舞いのままなので、他の
     * テストの挙動は1つも変わらない。
     */
    report(
      managerId: string,
      text: string,
      status: JobStatus = 'done',
      fields: { contentless?: true; failure?: { code: string; via: string } } = {},
    ) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
    /** SDK が報告した消費の**累積**を降ろす（差分にするのはデーモン側）。 */
    usage(managerId: string, models: Record<string, UsageTotals>, sessionId?: string) {
      emit?.({ type: 'usage', managerId, sessionId, models });
    },
    /** 委譲1区間ぶんの集計を降ろす（runner 側の集計は `runner-wakeup.test.ts` が別に固定する）。 */
    workerWait(managerId: string, fields: Omit<WorkerWaitEvent, 'type' | 'managerId'>) {
      emit?.({ type: 'worker_wait', managerId, ...fields });
    },
    /** runner 側でセッションが本当に閉じた（`RunnerSession#finish()` を通った）。 */
    closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string) {
      state.alive = state.alive.filter((s) => s.managerId !== managerId);
      emit?.({ type: 'closed', managerId, status, reason });
    },
    /** 確認へ上げずにその場で止められた（分類器・deny 規則）。 */
    denied(managerId: string, tool: string) {
      emit?.({
        type: 'permission_denied',
        managerId,
        toolUseId: `${tool}:test`,
        tool,
        input: {},
        via: 'live',
      });
    },
    /** 前のセッションを開き直せなかった（`recovered: false` なら仕事が止まる）。 */
    resumeFailed(managerId: string, sessionId: string, reason: string, recovered: boolean) {
      emit?.({ type: 'resume_failed', managerId, sessionId, reason, recovered });
    },
  };
}

describe('消費を台帳へ積む', () => {
  const runningJob = {
    id: 'mgr-spend',
    managerId: 'mgr-spend',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べもの',
    request: '調べておいて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
  };

  function usage(over: Partial<UsageTotals>): UsageTotals {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0,
      ...over,
    };
  }

  async function totalCostUsd(stores: Stores): Promise<number> {
    const { rows } = await stores.usage.aggregate({});
    return rows.reduce((sum, row) => sum + row.totals.costUsd, 0);
  }

  it('累積が降りてきたら差分だけ積む（同じ累積が2回来ても増えない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ outputTokens: 100, costUsd: 1 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    // 累積が伸びた分だけ増える。
    fake.usage('mgr-spend', { opus: usage({ outputTokens: 250, costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(3);

    // 同じものが再送されても増えない（イベント再送で二重計上しない）。
    fake.usage('mgr-spend', { opus: usage({ outputTokens: 250, costUsd: 3 }) }, 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await totalCostUsd(stores)).toBe(3);

    await s.pool.stop();
  });

  it('モデル別に分けて積む（どの層が高いかが分かる）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', {
      'claude-opus-5': usage({ costUsd: 2 }),
      'claude-sonnet-5': usage({ costUsd: 0.5 }),
    });
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(2.5);

    const { rows } = await stores.usage.aggregate({});
    expect(rows.map((row) => row.model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(rows.every((row) => row.managerId === 'mgr-spend')).toBe(true);

    await s.pool.stop();
  });

  it('累積が数え直されても記録済みは減らず、数え直したことが日誌に残る', async () => {
    // resume で SDK 側の累積が 0 から始まる。ここで基準を下げて引き算すると
    // 記録済みの分が消える（＝消費が減ったように見える）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(5);

    fake.usage('mgr-spend', { opus: usage({ costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(8);

    const entries = await stores.journal.list({ limit: 50 });
    const note = entries.find((entry) => 'text' in entry && entry.text.includes('数え直された'));
    expect(note).toBeDefined();

    await s.pool.stop();
  });

  it('全部ゼロの累積では記録済みを崩さない（クラッシュの記録に引きずられない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(5);

    // ゼロを数え直しとして採用すると、次に届いた本物の $5 が丸ごと増分になる。
    fake.usage('mgr-spend', { opus: usage({}) }, 'sess-1');
    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await totalCostUsd(stores)).toBe(5);

    await s.pool.stop();
  });

  it('台帳の始点を持つので「記録が無い期間」を 0 と言わない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    // まだ1件も無いうちは始点も無い。
    expect((await stores.usage.aggregate({})).since).toBeNull();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) });
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    const aggregate = await stores.usage.aggregate({ from: '2020-01-01' });
    expect(aggregate.since).not.toBeNull();
    // 台帳より前にかかる照会は「0」ではなく「記録が無い」と言えること。
    expect(aggregate.beforeLedger).toBe(true);
    expect(aggregate.notice).toContain('請求明細ではない');

    await s.pool.stop();
  });

  /**
   * `fold.delta`（ターン1回ぶんの増分）は台帳へ積むだけで捨てていた。
   * ここは日誌に `turn_usage` として残ることを見る（`clone.ts` と対になる形を
   * `manager.ts` の `case 'usage'` にも入れた — 片方だけだと非対称が残る）。
   */
  it('1ターンの増分が cache read/write を保持したまま turn_usage として日誌に残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage(
      'mgr-spend',
      { opus: usage({ cacheReadInputTokens: 100, cacheCreationInputTokens: 30, costUsd: 1 }) },
      'sess-1',
    );
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    const entries = await stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
    expect(entry.layer).toBe('manager');
    expect(entry.site).toBe('session');
    expect(entry.managerId).toBe('mgr-spend');
    expect(entry.sessionId).toBe('sess-1');
    // **合計に潰していないこと** — read と write が別々に残っている。
    expect(entry.models.opus).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 30,
      webSearchRequests: 0,
      costUsd: 1,
    });
    expect(entry.reset).toBeUndefined();

    await s.pool.stop();
  });

  it('増分が空の回（同じ累積の再送）は turn_usage の行を書かない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    // 同じ累積が再送される（イベント再送）＝増分ゼロ。
    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = await stores.journal.list({ types: ['turn_usage'] });
    // **「行が無い」＝増分ゼロであって、そのターンが無料だったわけではない**
    // （このテストでは実際に増分がゼロなので1件のまま増えない、が正しい）。
    expect(entries).toHaveLength(1);

    await s.pool.stop();
  });

  it('累積が数え直された回は turn_usage に reset が付き、既存の数え直し通知（exchange）も従来どおり出る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(5);

    // resume で SDK 側の累積が 0 から始まり、次に読めた値が 3 だった形。
    fake.usage('mgr-spend', { opus: usage({ costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(8);

    // **既存の1行（`exchange`）は従来どおり出る**（あちらを壊していない）。
    const all = await stores.journal.list({ limit: 50 });
    const note = all.find((entry) => 'text' in entry && entry.text.includes('数え直された'));
    expect(note).toBeDefined();

    const turnUsageEntries = all.filter(
      (entry): entry is Extract<JournalEntry, { type: 'turn_usage' }> =>
        entry.type === 'turn_usage',
    );
    expect(turnUsageEntries).toHaveLength(2);
    const resetEntry = turnUsageEntries.find((entry) => entry.reset !== undefined);
    if (resetEntry === undefined) throw new Error('reset 付きの turn_usage が無い');
    expect(resetEntry.reset).toEqual({ fromCostUsd: 5, toCostUsd: 3 });
    // **models は差分ではなく新しい累積の先頭**（3 であって -2 ではない）。
    expect(resetEntry.models.opus?.costUsd).toBe(3);

    await s.pool.stop();
  });

  it('台帳へ積めなくても仕事は止まらず、跡が残る（turn_usage は書かれない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1');

    await expect
      .poll(
        async () => {
          const entries = await stores.journal.list({ limit: 50 });
          return entries.some(
            (entry) => 'text' in entry && entry.text.includes('消費を台帳へ記録できなかった'),
          );
        },
        { timeout: 2000 },
      )
      .toBe(true);

    const turnUsage = await stores.journal.list({ types: ['turn_usage'] });
    expect(turnUsage).toHaveLength(0);

    await s.pool.stop();
  });
});

describe('worker_wait — 委譲1区間ぶんの集計を日誌に残す', () => {
  const runningJob = {
    id: 'mgr-wait',
    managerId: 'mgr-wait',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べもの',
    request: '調べておいて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
  };

  it('runner から降りた worker_wait は日誌に1件だけ入る（台帳には足さない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.workerWait('mgr-wait', {
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      notifications: 3,
      submits: 0,
      settled: true,
    });

    const entries = await vi.waitFor(async () => {
      const found = await stores.journal.list({ types: ['worker_wait'] });
      if (found.length === 0) throw new Error('worker_wait がまだ日誌に無い');
      return found;
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'worker_wait',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      settled: true,
    });
    // sources を渡していなければ日誌にもフィールドごと現れない
    // （取れない軸に0の行を作らない）。
    expect(entries[0]).not.toHaveProperty('sources');

    // 台帳（`ManagerSummary`）には足さない。
    const summary = (await s.pool.list()).find((job) => job.managerId === 'mgr-wait');
    expect(summary).not.toHaveProperty('workerWait');
    expect(JSON.stringify(summary)).not.toContain('worker_wait');

    await s.pool.stop();
  });

  it('sources を渡していれば日誌にもそのまま残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.workerWait('mgr-wait', {
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 1,
      turns: 1,
      byCause: { input: 0, notification: 1, continuation: 0 },
      toolless: 1,
      notifications: 1,
      submits: 1,
      sources: { system: 1 },
      settled: true,
    });

    const entries = await vi.waitFor(async () => {
      const found = await stores.journal.list({ types: ['worker_wait'] });
      if (found.length === 0) throw new Error('worker_wait がまだ日誌に無い');
      return found;
    });
    expect(entries[0]).toMatchObject({ sources: { system: 1 } });

    await s.pool.stop();
  });
});

describe('runner だけが入れ替わったとき（デプロイ）', () => {
  const runningJob = {
    id: 'mgr-running',
    managerId: 'mgr-running',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-before-swap',
    runnerId: 'runner-primary',
    lastReport: 'スキーマまで書いた',
  };

  it('デーモンが生き残っていても、走行中だった仕事を取り直す', async () => {
    // **引き取りの契機がデーモンの起動時しか無いと、ここが落ちる。** runner だけを
    // 再デプロイするとセッションは消えるのに台帳は `running` のままで、クローンが
    // 話しかけるまで永久に止まる。人間の不在で止まってよいのは承認待ちの仕事だけ
    // である（PRD「自律」）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    // 起動時の引き取り。runner に居ないので resume されて走り出す。
    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    // ここで runner だけが入れ替わる（デーモンは生きたまま）。
    fake.swap();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({
      managerId: 'mgr-running',
      sessionId: 'sess-before-swap',
    });

    // **「デーモンが再起動した」と伝えない。** 手元が残っている前提で書き始める。
    expect(fake.state.resumes[1]?.message).toContain('runner の器が作り直された');
    expect(fake.state.resumes[1]?.message).toContain('手元の状態を確かめよ');

    // クローンにも届く。作業ディレクトリが消えている可能性まで言う。
    const notice = s.inbox.filter((event) => event.type === 'manager_message').at(-1);
    expect((notice as { text: string }).text).toContain('runner の器が作り直された');
    expect((notice as { text: string }).text).toContain('コミット前の変更は失われている');

    await s.pool.stop();
  });

  it('返事待ちだったマネージャーの、死んだ確認を持ち越さない', async () => {
    // **持ち越すと、そのマネージャーには誰も届かなくなる。** 新しい器はその
    // request_id を知らないので確認は永久に解けず、以後の `manager_send` は
    // すべて死んだ確認への回答として横取りされ、`answer` が false を返して
    // 握り潰される。resume したのにクローンからも人間からも到達できない相手が
    // 残るのは、この修正が引いている PRD「自律」そのものの否定になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    // 器の中で確認待ちになる（デーモン側の待ち行列にも積まれる）。
    fake.ask('mgr-running', 'req-1', 'force push してよいか');
    await expect
      .poll(
        async () =>
          (await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting.length,
        { timeout: 2000 },
      )
      .toBe(1);

    fake.swap();
    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);

    // 待ち行列は空になっている（新しい器は req-1 を知らない）。
    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting).toEqual([]);

    // 追加指示が、死んだ確認への回答として横取りされない。
    const result = await s.pool.send('mgr-running', '続きをやって');
    expect(result.outcome).toBe('delivered');
    expect(fake.state.answers).toEqual([]);

    await s.pool.stop();
  });

  it('runner が名乗るたびに、実行環境プロファイルを降ろし直す', async () => {
    // **runner は記憶ストアを読めない**（M4 受け入れ基準3）ので、プロファイルを
    // 自分で取りに行けない。降ろし直さないと、器を作り直した瞬間に「昨日まで
    // 通っていた鍵が消える」が起きる — しかも誰も気づけない。
    const stores = createMemoryStores();
    await stores.profile.write('export SOME_API_TOKEN=abc123');
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    // **委譲を始める前に降りている。** 名乗り任せにすると、最初のマネージャーが
    // プロファイルの届く前に走り出しうる。
    await s.pool.restore();
    await expect.poll(() => fake.state.profiles.length, { timeout: 2000 }).toBe(1);
    expect(fake.state.profiles[0]).toContain('SOME_API_TOKEN');

    // 器が入れ替わる ＝ 置いたものは消えている。もう一度降ろす。
    fake.swap();
    await expect.poll(() => fake.state.profiles.length, { timeout: 2000 }).toBe(2);
    expect(fake.state.profiles[1]).toContain('SOME_API_TOKEN');
  });

  it('取り直しの最中に起こされた委譲を、死んだものとして起こし直さない', async () => {
    // **台帳と runner は別の瞬間に読まれる。** runner を先に読むと、その隙間で
    // 起こされた委譲が「runner に居ないのに台帳には居る」と見え、走り出した
    // ばかりの仕事を二本にしてしまう。台帳を先に読めば、隙間で生まれた仕事は
    // そもそも手元の一覧に入らない。
    const stores = createMemoryStores();
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    // 台帳を読んだ後・runner に聞く前で止める。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    fake.runner.list = async () => {
      fake.state.listCalls += 1;
      if (!first) return [...fake.state.alive];
      first = false;
      // 止まっている間に起きたことは、この応答には映らない（本物の HTTP 応答も
      // 投げた時点の景色を返す）。
      const before = [...fake.state.alive];
      await gate;
      return before;
    };
    // 起こした委譲が runner に居ることにする（本物の `start` と同じ）。
    fake.runner.start = async (command) => {
      fake.state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
    };

    fake.reconnect();
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(0);

    // 取り直しが止まっている間に、新しい委譲が走り出す。セッションも立つ
    // （＝台帳から見れば「resume できる走行中の仕事」に見える）。
    const started = await s.pool.start({ request: 'いま起こした仕事' });
    fake.session(started.managerId, 'sess-brand-new');
    await expect
      .poll(async () => (await stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-brand-new');

    release();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.state.resumes.filter((r) => r.managerId === started.managerId)).toEqual([]);
    expect(fake.state.resumes).toHaveLength(0);

    await s.pool.stop();
  });

  it('ストリームが切れただけなら何もしない（走っている仕事を二重に起こさない）', async () => {
    // 生死は台帳ではなく runner に聞く。聞かずに `hello` だけで再開させると、
    // ネットワークが一瞬途切れるたびに同じ仕事が二本走る。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    const before = fake.state.listCalls;
    fake.reconnect();

    // **聞きに行ったうえで何もしなかった**ことを見る。resume の本数だけを見ると、
    // 機構が存在しなくても・例外で死んでいても緑になる。
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBe(before + 1);
    expect(fake.state.resumes).toHaveLength(1);

    await s.pool.stop();
  });

  it('待機中だった仕事は起こさない（`done` は死ではなく待機である）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-done', status: 'done' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    const before = fake.state.listCalls;
    fake.swap();

    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBe(before + 1);
    expect(fake.state.resumes).toHaveLength(0);

    // 待機のまま。話しかければ続く（`restore` が引き取った状態を壊さない）。
    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-done')?.status).toBe('done');

    await s.pool.stop();
  });

  it('台帳にしか無い終わった仕事の live は、reattach の巻き添えで変わらない', async () => {
    // ステータス判定より前に `#records` へ載せると、`list()` が終わった仕事まで
    // `live: true` で見せる、という懸念そのものは正しい。だがここで確かめたいのは
    // 「`#records` に無いなら常に `live: false`」ではない — その決め打ちは
    // **`#retire`（終端した委譲を `#records` から外す）が入る前提でしか成り立たない
    // 話だった。** 当時「台帳にしか無い」に落ちる経路は `session_id` が無い /
    // `status: 'lost'` のものだけで、どちらも `isLive()` 自身が `false` を返すので
    // 決め打ちと一致していた。`#retire` を足した後は、**`done` / `failed` で
    // 終わった委譲も「台帳にしか無い」側へ普通に落ちる**（`session_id` が残って
    // いれば `manager_send` で明示的に起こし直せる）。決め打ちの `false` のままだと
    // 「完了した委譲について読めていた `live: true` が、外した瞬間に読めなくなる」
    // というデグレードになるので、`list()` のフォールバックは `isLive()` で計算し
    // 直すようにした（本体側の変更）。
    //
    // その上でこのテストが元々守っていたもの（`#reattach` の巻き添えで値が動かない
    // こと）は生きている。`isLive()` は `attached` を見ず `job.sessionId` だけで
    // 決まるので、reattach が触れなかったこの仕事の `live` は前後で変わらない。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-finished', status: 'done' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    // `restore` を通さずに（＝台帳にしか無い状態で）器が入れ替わる。
    const before = (await s.pool.list()).find((m) => m.managerId === 'mgr-finished');
    expect(before).toMatchObject({ status: 'done', live: true });
    fake.swap();

    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(0);
    expect(fake.state.resumes).toHaveLength(0);
    const after = (await s.pool.list()).find((m) => m.managerId === 'mgr-finished');
    expect(after).toMatchObject({ status: 'done', live: true });

    await s.pool.stop();
  });

  it('runner に聞けなかったときは何もしない（応答が無いことを死と読まない）', async () => {
    // `list()` が失敗したのを「セッションが無い」と読むと、生きている仕事を
    // 二重に起こす。分からないときは触らない。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    let asked = 0;
    fake.runner.list = async () => {
      asked += 1;
      throw new Error('runner が応答しない');
    };
    fake.swap();

    // 聞きには行っている（`#reattach` に入らないまま緑になるのを防ぐ）。
    await expect.poll(() => asked, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);

    await s.pool.stop();
  });

  it('起動時に掴んだ器と、名乗ってきた器が違っても取り直す', async () => {
    // **畳まれつつある旧 runner は、猶予（`drainingSeconds`）の間ずっと `/health`
    // と `/managers` に答え続ける。** 起動時の引き取りがそれを見て「生きている」
    // と判断した直後に、SSE が新しい器へ繋がる、という順序が普通に起きる。
    // ここで最初の名乗りを「初回だから」と素通りさせると、まさに拾いたい
    // 入れ替えが落ちる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: 'mgr-running',
      status: 'running',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-swap',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    // 旧い器が答えるので、繋ぎ直しただけで resume はしない。
    const restored = await s.pool.restore();
    expect(restored.map((m) => m.managerId)).toEqual(['mgr-running']);
    expect(fake.state.resumes).toHaveLength(0);

    // SSE が繋がった先は、もう新しい器である。**これが最初の名乗りになる。**
    fake.swap();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes[0]?.message).toContain('runner の器が作り直された');

    await s.pool.stop();
  });

  it('取り直しの最中に届いた名乗りを取りこぼさない', async () => {
    // **起動直後の名乗りを処理している最中に器が入れ替わるのは、まさに拾いたい
    // 場合そのものである。** 走行中だから、と2つ目の名乗りを捨てると、その
    // 入れ替えは誰にも見られないまま終わる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);
    // 起動時の名乗りで走った取り直しが片付くのを待ってから仕掛ける。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 1回目の取り直しを `list()` の途中で止め、そこに入れ替え前の景色を返させる。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fake.state.listCalls;
    let first = true;
    fake.runner.list = async () => {
      fake.state.listCalls += 1;
      if (!first) return [...fake.state.alive];
      first = false;
      const before = [...fake.state.alive];
      await gate;
      return before;
    };

    fake.reconnect();
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBe(base + 1);

    // 止まっている間に器が入れ替わる。
    fake.swap();
    release();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);

    await s.pool.stop();
  });

  it('resume が一時的にこけても、次の名乗りを待たずに自分で戻す', async () => {
    // **`hello` は SSE が繋がったときにしか来ない。** 器は上がってストリームも
    // 安定しているのに resume だけが一時的にこけた場合（起動直後・瞬断・5xx）、
    // 「次の名乗りでまた挑む」では永久に挑まれない。台帳は `running` のまま
    // 誰も走っていない仕事が残り、この経路が塞いだ穴と同じ形になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    // 次の resume だけ 503 で落とす（器は生きていて `list()` は答え続ける）。
    const original = fake.runner.resume.bind(fake.runner);
    let failed = 0;
    fake.runner.resume = async (command) => {
      if (failed === 0) {
        failed += 1;
        throw new RunnerHttpError('runner POST /managers/x/resume が失敗した (503)', 503);
      }
      return original(command);
    };

    fake.swap();

    // 名乗りも `manager_send` も追加せずに復旧する。
    await expect.poll(() => failed, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);
    await expect.poll(() => fake.state.resumes.length, { timeout: 5000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({
      managerId: 'mgr-running',
      sessionId: 'sess-before-swap',
    });

    await s.pool.stop();
  });

  it('生死を聞けなかったときも、次の名乗りを待たずに聞き直す', async () => {
    // `GET /managers` は resume と同じ HTTP 経路なので、器の起動直後・瞬断・
    // 一時的な 5xx でこける。**ここで黙って引き下がると、resume の再試行と
    // 同じ恒久停止が「生死確認の段階」に残る** — SSE は安定しているので次の
    // 名乗りは来ず、台帳は `running` のままセッションは不在になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    // swap 後の最初の `list()` だけ落とす（SSE は繋がったまま）。
    let asked = 0;
    fake.runner.list = async () => {
      asked += 1;
      if (asked === 1) throw new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
      return [...fake.state.alive];
    };

    fake.swap();

    await expect.poll(() => asked, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);

    // 名乗りも `manager_send` も追加せずに、聞き直して resume まで到達する。
    await expect.poll(() => fake.state.resumes.length, { timeout: 5000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({ managerId: 'mgr-running' });

    await s.pool.stop();
  });

  it('台帳を引けなかったときも、次の名乗りを待たずに引き直す', async () => {
    // 記憶ストア側の一時障害も同じ予約経路に載せる。ここだけ「黙って終わる」に
    // すると、同じ恒久停止が別の段階に残る。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    const listJobs = stores.jobs.listJobs.bind(stores.jobs);
    let reads = 0;
    stores.jobs.listJobs = async () => {
      reads += 1;
      if (reads === 1) throw new Error('台帳が一時的に読めない');
      return listJobs();
    };

    fake.swap();

    await expect.poll(() => reads, { timeout: 2000 }).toBe(1);
    await expect.poll(() => fake.state.resumes.length, { timeout: 5000 }).toBe(2);

    await s.pool.stop();
  });

  it('投げ直しても同じ答えが返る失敗は、無限に再試行せずクローンへ知らせる', async () => {
    // 400 は runner が「その命令は受け取れない」と答えている。同じものを投げ直しても
    // 同じ答えが返るので、黙って `running` のまま置くのでも回し続けるのでもなく、
    // 見えるようにするのが唯一の出口である（roadmap M5 受け入れ基準4）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    let attempts = 0;
    fake.runner.resume = async () => {
      attempts += 1;
      throw new RunnerHttpError('runner POST /managers/x/resume が失敗した (400)', 400);
    };

    fake.swap();

    await expect
      .poll(
        () =>
          s.inbox
            .filter((event) => event.type === 'manager_message')
            .some((event) => (event as { text: string }).text.includes('戻せなかった')),
        { timeout: 2000 },
      )
      .toBe(true);

    // 予約が積まれていないこと（時間を置いても挑み直さない）。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(attempts).toBe(1);

    await s.pool.stop();
  });

  it('諦めたジョブは、同じ runner の別ジョブの再試行に巻き込まれない', async () => {
    // **予約は runner 単位、諦めの判定はジョブ単位である。** ジョブ側に覚えないと、
    // 同じ runner に一時障害のジョブが1本あるだけで予約が積まれ続け、4xx で
    // 「挑み直さない」と決めたジョブが毎回巻き込まれる。runner への無意味な
    // resume と、同じ障害通知が予約の間隔ごとにクローンの受信箱へ積み上がる
    // （`isRetryableRunnerError` と README の約束が複数ジョブで破れる）。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-broken' });
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-flaky' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(2);

    const original = fake.runner.resume.bind(fake.runner);
    const tries = { broken: 0, flaky: 0 };
    fake.runner.resume = async (command) => {
      if (command.managerId === 'mgr-broken') {
        tries.broken += 1;
        throw new RunnerHttpError('runner POST resume が失敗した (400)', 400);
      }
      tries.flaky += 1;
      if (tries.flaky <= 2) {
        throw new RunnerHttpError('runner POST resume が失敗した (503)', 503);
      }
      return original(command);
    };

    fake.swap();

    // flaky は 503 を2回踏んでから戻る（＝予約が2回積まれる）。
    await expect.poll(() => tries.flaky, { timeout: 8000 }).toBe(3);
    await expect
      .poll(() => fake.state.resumes.some((r) => r.managerId === 'mgr-flaky'), { timeout: 8000 })
      .toBe(true);

    // その間、broken は1回しか試されず、通知も1回だけ。
    expect(tries.broken).toBe(1);
    const notices = s.inbox.filter(
      (event) =>
        event.type === 'manager_message' &&
        (event as { managerId: string }).managerId === 'mgr-broken' &&
        (event as { text: string }).text.includes('戻せなかった'),
    );
    expect(notices).toHaveLength(1);

    // **人間とクローンの明示的な経路は塞がない。** 諦めたのは自動の取り直しだけで、
    // 頼まれたら投げに行く（結果は呼び手へ返る。ここでは runner が 400 を返す）。
    await expect(s.pool.send('mgr-broken', 'やり直して')).rejects.toThrow('400');
    expect(tries.broken).toBe(2);

    await s.pool.stop();
  });

  it('別の runner のジョブには手を出さない（M5 で runner が増えても混ざらない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-elsewhere', runnerId: 'runner-second' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    fake.swap();

    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(1);
    // 入れ替わったのは runner-primary の器だけ。他所の宛先まで起こし直さない
    // （`#runners.get('runner-second')` が null を返すので `restore` も触らない）。
    expect(fake.state.resumes).toHaveLength(0);

    await s.pool.stop();
  });
});

/**
 * resume を SDK 側に拒まれる runner。
 *
 * 実機で起きたのはこれである（`No conversation found with session ID: …`）。
 * **失敗は `POST /managers/:id/resume` の応答としては返ってこない** — 命令は
 * 受理され、開いたストリームの側から後で落ちてくる。だから「resume を投げられた」
 * ことと「続きへ戻れた」ことは別物であり、前者だけを見ている限りこの穴は塞がらない。
 */
function resumeRejectingSdk(
  /**
   * 拒まれ方は実機で2種類出ている。
   *
   * - `no-conversation`: init すら来ずに落ちる（`No conversation found …`）
   * - `error-result`: 開きはするが、その回が結果なしで終わる（`error_during_execution`）
   * - `after-work`: 手が動いた後で落ちる。**これは resume の失敗ではない**
   */
  how: 'no-conversation' | 'error-result' | 'after-work' = 'no-conversation',
) {
  const opened: { resume: string | undefined; inputs: string[] }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    const inputs: string[] = [];
    opened.push({ resume: options.resume, inputs });

    void (async () => {
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
      }
    })();

    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (options.resume !== undefined && how === 'no-conversation') {
        // **init すら来ない。** SDK は開いた直後にこれを投げる。
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new Error(
          'Claude Code returned an error result:\n' +
            `No conversation found with session ID: ${options.resume}`,
        );
      }

      if (options.resume !== undefined) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: options.resume,
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        if (how === 'after-work') {
          // 実際に道具を動かしてから落ちる（済んだ作業がある）。
          const matchers = options.hooks?.PostToolUse as HookCallbackMatcher[];
          for (const matcher of matchers) {
            for (const hook of matcher.hooks) {
              await hook(
                { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} } as never,
                undefined,
                { signal: new AbortController().signal },
              );
            }
          }
          throw new Error('マネージャーのセッションが途中で落ちた');
        }

        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: options.resume,
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
        return;
      }
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-after-fallback',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      // 新しいセッションは、閉じられるまで開いたまま手を動かし続ける
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, opened };
}

describe('前のセッションへ戻れなかったとき（M4 受け入れ基準2）', () => {
  const runningJob = {
    id: 'mgr-lost',
    managerId: 'mgr-lost',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-before-restart',
    projectKey: 'proj-key',
    lastReport: 'スキーマまで書いた',
  };

  const savedLog = [
    { type: 'user', message: { role: 'user', content: 'DB の移行をやって' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'スキーマまで書いた' }] },
    },
  ];

  function setupRejecting(
    entries: unknown[] | null,
    how: 'no-conversation' | 'error-result' | 'after-work' = 'no-conversation',
    /**
     * 同じ台帳を引き継いだ**作り直しのデーモン**を組むときに渡す。プロセス内の
     * 記憶（`#unresumable`）は引き継がれない — そこが問題の在り処である。
     */
    reuse?: Stores,
  ) {
    const { fn, opened } = resumeRejectingSdk(how);
    const sessionStore = {
      append: async () => undefined,
      load: async (key: { projectKey: string; sessionId: string }) =>
        (entries !== null && key.projectKey === 'proj-key' ? entries : null) as never,
    };
    const stores = reuse ?? { ...createMemoryStores(), sessionStore };
    const inbox: InboxEvent[] = [];
    const runner = createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env: { PATH: '/usr/bin' },
    });
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
    });
    return { pool, stores, inbox, opened };
  }

  it('session_id で戻れなくても、預かった生ログから続きを起こす', async () => {
    // **黙って引き下がらない。** 器が落ちたことを理由に仕事を止めてよいのは
    // 承認待ちのときだけである（PRD「自律」）。session_id が腐っていても、
    // 生ログはデーモンが預かっているのだから、そこから組み立て直せる。
    const s = setupRejecting(savedLog);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    // 1本目は resume（拒まれる）、2本目は resume 無しで開き直したもの
    await expect.poll(() => s.opened.length, { timeout: 2000 }).toBe(2);
    expect(s.opened[0]?.resume).toBe('sess-before-restart');
    expect(s.opened[1]?.resume).toBeUndefined();

    // 新しいセッションには、失われたセッションの記録が渡っている
    await expect
      .poll(() => (s.opened[1]?.inputs ?? []).join('\n'), { timeout: 2000 })
      .toContain('スキーマまで書いた');
    expect((s.opened[1]?.inputs ?? []).join('\n')).toContain('DB の移行をやって');

    // クローンは「前のセッションからは戻れなかった」ことを知る（黙って続けない）
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('生ログ'),
    );
    expect(notice).toBeDefined();

    await s.pool.stop();
  });

  it('生ログも無いなら、再試行を打ち切ってクローンへ知らせる', async () => {
    // 投げ直しても同じ答えしか返らない失敗である。**黙って挑み続けない** —
    // 同じ session_id の resume が繰り返されると、同じ障害通知が受信箱に積み上がる
    // だけで、誰も状況を知れないまま台帳の `running` が残る。
    const s = setupRejecting(null);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
    ) as { text: string };
    expect(notice.text).toContain('自動では再試行しない');
    expect(notice.text).toContain('DB の移行をやって');

    // 生ログが無いのだから、勝手に白紙のセッションを起こさない
    expect(s.opened.filter((entry) => entry.resume === undefined)).toHaveLength(0);

    await s.pool.stop();
  });

  /**
   * **「戻せなかった」を「成果が無い」と言い換えない。**
   *
   * デーモンが観測したのは resume の失敗だけで、PR もブランチも見ていない
   * （リポジトリの事情はマネージャーの領域であって、デーモンが知るべきもので
   * はない）。2026-08-16T03:15 に、落ちる直前に PR を出して CI を通しマージ
   * まで届いていた仕事が、その1分半後の器の作り直しでこの経路を通った。
   * 知らせが「起こし直せ」で終わると、済んだ仕事をもう一度走らせる。
   */
  it('戻せなかった知らせは、成果の有無を断定せずリモートを確かめさせる', async () => {
    const s = setupRejecting(null);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
    ) as { text: string };

    // 観測していないことを断定しない。
    expect(notice.text).toContain('「仕事が終わっていない」ことの証拠ではない');
    // 次の一手が書いてある（起こし直す前に確かめる先）。
    expect(notice.text).toMatch(/リモート|PR/);
    expect(notice.text).toContain('起こし直す前に');

    await s.pool.stop();
  });

  it('開きはしたが結果なしで終わった resume も、戻れなかったものとして扱う', async () => {
    // もう1つの実機の顔（`error_during_execution`）。**`init` が来たことを
    // 「戻れた」と読まない** — 開いただけで何も返せていないなら、続きは進まない。
    const s = setupRejecting(savedLog, 'error-result');
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect.poll(() => s.opened.length, { timeout: 2000 }).toBe(2);
    expect(s.opened[1]?.resume).toBeUndefined();
    await expect
      .poll(() => (s.opened[1]?.inputs ?? []).join('\n'), { timeout: 2000 })
      .toContain('スキーマまで書いた');

    await s.pool.stop();
  });

  it('手が動いた後に落ちたのなら作り直さない（済んだ作業を二度走らせない）', async () => {
    // ここを「落ちたら作り直す」に広げると、コミットや PR を出した後の失敗で
    // 同じ作業を記録から二度走らせることになる。resume の失敗として扱うのは
    // **このセッションがまだ何もしていないとき**だけである。
    const s = setupRejecting(savedLog, 'after-work');
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    // 落ちたことは伝わるが、白紙から起こし直しはしない
    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('落ちた'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    expect(s.opened.filter((entry) => entry.resume === undefined)).toHaveLength(0);

    await s.pool.stop();
  });

  it('打ち切ったマネージャーは、デーモンを作り直しても二度と resume されない', async () => {
    // **「もう戻せない」がプロセス内の記憶（`#unresumable`）にしか無い。** 台帳へ
    // 残るのは `done`（＝直近の依頼を終えて待機中）である — 結果なしで終わった
    // resume が、そのまま「1ターン終わった」として報告に化けるからである。
    //
    // 器を作り直すと記憶は消え、台帳の `done` だけが残る。クローンから見えるのは
    // 「待機中で、話しかければ続くマネージャー」であり、実際には腐った session_id
    // しか無い。デプロイのたびに同じ死体へ話しかけ、同じ失敗の通知が積み上がる。
    // **戻せなかった仕事が「終わった」に見えるのが最も悪い** — 失われた仕事が
    // 完了として片付き、誰も起こし直さない。
    const first = setupRejecting(null, 'error-result');
    await first.stores.jobs.putJob(runningJob);

    await first.pool.restore();
    await expect
      .poll(
        () =>
          first.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    await first.pool.stop();

    // 台帳が「戻せない」を覚えている。`done`（待機中）でも `running` でもない。
    const stored = (await first.stores.jobs.listJobs()).find((job) => job.id === 'mgr-lost');
    expect(stored?.status).toBe('lost');

    // 器を入れ替えたデーモン。プロセス内の記憶は空だが、台帳は引き継いでいる。
    const second = setupRejecting(null, 'error-result', first.stores);

    expect(await second.pool.restore()).toEqual([]);
    // resume を投げ直していない（同じ死体をもう一度起こしに行かない）。
    expect(second.opened).toHaveLength(0);
    // 同じ通知も積み直さない（一度知らせたことを毎回言い直さない）。
    expect(second.inbox.filter((event) => event.type === 'manager_message')).toEqual([]);

    // **「終わった」ではない。** クローンが起こし直す対象として見分けられる。
    const listed = (await second.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await second.pool.stop();
  });

  it('送信に失敗した直後の一覧が、lost を live: true へ格上げしない', async () => {
    // **人間がこの画面を見るのは、まさに送った直後である**（送ったから状態を
    // 確かめる）。`send()` は宛先を `#load()` でプロセス内の像へ載せてから resume を
    // 投げるので、投げた先で失敗しても像は残る。その像を `list()` が既定の
    // `live: true` で見せると、`status: lost`（前のセッションへ戻れなかった）と
    // `live: true`（繋がっている）という両立しない組が出る。台帳は正しいまま
    // なので、**嘘をつくのは一覧だけ**である。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'lost' });
    const fake = swappableRunner('runner-test');
    let attempted = 0;
    fake.runner.resume = async () => {
      attempted += 1;
      // 実機で出たのはこれ（runner の HTTP 経路が 400 を返す）。
      throw new Error('runner POST /managers/mgr-lost/resume が失敗した (400)');
    };
    const s = setup(undefined, { stores, runner: fake.runner });

    // 送る前。台帳にしか無いので `live: false`（ここは既に守られている）。
    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-lost')).toMatchObject({
      status: 'lost',
      live: false,
    });

    await expect(s.pool.send('mgr-lost', '続きをやって')).rejects.toThrow();
    // **resume まで届いたうえで失敗した**ことを固定する。ここを見ないと、
    // send() が別の理由で早々に落ちても緑になる。
    expect(attempted).toBe(1);

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });

  it('resume の失敗が後から降ってきても、一覧は lost を live: true で見せない', async () => {
    // 同じ嘘へのもう1本の道。`resume_failed` は**受理された後**に SSE で降りてくる
    // ので、そのとき像は既に `#records` に居る。ここで `status: lost` /
    // `attached: false` へ落としても、一覧が像を無条件に `live: true` と数えるなら
    // 表示は変わらない。**`#load()` を直すだけでは塞がらない**のはこの経路である。
    const s = setupRejecting(null, 'error-result');
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();
    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();

    // 台帳を落としたのと同じデーモンが、そのまま一覧を出す。
    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });
});

/**
 * 報告の受信経路（クローンは「送られた」ではなく「届いた」ものしか読めない）。
 *
 * マネージャーの1ターンの出力は、SDK の `result` 1本では表せない。人間が
 * Claude Code の画面で読んでいるのは**そのターンに出た本文すべて**であり、
 * `result` はその最後の一片でしかないことがある（道具を挟むたびに本文は
 * 切れる）。`result` だけを報告にすると、クローンには末尾だけが届き、
 * **欠けていることが誰にも見えない**。人間より読めるものが少ない＝デグレード
 * （north_star 禁止1）であり、断片から全体像を組み立てた誤判断の原因になる。
 */
describe('マネージャーの報告を黙って落とさない', () => {
  it('道具で分断された本文も、6つ出したなら6つとも届く', async () => {
    const s = setup();
    await s.pool.start({ request: '6セクションで報告して' });
    const session = s.sessions[0] as FakeSession;

    // 前半を喋る → 道具を使う → 後半を喋る。SDK の `result` に載るのは
    // 最後の一片だけ、という実機で起きた形をそのまま作る。
    await session.say('## 1\n本文1\n\n## 2\n本文2\n\n## 3\n本文3');
    await session.say('## 4\n本文4\n\n## 5\n本文5\n\n## 6\n本文6');
    await session.report('## 5\n本文5\n\n## 6\n本文6');

    const reports = await vi.waitFor(() => {
      const found = s.inbox.filter(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (found.length === 0) throw new Error('報告がまだ届いていない');
      return found;
    });
    const delivered = reports.map((event) => (event as { text: string }).text).join('\n');

    for (const section of ['## 1', '## 2', '## 3', '## 4', '## 5', '## 6']) {
      expect(delivered).toContain(section);
    }

    await s.pool.stop();
  });

  it('作業者の本文はマネージャーの報告に混ぜない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    await session.say('マネージャーの結論');
    // 作業者（Task の中）の本文は `parent_tool_use_id` が付く。これは
    // マネージャーが人間へ向けて喋ったものではない。
    await session.say('作業者の途中経過', { parentToolUseId: 'tool-1' });
    await session.report('マネージャーの結論');

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (!found) throw new Error('報告がまだ届いていない');
      return found as { text: string };
    });

    expect(report.text).toContain('マネージャーの結論');
    expect(report.text).not.toContain('作業者の途中経過');

    await s.pool.stop();
  });

  it('前のターンの本文を次のターンの報告へ持ち越さない', async () => {
    const s = setup();
    await s.pool.start({ request: '2回に分けて答えて' });
    const session = s.sessions[0] as FakeSession;

    await session.say('1回目の答え');
    await session.report('1回目の答え');
    await session.say('2回目の答え');
    await session.report('2回目の答え');

    const reports = await vi.waitFor(() => {
      const found = s.inbox.filter(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (found.length < 2) throw new Error('報告がまだ2本届いていない');
      return found as { text: string }[];
    });

    expect(reports[reports.length - 1]?.text).not.toContain('1回目の答え');

    await s.pool.stop();
  });
});

/**
 * **止めたことと、止まったことは別である。**
 *
 * `runner.stop()` は該当のセッションが手元に無ければ**黙って何もしない**
 * （`#sessions.get(id)?.stop()`）。受理だけを見て「止まった」と言うと、走り
 * 続けているマネージャーを止めたことにしてしまう — 人間もクローンも、止めた
 * つもりで次の判断へ進む。実際に畳まれたセッションは runner の一覧から消える
 * （`onClosed`）ので、そこまで見に行く。
 *
 * 人間の口（`DELETE /managers/:id`）もクローンの `manager_stop` も、ここを通る。
 */
describe('止めた結果を確かめる', () => {
  const job = {
    id: 'mgr-stopme',
    managerId: 'mgr-stopme',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '暴走中',
    request: '延々と直し続けている',
    cwd: '/work/project',
    sessionId: 'sess-stopme',
    runnerId: 'runner-primary',
  };

  it('セッションが畳まれたら、止まったと言い切る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    // 本物どおり、止めたセッションは一覧から消える。
    const runner = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    const s = setup(undefined, { stores, runner });

    const result = await s.pool.abort(job.id, '暴走したので');

    expect(result.outcome).toBe('stopped');
    expect(result.sessionGone).toBe(true);
    expect(result.detail).not.toContain('止まりきっていない');
    // **2026-08-21 に反転。** 直す前は `sessionGone === true`（止まったと確かめた）
    // でも台帳の `status` を `'done'`（＝終えて待機中。セッションは生きている）に
    // 書いていた——止めた事実と「待機中」が1語に潰れ、`isLive()` は
    // `record.job.sessionId` が残っていることを理由に `live: true` を返して
    // いた（このテストは元々それを固定していた）。いまは `'stopped'` という
    // 専用の終端状態を持つので、ここを反転する（PR「『止めた』を、止まったと
    // 確かめたときだけそう言う」の3点セット：期待値だけ反転・元のコメントは
    // 上に残す・PR 本文に理由を書く）。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');
    expect(listed?.live).toBe(false);

    await s.pool.stop();
  });

  /**
   * **未回答の待ちがある状態で止めてみる。** `not_stopped` は「確かめられて
   * いない」ではなく「止まっていないと確かめた」明確な失敗なので、生きている
   * かもしれないマネージャーの状態を1文字も畳んではいけない——`waiting`（未回答
   * の許可確認）が消えないことまで確かめる。
   *
   * **2026-08-22 に2本へ割った（変異試験で分離を確認）。** 元は1本の `it()` で
   * 「`outcome` の正しさ」と「台帳を1文字も書かない」の両方を順に assert して
   * いた。変異試験でこの2つを別々に壊すと（1: `outcome` を常に `'stopped'` に
   * 固定する／2: `outcome === 'stopped'` の台帳書き込みガードを外す）、
   * **どちらの変異でも同じ1本が落ちた**——`outcome` を常に `'stopped'` にすると
   * ガードの条件も常に真になり台帳まで書き換わるので、1つの変異が両方の保証を
   * 一緒に壊してしまい、テストの落ち方だけでは「どちらの保証が壊れたか」が
   * 見分けられなかった。`outcome` の正しさ（何を確かめたか）と、台帳を書かない
   * こと（確かめられていないものへの副作用が無いか）は別の保証なので、
   * `abort()` は fire-and-forget な後続処理を持たず全部 `await` 済みで返る
   * （`#onEvent` の R4 系と違って完了待ちの同期が要らない）ことを使い、
   * 単純に2つの `it()` へ分けた。アサーションは1つも削っていない。
   */
  async function abortWithLiveSession() {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...job, status: 'waiting_human' });
    // `swappableRunner` の `stop` は何もしない ＝ 受理はするが畳まない器。
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'waiting_human',
      cwd: job.cwd,
      request: job.request,
      waiting: [{ requestId: 'req-1', summary: '本番に触ってよいか' }],
      sessionId: job.sessionId,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();
    const result = await s.pool.abort(job.id);
    return { s, result };
  }

  it('セッションが残っていたら、止まったことにしない（outcome の正しさ）', async () => {
    const { s, result } = await abortWithLiveSession();

    // **黙って成功にしない。** 見た結果をそのまま言う。
    expect(result.outcome).toBe('not_stopped');
    expect(result.sessionGone).toBe(false);
    expect(result.detail).toContain('止まっていない');

    await s.pool.stop();
  });

  it('セッションが残っていたら、台帳を1文字も書かない', async () => {
    const { s } = await abortWithLiveSession();

    // **台帳を1文字も書かない。** status も waiting も、止める前のままである。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('waiting_human');
    expect(listed?.waiting).toEqual([{ requestId: 'req-1', summary: '本番に触ってよいか' }]);

    await s.pool.stop();
  });

  /**
   * 誰が止めたかは記録に残る。クローンが止めた仕事の日誌に「人間が停止させた」と
   * 残ると、人間とクローンで見えている経緯が食い違う（止まり方は同じである）。
   */
  it('クローンが止めたら、クローンが止めたと残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    const entries = await s.stores.journal.list({ types: ['exchange'] });
    const stopped = entries.find((entry) => JSON.stringify(entry).includes('（停止）'));
    expect(JSON.stringify(stopped)).toContain('クローンが停止させた');
    expect(JSON.stringify(stopped)).not.toContain('人間が停止させた');

    await s.pool.stop();
  });

  it('居ないマネージャーを止めても、黙って成功にしない', async () => {
    const s = setup(undefined, { stores: createMemoryStores(), runner: swappableRunner().runner });

    const result = await s.pool.abort('mgr-nope');

    // **2026-08-21 に反転（改名）。** 「居ない」は PR #137 の語彙で `'unknown'`
    // （確かめられなかった）と紛れる別の観測なので `'absent'` に改名した
    // （`DELETE /managers/:id` はここだけ 404 に写す）。
    expect(result.outcome).toBe('absent');
    expect(result.detail).toContain('mgr-nope');

    await s.pool.stop();
  });

  /**
   * **`runner.stop()` が投げても、`abort()` ごと reject させない（R3）。**
   *
   * HTTP 越しの runner では期限切れ（`RunnerUnknownError`）や明確な失敗（接続
   * 拒否等）が `runner.stop()` から投げられる（`runner-client.ts` の `#call`）。
   * 直す前はここを裸で `await` していたので、投げた瞬間 `abort()` 全体が reject
   * し、日誌の1行も、クローンへの通知も、状態の更新も、何も残らないまま
   * `DELETE /managers/:id` が 500 になっていた。
   *
   * ここでは `runner.list()` の探りも届かないケースを固定する——権威を置く先
   * （`sessionGone`）自体が確かめられないので `'unknown'` が正しい。
   */
  /**
   * **2026-08-22 に3本へ割った。** 元は1本の `it()` で「`outcome` を `'unknown'`
   * で言い切る」「例外を握り潰さない（日誌に残る）」「台帳を1文字も書かない」の
   * 3つを順に assert していた。「セッションが残っていたら」の変異試験（上）で、
   * `outcome` を常に `'stopped'` にする変異（変異1）と台帳の書き込みガード
   * （`if (outcome === 'stopped')`）を外す変異（変異2）を当てたところ、**この
   * テストも同じ形で複数の変異にまたがって落ちた**（変異1はこのテストの
   * `outcome` の行と `status` の行の両方を、変異2は `status` の行だけを壊す）。
   * `status` の書き込みは `outcome === 'stopped'` の分岐の中にあるので、
   * `outcome` を壊す変異は必然的に `status` の保証も一緒に壊す——これは
   * テストの粒度の問題ではなく実装の構造そのもの（`status` の正しさが
   * `outcome` の正しさに依存する）なので、これ以上は分けても分離しきれない。
   * それでも「日誌に握り潰さず残ること」は `outcome` にも `status` の書き込み
   * 分岐にも依存しない独立した保証なので、ここだけは完全に分離できる——
   * 割ることで、少なくとも変異2（台帳ガード外し）が `outcome` の保証と日誌の
   * 保証のどちらにも触れないことが見えるようになる。アサーションは1つも
   * 削っていない。
   */
  async function abortWithUnreachableProbe() {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const runner = {
      ...fake.runner,
      async stop(): Promise<void> {
        throw new Error('期限切れ（テスト）');
      },
      async list() {
        throw new Error('list も届かない（テスト）');
      },
    };
    const s = setup(undefined, { stores, runner });
    const result = await s.pool.abort(job.id);
    return { s, result };
  }

  it('runner.stop() が投げても abort() は投げない（探りも届かなければ unknown で言い切る）', async () => {
    const { s, result } = await abortWithUnreachableProbe();

    expect(result.outcome).toBe('unknown');
    expect(result.sessionGone).toBeUndefined();
    expect(result.detail).toContain('期限切れ（テスト）');

    await s.pool.stop();
  });

  it('runner.stop() が投げても、捕まえた例外を握り潰さず日誌に残す', async () => {
    const { s } = await abortWithUnreachableProbe();

    const entries = await s.stores.journal.list({ types: ['exchange'] });
    const line = entries.find((entry) => JSON.stringify(entry).includes(job.id));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).toContain('期限切れ（テスト）');

    await s.pool.stop();
  });

  it('runner.stop() が投げても探りが unknown なら、台帳を1文字も書かない', async () => {
    const { s } = await abortWithUnreachableProbe();

    // **状態は動かさない。** 確かめられていない以上、書く材料が無い。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('running');

    await s.pool.stop();
  });

  /**
   * **RPC の不明を、止まった事実より優先させない。**
   *
   * `runner.stop()` が例外を投げても、`runner.list()` の探りが「消えた」と
   * 答えるなら、止まったと言い切ってよい（stop の RPC が返らなくても、届いて
   * いて実際に止まっていることがある）。権威は常に `sessionGone` に置く。
   */
  it('runner.stop() が投げても、探りで消えていれば stopped', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const runner = {
      ...fake.runner,
      async stop(): Promise<void> {
        throw new Error('返らなかった（テスト）');
      },
      async list() {
        // 探りには答えた。該当のセッションは既に消えている。
        return [];
      },
    };
    const s = setup(undefined, { stores, runner });

    const result = await s.pool.abort(job.id);

    expect(result.outcome).toBe('stopped');
    expect(result.sessionGone).toBe(true);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /**
   * **書けなくても委譲は止めない。だが跡は残る。**
   *
   * ジョブ台帳のほうが効く。「後から `manager_report` で読めた ⟹ 経路が
   * 通っていた」は成功した場合の話であって、失敗は台帳にも日誌にも跡を
   * 残さない（＝台帳を判別器に使えない）。
   *
   * 跡に本文が乗らないことも一緒に固定する（#52 と同じ形を作らない）。
   */
  it('日誌とジョブ台帳が書けなくても委譲は続き、落としたことが stderr に残る（本文は出さない）', async () => {
    const stores = failingJobWrite(
      failingJournalAppend(createMemoryStores(), 'storage is closed'),
      'storage is closed',
    );
    const s = setup(undefined, { stores });

    const lines = await captureStderr(async () => {
      await s.pool.start({ request: '鍵は ghp_000000000000000000000000000000000000 だ' });
      await s.pool.stop();
    });

    const text = lines.join('');
    expect(text).toContain('日誌を記録できませんでした');
    expect(text).toContain('ジョブ台帳を記録できませんでした');
    expect(text).toContain('storage is closed');
    expect(text).not.toContain('ghp_');
  });
});

/**
 * **止めたマネージャーの後続イベントは、日誌に残してクローンを起こさない（R4）。**
 *
 * `abort()` が `#retire()` しても、`#onEvent` は台帳から像を作り直す（`#load()`）。
 * だから止めたあとに届く `report` / `ask` を無条件に処理すると、`record.job.status`
 * を `stopped` から上書きし、`#emit()` でクローンのターンを起こしてしまう
 * （「止めたマネージャーが後から報告を出す」「死んだマネージャーが確認を求める」）。
 */
describe('止めたマネージャーの後続イベント（R4）', () => {
  const job = {
    id: 'mgr-stopped-then-event',
    managerId: 'mgr-stopped-then-event',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '暴走中',
    request: '延々と直し続けている',
    cwd: '/work/project',
    sessionId: 'sess-stopped-then-event',
    runnerId: 'runner-primary',
  };

  /** 止めるところまで共通に済ませる（`abort()` の探りで `sessionGone: true` になる形）。 */
  async function stopped() {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    const runner = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    const s = setup(undefined, { stores, runner });
    const result = await s.pool.abort(job.id, 'テストで止めた');
    expect(result.outcome).toBe('stopped');
    return { s, fake };
  }

  /**
   * `emit?.(...)` は `runner.connect((event) => void this.#onEvent(event))` を
   * 経由するので、`#onEvent` は fire-and-forget（`void`）で走る。イベントを
   * 発火した直後は日誌への書き込みがまだ終わっていないことがあるので、
   * `expect.poll` で「処理が終わった」ことそのものを確かめてから、
   * 他のアサーション（inbox が増えていないこと・status が動いていないこと）へ進む。
   */
  async function journalHas(s: Setup, needle: string, types: JournalEntry['type'][]) {
    await expect
      .poll(
        async () => {
          const entries = await s.stores.journal.list({ types });
          return entries.some((entry) => JSON.stringify(entry).includes(needle));
        },
        { timeout: 2000 },
      )
      .toBe(true);
  }

  /**
   * **`#onEvent` の中で `await` を挟まずに済む「処理が終わった」の合図が無い。**
   *
   * `journalHas`（上）は「日誌にその文字列が現れる」ことを待つので、日誌への
   * 書き込みが実際に起きる保証だけを使える。しかし下のガードのうち「journal
   * 呼び出しだけを消す変異」（保証1＝日誌に残ることを壊す変異）を当てると、
   * ガード自身の分岐（`if (status === 'stopped') { ...; return; }`）は残った
   * ままなので、この変異のもとでも `#onEvent` は正しく早期リターンし、
   * inbox / status は一切動かない——つまり保証2（クローンへ回らない・status が
   * 動かない）は**その変異のもとでも成立している**。だから保証2のテストが
   * `journalHas` を「処理が終わった合図」として待ってしまうと、日誌には何も
   * 書かれないその変異のもとでタイムアウトし、**保証2は壊れていないのに
   * テストだけが落ちる**——保証1と保証2がまた1つに戻ってしまう。
   *
   * **元は固定の実時間（`setTimeout(resolve, 100)`）で fire-and-forget の
   * 完了を待っていた。これに欠陥があった。** 器が混んでいる CI（runner は
   * UTC・共有）では、100ms のうちに `#onEvent` の処理が終わらないことがある。
   * そのとき「まだ処理されていない（inbox がまだ増えていないだけ）」を
   * 「クローンへ回らなかった（保証2が成立している）」と読んでしまう——
   * ガードを無効化する変異Aを当てても、処理が固定時間内に終わらなければ
   * テストは黙って通る＝歯が消える（`AGENTS.md`「静かに失敗する道具」の
   * 「失敗が成功として観測される」形そのもの）。
   *
   * **直し方は「日誌が書かれるまで、ただし上限つきで待つ」こと。** 正常時は
   * 日誌にその文字列が現れた時点で待ちを終えるので速く、取りこぼしが無い。
   * **上限まで現れなくても、この待ちのほうを失敗させない。** `#journal(...)`
   * を壊す変異（保証1を壊す変異B）を当てたときは、日誌には最後まで何も
   * 書かれないので、この待ちは上限まで律儀に待ってから黙って抜ける。その
   * 結果、保証2のテストは（日誌の中身を見ずに）inbox / status のアサーション
   * まで進み、変異Bのもとでも通る——落ちる集合が保証1側とちょうど分かれた
   * ままになる。**この「上限で抜けても失敗させない」という一見奇妙な仕様
   * こそが、保証1と保証2の分離を保つ本体である。** 次に読む者がここへ
   * `expect`（「タイムアウトしたら失敗させたい」という自然な直感）を足すと、
   * その分離がまた壊れる——足したくなったら、まずこのコメントとセットで
   * `journalHas` との役割の違いを読み直すこと。
   */
  async function settleAfterJournal(
    s: Setup,
    needle: string,
    types: JournalEntry['type'][],
    timeoutMs = 500,
  ) {
    const start = Date.now();
    for (;;) {
      const entries = await s.stores.journal.list({ types });
      if (entries.some((entry) => JSON.stringify(entry).includes(needle))) return;
      if (Date.now() - start >= timeoutMs) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * **`report` のテストは、ここから2本に割ってある（2026-08-22）。**
   *
   * 元は1本の `it()` で「日誌には残る」「クローンへは回らず status も動かない」
   * を順に assert していた。変異試験で次の2つを別々に壊すと:
   *
   * - 変異A: ガード（`if (record.job.status === 'stopped') {...}`）を丸ごと外す
   * - 変異B: ガードは残したまま、その中の `await this.#journal(...)` だけを消す
   *
   * **どちらの変異でも、落ちたテストは同じ1本だった**（変異Aは
   * `s.inbox.length` の行で、変異Bは `journalHas` の行で落ち、その先には
   * 進まない）。vitest は最初に失敗した assertion で止まるので、テスト名の
   * 粒度だけでは「日誌に残る」と「クローンを起こさない」のどちらの保証が
   * 壊れたのかが区別できない。1つの `it()` の中に2つの保証を重ねて書いていた
   * ことが原因なので、保証ごとに `it()` を分けた。アサーションは1つも
   * 削っていない。
   */
  it('report イベントは日誌には残る（捨てない）', async () => {
    const { s, fake } = await stopped();

    fake.report(job.id, '止めたはずなのに報告してきた', 'done');

    // 日誌には残っている（捨てない）。
    await journalHas(s, '止めたはずなのに報告してきた', ['exchange']);

    await s.pool.stop();
  });

  it('report イベントはクローンへは回らず、status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.report(job.id, '止めたはずなのに報告してきた', 'done');
    await settleAfterJournal(s, '止めたはずなのに報告してきた', ['exchange']);

    // クローンの受信箱（inbox）へは1件も増えていない。
    expect(s.inbox.length).toBe(postedBefore);
    // status は stopped から動かない。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /** `ask` も `report` と同じ形（日誌＋受信箱＋waiting を1本で見ていた）なので、同じ理由で割る。 */
  it('ask イベントは日誌には残る（捨てない）', async () => {
    const { s, fake } = await stopped();

    fake.ask(job.id, 'req-after-stop', '止めたはずなのに確認を求めてきた');

    await journalHas(s, '止めたはずなのに確認を求めてきた', ['escalation']);

    await s.pool.stop();
  });

  it('ask イベントはクローンへは回らず、waiting も積まれない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.ask(job.id, 'req-after-stop', '止めたはずなのに確認を求めてきた');
    await settleAfterJournal(s, '止めたはずなのに確認を求めてきた', ['escalation']);

    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');
    expect(listed?.waiting).toEqual([]);

    await s.pool.stop();
  });

  it('closed(failed) イベントは日誌には載るが、クローンへは回らず status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.closed(job.id, 'failed', '止めたはずなのに落ちたと言ってきた');

    await journalHas(s, '止めたはずなのに落ちたと言ってきた', ['exchange']);
    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /**
   * `resume_failed` は `report` / `ask` / `closed` と同じ形の後続イベントである
   * （直前に投げていた自動再開の結果が、止めた後に遅れて届く）。ここも同じ理由で
   * 畳む。`event.recovered` の真偽どちらでも（`running` へ書く枝・`lost` へ書く枝
   * どちらでも）status を動かさないことを両方固定する。
   */
  it('resume_failed（recovered: false）イベントは日誌には載るが、クローンへは回らず status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.resumeFailed(job.id, job.sessionId, '止めたはずなのに開き直せなかったと言ってきた', false);

    await journalHas(s, '止めたはずなのに開き直せなかったと言ってきた', ['exchange']);
    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  it('resume_failed（recovered: true）イベントも日誌には載るが、クローンへは回らず status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.resumeFailed(job.id, job.sessionId, '止めたはずなのに生ログから続けたと言ってきた', true);

    await journalHas(s, '止めたはずなのに生ログから続けたと言ってきた', ['exchange']);
    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /**
   * **このガードは、明示的な `manager_send` で起こし直す能力を塞がない。**
   *
   * `send()` は resume が受理された時点で `record.job.status` を先に `'running'`
   * へ書く（`send()` 本体）。だから `resume_failed` がその後に届いても、この時点
   * では `record.job.status` は既に `'stopped'` ではなく、上の新しいガードには
   * 掛からない——`resume_failed` 本来の分岐（`event.recovered` の真偽で
   * `running` / `lost` を書き分ける）がそのまま働く。ここでは `recovered: false`
   * を届けて `lost` へ落ちることを確かめる——ガードに飲まれて `stopped` の
   * ままだったら、この分岐は起きない。
   */
  it('明示的な manager_send で起こした後の resume_failed は、新しいガードに塞がれず従来どおり処理される', async () => {
    const { s, fake } = await stopped();

    // stopped から明示的に送る。session_id は残っているので resume 経路を通り、
    // 受理された時点で status は 'running' へ戻る（`schema.ts` の
    // `jobStatusSchema` の doc・2026-08-22 訂正）。
    const sendResult = await s.pool.send(job.id, 'まだ続きがある');
    expect(sendResult.outcome).toBe('delivered');
    const afterSend = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(afterSend?.status).toBe('running');

    // その resume が SDK 側では見つからなかった、と後から同じ runner から届く
    // （`fake` は `stopped()` が組んだ、この pool に繋がっている runner その
    // ものである）。`recovered: false` なので、塞がれていなければ `lost` へ
    // 落ちる——新しいガードに飲まれて `running` のままなら、この分岐は起きない。
    fake.resumeFailed(job.id, job.sessionId, '結局戻れていなかった', false);

    await expect
      .poll(async () => (await s.pool.list()).find((m) => m.managerId === job.id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');

    await s.pool.stop();
  });
});

/**
 * **中身の無い報告は、記録は残すがクローンのターンを起こさない。**
 *
 * `runner.ts` の `resultText()` / `reportText()` が「SDK の `result` にも
 * `said`（そのターンで実際に喋った本文）にも文字が無かった」と確定させた
 * ときだけ `report` イベントに `contentless: true` が立つ
 * （`runner-protocol.ts` の doc）。`manager.ts` の `case 'report'` はこれを見て
 * `#emit()`（クローンの受信箱へ積む経路）だけをスキップし、台帳・日誌は
 * これまでどおり書く。捨てると「黙って失われる」を作るので、捨てない。
 *
 * **「クローンを起こさない」と「記録に残る」は別々の歯にしてある。** 1本目
 * （inbox が増えない）は `manager.ts` が `contentless` を無視する変異で
 * 落ちるが、台帳・日誌を消す変異では落ちない。2本目（台帳・日誌に残る）は
 * その逆で、1本目の変異では落ちない。
 *
 * **文言では判定していない。** `contentless` は構造化された印であって
 * `event.text === '（報告なし）'` という文字列一致ではない（`sdk-failure.ts`
 * の「検知は構造化された印だけで行う」と同じ形）。3本目がこれを固定する —
 * マネージャーが `say()` で本当に「（報告なし）」と喋った回は `said` が
 * 非空になるので `contentless` が立たず、文言が同じでもクローンへ届く。
 */
describe('中身の無い報告は、記録は残すがクローンを起こさない', () => {
  /** 台帳の1件を直接読む（`runner-failure.test.ts` の `jobOf` と同じ理由 —一覧は写し忘れうる）。 */
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((job) => job.id === managerId);
  }

  /**
   * 日誌に載ったことを「`#onEvent` の処理が（`#emit` の分岐まで）終わった」の
   * 合図にする。R4 のテスト（`journalHas`）と同じ理由 — `#onEvent` は
   * fire-and-forget（`void`）で走るので、発火直後は書き込みがまだ終わって
   * いないことがある。日誌への書き込みは `#emit` を呼ぶかどうかの分岐の
   * 直前なので、これが見えた時点で分岐は（同期的に）通り終えている。
   */
  async function journalHasText(s: Setup, needle: string): Promise<void> {
    await vi.waitFor(async () => {
      const entries = await s.stores.journal.list({ types: ['exchange'] });
      if (!entries.some((entry) => JSON.stringify(entry).includes(needle))) {
        throw new Error('日誌にまだ載っていない');
      }
    });
  }

  it('本文が1文字も無い報告では、クローンの受信箱（inbox）が増えない', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;
    const before = s.inbox.length;

    // `say()` を1度も呼ばない ＝ said は空。SDK の result も空文字列 ＝
    // resultText() が「（報告なし）」を作り empty:true になる。
    await session.report('');

    // **完了の合図は `lastReport`（台帳）にする。日誌ではない。** ここは
    // 「クローンを起こさない」だけを固定したいテストなので、待ち方そのものが
    // `#journal` に依存すると、`#journal` を消す変異（次のテストが検出すべき
    // もの）でこのテストまで一緒にタイムアウトで落ちてしまう —
    // 「クローンを起こさない」と「記録に残る」を別々の歯にする、という要件に
    // 反する。`record.job.lastReport` は `#journal` より前に書かれる
    // （`manager.ts` の `case 'report'`）ので、これを待てば1と2の変異を
    // 混同しない。
    await vi.waitFor(async () => {
      const job = await jobOf(s, started.managerId);
      if (job?.lastReport !== '（報告なし）') throw new Error('台帳がまだ更新されていない');
    });

    expect(s.inbox.length).toBe(before);

    await s.pool.stop();
  });

  it('同じ回は台帳（lastReport）と日誌には残っている', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    await session.report('');
    await journalHasText(s, '（報告なし）');

    const job = await jobOf(s, started.managerId);
    expect(job?.lastReport).toBe('（報告なし）');

    const entries = await s.stores.journal.list({ types: ['exchange'] });
    expect(entries.some((entry) => JSON.stringify(entry).includes('（報告なし）'))).toBe(true);

    await s.pool.stop();
  });

  it('マネージャーが本当に「（報告なし）」と報告した回は、文言が同じでもクローンへ届く', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;
    const before = s.inbox.length;

    // said（実際に喋った本文）に '（報告なし）' そのものが入る形を作る。
    // 中身が無い場合とまったく同じ文字列が本文になるが、`said` が非空
    // なので contentless は立たない。
    await session.say('（報告なし）');
    await session.report('（報告なし）');

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (!found) throw new Error('報告がまだ届いていない');
      return found as { text: string };
    });
    expect(report.text).toContain('（報告なし）');
    expect(s.inbox.length).toBe(before + 1);

    await s.pool.stop();
  });

  it('中身のある報告はこれまでどおりクローンへ届く（回帰）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;
    const before = s.inbox.length;

    await session.say('中身のある報告');
    await session.report('中身のある報告');

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (!found) throw new Error('報告がまだ届いていない');
      return found as { text: string };
    });
    expect(report.text).toContain('中身のある報告');
    expect(s.inbox.length).toBe(before + 1);

    await s.pool.stop();
  });
});

/**
 * **台帳に載っている事実を、一覧が落とさない。**
 *
 * `lastFailure`（`schema.ts`）は「直近の1ターンが報告ではなく失敗で終わった」
 * ことで、人間の面（CLI の `/managers`・Web のマネージャー画面）とクローンが
 * これを読んで「報告が来た」と区別する。**外へ出るのは `summaryOf` を通った分
 * だけ**なので、ここが写し忘れると、台帳には載っているのにどの面にも出ない
 * ——直す前とまったく同じ見え方（`You've hit your org's monthly spend limit …`
 * が報告として出る）に戻る（`sdk-failure.ts` の doc）。
 */
describe('一覧は、直近のターンが失敗で終わったことを落とさない', () => {
  const failedJob = {
    id: 'mgr-billing',
    managerId: 'mgr-billing',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    // **`failed` ではない。** 支出上限に当たった回もセッションは生きているので、
    // 台帳の状態は `done`（終えて待機中。話しかければ続く）のままである。
    status: 'done' as const,
    summary: '調査',
    request: '調べて',
    cwd: '/work/project',
    lastReport: '（このターンは応答を返さずに終わった: billing_error / assistant_error）',
    lastFailure: {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-08-20T10:00:00.000Z',
    },
  };

  it('台帳の lastFailure が要約に載る（status は done のまま）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(failedJob);
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-billing');

    expect(listed?.lastFailure).toEqual({
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-08-20T10:00:00.000Z',
    });
    // **状態は置き換えない。** ここを `failed` へ倒すと、人間は続けられる仕事を
    // そこで閉じる（`status` と `lastFailure` を分けた理由そのもの）。
    expect(listed?.status).toBe('done');

    await s.pool.stop();
  });

  it('失敗していないマネージャーには lastFailure を作らない（「失敗していない」と「見ていない」を混ぜない）', async () => {
    const stores = createMemoryStores();
    // **失敗の印だけを外した同じジョブ**を入れる（`delete` で外すのは、
    // `exactOptionalPropertyTypes` で `undefined` を代入できないため）。
    const ok = { ...failedJob, id: 'mgr-ok', managerId: 'mgr-ok' };
    delete (ok as { lastFailure?: unknown }).lastFailure;
    await stores.jobs.putJob(ok);
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-ok');

    expect(listed).toBeDefined();
    expect(listed?.lastFailure).toBeUndefined();
    // キーごと無いこと（`undefined` を入れた形と区別する）。
    expect(Object.hasOwn(listed as object, 'lastFailure')).toBe(false);

    await s.pool.stop();
  });
});

/**
 * `#records`（デーモン側が持つマネージャーの像）の寿命。
 *
 * `ManagerRecord` の JSDoc は「像はマネージャーと一緒に消えるので寿命は元から
 * 有限」と書いているが、`done` / `lost` / `failed` へ着いても外す経路が
 * 一度も無かった（実測で6日に58本、外れずに増え続ける）。`#retire` がその
 * 唯一の出口である。
 *
 * ここでは `#records` から外れたこと自体を、プロセス内だけに載る帳面
 * （`denials()`。`Job` 側には無い）が空へ戻ることで観測する — `list()` /
 * `manager_send` の出力は `#load()` が台帳から作り直すので、外れても外れなくても
 * 同じに見える（それ自体が受け入れ条件でもある）。
 */
describe('#records の寿命（終端で外れる）', () => {
  function job(id: string, overrides: Partial<Job> = {}): Job {
    return {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'running',
      summary: '長い仕事',
      request: 'DB の移行をやって',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
      ...overrides,
    };
  }

  (['done', 'lost', 'failed'] as const).forEach((status) => {
    it(`closed（${status}）で #records から外れても、manager_list / manager_report は従来どおり答えられる（受け入れ条件）`, async () => {
      const id = `mgr-closed-${status}`;
      const stores = createMemoryStores();
      await stores.jobs.putJob(job(id));
      const fake = swappableRunner('runner-test');
      fake.state.alive.push({
        managerId: id,
        status: 'running',
        cwd: '/work/project',
        request: 'DB の移行をやって',
        waiting: [],
        sessionId: `sess-${id}`,
      });
      const s = setup(undefined, { stores, runner: fake.runner });
      await s.pool.restore();

      // 走行中に拒否が積まれる（`denials()` が非空になる ＝ 像がまだ生きている証拠）。
      fake.denied(id, 'Bash');
      expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1 }]);

      // 本当に閉じる（`RunnerSession#finish()` を通った印）。
      fake.closed(id, status, `終端: ${status}`);

      // **`#records` から外れたことの外部から見える証拠。** `denied` はプロセス内
      // だけの帳面で `Job` には書かない（起動をまたいでも残らない設計）ので、
      // ここが空へ戻ることは「像そのものが消えた」ことを意味する。
      await expect.poll(() => s.pool.denials(id), { timeout: 2000 }).toEqual([]);

      // **それでも `manager_list` / `manager_report` は答えられる。** `Job` 本体は
      // 台帳に残るので、`list()` は台帳から summary を作り直す。
      const listed = (await s.pool.list()).find((m) => m.managerId === id);
      expect(listed).toBeDefined();
      expect(listed).toMatchObject({
        status,
        request: 'DB の移行をやって',
        // `lost` だけは「戻れないと確認済み」なので `live: false` が正しい。
        // `done` / `failed` は `session_id` が残っている限り明示的に起こし直せる
        // ので `live: true`（`list()` のフォールバックを `isLive()` に直した分）。
        live: status !== 'lost',
      });

      const transcript = await s.pool.transcript(id);
      // 生ログを預かっていない fake runner でも、`transcript()` は「無い」で
      // 応答できる（`#records` に無いことで例外にならない）ことだけを見る。
      expect(transcript).toBeNull();

      await s.pool.stop();
    });
  });

  it('abort() で外れても、manager_list は従来どおり答えられる', async () => {
    const id = 'mgr-aborted';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: `sess-${id}`,
    });
    const runner = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    const s = setup(undefined, { stores, runner });
    await s.pool.restore();

    fake.denied(id, 'Edit');
    expect(s.pool.denials(id)).toEqual([{ tool: 'Edit', count: 1 }]);

    await s.pool.abort(id, '暴走したので');

    expect(s.pool.denials(id)).toEqual([]);
    const listed = (await s.pool.list()).find((m) => m.managerId === id);
    // **2026-08-21 に反転。** 直す前は `abort()` が確かに止めても台帳の `status` を
    // `'done'` に書いていた（「止めた」と「待機中」が1語に潰れていた、R2）。いまは
    // `'stopped'` という専用の終端状態を持つので、ここを反転する（3点セットは
    // 上の「セッションが畳まれたら、止まったと言い切る」と同じ理由）。
    expect(listed).toMatchObject({ status: 'stopped' });

    await s.pool.stop();
  });

  it('resume_failed で lost になって外れても、manager_send で明示的に起こし直せる（送信の経路が壊れない）', async () => {
    // 「lost へ明示的に話しかけて起こし直す経路」（`resume_failed` のコメント）が
    // `#retire` の後でも通ることを見る。`#load()` が台帳から像を作り直し、
    // `!record.attached` の分岐が resume を投げる。
    const id = 'mgr-resume-failed-lost';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: `sess-${id}`,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash');
    expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1 }]);

    fake.resumeFailed(id, `sess-${id}`, '開き直せなかった', false);
    await expect
      .poll(async () => (await stores.jobs.listJobs()).find((j) => j.id === id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');
    expect(s.pool.denials(id)).toEqual([]);

    const result = await s.pool.send(id, '続けて');
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({ managerId: id, sessionId: `sess-${id}` });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('reattach（runner 入れ替え）で挑み直しを諦めて lost になっても外れる', async () => {
    // `#reattach` 側のもう1つの `lost` 化経路（`isRetryableRunnerError` が偽の
    // resume 失敗）。ここも `#retire` の対象であることを確かめる。
    const id = 'mgr-reattach-giveup';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash');
    expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1 }]);

    fake.runner.resume = async () => {
      throw new RunnerHttpError('runner POST resume が失敗した (400)', 400);
    };
    fake.swap();

    await expect
      .poll(async () => (await stores.jobs.listJobs()).find((j) => j.id === id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');
    await expect.poll(() => s.pool.denials(id), { timeout: 2000 }).toEqual([]);

    await s.pool.stop();
  });

  it('確認待ちが残っていても、閉じた（closed）後の /answer は宙に浮かず「解けない」と返る', async () => {
    // 落とし穴1: 外した瞬間に、未解決の確認が残っているマネージャーへの
    // `/answer` が通らなくなる形が無いか。`case 'closed'` は `#retire` の前から
    // `record.waiting = []` を持ってから畳んでいる（`resume_failed` の `lost` 化
    // 経路にも同じ形を足した）ので、答えは「待っていない」という明確な結果に
    // なる（宙に浮いて黙って捨てられることはない）。
    const id = 'mgr-ask-then-closed';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id, { status: 'waiting_human' }));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: id,
      status: 'waiting_human',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [{ requestId: 'req-9', summary: '許可して' }],
      sessionId: `sess-${id}`,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    // `restore()` が runner の `alive` から `waiting` をそのまま引き取る
    // （`waiting_human` はホワイトリストに載っているので `attached: true`）。
    await s.pool.restore();

    // クローンが答える前に runner 側でセッションが閉じた。
    fake.closed(id, 'lost', 'セッションが落ちた');

    const result = await s.pool.send(id, '許可する', { requestId: 'req-9' });
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('待っていない');

    await s.pool.stop();
  });
});

/**
 * runner の指名（`ManagerStartInput.runnerId`）と一覧（`ManagerPool.runners()`）。
 *
 * roadmap の依頼「コンテナがいくつあって、どこで何をいくつ動かしているかを
 * クローンが把握できるようにする」＋「manager を立てるときにどちらのコンテナで
 * 作業するかをクローンの判断で選べるようにする」の、`ManagerPool` 層での固定。
 *
 * SDK は握らない——`Pool.start()` は `runner.start(command)` を呼ぶだけで完結する
 * ので、`RunnerClient` を直接実装した軽い偽物で足りる（`runner-placement.test.ts`
 * と同じ作法）。
 */
class FakePoolRunner implements RunnerClient {
  readonly runnerId: string;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  started: string[] = [];
  /** 呼ばれた回数。**`resources()` は呼ばれないことを確かめるために数える。** */
  resourcesCalls = 0;
  credentialsCalls = 0;
  profileCalls = 0;
  fakeCredentials: RunnerCredentialFingerprint[] = [];
  fakeProfile: RunnerProfileFingerprint | undefined;

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    this.resourcesCalls += 1;
    return this.report;
  }
  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<void> {
    this.started.push(command.managerId);
  }
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
  async answer(): Promise<boolean> {
    return false;
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    this.credentialsCalls += 1;
    return this.fakeCredentials;
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    this.profileCalls += 1;
    return this.fakeProfile;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

describe('runner の指名（Pool.start の runnerId）', () => {
  it('runnerId を指名すると、その runner が起こされる（自動配置の点数計算を通していない）', async () => {
    // 点数だけを見れば roomy が勝つ構図——それでも tight を名指ししたら tight に
    // 置かれることを確かめる（自動配置の点数計算を通していない証拠）。
    const roomy = new FakePoolRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const tight = new FakePoolRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([roomy, tight]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const summary = await pool.start({ request: '指名した器で頼む', runnerId: 'runner-tight' });

    // **ここで見るのは「指名が効いたか」だけ。** 返り値の runnerId が実際の選択と
    // 一致するかは別の保証（次の describe）なので、ここでは混ぜない。
    expect(tight.started).toEqual([summary.managerId]);
    expect(roomy.started).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  it('指名した runner の runnerId が、返ってくる summary.runnerId に一致する', async () => {
    const roomy = new FakePoolRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const tight = new FakePoolRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([roomy, tight]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const summary = await pool.start({ request: '指名した器で頼む', runnerId: 'runner-tight' });

    expect(summary.runnerId).toBe('runner-tight');

    await pool.stop();
    await registry.stop();
  });

  it('指名しなければ、資源で選ばれた runner が起こされ、summary.runnerId がそれと一致する', async () => {
    const busy = new FakePoolRunner('runner-busy', { managers: 9 });
    const idle = new FakePoolRunner('runner-idle', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([busy, idle]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const summary = await pool.start({ request: '自動配置に任せる' });

    // **返ってくる runnerId は、実際に start() を受け取った器と一致する。**
    // ここを「入力の指名をそのまま書き戻す」ような実装に変異させると、指名して
    // いないこの経路では `undefined` になって落ちる。
    expect(summary.runnerId).toBe('runner-idle');
    expect(idle.started).toEqual([summary.managerId]);
    expect(busy.started).toEqual([]);

    await pool.stop();
    await registry.stop();
  });
});

describe('runner の一覧（ManagerPool.runners）', () => {
  it('器ごとの本数を返す（デーモンの台帳から見た数）', async () => {
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const b = new FakePoolRunner('runner-b', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a, b]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    // 2本を runner-a、1本を runner-b へ指名して置く。
    await pool.start({ request: '1本目', runnerId: 'runner-a' });
    await pool.start({ request: '2本目', runnerId: 'runner-a' });
    await pool.start({ request: '3本目', runnerId: 'runner-b' });

    const overview: RunnerFleetOverview = await pool.runners();

    const byLabel = new Map(overview.runners.map((r) => [r.label, r]));
    expect(byLabel.get('runner-a')?.managers).toHaveLength(2);
    expect(byLabel.get('runner-b')?.managers).toHaveLength(1);
    expect(overview.unassigned).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  it('runnerId の無いマネージャーを、どの器にも混ぜず unassigned 別枠へ出す', async () => {
    const stores = createMemoryStores();
    // **`runnerId` を書かない古いジョブを台帳に直接置く。** `manager_id → runner_id`
    // を記録する前の世代を模す（`Job.runnerId` は optional）。
    const at = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-legacy',
      managerId: 'mgr-legacy',
      createdAt: at,
      updatedAt: at,
      status: 'done',
      summary: '記録の無い古い仕事',
      request: '記録の無い古い仕事',
      cwd: '/work/project',
    });
    const only = new FakePoolRunner('runner-only', { managers: 0 });
    const registry = createRunnerRegistry([only]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    // **0 に畳まれていない。** `runner-only` の内訳には現れず、別枠に1件として出る。
    expect(overview.runners.find((r) => r.label === 'runner-only')?.managers).toEqual([]);
    expect(overview.unassigned).toEqual([{ managerId: 'mgr-legacy', status: 'done' }]);

    await pool.stop();
    await registry.stop();
  });

  it('state は5値のまま渡す（connected へ畳まない）', async () => {
    // まだ開けていない（開けなかった）1台は `unreachable`。`connected` へ畳んで
    // いれば、クローンは「使える」と誤読する。
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
    await registry.register({
      label: 'http://runner:later',
      open: () => Promise.reject(new Error('fetch failed')),
    });
    const stores = createMemoryStores();
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    expect(overview.runners).toMatchObject([
      { label: 'http://runner:later', state: 'unreachable' },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('resources() は呼ばない（この一覧のために配置の往復を足さない）', async () => {
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.runners();
    await pool.runners({ fingerprints: true });

    expect(a.resourcesCalls).toBe(0);

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints を渡さなければ credentials()/profile() を呼ばず、指紋を載せない', async () => {
    const a = new FakePoolRunner('runner-a');
    a.fakeCredentials = [
      { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    a.fakeProfile = { sha256: 'cafef00dbabe', bytes: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    expect(a.credentialsCalls).toBe(0);
    expect(a.profileCalls).toBe(0);
    expect(overview.runners[0]?.credentials).toBeUndefined();
    expect(overview.runners[0]?.profile).toBeUndefined();

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints: true を渡すと、開いている器の鍵とプロファイルの指紋を添える', async () => {
    const a = new FakePoolRunner('runner-a');
    a.fakeCredentials = [
      { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    a.fakeProfile = { sha256: 'cafef00dbabe', bytes: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners({ fingerprints: true });

    expect(overview.runners[0]?.credentials).toEqual(a.fakeCredentials);
    expect(overview.runners[0]?.profile).toEqual(a.fakeProfile);

    await pool.stop();
    await registry.stop();
  });
});
