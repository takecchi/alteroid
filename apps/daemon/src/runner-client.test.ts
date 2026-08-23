import type {
  query as sdkQuery,
  CanUseTool,
  HookCallbackMatcher,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import {
  createManagerPool,
  createRunnerHost,
  createRunnerRegistry,
  createMemoryStores,
  DEFAULT_SSE_HEARTBEAT_MS,
  HEARTBEAT_FRAME,
  type ManagerPool,
  type InboxEvent,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHash } from 'node:crypto';

import { createHttpRunner, type RunnerDroppedEventReport } from './runner-client.js';

/** 制御面の合鍵。runner が持つのは sha256 だけである。 */
const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

/**
 * デーモン ↔ manager-runner を**実際の HTTP 境界越しに**通す統合テスト（roadmap M4）。
 *
 * ここで確かめたいのは、分離しても M1〜M3 の能力が落ちないことである:
 * 委譲・許可確認のエスカレーション・報告・監査（全ツール実行）・生ログ、そして
 * デーモン再起動後に**走行中のマネージャーが実際に続きを進める**こと。
 *
 * SDK だけは偽物（`queryFn`）にする。境界そのものは本物を通す — 偽の境界で
 * 確かめても、分離できたことの証明にならない。
 */
interface FakeSession {
  options: Options;
  inputs: string[];
  ask(toolName: string, requestId: string): Promise<PermissionResult>;
  report(text: string): Promise<void>;
  usedTool(tool: string): Promise<void>;
  /**
   * `PostToolUse` フックが実機で送ってくることのある形（`tool_input` という
   * キー自体が無い）を模す。`usedTool` は常に `tool_input: { a: 1 }` を渡すので、
   * この形は再現できない（#223 と同じ理由の回帰）。
   */
  usedToolWithoutInput(tool: string): Promise<void>;
  mirror(projectKey: string, entries: SessionStoreEntry[]): Promise<void>;
}

function fakeSdk(sessionId = 'sess-1') {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const inputs: string[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      options,
      inputs,
      async ask(toolName, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        const result = await canUseTool(toolName, { command: 'ls' }, {
          signal: new AbortController().signal,
          requestId,
          toolUseID: `tool-${requestId}`,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した');
        return result;
      },
      async report(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: sessionId,
          uuid: 'uuid-result',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async usedTool(tool) {
        const matchers = options.hooks?.PostToolUse as HookCallbackMatcher[];
        for (const matcher of matchers) {
          for (const hook of matcher.hooks) {
            await hook(
              { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { a: 1 } } as never,
              undefined,
              { signal: new AbortController().signal },
            );
          }
        }
      },
      async usedToolWithoutInput(tool) {
        const matchers = options.hooks?.PostToolUse as HookCallbackMatcher[];
        for (const matcher of matchers) {
          for (const hook of matcher.hooks) {
            // `tool_input` というキー自体を持たない（実機の SDK が送ってくることの
            // ある形）。手で `undefined` を代入するのではなく、キーを書かない。
            await hook({ hook_event_name: 'PostToolUse', tool_name: tool } as never, undefined, {
              signal: new AbortController().signal,
            });
          }
        }
      },
      async mirror(projectKey, entries) {
        await (options.sessionStore as SessionStore).append({ projectKey, sessionId }, entries);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

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

    return Object.assign(generate(), {
      close: () => {
        if (emit) emit(null as unknown as SDKMessage);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

/** hono のアプリへ直に流す fetch（ソケットを開かずに本物の HTTP 経路を通す）。 */
function fetchInto(app: ReturnType<typeof createRunnerApp>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return app.request(`${url.pathname}${url.search}`, init as never);
  }) as typeof fetch;
}

interface Rig {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  sessions: FakeSession[];
  close(): Promise<void>;
}

/** runner（別プロセス相当）と、それに繋ぐデーモン側のプールを1組作る。 */
async function rig(options: { stores?: Stores; sessionId?: string } = {}): Promise<Rig> {
  const { fn, sessions } = fakeSdk(options.sessionId ?? 'sess-1');
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: (event) => outbox.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin', ALTEROID_DATABASE_URL: 'postgres://secret@db/alteroid' },
  });
  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });

  const client = await createHttpRunner({
    baseUrl: 'http://runner.test',
    token: TOKEN,
    fetchFn: fetchInto(app),
  });

  const stores = options.stores ?? createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([client]),
  });

  return {
    pool,
    stores,
    inbox,
    sessions,
    async close() {
      await pool.stop();
      await host.shutdown();
    },
  };
}

const rigs: Rig[] = [];

afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()?.close();
});

async function open(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const created = await rig(options);
  rigs.push(created);
  return created;
}

