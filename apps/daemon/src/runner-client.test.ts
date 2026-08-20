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
  type ManagerPool,
  type InboxEvent,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { createHttpRunner } from './runner-client.js';

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
      .toEqual({ kind: 'runner-volume', runnerId: 'runner-primary', path: '/workspace' });
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
