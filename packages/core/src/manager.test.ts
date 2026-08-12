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
import { describe, expect, it } from 'vitest';

import {
  MANAGER_MODEL,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WITHHELD_ENV_KEYS,
  createManagerPool,
  type ManagerPool,
} from './manager.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

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
}

function setup(env: NodeJS.ProcessEnv = { PATH: '/usr/bin', ALTEROID_HOME: '/secret' }): Setup {
  const { fn, sessions } = fakeSdk();
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    queryFn: fn,
    post: (event) => inbox.push(event),
    defaultCwd: '/work/project',
    env,
  });
  return { pool, stores, sessions, inbox };
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

    // 権限モードは人間が Claude Code を開いたときと同じ既定のまま
    expect(options.permissionMode).toBeUndefined();

    // 人間と同じ設定・同じ .mcp.json を渡す（下向きは同じものが見える）
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.cwd).toBe('/work/project');

    // Claude Code 既定のシステムプロンプトを置き換えない（置き換え = デグレード）
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });

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

  it('許可確認はクローンへ回り、返事が来るまでその仕事だけが止まる（受け入れ基準2）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

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

  it('manager_id と SDK の session_id の対応が JobStore に残る（M4 の resume の足がかり）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '直して' });

    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-mgr');

    const job = (await s.stores.jobs.listJobs())[0];
    expect(job).toMatchObject({ id: managerId, request: '直して', cwd: '/work/project' });

    // 生ログへの入口も残る（可観測性の最下段へ降りるため）
    await (s.sessions[0] as FakeSession).usedTool('Read');
    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.transcriptPath, { timeout: 2000 })
      .toBe('/tmp/does-not-exist.jsonl');

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
});