describe('デーモン ↔ manager-runner（HTTP 境界）', () => {
  it('runner_id を名乗り、委譲が境界越しに走る', async () => {
    const r = await open();

    const summary = await r.pool.start({ request: 'ログイン周りを直して' });

    expect(summary.runnerId).toBe('runner-primary');
    // 宛先と workspace の所在が台帳に残る（`manager_id → runner_id → …` の鎖）
    await expect
      .poll(async () => (await r.stores.jobs.listJobs())[0]?.workspace, { timeout: 2000 })
      .toEqual({
        // 境界を越えても、**確かめていない永続性は名乗らない**。
        kind: 'unknown',
        runnerId: 'runner-primary',
        path: '/workspace',
        reason: expect.stringContaining('確かめられない') as unknown as string,
      });
    await expect
      .poll(async () => (await r.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-1');
  });

  it('記憶ストアの鍵は runner の子プロセスにも渡らない（受け入れ基準3の二重の底）', async () => {
    const r = await open();
    await r.pool.start({ request: '調べて' });

    const env = (r.sessions[0] as FakeSession).options.env ?? {};
    expect(env.ALTEROID_DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('許可確認がクローンまで届き、回答が境界越しに戻る（受け入れ基準: M2-2）', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: 'デプロイして' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    const asked = (r.sessions[0] as FakeSession).ask('Bash', 'req-1');

    // クローンの受信箱へ、宛先つきで届く
    await expect
      .poll(() => r.inbox.filter((event) => event.type === 'manager_message').length, {
        timeout: 2000,
      })
      .toBe(1);
    const event = r.inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission', managerId, requestId: 'req-1' });

    // 止まっているのはこの1件だけ、と一覧からも見える
    const waiting = (await r.pool.list()).find((m) => m.managerId === managerId);
    expect(waiting?.status).toBe('waiting_human');
    expect(waiting?.waiting[0]?.requestId).toBe('req-1');

    const result = await r.pool.send(managerId, 'よい', { decision: 'allow', requestId: 'req-1' });
    expect(result.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });

    // 誰が何を聞かれ、何と答えたかが日誌に残る（監査）
    const escalations = (await r.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations.map((entry) => entry.answer)).toEqual(['[allow] よい', undefined]);
  });

  it('報告と全ツール実行がデーモン側へ上がる（監査は分離後も落ちない）', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: '直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    await (r.sessions[0] as FakeSession).usedTool('Edit');
    await (r.sessions[0] as FakeSession).report('直した');

    await expect
      .poll(async () => (await r.stores.journal.list({ types: ['tool_use'] })).length, {
        timeout: 2000,
      })
      .toBe(1);
    const [tool] = (await r.stores.journal.list({ types: ['tool_use'] })) as { actor: string }[];
    expect(tool?.actor).toBe(`manager:${managerId}`);

    await expect
      .poll(() => r.inbox.some((event) => event.type === 'manager_message'), { timeout: 2000 })
      .toBe(true);
    expect((await r.pool.list())[0]?.lastReport).toBe('直した');
  });

  /**
   * **回帰: `tool_input` を持たない `PostToolUse` イベントが、HTTP 境界を越えて
   * 捨てられる（#223 と同じ形。`tool_use` の `input` 版）。**
   *
   * `permission_denied` の `input` で先に踏んだ形が、`tool_use` イベントにも
   * ある。`hook.tool_input` が無い（＝ `undefined`）とき、`runner.ts` の
   * `#onPostToolUse` が作る `tool_use` イベントの `input` も `undefined` に
   * なる。HTTP でこのイベントを runner からデーモンへ渡す側は `JSON.stringify`
   * を通すので、値が `undefined` の欄はキーごと落ちる——境界の向こうでは
   * `input` というキー自体が存在しない。`runnerEventSchema` の `tool_use` の
   * `input` が必須のままだと（zod 4 は `z.unknown()` に対してキーの不在を
   * 許さない）、`safeParse` が落ちてこのイベントがまるごとデーモンに届かず、
   * **その1回のツール実行の監査が跡形もなく消える。**
   */
  it('`tool_input` の無い PostToolUse イベントでも、境界越しに監査が届く（回帰）', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: '直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    await (r.sessions[0] as FakeSession).usedToolWithoutInput('Bash');

    await expect
      .poll(async () => (await r.stores.journal.list({ types: ['tool_use'] })).length, {
        timeout: 2000,
      })
      .toBe(1);
    const [tool] = (await r.stores.journal.list({ types: ['tool_use'] })) as {
      actor: string;
      tool: string;
      input?: unknown;
    }[];
    expect(tool?.actor).toBe(`manager:${managerId}`);
    expect(tool?.tool).toBe('Bash');
    expect(tool?.input).toBeUndefined();
  });

  it('生ログは runner から上がってデーモンが預かる（可観測性の最下段）', async () => {
    const entries: { key: unknown; entries: unknown[] }[] = [];
    const sessionStore: SessionStore = {
      append: async (key, appended) => {
        entries.push({ key, entries: appended });
      },
      load: async () => null,
    };
    const stores = { ...createMemoryStores(), sessionStore };
    const r = await open({ stores });
    await r.pool.start({ request: '調べて' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    await (r.sessions[0] as FakeSession).mirror('proj', [{ type: 'user', uuid: 'u1' }]);

    await expect.poll(() => entries.length, { timeout: 2000 }).toBe(1);
    // 生ログを後から引き当てる鍵（projectKey）も台帳に残る
    await expect
      .poll(async () => (await r.stores.jobs.listJobs())[0]?.projectKey, { timeout: 2000 })
      .toBe('proj');
  });

  it('デーモンだけが再起動したら、走っているマネージャーへ繋ぎ直す（殺さない）', async () => {
    // runner は別プロセスなので、デーモンが落ちてもマネージャーは手を止めない。
    const { fn, sessions } = fakeSdk('sess-live');
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/workspace',
      emit: (event) => outbox.push(event),
      queryFn: fn,
    });
    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
    const stores = createMemoryStores();

    const connect = async (): Promise<ManagerPool> => {
      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn: fetchInto(app),
      });
      return createManagerPool({
        stores,
        post: () => undefined,
        runners: createRunnerRegistry([client]),
      });
    };

    const first = await connect();
    const { managerId } = await first.start({ request: '長い仕事' });
    await expect.poll(() => sessions.length, { timeout: 2000 }).toBe(1);
    await first.stop(); // デーモンが落ちる（runner は生きたまま）

    const second = await connect();
    const restored = await second.restore();

    expect(restored.map((m) => m.managerId)).toEqual([managerId]);
    // 繋ぎ直しただけ。セッションは増えていない（＝二重に起こしていない）
    expect(sessions).toHaveLength(1);

    await second.stop();
    await host.shutdown();
  });

  it('runner ごと作り直されたら、預かった生ログから resume して続きを進める', async () => {
    // **これが受け入れ基準2の本体である。** 器を作り直したあと、走行中だった
    // 仕事が「話しかけられるまで止まったまま」では、人間の不在で仕事が止まる。
    const seeded: SessionStoreEntry[] = [{ type: 'user', uuid: 'u1' }];
    const sessionStore: SessionStore = {
      append: async () => undefined,
      load: async (key) => (key.sessionId === 'sess-before' ? seeded : null),
    };
    const stores = { ...createMemoryStores(), sessionStore };
    await stores.jobs.putJob({
      id: 'mgr-old',
      managerId: 'mgr-old',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running',
      summary: '移行作業',
      request: 'DB の移行をやって',
      cwd: '/workspace',
      runnerId: 'runner-primary',
      sessionId: 'sess-before',
      projectKey: 'proj',
      workspace: { kind: 'runner-volume', runnerId: 'runner-primary', path: '/workspace' },
    });

    // 新しい器（runner も作り直された）で立ち上がる
    const r = await open({ stores, sessionId: 'sess-after' });
    const restored = await r.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual(['mgr-old']);
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    const session = r.sessions[0] as FakeSession;
    // session_id から resume し、預かった生ログを materialize させている
    expect(session.options.resume).toBe('sess-before');
    expect(
      await (session.options.sessionStore as SessionStore).load({
        projectKey: 'any',
        sessionId: 'sess-before',
      }),
    ).toEqual(seeded);

    // **開き直すだけで終わらない。** 続きの指示まで届いている
    await expect
      .poll(() => session.inputs.join(''), { timeout: 2000 })
      .toContain('中断していた作業の続きを進めよ');

    // クローンも「続きがある」ことを知っている（受信箱ただ1つの経路で）
    expect(
      r.inbox.some(
        (event) => event.type === 'manager_message' && event.text.includes('再開させた'),
      ),
    ).toBe(true);
  });

  it('Unix ソケット越しでも同じように動く（コンテナ構成の実経路）', async () => {
    // コンテナでは TCP を開かない（同じ器のマネージャーに curl の宛先を作らない）。
    // その経路自体を通しておかないと、テストだけが通る配線になる。
    const { mkdtempSync, rmSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createAdaptorServer } = await import('@hono/node-server');

    const dir = mkdtempSync(join(tmpdir(), 'alteroid-sock-'));
    const socketPath = join(dir, 'runner.sock');
    const { fn, sessions } = fakeSdk('sess-sock');
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/workspace',
      emit: (event) => outbox.push(event),
      queryFn: fn,
    });
    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
    const server = createAdaptorServer({ fetch: app.fetch });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
    chmodSync(socketPath, 0o600);

    try {
      const client = await createHttpRunner({ baseUrl: `unix:${socketPath}`, token: TOKEN });
      const stores = createMemoryStores();
      const inbox: InboxEvent[] = [];
      const pool = createManagerPool({
        stores,
        post: (event) => inbox.push(event),
        runners: createRunnerRegistry([client]),
      });

      const summary = await pool.start({ request: 'ソケット越しに委譲' });
      expect(summary.runnerId).toBe('runner-primary');

      // 出来事（SSE）もソケットを流れて届く
      await expect
        .poll(async () => (await stores.jobs.listJobs())[0]?.sessionId, { timeout: 3000 })
        .toBe('sess-sock');

      // 許可確認の往復も通る
      await expect.poll(() => sessions.length, { timeout: 2000 }).toBe(1);
      const asked = (sessions[0] as FakeSession).ask('Bash', 'req-sock');
      await expect
        .poll(() => inbox.some((event) => event.type === 'manager_message'), { timeout: 3000 })
        .toBe(true);
      await pool.send(summary.managerId, 'よい', { decision: 'allow', requestId: 'req-sock' });
      expect(await asked).toEqual({ behavior: 'allow' });

      await pool.stop();
    } finally {
      await host.shutdown().catch(() => undefined);
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('繋いでいない間に降りてきた確認も、繋ぎ直したときに届く（宙吊りにしない）', async () => {
    const { fn, sessions } = fakeSdk('sess-queue');
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/workspace',
      emit: (event) => outbox.push(event),
      queryFn: fn,
    });
    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
    const stores = createMemoryStores();
    const inbox: InboxEvent[] = [];

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchInto(app),
    });
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([client]),
    });
    const { managerId } = await pool.start({ request: '確認してくる仕事' });
    await expect.poll(() => sessions.length, { timeout: 2000 }).toBe(1);
    await pool.stop(); // デーモンが落ちている間に…

    void (sessions[0] as FakeSession).ask('Bash', 'req-late'); // …確認が降りてくる

    const client2 = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchInto(app),
    });
    const revived = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([client2]),
    });
    await revived.restore();

    // 溜まっていた確認が届く（捨てていたら、マネージャーは永久に待つ）
    await expect
      .poll(
        () =>
          inbox.some((event) => event.type === 'manager_message' && event.requestId === 'req-late'),
        { timeout: 3000 },
      )
      .toBe(true);
    expect(
      (await revived.list()).find((m) => m.managerId === managerId)?.waiting[0]?.requestId,
    ).toBe('req-late');

    await revived.stop();
    await host.shutdown();
  });
});

/**
 * 配置の材料が HTTP の境界を渡ること（roadmap M5 / PR3）。
 *
 * 資源の値そのものは器によって違うので**値では見ない**（cgroup の読み方は
 * `packages/core/src/runner-resources.test.ts` が押さえている）。ここで見るのは、
 * **何が渡り、何が渡らないか**である。
 */
describe('資源による配置の材料', () => {
  /** `/health` を好きな形で返す偽 runner（古い器を作るため）。 */
  function fetchHealth(body: unknown): typeof fetch {
    return (async () => Response.json(body)) as typeof fetch;
  }

  it('runner の /health が資源を名乗り、デーモンがそれを採る', async () => {
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/workspace',
      emit: (event) => outbox.push(event),
      queryFn: fakeSdk().fn,
    });
    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchInto(app),
    });

    const resources = await client.resources?.();

    // 稼働本数は M4 からある材料（**新しく足したのは CPU とメモリだけ**）。
    expect(resources?.managers).toBe(0);
    // **出典を名乗ること**が要点である。cgroup を持たない器でも黙らず、os として答える。
    expect(resources?.memory?.source).toMatch(/^(cgroup|os)$/);
    expect(resources?.memory?.limitBytes).toBeGreaterThan(0);
    expect(resources?.cpu?.cores).toBeGreaterThan(0);

    await host.shutdown();
  });

  it('資源を返さない古い runner からも稼働本数は渡る（締め出さないための材料）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://legacy.test',
      token: TOKEN,
      fetchFn: fetchHealth({
        ok: true,
        runnerId: 'runner-legacy',
        workspacePath: '/workspace',
        managers: 3,
      }),
    });

    // **配置側はこれを平均で埋めて競わせる**（`chooseByResources`）。ここで
    // `undefined` を返してしまうと、古い器が自分の抱えている本数でさえ competing
    // できなくなる。
    expect(await client.resources?.()).toEqual({ managers: 3 });
  });

  it('資源の形が壊れていても、読めた材料は落とさない', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://broken.test',
      token: TOKEN,
      fetchFn: fetchHealth({
        ok: true,
        runnerId: 'runner-broken',
        workspacePath: '/workspace',
        managers: 2,
        resources: { cpu: { cores: 'たくさん' } },
      }),
    });

    // 宣言していない形は捨てるが、**まとめて弾かない。** 弾くと、`cpu` が壊れた
    // だけの器が「何も報告しない器」に見える。
    expect(await client.resources?.()).toEqual({ managers: 2 });
  });

  it('resources() は runnerId を採らない（器が入れ替わっても宛先を書き換えない）', async () => {
    let runnerId = 'runner-primary';
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: (async () =>
        Response.json({
          ok: true,
          runnerId,
          workspacePath: '/workspace',
          managers: 0,
        })) as typeof fetch,
    });
    expect(client.runnerId).toBe('runner-primary');

    // 器が入れ替わって別の runner_id を名乗り始めた。
    runnerId = 'runner-replaced';
    await client.resources?.();

    // **黙って繋ぎ変えない。** ここで採ると台帳の鎖（`manager_id → runner_id`）が
    // 音もなく別の器へ向く（`ping` に書いてある理由と同じである）。
    expect(client.runnerId).toBe('runner-primary');
  });
});

/**
 * 器の入れ替えの判定材料（roadmap M5 PR4）。
 *
 * **本物の runner の `/health` を通して確かめる。** ここで偽の応答を組み立てると、
 * runner が実際に `instanceId` を名乗っていることを1つも確かめられない
 * （名簿側の判定は `packages/core/src/runner-swap.test.ts` が持つ）。
 */
describe('器の入れ替えの判定材料', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('runner の /health が instanceId を名乗り、identity() がそれを読む', async () => {
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/workspace',
      emit: (event) => outbox.push(event),
      queryFn: fakeSdk().fn,
    });
    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchInto(app),
    });
    cleanups.push(() => client.close());

    const identity = await client.identity?.();

    expect(identity?.runnerId).toBe('runner-primary');
    // **名乗っていること自体が要件である**（無いと名簿は入れ替えを判定できない）。
    expect(typeof identity?.instanceId).toBe('string');
    expect(identity?.instanceId?.length ?? 0).toBeGreaterThan(0);

    // **同じプロセスの間は変わらない。** 呼ぶたびに変わる値だと、毎回の名乗りが
    // 「入れ替わった」に見える（判定が常に真になって使い物にならない）。
    const again = await client.identity?.();
    expect(again?.instanceId).toBe(identity?.instanceId);
  });

  /**
   * **接続の瞬間から名簿が持てること。**
   *
   * 名簿はこの値を `hello()` の応答から採る（`Registry#open`）。ここが取れていないと、
   * 開けた直後に走る引き取りが**判定材料を持たないまま**動く窓ができる — それは
   * 生きている器の仕事を奪いうる側である。
   *
   * **往復を増やしていないことも一緒に見る。** 開くときに `identity()` を別に叩く
   * 形にすると、`hello()` と合わせて2往復になる（`runner-swap.test.ts` が
   * 「開けた瞬間には叩かない」を固定しているのと対になっている）。
   */
  it('hello() が /health の instanceId を拾う（新しい往復を増やさない）', async () => {
    let calls = 0;
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: (async () => {
        calls += 1;
        return Response.json({
          ok: true,
          runnerId: 'runner-primary',
          instanceId: 'boot-7',
          workspacePath: '/workspace',
          managers: 0,
          pendingEvents: 0,
          credentials: [],
        });
      }) as unknown as typeof fetch,
    });
    cleanups.push(() => client.close());

    expect(client.instanceId).toBe('boot-7');
    // `createHttpRunner` が通すのは `hello()` の1回だけである。
    expect(calls).toBe(1);
  });

  it('identity() は runnerId を採らない（読むが書き換えない）', async () => {
    let runnerId = 'runner-primary';
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: (async () =>
        Response.json({
          ok: true,
          runnerId,
          instanceId: 'boot-1',
          workspacePath: '/workspace',
        })) as typeof fetch,
    });
    expect(client.runnerId).toBe('runner-primary');

    runnerId = 'runner-replaced';
    const identity = await client.identity?.();

    // 読んだ値は返すが、**自分の宛先は書き換えない**（`resources()` と同じ線）。
    expect(identity?.runnerId).toBe('runner-replaced');
    expect(client.runnerId).toBe('runner-primary');
  });
});

/**
 * `hello()` が拾う版（roadmap M5 相当。「connected なのに unheard」の窓を
 * 塞ぐ側）。
 *
 * **`identity()` の heartbeat とは別の経路である。** `createHttpRunner()` は
 * 内部で `hello()` を呼んでから返る（`runnerId` / `workspacePath` を確かめる
 * のと同じタイミング）ので、繋がった時点で `client.revision` が既に埋まって
 * いることを確かめる——`identity()` を1回も呼ばずに、である。
 *
 * **本物の runner の `/health` を通して確かめる。** 名簿側が実際にこれを
 * 拾って `entry.revision` を早める判定は `packages/core/src/runner-swap.test.ts`
 * が持つ。
 */
describe('hello() が拾う版', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('接続した時点（identity() を呼ぶ前）で revision が埋まっている', async () => {
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/workspace',
      emit: (event) => outbox.push(event),
      queryFn: fakeSdk().fn,
    });
    const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchInto(app),
    });
    cleanups.push(() => client.close());

    // **`identity()` を一度も呼んでいない。** それでも revision は埋まって
    // いる——`hello()`（`createHttpRunner` 内部）が既に読んでいるからである。
    // このテスト環境では `pnpm build` 済みなので CANON_REVISION が焼かれて
    // おり、runner の /health は known を返す（`known` 固定にしない——焼き
    // 込み状態に依存するので `status` の型だけを見る）。
    expect(client.revision).toBeDefined();
    expect(['known', 'unknown']).toContain(client.revision?.status);
  });

  it('/health に revision フィールドが無い古い runner では、revision は undefined のまま（プレースホルダにしない）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: (async () =>
        Response.json({
          ok: true,
          runnerId: 'runner-old',
          workspacePath: '/workspace',
          // revision フィールド自体を持たない（この機能より前の runner を模す）。
        })) as typeof fetch,
    });
    cleanups.push(() => client.close());

    expect(client.revision).toBeUndefined();
  });
});

/**
 * 死んだ runner への SSE 再接続のバックオフ。
 *
 * `sleepFn` を差し替えて、実時間を待たずに決定的に測る（`fetchFn` と同じ作法）。
 * `/health` は `hello()` が繋ぐ時に一度読むので常に応答する形にし、`/events` への
 * 応答だけを制御する。
 */
describe('死んだ runner への SSE 再接続（バックオフ）', () => {
  // **常に stderr を黙らせる。** 内容を見る必要がないテストでも実際の stderr へ
  // 書かれるのはノイズなので、この describe の全テストで抑える。内容を見る
  // テストは `stderrSpy` を直接読む。
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function pathOf(input: string | URL | Request): string {
    return new URL(typeof input === 'string' ? input : input.toString()).pathname;
  }

  /**
   * `#274` のリセット閾値と同じ導出をテスト側でも行う。**別の値を手で書かない**
   * ——本体（`runner-client.ts` の `CONNECTION_HEALTHY_THRESHOLD_MS`）と同じ
   * 公開定数から導くことで、閾値が変わってもテストが自動で追随する。
   */
  const HEALTHY_THRESHOLD_MS = DEFAULT_SSE_HEARTBEAT_MS * 2;

  /**
   * `/events` へ行くたびに `outcome()` を呼び、結果に応じて応答を組み立てる。
   *
   * - `'fail'`: 503（例外を伴う失敗として `#stream` に伝わる）
   * - `'ok'`: 例外は投げないが、**バイトを一切届けずに即座に閉じる**——`#274`
   *   より前はこれが「成功」としてリセットの引き金だったが、新条件（持続 +
   *   バイトの到着）ではリセットしない。「無音のままぶら下がって切れた死んだ
   *   接続」を模すのにも使う
   * - `'healthy'`: **バイトが1つ届いてから閉じる。** 「閾値を超えてから届く」の
   *   部分は `ReadableStream` の中では作らない —— `pull`/`start` は
   *   `reader.read()` が呼ばれる前に**先出しで**走ることがあり（実測: 接続直後
   *   に `pull` が走り、`#stream` が `connectedAt` を記録するより前にバイトの
   *   側の時計を進めてしまった）、ストリーム内部の副作用で経過時間を作ると
   *   `#stream` 側の計測と競合する。**だから経過時間は `nowFn` 側だけで作る**
   *   ——呼び出し元が `nowFn` を「1回目の呼び出し（`connectedAt`）は0、以降は
   *   `HEALTHY_THRESHOLD_MS`」を返す形にして注入する。
   */
  function fetchEvents(outcome: (callIndex: number) => 'fail' | 'ok' | 'healthy'): {
    fetchFn: typeof fetch;
    eventsCalls: () => number;
  } {
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      const path = pathOf(input);
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-flaky', workspacePath: '/workspace' });
      }
      if (path === '/events') {
        const result = outcome(calls);
        calls += 1;
        if (result === 'fail') return new Response(null, { status: 503 });
        if (result === 'healthy') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.enqueue(new TextEncoder().encode(HEARTBEAT_FRAME));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        // 'ok': 何も流さず、すぐに読み切れる形で閉じる（例外は起きない）。
        return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`想定していない path: ${path}`);
    }) as typeof fetch;
    return { fetchFn, eventsCalls: () => calls };
  }

  /**
   * 「接続してから閾値ちょうど経った後にバイトが届く」を模す `nowFn`。
   *
   * **1回目の呼び出し（`#stream` の `connectedAt`）は0、以降は
   * `HEALTHY_THRESHOLD_MS` を返す。** これは境界そのものを突く——`#pump` の
   * 判定が `>=` なら健全（`HEALTHY_THRESHOLD_MS - 0 >= HEALTHY_THRESHOLD_MS`
   * は真）、`>` に変異していれば健全にならない（変異4本の1本目に対応）。
   */
  function nowFnAtExactThreshold(): () => number {
    let calls = 0;
    return () => {
      const value = calls === 0 ? 0 : HEALTHY_THRESHOLD_MS;
      calls += 1;
      return value;
    };
  }

  it('待ちが 1000→2000→4000→8000→16000→30000→30000… と伸びて頭打ちになる', async () => {
    const { fetchFn } = fetchEvents(() => 'fail');
    const waits: number[] = [];
    let notifyEnough: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      notifyEnough = resolve;
    });
    const sleepFn = async (ms: number): Promise<void> => {
      waits.push(ms);
      if (waits.length >= 8) notifyEnough();
    };

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
    });
    await client.connect(() => undefined);
    await enough;
    await client.close();

    expect(waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('繋ぎ直せたら基準へ戻る', async () => {
    // 1敗目→2敗目→成功（閾値を超えてからバイトが届く）→3敗目、の順で応答する。
    //
    // **#274 で成功の定義が変わった。** 以前は `'ok'`（例外を伴わず即座に
    // 閉じる、バイトを一切運ばない接続）が「成功」だった——本番ではこの形が
    // 「繋がった直後に死ぬ相手」と区別できず、リセットの誤発火の元だった
    // （doc「なぜ『繋がった時点』ではないか」参照）。ここでは新条件どおり
    // `'healthy'`（閾値を超えてからバイトが届く）で「持続した接続」を模す。
    // **保証そのもの（繋ぎ直せたら基準へ戻る）は変わっていない。** 変わった
    // のは「何をもって繋ぎ直せたと判定するか」だけである。
    const { fetchFn } = fetchEvents((i) => (i < 2 ? 'fail' : i === 2 ? 'healthy' : 'fail'));
    const waits: number[] = [];
    let notifyEnough: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      notifyEnough = resolve;
    });
    const sleepFn = async (ms: number): Promise<void> => {
      waits.push(ms);
      if (waits.length >= 4) notifyEnough();
    };

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      nowFn: nowFnAtExactThreshold(),
    });
    await client.connect(() => undefined);
    await enough;
    await client.close();

    // 1000(1敗目) → 2000(2敗目) → 1000(持続した接続で基準へ戻る) → 1000(3敗目、伸びた列を引き継がない)
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 1000, 1000]);
  });

  it('stderr は初回と間隔が変わったときだけ書き、繋ぎ直せたときは1行書く', async () => {
    // 3敗 → 成功（閾値を超えてからバイトが届く） → 1敗、の順。3敗目は初回・
    // 2回目と違う間隔なのでその都度書き、成功で「繋ぎ直せた」を1行、直後の
    // 敗北は基準(1000)からまた書く。
    //
    // **#274 で成功の定義が変わった（上のテストと同じ理由）。** `'ok'` から
    // `'healthy'` へ変えたのはフィクスチャだけで、保証（初回と間隔が変わった
    // ときだけ書く／繋ぎ直せたら1行書く）そのものは変わっていない。
    const { fetchFn } = fetchEvents((i) => (i < 3 ? 'fail' : i === 3 ? 'healthy' : 'fail'));
    const waits: number[] = [];
    let notifyEnough: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      notifyEnough = resolve;
    });
    const sleepFn = async (ms: number): Promise<void> => {
      waits.push(ms);
      if (waits.length >= 5) notifyEnough();
    };

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      nowFn: nowFnAtExactThreshold(),
    });
    await client.connect(() => undefined);
    await enough;
    await client.close();

    const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const failureLines = lines.filter((line: string) => line.includes('ストリームが切れました'));
    const reconnectLines = lines.filter((line: string) => line.includes('繋ぎ直せた'));

    // 1000, 2000, 4000 は間隔が毎回変わるので書く。成功で列がリセットされた
    // 直後の敗北（4敗目、基準の1000へ戻る）は「新しい列の初回」なのでまた書く
    // — 黙るのは同じ値が続くときだけである。
    expect(failureLines).toHaveLength(4);
    expect(failureLines[0]).toContain('次は1000ms後に再試行');
    expect(failureLines[1]).toContain('次は2000ms後に再試行');
    expect(failureLines[2]).toContain('次は4000ms後に再試行');
    expect(failureLines[3]).toContain('次は1000ms後に再試行');
    // 繋ぎ直せた行は1回だけ。
    expect(reconnectLines).toHaveLength(1);
  });

  it('待ちが変わらない間は stderr を書き直さない（頭打ち後は黙る）', async () => {
    const { fetchFn } = fetchEvents(() => 'fail');
    const waits: number[] = [];
    let notifyEnough: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      notifyEnough = resolve;
    });
    const sleepFn = async (ms: number): Promise<void> => {
      waits.push(ms);
      if (waits.length >= 8) notifyEnough();
    };

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
    });
    await client.connect(() => undefined);
    await enough;
    await client.close();

    const failureLines = stderrSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.includes('ストリームが切れました'));

    // 1000/2000/4000/8000/16000/30000 の6行で止まり、7敗目・8敗目（どちらも
    // 30000）では書かない。
    expect(failureLines).toHaveLength(6);
  });

  it('close() の後は挑み直さない（既存の保証がバックオフでも残る）', async () => {
    const { fetchFn, eventsCalls } = fetchEvents(() => 'fail');
    const clientHolder: { current?: { close(): Promise<void> } } = {};
    const sleepFn = async (): Promise<void> => {
      // 失敗の直後、待っている間にデーモンが閉じたとする。
      await clientHolder.current?.close();
    };

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
    });
    clientHolder.current = client;
    await client.connect(() => undefined);

    // ループが1周し、close() 後にもう一度 /events を叩いていないかを確かめる。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(eventsCalls()).toBe(1);
  });

  /**
   * 「持続した」（#274）の核 —— 時間とバイトの両方が要ることを、それぞれ
   * 単独では効かないことで示す。
   */
  describe('リセットは「閾値を超えてからバイトが届いた」ときだけ効く（#274）', () => {
    it('hello 相当のバイトが接続直後に届いても、リセットされない（閾値未満）', async () => {
      // 接続直後に1バイト届く（runner の `hello` を模す）が、時計を進めない
      // ので閾値には絶対に届かないまま接続が死ぬ、を繰り返す。
      //
      // **この条件（「一度でも出来事が届いたらリセット」）は一度提案され、
      // `hello` が接続直後に無条件で書かれる現物（`apps/runner/src/app.ts`
      // の `for (;;)` ループに入る前の書き込み）を読んで撤回された。** 同じ
      // 道を二度通らないことを、ここで歯にする——前任が捨てた条件と、今回の
      // 条件（時間 + バイト）を分けるのがこのテストの役目である。
      const fetchFn = (async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path === '/health') {
          return Response.json({ runnerId: 'runner-flaky', workspacePath: '/workspace' });
        }
        if (path === '/events') {
          let pulls = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull: (controller) => {
                pulls += 1;
                if (pulls === 1) {
                  // hello 相当のバイト。**中身は問わない** —— #read はフレーム
                  // の中身を見ずに、届いた事実だけを使う。
                  controller.enqueue(new TextEncoder().encode(HEARTBEAT_FRAME));
                  return;
                }
                controller.error(new Error('接続が死んだ'));
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        throw new Error(`想定していない path: ${path}`);
      }) as typeof fetch;

      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 6) notifyEnough();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
        // 時計を進めない —— 経過時間は常に0で、閾値には絶対に届かない。
        nowFn: () => 0,
      });
      await client.connect(() => undefined);
      await enough;
      await client.close();

      // バイトは毎回届いているが、閾値未満なのでリセットされない。通常の
      // 失敗（何も届かない場合）と同じ形で登り続ける——これが doc の意図
      // 「開いてすぐ壊れる相手にもバックオフが効く」を守っている証拠である。
      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines.some((line: string) => line.includes('繋ぎ直せた'))).toBe(false);
    });

    it('バイトが1度も届かないまま閾値を超えて切れても、リセットされない（無音でぶら下がった死んだ接続）', async () => {
      // 'ok': 例外を投げずに、バイトを一切運ばず閉じる接続。nowFn は毎回
      // 大きく進める——「時間だけは閾値を軽々超えたように見える」状況を
      // 作ってもなお、バイトが一度も届かなければリセットされないことを
      // 確かめる。**これが「純粋な経過時間では切らない」の歯である**
      // ——runner の event loop が詰まってソケットだけ開いている場合、
      // バイトは来ないのに接続は undici の bodyTimeout まで生き延びる、
      // という doc の懸念そのものを再現している。
      let clockValue = 0;
      const nowFn = (): number => {
        clockValue += HEALTHY_THRESHOLD_MS * 10;
        return clockValue;
      };
      const { fetchFn } = fetchEvents(() => 'ok');

      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 6) notifyEnough();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
        nowFn,
      });
      await client.connect(() => undefined);
      await enough;
      await client.close();

      // 'ok' は例外を投げないので「切れました」ログは出ない。だがバイトが
      // 一度も届いていないので持続したとはみなされず、待ちは伸び続ける
      // ——基準(1000)へは一度も戻らない。
      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines.some((line: string) => line.includes('繋ぎ直せた'))).toBe(false);
    });
  });

  describe('stderr の cause 付記', () => {
    /**
     * `/events` への `fetch` 自体が例外を投げる形の失敗を組み立てる。
     *
     * `fetchEvents`（この describe の外側にある）は 503 の `Response` を返す
     * 形の失敗しか作れない——これは `#stream` が自分で投げる
     * `new Error(...)`（`cause` を持たない）であって、**Node 22 の素の
     * `fetch`（undici）が streaming 中の切断で投げる `TypeError: terminated`
     * （`cause` 付き）を再現できない。** ここではその形を直接作る。
     */
    function fetchEventsThrowing(causeOf: (callIndex: number) => unknown): {
      fetchFn: typeof fetch;
    } {
      let calls = 0;
      const fetchFn = (async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path === '/health') {
          return Response.json({ runnerId: 'runner-flaky', workspacePath: '/workspace' });
        }
        if (path === '/events') {
          const cause = causeOf(calls);
          calls += 1;
          throw new TypeError('terminated', { cause });
        }
        throw new Error(`想定していない path: ${path}`);
      }) as typeof fetch;
      return { fetchFn };
    }

    /**
     * ちょうど1敗ぶんだけ待たせて、その1回分のログを読む。
     *
     * **`close()` は `sleepFn` の中から呼ぶ**（上の「close() の後は挑み直さ
     * ない」テストと同じ形）。`await enough; await client.close();` のように
     * 外側から呼ぶと、`#pump` のループがもう1周（次の `#stream` 呼び出し）を
     * 始めてから `close()` が効くまでの間にレースが生まれ、2行目が書かれる
     * ことがある。`sleepFn` の中で `close()` を await すると、`#pump` が次の
     * ループへ進む前に `#closed` が立つので、1周しか回らないことが保証できる。
     */
    async function runOnceAndCollectFailureLines(fetchFn: typeof fetch): Promise<string[]> {
      const clientHolder: { current?: { close(): Promise<void> } } = {};
      const sleepFn = async (): Promise<void> => {
        await clientHolder.current?.close();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
      });
      clientHolder.current = client;
      await client.connect(() => undefined);

      // ループが1周し、sleepFn の中の close() が完了するのを待つ
      // （「close() の後は挑み直さない」テストと同じ待ち方）。
      await new Promise((resolve) => setTimeout(resolve, 20));

      return stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((line: string) => line.includes('ストリームが切れました'));
    }

    it('cause を持つ例外で切れたとき、ログ行に cause と code が1行で出る', async () => {
      const socketError = Object.assign(new Error('other side closed'), {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET',
      });
      const { fetchFn } = fetchEventsThrowing(() => socketError);

      const failureLines = await runOnceAndCollectFailureLines(fetchFn);

      expect(failureLines).toHaveLength(1);
      const line = failureLines[0] as string;
      expect(line).toContain('TypeError: terminated');
      expect(line).toContain('cause=SocketError: other side closed');
      expect(line).toContain('code=UND_ERR_SOCKET');
      // 1行に収まる（既存の「間隔で機構を判別する」運用が読める形のまま）。
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd()).not.toContain('\n');
    });

    it('body timeout の cause（別の code）も区別して出る', async () => {
      const bodyTimeout = Object.assign(new Error('Body Timeout Error'), {
        name: 'BodyTimeoutError',
        code: 'UND_ERR_BODY_TIMEOUT',
      });
      const { fetchFn } = fetchEventsThrowing(() => bodyTimeout);

      const failureLines = await runOnceAndCollectFailureLines(fetchFn);

      expect(failureLines).toHaveLength(1);
      expect(failureLines[0]).toContain('cause=BodyTimeoutError: Body Timeout Error');
      expect(failureLines[0]).toContain('code=UND_ERR_BODY_TIMEOUT');
    });

    it('cause が無い例外でも壊れず、従来どおりの行が出る', async () => {
      // 503 応答は #stream 自身が投げる `new Error(...)` で、cause を持たない。
      const { fetchFn } = fetchEvents(() => 'fail');

      const failureLines = await runOnceAndCollectFailureLines(fetchFn);

      expect(failureLines).toHaveLength(1);
      const line = failureLines[0] as string;
      expect(line).toContain('runner の /events に繋げない (503)');
      expect(line).not.toContain('cause=');
      expect(line.trimEnd()).not.toContain('\n');
    });

    it('cause が Error でない値（文字列）でも壊れない', async () => {
      const { fetchFn } = fetchEventsThrowing(() => 'ただの文字列の cause');

      const failureLines = await runOnceAndCollectFailureLines(fetchFn);

      expect(failureLines).toHaveLength(1);
      const line = failureLines[0] as string;
      expect(line).toContain('cause=ただの文字列の cause');
      expect(line).not.toContain('code=');
      expect(line.trimEnd()).not.toContain('\n');
    });

    it('待ち時間が同じでも cause の code が変われば、頭打ち後でもまた書く', async () => {
      // 1〜6敗目は SocketError（待ちは 1000→2000→4000→8000→16000→30000 と
      // 伸びるので、待ちが変わるたびに書く＝既存の間引きの範囲）。7敗目から
      // BodyTimeoutError に切り替わる——待ちは 6敗目と同じ 30000 で頭打ちの
      // ままだが、**cause の code が変わっている**。8敗目は7敗目と同じ
      // BodyTimeoutError なので、そこは従来どおり黙る。
      const socketError = Object.assign(new Error('other side closed'), {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET',
      });
      const bodyTimeout = Object.assign(new Error('Body Timeout Error'), {
        name: 'BodyTimeoutError',
        code: 'UND_ERR_BODY_TIMEOUT',
      });
      const { fetchFn } = fetchEventsThrowing((i) => (i < 6 ? socketError : bodyTimeout));

      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 8) notifyEnough();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
      });
      await client.connect(() => undefined);
      await enough;
      await client.close();

      const failureLines = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((line: string) => line.includes('ストリームが切れました'));

      // 待ちが変わる1〜6敗目で6行、待ちは同じでも cause が切り替わった
      // 7敗目でもう1行、cause も待ちも同じ8敗目では書かない: 計7行。
      expect(failureLines).toHaveLength(7);
      expect(failureLines[5]).toContain('code=UND_ERR_SOCKET');
      expect(failureLines[6]).toContain('code=UND_ERR_BODY_TIMEOUT');
    });
  });
});

/**
 * **解釈できずに捨てたフレームが、跡を残すこと。**
 *
 * ここは2つの形で黙って捨てていた —— `JSON.parse` が投げる（構造が無い）と、
 * `runnerEventSchema.safeParse` が失敗する（構文としては正しい JSON）。
 * とくに後者は、**runner が新しい種類の出来事を出し始めても、届いていないことを
 * 観測できる場所が1つも無い**という形だった。
 *
 * **5本を別々の `it()` で測る。** vitest は最初の失敗で止まるので、同居させると
 * 後ろが一度も走らない。**それぞれが単独で守るものを doc に書く。**
 */
describe('解釈できずに捨てた出来事の跡', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  /**
   * 指定したフレームを流してから閉じるストリームを1回だけ返す。
   *
   * **2回目以降の `/events` は返らないようにする。** `#pump` は正常終了でも
   * 1秒後に張り直すので、放っておくと同じ跡が積み増して件数が読めなくなる
   * （その挙動自体はこの PR の対象ではない）。
   */
  function fetchFramesOnce(frames: string[]): typeof fetch {
    let served = false;
    return (async (input: string | URL | Request) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-noisy', workspacePath: '/workspace' });
      }
      if (path === '/events') {
        if (served) return new Promise<Response>(() => undefined);
        served = true;
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            const encoder = new TextEncoder();
            for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`想定していない path: ${path}`);
    }) as typeof fetch;
  }

  /**
   * `fetchFramesOnce` と同じ形だが、`data: ` で包まない——生のフレームを
   * そのまま `/events` の本文として流す。heartbeat のコメント行
   * （`HEARTBEAT_FRAME` そのもの）を挟みたいテストのためのもので、
   * `data:` を前置きしてしまうと `: hb` が `data: : hb` になり、
   * 実物の runner が出す形と違ってしまう。
   *
   * **2回目以降の `/events` は返らない**（`fetchFramesOnce` と同じ理由）。
   */
  function fetchRawFramesOnce(rawFrames: string[]): typeof fetch {
    let served = false;
    return (async (input: string | URL | Request) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-noisy', workspacePath: '/workspace' });
      }
      if (path === '/events') {
        if (served) return new Promise<Response>(() => undefined);
        served = true;
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            const encoder = new TextEncoder();
            for (const rawFrame of rawFrames) controller.enqueue(encoder.encode(rawFrame));
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`想定していない path: ${path}`);
    }) as typeof fetch;
  }

  async function collectRaw(rawFrames: string[]) {
    const dropped: RunnerDroppedEventReport[] = [];
    const events: unknown[] = [];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchRawFramesOnce(rawFrames),
      sleepFn: async () => undefined,
      onDroppedEvent: (report) => dropped.push(report),
    });
    await client.connect((event) => events.push(event));
    // `collect` と同じ待ち方。捨てたものが在れば `closed` のまとめが来るし、
    // 全部正常なら `onEvent` が呼ばれている。
    await expect
      .poll(() => dropped.some((r) => r.phase === 'closed') || events.length > 0, { timeout: 2000 })
      .toBe(true);
    await client.close();
    return { dropped, events };
  }

  /**
   * **`HEARTBEAT_FRAME` そのものを固定する。** `': hb\n\n'` から変わると、
   * 直下の「heartbeat は跡を残さない」の根拠（`data:` 行を1つも持たない
   * コメント行である、という前提）が黙って崩れる。フレームの形を変えた日に
   * 気づけるよう、値そのものをここでも固定する。
   */
  it('HEARTBEAT_FRAME は ": hb\\n\\n" そのもの', () => {
    expect(HEARTBEAT_FRAME).toBe(': hb\n\n');
  });

  /**
   * **この歯が単独で守るもの**: runner の実物の `#read` を通しても、
   * heartbeat のコメント行が「解釈できずに捨てた」として拾われないこと。
   *
   * `HEARTBEAT_FRAME` は `data:` 行を1つも持たない SSE コメント行なので、
   * `#read` の `data:` フィルタを通すと空文字列になり `if (data.length > 0)`
   * を満たさない——つまり跡そのものが作られない設計である。ここが崩れると、
   * runner が15秒ごとに書く heartbeat の分だけ `dropped` が積み上がり、
   * 本物の「解釈できない出来事」の跡がその中へ埋もれる。
   */
  it('heartbeat のコメント行を挟んでも、跡は残らず hello は届く', async () => {
    const { dropped, events } = await collectRaw([
      HEARTBEAT_FRAME,
      HEARTBEAT_FRAME,
      HEARTBEAT_FRAME,
      'data: {"type":"hello","runnerId":"r1"}\n\n',
    ]);

    expect(events).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  async function collect(frames: string[]) {
    const dropped: RunnerDroppedEventReport[] = [];
    const events: unknown[] = [];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchFramesOnce(frames),
      sleepFn: async () => undefined,
      onDroppedEvent: (report) => dropped.push(report),
    });
    await client.connect((event) => events.push(event));
    // **読み切れたことの合図は2つある。** 捨てたものが在れば閉じるときの
    // まとめが来るし、全部正常なら `onEvent` が呼ばれている。**正常な回は跡が
    // 1件も出ないので、まとめを待つと永久に待つ**（それがこの describe の
    // 「正常なフレームでは跡を出さない」が主張していることそのものである）。
    await expect
      .poll(() => dropped.some((r) => r.phase === 'closed') || events.length > 0, { timeout: 2000 })
      .toBe(true);
    await client.close();
    return { dropped, events };
  }

  /**
   * **この歯が単独で守るもの**: スキーマに合わないフレームが跡を残すこと。
   * これが落ちると、runner が新しい出来事を出し始めても誰も気づけない
   * （この PR の主題そのもの）。
   */
  it('スキーマに合わないフレームは、type つきで跡が出る', async () => {
    const { dropped } = await collect([JSON.stringify({ type: 'brand_new_event', at: 1 })]);

    const first = dropped.find((r) => r.phase === 'first');
    expect(first).toMatchObject({
      phase: 'first',
      reason: 'unknown-shape',
      type: 'brand_new_event',
    });
  });

  /**
   * **この歯が単独で守るもの**: 読めなかった `type` を作らないこと。
   * ここで `'(不明)'` のような値を置くと、それが `type` の1つとして数えられる
   * （AGENTS.md「取れない軸に 0 の行を作らない」）。
   */
  it('JSON にならないフレームでは、type を作らない', async () => {
    const { dropped } = await collect(['{壊れている']);

    const first = dropped.find((r) => r.phase === 'first');
    expect(first).toMatchObject({ phase: 'first', reason: 'unparsable' });
    expect(first && 'type' in first ? first.type : undefined).toBeUndefined();
    expect(first?.phase === 'first' ? first.bytes : 0).toBeGreaterThan(0);
  });

  /**
   * **この歯が単独で守るもの**: 正常なフレームで跡を出さないこと。
   *
   * これが無いと「常に跡を出す」実装が緑になる。**そして常時出る跡は、跡を
   * 無意味にする**（読む人が読まなくなる）。両方向を測るための1本である。
   */
  it('正常なフレームでは跡を出さない', async () => {
    const { dropped, events } = await collect([JSON.stringify({ type: 'hello', runnerId: 'r1' })]);

    expect(events).toHaveLength(1);
    expect(dropped.filter((r) => r.phase === 'first')).toHaveLength(0);
    // 閉じるときのまとめも出ない（数える対象が1件も無いので）。
    expect(dropped).toHaveLength(0);
  });

  /**
   * **この歯が単独で守るもの**: 同じ `type` を2度以上出さないこと。
   * これが落ちると、壊れたストリームが跡でログを埋める。
   */
  it('同じ type は初出だけ。2件目以降は数えるだけ', async () => {
    const frame = JSON.stringify({ type: 'brand_new_event' });
    const { dropped } = await collect([frame, frame, frame]);

    expect(dropped.filter((r) => r.phase === 'first')).toHaveLength(1);
  });

  /**
   * **この歯が単独で守るもの**: 量が閉じるときに出ること。
   * 初出だけだと「1件だったのか100件だったのか」が永久に分からない。
   */
  it('接続を閉じるときに、種別ごとの件数が出る', async () => {
    const frame = JSON.stringify({ type: 'brand_new_event' });
    const { dropped } = await collect([frame, frame, '{壊れている']);

    const closed = dropped.find((r) => r.phase === 'closed');
    expect(closed?.phase === 'closed' ? closed.dropped : []).toEqual(
      expect.arrayContaining([
        { key: 'unknown-shape:brand_new_event', count: 2 },
        { key: 'unparsable', count: 1 },
      ]),
    );
  });
});
