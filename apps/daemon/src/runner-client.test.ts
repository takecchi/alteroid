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

  /**
   * **#322: decision を省略した回答は、境界の先（runner.ts）が推論した
   * decision（`inferDecision`）が journal まで戻ること。** 直上のテストは
   * `decision: 'allow'` を明示しており、それは修正前の実装でも
   * （クローンが渡した値をそのまま書くだけだったので）`[allow]` になっていた
   * ——境界越しに確定値が正しく運ばれることの証明にはならない。ここでは
   * **decision を渡さず**、SDK へ実際に返った behavior と journal の両方を
   * 見る。
   */
  it('decision を明示しない回答でも、確定した allow/deny が境界越しに journal へ残る（#322）', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: 'デプロイして' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    const asked = (r.sessions[0] as FakeSession).ask('Bash', 'req-2');
    await expect
      .poll(() => r.inbox.filter((event) => event.type === 'manager_message').length, {
        timeout: 2000,
      })
      .toBe(1);

    // **decision は付けない** — 測るのは runner.ts 側の推論が journal まで
    // 戻ることである。
    const result = await r.pool.send(managerId, 'よい、そのまま進めて', { requestId: 'req-2' });
    expect(result.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });

    const escalations = (await r.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations.map((entry) => entry.answer)).toEqual([
      '[allow] よい、そのまま進めて',
      undefined,
    ]);
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
 * **旧 runner への問い合わせ（版のずれ。`railway/README.md`「4. 落ちた側を
 * 待つ / 取り直す」）が `list()` から要素を消さないこと。**
 *
 * runner とデーモンは別の Railway Service で、別々にデプロイされる。
 * `drainingSeconds` の猶予中、畳まれつつある旧 runner は `/health` にも
 * `/managers` にも答え続け、起動時の引き取りがそれを見て「生きている」と
 * 判断した直後に SSE が新しい器へ繋がる、という順序が普通に起きる。**その窓
 * の `/managers` 応答には `kind` も `askedAt` も乗らない**（この2つを足す前の
 * runner の応答そのもの）。
 *
 * `kind`/`askedAt` を必須のままにすると、`runnerManagerStateSchema.safeParse`
 * がこの形を「読めない」と判定し、`list()` は `flatMap` で要素ごと黙って
 * 捨てる（跡が残らない）。すると `manager.ts` の `alive.has(job.id)` が偽に
 * なり、`record.waiting = []` で待っていた確認まで捨てられ、**返事待ちの
 * マネージャーだけ**が起こし直される——#334 が足した `kind`/`askedAt` 自身が
 * 作りかけていた退行である。
 */
describe('旧 runner への問い合わせ（kind / askedAt を持たない /managers 応答）', () => {
  /** `/health` には普通に答え、`/managers` だけ旧い形で返す偽 runner。 */
  function fetchLegacyManagers(): typeof fetch {
    return (async (input: string | URL | Request) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-legacy', workspacePath: '/workspace' });
      }
      if (path === '/managers') {
        return Response.json({
          managers: [
            {
              managerId: 'mgr-legacy',
              status: 'waiting_human',
              cwd: '/workspace/mgr-legacy',
              request: '古い runner からの引き継ぎ',
              // **`kind` も `askedAt` も無い** — `drainingSeconds` の猶予中の
              // 旧 runner の応答そのもの（この2つを足す前の版）。
              waiting: [{ requestId: 'req-legacy', summary: '許可してよいか' }],
            },
          ],
        });
      }
      throw new Error(`このテストの偽 runner が想定していないパス: ${path}`);
    }) as typeof fetch;
  }

  it('kind / askedAt を持たない waiting も list() から捨てられない', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://legacy.test',
      token: TOKEN,
      fetchFn: fetchLegacyManagers(),
    });

    const managers = await client.list();

    // **本題はここ。** `safeParse` が落ちて `flatMap` で要素ごと消えていたら
    // ここが空配列になる（跡も残らない）。
    expect(managers).toHaveLength(1);
    const manager = managers.find((m) => m.managerId === 'mgr-legacy');
    expect(manager?.waiting).toHaveLength(1);
    expect(manager?.waiting[0]?.requestId).toBe('req-legacy');
    expect(manager?.waiting[0]?.summary).toBe('許可してよいか');
    // **欠けた2つを、デーモン側の既定値で埋めていないこと。** `askedAt` を
    // 「取れなければいま」で埋めると、値の意味が経路によって変わる
    // （`AGENTS.md`「取れない軸に0の行を作る」）。
    expect(manager?.waiting[0]?.kind).toBeUndefined();
    expect(manager?.waiting[0]?.askedAt).toBeUndefined();
  });

  it('kind / askedAt を持つ通常の waiting は今までどおり値ごと届く（回帰なし）', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-current', workspacePath: '/workspace' });
      }
      if (path === '/managers') {
        return Response.json({
          managers: [
            {
              managerId: 'mgr-current',
              status: 'waiting_human',
              cwd: '/workspace/mgr-current',
              request: 'いまの runner からの引き継ぎ',
              waiting: [
                {
                  requestId: 'req-current',
                  summary: '許可してよいか',
                  kind: 'permission',
                  askedAt: '2026-08-24T00:00:00.000Z',
                },
              ],
            },
          ],
        });
      }
      throw new Error(`このテストの偽 runner が想定していないパス: ${path}`);
    }) as typeof fetch;

    const client = await createHttpRunner({
      baseUrl: 'http://current.test',
      token: TOKEN,
      fetchFn,
    });

    const managers = await client.list();
    const manager = managers.find((m) => m.managerId === 'mgr-current');
    expect(manager?.waiting[0]?.kind).toBe('permission');
    expect(manager?.waiting[0]?.askedAt).toBe('2026-08-24T00:00:00.000Z');
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

  /**
   * **直上の歯は、`resources` の *外側* しか測っていなかった。**
   *
   * `resources` の中身が `cpu` ひとつだけなので、「まとめて弾く」実装でも
   * 「1つずつ検証する」実装でも同じ `{ managers: 2 }` になる ——
   * **どちらでも通るので、名前が約束している「読めた材料は落とさない」を
   * 測れていない。** ここでは壊れた材料の隣に**読める材料を並べて**、
   * 道連れが起きないことを単独で撃つ。
   */
  it('資源の中で1つの材料だけが壊れていても、残りの材料は落とさない', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://partial.test',
      token: TOKEN,
      fetchFn: fetchHealth({
        ok: true,
        runnerId: 'runner-partial',
        workspacePath: '/workspace',
        managers: 2,
        resources: {
          cpu: { cores: 'たくさん' },
          memory: { limitBytes: 1_000, usedBytes: 100, source: 'cgroup' },
          pids: { current: 955, max: 1000 },
        },
      }),
    });

    expect(await client.resources?.()).toEqual({
      managers: 2,
      memory: { limitBytes: 1_000, usedBytes: 100, source: 'cgroup' },
      pids: { current: 955, max: 1000 },
    });
  });

  /**
   * **材料が増えるたびに、道連れの面も増える。**
   *
   * `tasks`（器の pids の内訳。#315）を足したとき、`resources` はまだ丸ごと
   * 1回 `safeParse` していた ⟹ **`tasks` の形が崩れただけで `cpu` / `memory` /
   * `pids` まで消えた。** 内訳を出せる器が「資源を1つも報告しない器」に見える。
   *
   * この歯は**いちばん新しい材料の側から**撃つ ——「1つずつ検証する」が
   * 材料を数え上げずスキーマの `shape` を回している限り、次に足される材料でも
   * 同じ性質が保たれる。
   */
  it('内訳（tasks）の形が壊れていても、cpu / memory / pids は落とさない', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://broken-tasks.test',
      token: TOKEN,
      fetchFn: fetchHealth({
        ok: true,
        runnerId: 'runner-broken-tasks',
        workspacePath: '/workspace',
        managers: 1,
        resources: {
          cpu: { cores: 4, source: 'cgroup' },
          memory: { limitBytes: 2_000, usedBytes: 500, source: 'cgroup' },
          pids: { current: 178, max: 1000 },
          // `zombies` が数でない ＝ 内訳だけが壊れている runner。
          tasks: { threads: 178, processes: 136, zombies: 'たくさん' },
        },
      }),
    });

    expect(await client.resources?.()).toEqual({
      managers: 1,
      cpu: { cores: 4, source: 'cgroup' },
      memory: { limitBytes: 2_000, usedBytes: 500, source: 'cgroup' },
      pids: { current: 178, max: 1000 },
    });
  });

  /** `resources` がオブジェクトですらない応答でも、他の材料まで道連れにしない。 */
  it('resources がオブジェクトでなくても、managers は落とさない', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://not-object.test',
      token: TOKEN,
      fetchFn: fetchHealth({
        ok: true,
        runnerId: 'runner-not-object',
        workspacePath: '/workspace',
        managers: 4,
        resources: 'たくさん',
      }),
    });

    expect(await client.resources?.()).toEqual({ managers: 4 });
  });

  /**
   * `pendingEvents` / `oldestPendingAt`（#358）が `/health` から `resources()`
   * まで渡ること。**この欄が `HealthBody` に無かったせいで、runner が正しい値を
   * 返しても読まれずに落ちていた**（Issue #358 の訂正の下流側）。
   *
   * 本物の `Outbox` と `createRunnerApp` を通す——`managers` と同じく、
   * ここも実際の境界を越えさせないと「渡ることの証明」にならない
   * （直上の「runner の /health が資源を名乗り、デーモンがそれを採る」と同じ理由）。
   */
  it('runner の /health が pendingEvents/oldestPendingAt を名乗り、デーモンがそれを採る', async () => {
    const outbox = new Outbox();
    // listener を付けない（＝デーモンが繋いでいない状態）ので `Outbox.#queue`
    // にそのまま溜まる——`resources()` を呼ぶだけなら `/events` を開く必要は無い。
    outbox.push({ type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' });
    outbox.push({ type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' });
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

    expect(resources?.pendingEvents).toBe(2);
    expect(typeof resources?.oldestPendingAt).toBe('string');

    await host.shutdown();
  });

  /**
   * `pendingEvents` は0件でも「測れる値」なのでそのまま0が渡る（`managers` と
   * 同じ扱い）。**`oldestPendingAt` だけが違う**——0件のときは「いちばん古い
   * もの」自体が存在しないので、欄ごと出ない（`runnerPlacementResourcesSchema`
   * の doc）。ここを混同すると「0の行を作らない」を pendingEvents にも
   * 誤って当ててしまう（実際に一度、この取り違えでこのテスト自身が壊れた）。
   */
  it('未送出が0件のとき、pendingEvents は0のまま渡り oldestPendingAt だけ出ない', async () => {
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

    expect(resources?.pendingEvents).toBe(0);
    expect(resources).not.toHaveProperty('oldestPendingAt');

    await host.shutdown();
  });

  it('pendingEvents/oldestPendingAt を返さない古い runner からも他の材料は渡る（締め出さない）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://legacy.test',
      token: TOKEN,
      fetchFn: fetchHealth({
        ok: true,
        runnerId: 'runner-legacy',
        workspacePath: '/workspace',
        managers: 3,
        // pendingEvents / oldestPendingAt を欄ごと持たない（この機能より前の runner）。
      }),
    });

    expect(await client.resources?.()).toEqual({ managers: 3 });
  });

  it('pendingEvents の形が壊れていても、他の材料は落とさない（managers と同じ扱い）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://broken.test',
      token: TOKEN,
      fetchFn: fetchHealth({
        ok: true,
        runnerId: 'runner-broken',
        workspacePath: '/workspace',
        managers: 2,
        pendingEvents: 'たくさん',
        oldestPendingAt: 'ちょっと前',
      }),
    });

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
 * `POST /managers/:id/answers` の応答から `decision` を読む口（#322）。
 *
 * **`資源による配置の材料` と同じ形の罠がここにもある。** ローリング再デプロイの
 * 窓では、まだこの変更前の runner が `{ ok: true }` だけを返す——`decision` は
 * 欄そのものが無い。ここでは実際の runner を経由せず、`fetchFn` で応答を
 * 直接組み立てて確かめる（`資源による配置の材料` の `fetchHealth` と同じ作法）。
 */
describe('許可確認の回答の応答から decision を読む', () => {
  it('decision を報告しない古い runner の応答でも、届いたことは分かる（既定値へは倒さない）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://legacy.test',
      token: TOKEN,
      fetchFn: (async () => Response.json({ ok: true })) as typeof fetch,
    });

    const outcome = await client.answer('mgr-x', {
      requestId: 'req-x',
      message: 'よい',
      decision: 'allow',
    });

    // **`decision` キー自体が無いことを見る。** `outcome.decision` を
    // `undefined` と比べるだけでは「キーが無い」のか「値が undefined」のかを
    // 区別できない——`toEqual` はキーの有無まで見るので、既定値（`?? 'allow'`
    // など）へ倒す変異が入ればここで落ちる。
    expect(outcome).toEqual({ delivered: true });
  });

  it('decision を報告する runner の応答からは、その値がそのまま渡る', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: (async () => Response.json({ ok: true, decision: 'deny' })) as typeof fetch,
    });

    const outcome = await client.answer('mgr-x', { requestId: 'req-x', message: 'だめ' });

    expect(outcome).toEqual({ delivered: true, decision: 'deny' });
  });

  it('宛先が見つからない（ok: false）ときは decision を持たない', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: (async () => Response.json({ ok: false })) as typeof fetch,
    });

    const outcome = await client.answer('mgr-x', { requestId: 'req-gone', message: 'よい' });

    expect(outcome).toEqual({ delivered: false });
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

  /**
   * `pendingEvents` / `oldestPendingAt`（#358 案b の第2段）が `/health` から
   * `identity()` まで渡ること。**`resources()` の同名の歯（`資源による配置の
   * 材料` の「runner の /health が pendingEvents/oldestPendingAt を名乗り、
   * デーモンがそれを採る」）と同じ理由で、本物の `Outbox` と
   * `createRunnerApp` を通す**——狙いは「10秒ごとの heartbeat（`identity()`）
   * からも同じ2欄が読める」ことの証明で、境界を越えさせないと証明にならない。
   */
  it('runner の /health が pendingEvents/oldestPendingAt を名乗り、identity() がそれを採る', async () => {
    const outbox = new Outbox();
    outbox.push({ type: 'session', managerId: 'mgr-1', sessionId: 'sess-1' });
    outbox.push({ type: 'session', managerId: 'mgr-2', sessionId: 'sess-2' });
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

    expect(identity?.pendingEvents).toBe(2);
    expect(typeof identity?.oldestPendingAt).toBe('string');

    await host.shutdown();
  });

  /**
   * 締め出さない側の歯——`pendingEvents` / `oldestPendingAt` を返さない
   * 古い runner でも、`identity()` の他の材料（`runnerId` / `instanceId` /
   * `revision`）は今まで通り渡る（`resources()` 側の「他の材料は渡る」歯と
   * 同じ形。`:877` 付近）。
   */
  it('pendingEvents/oldestPendingAt を返さない古い runner からも他の材料は渡る（締め出さない）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://legacy.test',
      token: TOKEN,
      fetchFn: (async () =>
        Response.json({
          ok: true,
          runnerId: 'runner-legacy',
          instanceId: 'boot-legacy',
          workspacePath: '/workspace',
          // pendingEvents / oldestPendingAt を欄ごと持たない（この機能より前の runner）。
        })) as typeof fetch,
    });
    cleanups.push(() => client.close());

    const identity = await client.identity?.();

    expect(identity?.runnerId).toBe('runner-legacy');
    expect(identity?.instanceId).toBe('boot-legacy');
    expect(identity).not.toHaveProperty('pendingEvents');
    expect(identity).not.toHaveProperty('oldestPendingAt');
  });

  /**
   * `pendingEvents` の形が壊れていても、他の材料は落とさない
   * （`resources()` 側の同名の歯 `:893` 付近と同じ形——1つずつ検証する
   * ことの証拠）。
   */
  it('pendingEvents の形が壊れていても、他の材料は落とさない（identity() でも managers と同じ扱い）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://broken.test',
      token: TOKEN,
      fetchFn: (async () =>
        Response.json({
          ok: true,
          runnerId: 'runner-broken',
          instanceId: 'boot-broken',
          workspacePath: '/workspace',
          pendingEvents: 'たくさん',
          oldestPendingAt: 'ちょっと前',
        })) as typeof fetch,
    });
    cleanups.push(() => client.close());

    const identity = await client.identity?.();

    expect(identity?.runnerId).toBe('runner-broken');
    expect(identity?.instanceId).toBe('boot-broken');
    expect(identity).not.toHaveProperty('pendingEvents');
    expect(identity).not.toHaveProperty('oldestPendingAt');
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
  // **常に stderr / stdout を黙らせる。** 内容を見る必要がないテストでも実際の
  // 出力へ書かれるのはノイズなので、この describe の全テストで抑える
  // （`stdout` を黙らせないと `vitest.setup.ts` の歯（#314）が「繋ぎ直せた」を
  // stdout へ書くテストを落とす）。内容を見るテストは `stderrSpy` /
  // `stdoutSpy` を直接読む。
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
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

  it('stderr は初回と間隔が変わったときだけ書き、繋ぎ直せたときは stdout に1行書く（切断の行は stdout に漏れない）', async () => {
    // 3敗 → 成功（閾値を超えてからバイトが届く） → 1敗、の順。3敗目は初回・
    // 2回目と違う間隔なのでその都度書き、成功で「繋ぎ直せた」を1行、直後の
    // 敗北は基準(1000)からまた書く。
    //
    // **#274 で成功の定義が変わった（上のテストと同じ理由）。** `'ok'` から
    // `'healthy'` へ変えたのはフィクスチャだけで、保証（初回と間隔が変わった
    // ときだけ書く／繋ぎ直せたら1行書く）そのものは変わっていない。
    //
    // **#420 で「繋ぎ直せた」の宛先が stderr から stdout へ移った。** 正常
    // （回復）は stdout・異常（切断）は stderr という既に確定した割り当てへの
    // 当てはめ（`tokenRotationStream` の doc、`#pump` の doc参照）。ここでは
    // 「回復が stdout に出ること」と「正常系を移した拍子に切断の行まで stdout
    // へ漏れていないこと」を同じテストで確かめる。
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

    const stderrLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const stdoutLines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const failureLines = stderrLines.filter((line: string) =>
      line.includes('ストリームが切れました'),
    );
    const reconnectLines = stdoutLines.filter((line: string) => line.includes('繋ぎ直せた'));

    // 1000, 2000, 4000 は間隔が毎回変わるので書く。成功で列がリセットされた
    // 直後の敗北（4敗目、基準の1000へ戻る）は「新しい列の初回」なのでまた書く
    // — 黙るのは同じ値が続くときだけである。**切断の行は stderr のまま。**
    expect(failureLines).toHaveLength(4);
    expect(failureLines[0]).toContain('次は1000ms後に再試行');
    expect(failureLines[1]).toContain('次は2000ms後に再試行');
    expect(failureLines[2]).toContain('次は4000ms後に再試行');
    expect(failureLines[3]).toContain('次は1000ms後に再試行');
    // 繋ぎ直せた行は stdout に1回だけ出る。
    expect(reconnectLines).toHaveLength(1);
    // **正常系を移した拍子に、異常系まで stdout へ流れていないか。** 切断の
    // 行が stdout に1件も出ていないことを同じ回で確かめる。
    expect(stdoutLines.some((line: string) => line.includes('ストリームが切れました'))).toBe(false);
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

    it('繋ぎ直せた は、接続が生きたままの間に出る（接続が終わるのを待たない）', async () => {
      // **この歯が守るのは「時点」である。** 上の2本（hello直後／無音）は
      // 「出ないこと」を測っているが、こちらは「出るタイミング」を測る——
      // 接続を手で操作できるストリームにして、閉じずにバイトだけを流し、
      // その時点で既に stdout へ書かれていることを確認する（#420 で宛先が
      // stderr から stdout へ移った）。
      //
      // **接続を閉じてから確認する形にしないこと。** 閉じてから確認すると、
      // 「`#stream()` が終わった後に書く」実装でも「健全と判定した瞬間に
      // 書く」実装でも同じ結果になり、この2つを区別できない
      // （このテストが守りたい性質そのものが見えなくなる）。
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let eventsCalls = 0;
      const fetchFn = (async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path === '/health') {
          return Response.json({ runnerId: 'runner-flaky', workspacePath: '/workspace' });
        }
        if (path === '/events') {
          eventsCalls += 1;
          if (eventsCalls === 1) return new Response(null, { status: 503 }); // 1敗目
          // 2本目の接続: 手で操作できるストリーム（閉じない限り生き続ける）。
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controllerRef = controller;
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        throw new Error(`想定していない path: ${path}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn: async () => undefined, // 1敗目の待ちを即座に消費し、2本目へ進む
        nowFn: nowFnAtExactThreshold(),
      });
      await client.connect(() => undefined);

      // 1敗目のログが出て、2本目の接続（手で操作できるストリーム）が
      // 開かれるのを待つ。
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(controllerRef).toBeDefined();
      expect(
        stdoutSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes('繋ぎ直せた')),
      ).toBe(false);

      // 閾値ちょうどでバイトを1つ流す。接続はまだ閉じていない
      // （`controllerRef.close()` を呼んでいない）。
      controllerRef?.enqueue(new TextEncoder().encode(HEARTBEAT_FRAME));
      await new Promise((resolve) => setTimeout(resolve, 20));

      // **接続がまだ生きている時点で、既に書かれている。**
      const lines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines.filter((line: string) => line.includes('繋ぎ直せた'))).toHaveLength(1);

      // 後始末: ストリームを閉じてからクライアントも閉じる。
      controllerRef?.close();
      await client.close();
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

    it('UND_ERR_BODY_TIMEOUT で頭打ち（30000ms）まで伸びた後、healthy へ回復すると「繋ぎ直せた」が出て基準へ戻る（#308）', async () => {
      // **`#lastLoggedDelayMs` の doc（#308）が名指す穴。** 「待ち幅が頭打ちへ
      // 張り付いたまま失敗し続ける区間では、同じ間隔で切れ続ける沈黙と
      // 『直った』（繋ぎ直せたの行）が、ログの不在だけでは見分けが付かない」
      // という懸念が書かれていたが、**頭打ちに達した後に実際に healthy へ
      // 回復させて「繋ぎ直せた」が出るかは、一度も測っていなかった。**
      //
      // callIndex 0〜5 を UND_ERR_BODY_TIMEOUT で失敗させる（待ちが
      // 1000→2000→4000→8000→16000→30000 と伸びて頭打ちになる）。6回目
      // （callIndex 6）だけ healthy（閾値を超えてからバイトが届く）へ切り替える。
      const bodyTimeout = Object.assign(new Error('Body Timeout Error'), {
        name: 'BodyTimeoutError',
        code: 'UND_ERR_BODY_TIMEOUT',
      });

      let calls = 0;
      const fetchFn = (async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path === '/health') {
          return Response.json({ runnerId: 'runner-flaky', workspacePath: '/workspace' });
        }
        if (path === '/events') {
          const index = calls;
          calls += 1;
          if (index < 6) throw new TypeError('terminated', { cause: bodyTimeout });
          // 7回目（index === 6）。閾値を超えてからバイトが届く「持続した」接続。
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
        throw new Error(`想定していない path: ${path}`);
      }) as typeof fetch;

      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        // 6敗目（頭打ちの30000ms）まで6回、回復した7周目の後にもう1回
        // （基準へ戻った待ち）——計7回で止める。
        if (waits.length >= 7) notifyEnough();
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

      const stderrLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const stdoutLines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const failureLines = stderrLines.filter((line: string) =>
        line.includes('ストリームが切れました'),
      );
      // **#420 で宛先が stderr から stdout へ移った。**
      const reconnectLines = stdoutLines.filter((line: string) => line.includes('繋ぎ直せた'));

      // 1〜6敗目は待ちが毎回変わる（1000→2000→4000→8000→16000→30000）ので
      // 6行とも書く。cause の code（UND_ERR_BODY_TIMEOUT）も毎回付く。
      expect(failureLines).toHaveLength(6);
      for (const line of failureLines) {
        expect(line).toContain('code=UND_ERR_BODY_TIMEOUT');
      }
      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);

      // **本題1: 頭打ちから回復した時点で「繋ぎ直せた」がちょうど1回出る。**
      // 「切れ続ける沈黙」と「直った」が見分けられない、という #308 の懸念が
      // 実際には塞がっていることを、ここで初めて測る。
      expect(reconnectLines).toHaveLength(1);

      // **本題2: 回復直後の待ちは基準値（1000ms）へ戻る。** 頭打ち（30000）を
      // 引き継いでいれば、7回目の待ちも 30000 のままになる。
      expect(waits[6]).toBe(1000);
    });
  });

  /**
   * **#308 が名指した穴そのもの。** `#pump` の1周は `failed` / `healthy` の
   * 組で3通りに終わる——「失敗（例外）」と「持続した」はそれぞれ「切れました」
   * 「繋ぎ直せた」を書いてきたが、**「閾値未満で、例外も投げずに静かに閉じた」
   * だけはどちらの枝にも入らず、1行も書かれなかった。** 実測（このファイルを
   * 直す前に取った生カウント）は `lines.length === 0` だった——`waits` は
   * 通常の失敗と同じに 1000→…→30000 と伸びるのに、stderr からはそれを
   * 一切追えなかった。
   */
  describe('静かに閉じた接続にも stderr が出る（#308）', () => {
    it('静かに閉じ続けると、頭打ちへ張り付くまでの間隔ごとに書き、以後は黙る', async () => {
      const { fetchFn } = fetchEvents(() => 'ok');
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

      // バックオフの伸び方そのものは変えていない——既存の歯（1577行付近）と
      // 同じ列。
      expect(waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);

      const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const quietLines = lines.filter((line: string) => line.includes('持続しないまま終わった'));

      // 直す前は0行だった（測定Bの実測）。いまは失敗経路と同じ形（初回と
      // 間隔が変わったときだけ）で6行出て、頭打ち（30000）の後は黙る。
      expect(quietLines).toHaveLength(6);
      expect(quietLines[0]).toContain('次は1000ms後に再試行');
      expect(quietLines[5]).toContain('次は30000ms後に再試行');
      // 「切れました」は例外の言い回しなので使わない。「繋ぎ直せた」も
      // healthy になっていないので出ない。
      expect(lines.some((line: string) => line.includes('ストリームが切れました'))).toBe(false);
      expect(lines.some((line: string) => line.includes('繋ぎ直せた'))).toBe(false);
    });

    it('静かに閉じた経路と失敗経路の dedup は互いを消し合わない', async () => {
      // 6敗（1000→…→30000、頭打ち）→ 静かに閉じる（30000のまま）→ 敗
      // （30000のまま）→ 静かに閉じる（30000のまま）、の順。頭打ちに達した
      // 後、経路が交互に入れ替わっても、それぞれの dedup が自分の直前の値
      // としか比べないことを確かめる——同じフィールドを共有していれば、
      // 静かな1行が挟まるだけで直後の敗北がまた書いてしまったり、逆に
      // 静かな行の2回目以降が黙らなかったりする。
      const { fetchFn } = fetchEvents((i) => {
        if (i < 6) return 'fail';
        if (i === 6) return 'ok';
        if (i === 7) return 'fail';
        return 'ok';
      });
      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 9) notifyEnough();
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

      expect(waits.slice(0, 9)).toEqual([
        1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000,
      ]);

      const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const failureLines = lines.filter((line: string) => line.includes('ストリームが切れました'));
      const quietLines = lines.filter((line: string) => line.includes('持続しないまま終わった'));

      // 6敗目までは間隔が毎回変わるので6行。7敗目（index=7、頭打ちのまま・
      // cause も同じ）は、間に静かな1行（index=6）が挟まっても黙る——
      // 静かな行がこの dedup を乱していない証拠。
      expect(failureLines).toHaveLength(6);
      // 静かな行は index=6 で1回。index=8 は同じ待ち幅(30000)のままなので、
      // 間に敗（index=7）が挟まっても静かな側の dedup は自分の直前の値
      // （30000）としか比べず、黙る——合わせて1行。
      expect(quietLines).toHaveLength(1);
      expect(quietLines[0]).toContain('次は30000ms後に再試行');
      for (const line of [...failureLines, ...quietLines]) {
        expect(line).not.toContain('繋ぎ直せた');
      }
    });

    it('静かに閉じ続けて頭打ちへ張り付いた後、healthy へ回復すると「繋ぎ直せた」が出る（出の端）', async () => {
      // **入りの端（上の2本）だけでは #308 は半分しか塞がっていない。** 静かに
      // 閉じ続けるだけでバックオフに入り、そこから実際に healthy へ回復した
      // ときに「繋ぎ直せた」が出なければ、「切れ続ける沈黙」と「直った」を
      // 見分けさせないという穴が、失敗経路から静かな経路へ移っただけになる。
      // ここでその出の端を測る——`UND_ERR_BODY_TIMEOUT で頭打ち…` テスト
      // （上の describe）と同じ形だが、ラウンドを埋めるのが例外ではなく
      // 静かな終わり（'ok'）である点だけが違う。
      const { fetchFn } = fetchEvents((i) => (i < 6 ? 'ok' : 'healthy'));

      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        // 6回（静かに閉じて頭打ちへ張り付く）+ 回復直後の1回 = 7回で止める。
        if (waits.length >= 7) notifyEnough();
      };

      // **`nowFnAtExactThreshold()` はそのまま使えない。** あれは「1回目の
      // 呼び出し（唯一の接続の connectedAt）は0、以降は閾値」という前提の
      // 足場だが、ここでは 'ok'（静かに閉じる）接続も `connectedAt` を測る
      // ために `#nowFn` を1回ずつ消費する（バイトが来ないので `onBytes` 側は
      // 呼ばれない）。6本の 'ok' がその6回ぶんを先に使うので、7本目
      // （'healthy'）の `connectedAt`（7回目の呼び出し）が0、その直後の
      // `onBytes`（8回目の呼び出し）が閾値になるよう、呼び出し回数を直に
      // 数える専用の `nowFn` を使う。
      let nowCalls = 0;
      const nowFn = (): number => {
        const value = nowCalls === 7 ? HEALTHY_THRESHOLD_MS : 0;
        nowCalls += 1;
        return value;
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

      // **入りの端は stderr、出の端は stdout。** 静かな閉じは「開いてすぐ
      // 壊れる相手」＝異常なので stderr、回復は正常なので stdout ——
      // `tokenRotationStream` の doc が確定させた「正常は stdout・異常は
      // stderr」の割り当て（#420 / #551）にそのまま従う。**この2本を別々の
      // ストリームから読むこと自体が歯である。**
      const stderrLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const stdoutLines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const quietLines = stderrLines.filter((line: string) =>
        line.includes('持続しないまま終わった'),
      );
      const reconnectLines = stdoutLines.filter((line: string) => line.includes('繋ぎ直せた'));

      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      expect(quietLines).toHaveLength(6);

      // **本題: 静かに閉じ続けただけの区間から回復しても、「繋ぎ直せた」が
      // ちょうど1回出る。** 直す前はここが `#backingOff` が一度も立たない
      // ため永久に出なかった。
      expect(reconnectLines).toHaveLength(1);

      // **異常（静かな閉じ）を stdout へ漏らしていないか。** #551 が切断の行
      // に同じ形の歯を立てているので、足した行にも同じものを当てる ——
      // 正常系の宛先を変えた拍子に異常系が付いていく事故は、片側だけ見て
      // いると通ってしまう。
      expect(stdoutLines.some((line: string) => line.includes('持続しないまま終わった'))).toBe(
        false,
      );

      // 回復直後の待ちは基準値（1000ms）へ戻る——バックオフの計算そのもの
      // (`#nextDelayMs`) は変えていないことの確認。
      expect(waits[6]).toBe(1000);
    });
  });

  /**
   * **本番には runner が複数台あり、それぞれ独立した stream と独立した backoff
   * 状態を持つ（#274 issue コメント、2026-08-23T09:03:36Z）。** ところが
   * 「切れました」「繋ぎ直せた」の2行は runner を名乗らないので、`16000ms →
   * 4000ms` のような待ちの下降が「1台でリセットが起きた証拠」か「単に別の台の
   * 行」かが、ログからは判定できない——この PR（#309）が守る契約（接続が
   * 持続してからリセットする）は runner ごとに成立する条件なので、ログも
   * runner ごとに読めなければ本番で検証できない。ここではその識別子が
   * 実際に2行へ出ることと、**取れていないのに取れた顔をして出ない**ことを
   * 別々の歯で確かめる。
   */
  describe('ログの宛先識別子（#274 issue コメント）', () => {
    /**
     * `/health` の応答本文だけを差し替えられる `fetchEvents` の変種。
     *
     * **本体の `fetchEvents`（このファイルの上のほう）は変えない**——
     * `runnerId: 'runner-flaky'` を前提にした既存の歯がある。ここで見たいのは
     * `/health` が `runnerId` を返す／返さないの差だけなので、専用の
     * ヘルパーをこの describe に閉じて置く。
     */
    function fetchEventsWithHealth(
      healthBody: Record<string, unknown>,
      outcome: (callIndex: number) => 'fail' | 'ok' | 'healthy',
    ): { fetchFn: typeof fetch } {
      let calls = 0;
      const fetchFn = (async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path === '/health') {
          return Response.json(healthBody);
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
          return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`想定していない path: ${path}`);
      }) as typeof fetch;
      return { fetchFn };
    }

    /** 1敗目→成功（閾値超えでバイト到着）→2敗目、の順で「切れました」1行と「繋ぎ直せた」1行を作る。 */
    async function runFailThenHealthyThenFail(
      fetchFn: typeof fetch,
    ): Promise<{ failureLines: string[]; reconnectLines: string[] }> {
      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 3) notifyEnough();
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

      const stderrLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      // **#420 で「繋ぎ直せた」の宛先が stderr から stdout へ移った。**
      const stdoutLines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      return {
        failureLines: stderrLines.filter((line: string) => line.includes('ストリームが切れました')),
        reconnectLines: stdoutLines.filter((line: string) => line.includes('繋ぎ直せた')),
      };
    }

    it('/health が runnerId を返す runner では、切断・再接続の両方の行にその識別子が出る', async () => {
      const { fetchFn } = fetchEventsWithHealth(
        { runnerId: 'runner-flaky', workspacePath: '/workspace' },
        (i) => (i === 0 ? 'fail' : i === 1 ? 'healthy' : 'fail'),
      );

      const { failureLines, reconnectLines } = await runFailThenHealthyThenFail(fetchFn);

      expect(failureLines.length).toBeGreaterThan(0);
      expect(reconnectLines).toHaveLength(1);
      // 器の入れ替えの行（`index.ts` の `onSwap`）と同じ組み立て
      // （`runner (<url> / <runnerId>)`）で出る。
      for (const line of [...failureLines, ...reconnectLines]) {
        expect(line).toContain('runner (http://runner.test / runner-flaky)');
      }
    });

    it('/health が runnerId を返さない（古い runner）ときは、既定値 runner-primary がログに出ない', async () => {
      // `runnerId` フィールド自体が無い応答——`hello()` の doc が言う
      // 「フィールド自体が無い古い runner」を模す。
      const { fetchFn } = fetchEventsWithHealth({ workspacePath: '/workspace' }, (i) =>
        i === 0 ? 'fail' : i === 1 ? 'healthy' : 'fail',
      );
      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 3) notifyEnough();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
        nowFn: nowFnAtExactThreshold(),
      });
      // **罠の歯。** `client.runnerId` 自体は既定値を持ったままである
      // （`RunnerClient.runnerId` は non-optional で、`hello()` は聞けなければ
      // 書き換えない）。この既定値をそのままログへ出すと、取れていない値が
      // 取れた値の顔をして出る——それを下で確かめる。
      expect(client.runnerId).toBe('runner-primary');
      // **#330 の歯。** `onSwap` / `onLost` / `GET /runners`（`runner-protocol.ts`
      // の `heardRunnerIdOf`）はこの欄を見て「聞けたか」を判定する。
      expect(client.runnerIdKnown).toBe(false);

      await client.connect(() => undefined);
      await enough;
      await client.close();

      const stderrLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      // **#420 で「繋ぎ直せた」の宛先が stderr から stdout へ移った。**
      const stdoutLines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const failureLines = stderrLines.filter((line: string) =>
        line.includes('ストリームが切れました'),
      );
      const reconnectLines = stdoutLines.filter((line: string) => line.includes('繋ぎ直せた'));

      expect(failureLines.length).toBeGreaterThan(0);
      expect(reconnectLines).toHaveLength(1);
      for (const line of [...failureLines, ...reconnectLines]) {
        expect(line).not.toContain('runner-primary');
        // URL は出るが、` / <runnerId>` の部分ごと無い。
        expect(line).toContain('runner (http://runner.test)');
        expect(line).not.toMatch(/runner \(http:\/\/runner\.test \/ /);
      }
    });
  });

  /**
   * **`RunnerClient.runnerIdKnown` そのものを直接測る（#330）。**
   *
   * 上の「ログの宛先識別子」describe は `#describeSelf` を通した間接的な
   * 観測（ログ文字列）だが、`runnerIdKnown` は `onSwap` / `onLost` /
   * `GET /runners`（`packages/core/src/runner-protocol.ts` の
   * `heardRunnerIdOf`）が直接読む口として `HttpRunner` の外へ引き上げたもの
   * なので、ここではその口自体を直接読んで確かめる。
   */
  describe('runnerIdKnown（#330）', () => {
    it('/health が runnerId を返せば true になる', async () => {
      const fetchFn = (async (input: string | URL | Request) => {
        if (pathOf(input) === '/health') {
          return Response.json({ runnerId: 'runner-x', workspacePath: '/workspace' });
        }
        throw new Error(`想定していない path: ${pathOf(input)}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });

      expect(client.runnerId).toBe('runner-x');
      expect(client.runnerIdKnown).toBe(true);
    });

    it('/health が runnerId を返さなければ false のまま（既定値 runner-primary は聞けた値ではない）', async () => {
      const fetchFn = (async (input: string | URL | Request) => {
        if (pathOf(input) === '/health') {
          return Response.json({ workspacePath: '/workspace' });
        }
        throw new Error(`想定していない path: ${pathOf(input)}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });

      expect(client.runnerId).toBe('runner-primary');
      expect(client.runnerIdKnown).toBe(false);
    });

    it('/health が空文字の runnerId を返しても false のまま', async () => {
      const fetchFn = (async (input: string | URL | Request) => {
        if (pathOf(input) === '/health') {
          return Response.json({ runnerId: '', workspacePath: '/workspace' });
        }
        throw new Error(`想定していない path: ${pathOf(input)}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });

      expect(client.runnerId).toBe('runner-primary');
      expect(client.runnerIdKnown).toBe(false);
    });
  });

  /**
   * **`RunnerClient.workspacePathKnown` そのものを直接測る（#389）。**
   *
   * `runnerIdKnown（#330）` と同じ形の罠が `workspacePath` にも在った——
   * `entries()`（`packages/core/src/runner-protocol.ts`）は #330 の修正後も
   * `entry.client !== null` だけを根拠に `workspacePath` を無条件で出しており、
   * `/health` から一度も受け取れていない相手について既定値 `''` が「受け取った
   * 値」の顔で出ていた。ここではその判定材料そのもの（`workspacePathKnown`）を
   * 直接読んで確かめる。
   */
  describe('workspacePathKnown（#389）', () => {
    it('/health が workspacePath を返せば true になる', async () => {
      const fetchFn = (async (input: string | URL | Request) => {
        if (pathOf(input) === '/health') {
          return Response.json({ runnerId: 'runner-x', workspacePath: '/workspace' });
        }
        throw new Error(`想定していない path: ${pathOf(input)}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });

      expect(client.workspacePath).toBe('/workspace');
      expect(client.workspacePathKnown).toBe(true);
    });

    it('/health が workspacePath を返さなければ false のまま（既定値の空文字は聞けた値ではない）', async () => {
      const fetchFn = (async (input: string | URL | Request) => {
        if (pathOf(input) === '/health') {
          return Response.json({ runnerId: 'runner-x' });
        }
        throw new Error(`想定していない path: ${pathOf(input)}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });

      expect(client.workspacePath).toBe('');
      expect(client.workspacePathKnown).toBe(false);
    });

    /**
     * **`runnerId` とは扱いが違う分岐。** `runnerId` は空文字を「聞けていない」
     * として弾くが、`workspacePath` は弾かない——本当に空の作業ディレクトリを
     * 名乗る runner がありうるからである（`hello()` の doc）。この直前のテストと
     * `workspacePath` の値だけを比べると同じ（どちらも `''`）だが、
     * `workspacePathKnown` は逆になる。値そのもの（`=== ''`）では
     * この2つを区別できないことを、ここで固定する。
     */
    it('/health が空文字の workspacePath を返せば true になる（runnerId とは違う）', async () => {
      const fetchFn = (async (input: string | URL | Request) => {
        if (pathOf(input) === '/health') {
          return Response.json({ runnerId: 'runner-x', workspacePath: '' });
        }
        throw new Error(`想定していない path: ${pathOf(input)}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });

      expect(client.workspacePath).toBe('');
      expect(client.workspacePathKnown).toBe(true);
    });
  });

  /**
   * `HttpRunner.legState`（runner→デーモンの `/events` の脚。デーモン自身の
   * 側の端）が、`#pump` / `#stream` の実際の遷移に沿って動くこと。
   *
   * **型の上で状態が在るだけでは、`#pump` が一度も更新しなければ静かに
   * 効かなくなる**（AGENTS.md「歯」節。まさにこの Issue の発端——runner 側
   * だけを見ていて、デーモン自身の脚が固着していることに気づけなかった形）。
   * だからここでは値そのものではなく、**実際にストリームを開閉させて**
   * 遷移を測る。
   */
  describe('legState（脚の状態。デーモン自身の /events の端）', () => {
    it('接続する前は never-connected', async () => {
      const { fetchFn } = fetchEvents(() => 'fail');
      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });

      expect(client.legState).toEqual({ status: 'never-connected' });

      await client.close();
    });

    it('ストリームが開くと connected になり、バイトを受け取ると lastByteAt が進む', async () => {
      const fetchFn = (async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path === '/health') {
          return Response.json({ runnerId: 'runner-leg', workspacePath: '/workspace' });
        }
        if (path === '/events') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(HEARTBEAT_FRAME));
                // **意図的に close しない。** 接続を開いたままにして、
                // 「開いている」状態を安定して観測できるようにする
                // （閉じてしまうと `#pump` がすぐ次の周回へ進み、
                // `connected` を見る前に `down` へ遷移しうる）。
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        throw new Error(`想定していない path: ${path}`);
      }) as typeof fetch;

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
      });
      // **`try/finally` で必ず `close()` する。** この接続はストリームを
      // 意図的に閉じないので、途中のアサーションが投げると `close()` を
      // 飛ばして次のテストへ「開いたまま」の接続を持ち越すことになる——
      // 実際にそれで別のテストと合流させたときにテスト実行そのものが固まる
      // 形を1回踏んだ（PR 本文に生の再現ログがある）。
      try {
        expect(client.legState).toEqual({ status: 'never-connected' });

        await client.connect(() => undefined);
        // `connect()` は fire-and-forget（`void this.#pump(...)`）なので、
        // 実際にストリームが開くまで待つ。**上限を明示する**——狙った状態に
        // ならないまま無期限に待つと、直した先で壊したときに「赤くなる」
        // ではなく「テストごと固まる」という別の形の壊れ方になる。
        await vi.waitFor(
          () => {
            expect(client.legState?.status).toBe('connected');
          },
          { timeout: 2000, interval: 10 },
        );

        const leg = client.legState;
        expect(leg?.status).toBe('connected');
        if (leg?.status === 'connected') {
          expect(leg.since).toEqual(expect.any(String));
        }
        // heartbeat のバイトを1つ流してあるので、いずれ lastByteAt が付く。
        await vi.waitFor(
          () => {
            const current = client.legState;
            const lastByteAt = current?.status === 'connected' ? current.lastByteAt : undefined;
            expect(lastByteAt).toEqual(expect.any(String));
          },
          { timeout: 2000, interval: 10 },
        );
      } finally {
        await client.close();
      }
    }, 10_000);

    /**
     * **`down` へは「一度は開けた後で終わった」ときだけ遷移する。** 一度も
     * 開けたことが無ければ、何回失敗しても `never-connected` のままである
     * （「脚が無い」と「脚が落ちている」を混ぜないのと同じ形で、こちらは
     * 「まだ一度も繋がっていない」と「繋がってから落ちた」を混ぜない）。
     */
    it('一度も開けたことが無ければ、失敗を重ねても never-connected のまま', async () => {
      const { fetchFn } = fetchEvents(() => 'fail');
      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 3) notifyEnough();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
      });
      // **`try/finally` で必ず `close()` する。** `sleepFn` は間を置かず
      // 即座に解決するので、アサーションが投げて `close()` を飛ばすと
      // `#pump` が実時間の待ちを1ミリ秒も挟まずに回り続ける——テストが
      // 「赤くなる」のではなく「テスト実行そのものが固まる」形になる
      // （PR 本文に生の再現ログがある。この形を実際に1回踏んだ）。
      try {
        await client.connect(() => undefined);
        await enough;

        expect(client.legState).toEqual({ status: 'never-connected' });
      } finally {
        await client.close();
      }
    });

    /**
     * **本題。** 一度は開いた接続が終わると `down` になり、いつから・直近の
     * 理由・次の再試行時刻が読める。
     */
    it('開いた接続が終わると down になり、いつから・直近の理由・次の再試行時刻が読める', async () => {
      // 1回目は healthy（開いて閉じる）、2回目以降は fail（503）。
      const { fetchFn } = fetchEvents((i) => (i === 0 ? 'healthy' : 'fail'));
      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 2) notifyEnough();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
        nowFn: nowFnAtExactThreshold(),
      });
      // **`try/finally` で必ず `close()` する**（上と同じ理由）。
      try {
        await client.connect(() => undefined);
        await enough;

        const leg = client.legState;
        expect(leg?.status).toBe('down');
        if (leg?.status === 'down') {
          // 1回目（healthy）は開いて閉じたので `since` が付く。
          expect(leg.since).toEqual(expect.any(String));
          // 2回目（fail、503）の理由が読める。
          expect(leg.lastFailureReason).toContain('繋げない');
          expect(leg.nextRetryAt).toEqual(expect.any(String));
        }
      } finally {
        await client.close();
      }
    });

    /**
     * **例外を投げずに閾値未満で静かに閉じた回も `down` へ落ち、理由欄には
     * 「持続しないまま終わった」旨が入る。** `#pump` の3つ目の枝（#308）と
     * 同じ区別を `legState.lastFailureReason` でも保つ。
     */
    it('静かに閉じた（例外なし）回でも down になり、その旨が理由に入る', async () => {
      const { fetchFn } = fetchEvents((i) => (i === 0 ? 'healthy' : 'ok'));
      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 2) notifyEnough();
      };

      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
        nowFn: nowFnAtExactThreshold(),
      });
      // **`try/finally` で必ず `close()` する**（上と同じ理由）。
      try {
        await client.connect(() => undefined);
        await enough;

        const leg = client.legState;
        expect(leg?.status).toBe('down');
        if (leg?.status === 'down') {
          expect(leg.lastFailureReason).toBe('ストリームが持続しないまま終わった');
        }
      } finally {
        await client.close();
      }
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

/**
 * **`/events` が無音のまま固着したら切る**（#323）。
 *
 * ## この describe が守っている性質
 *
 * `/events` だけが、返らない相手を見切る仕組みを持っていなかった。制御面は
 * `#call()` の `RUNNER_CALL_DEADLINE_MS` で見切るが、`/events` は `connect()` が
 * 切り離す背景タスクの中で `for(;;) await reader.read()` を回すだけである。
 * **解決も棄却もしない `read()` は `#pump` を丸ごと止める** ——`#pump` は自分の
 * 中に再接続ループを持っているので、そのループごと止まり、バックオフは一度も
 * 回らない。#323 の実測では4時間止まり、回復の契機はプロセスの再起動だった。
 *
 * ## ⚠️ この歯が再現していないもの
 *
 * **本物のソケットが半開き（half-open）になるところは再現していない。** ここで
 * 作っているのは「`reader.read()` が解決も棄却もしない `ReadableStream`」で
 * あって、TCP や Unix ソケットの実物ではない。runner ⇔ daemon の境界を実際に
 * 跨ぐ試験はこのリポジトリに無い（`clone.test.ts` も in-process のフェイクで
 * この境界を跨がない）。
 *
 * **だから `signal` から本文の終わり方への配線も、ここでは自分で書いている** ——
 * 本物の `fetch` は `signal` の abort で本文を error させ、`requestOverSocket` は
 * `req.destroy()` を呼ぶ。**その2つが `reader.read()` の側にどう現れるかは経路に
 * よって違いうるので、両方（棄却／`done`）を模した歯を並べてある。**
 */
describe('/events が無音のまま固着したら切る（#323）', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  /**
   * 本体（`runner-client.ts` の `RUNNER_STREAM_SILENCE_TIMEOUT_MS`）と**同じ
   * 公開定数から導く。別の値を手で書かない** ——`HEALTHY_THRESHOLD_MS` と同じ作法。
   */
  const SILENCE_MS = DEFAULT_SSE_HEARTBEAT_MS * 3;

  /** 差し替えたタイマー。**張られた窓を全部覚えておき、テストが手で発火させる。** */
  interface FakeTimers {
    setTimerFn: (ms: number, onFire: () => void) => () => void;
    /** 張られた窓の ms を張られた順に。 */
    armed: () => number[];
    /** 取り消された窓の ms を取り消された順に。 */
    cancelled: () => number[];
    /** **まだ生きている最後の窓**を発火させる。無ければ投げる。 */
    fire: () => void;
  }

  function fakeTimers(): FakeTimers {
    const armed: number[] = [];
    const cancelled: number[] = [];
    const live: { ms: number; onFire: () => void }[] = [];
    return {
      setTimerFn: (ms, onFire) => {
        armed.push(ms);
        const entry = { ms, onFire };
        live.push(entry);
        return () => {
          const at = live.indexOf(entry);
          if (at === -1) return;
          live.splice(at, 1);
          cancelled.push(ms);
        };
      },
      armed: () => [...armed],
      cancelled: () => [...cancelled],
      fire: () => {
        const entry = live.pop();
        if (entry === undefined) throw new Error('生きている見張りが無い');
        entry.onFire();
      },
    };
  }

  /** 何も流さず、閉じもしない本文。**これが「無音のまま固着した接続」である。** */
  type OnAbort = 'reject' | 'done';
  function silentBody(signal: AbortSignal | null | undefined, onAbort: OnAbort): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          // **`enqueue` も `close` もしない。** `reader.read()` は解決も棄却も
          // しないまま残る —— `#read` の `for(;;)` がそこで止まる形そのもの。
          signal?.addEventListener(
            'abort',
            () => {
              if (onAbort === 'done') controller.close();
              else controller.error(new Error('The operation was aborted'));
            },
            { once: true },
          );
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  /** 1フレーム流してから、閉じずにぶら下がり続ける本文。**生きている接続。** */
  function bodyThen(frames: string[], signal: AbortSignal | null | undefined): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          signal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  function pathOf(input: string | URL | Request): string {
    return new URL(typeof input === 'string' ? input : input.toString()).pathname;
  }

  /**
   * `/events` へ行くたびに `body()` を呼んで応答を組み立てる `fetch`。
   *
   * `signal` を本文へ渡すのは、**本物の `fetch` が `signal` を本文の終わり方へ
   * 配線しているのを模しているから**である（この describe の doc）。
   */
  function eventsFetch(
    body: (callIndex: number, signal: AbortSignal | null | undefined) => Response,
  ): {
    fetchFn: typeof fetch;
    eventsCalls: () => number;
    lastSignal: () => AbortSignal | null | undefined;
  } {
    let calls = 0;
    let lastSignal: AbortSignal | null | undefined;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-stuck', workspacePath: '/workspace' });
      }
      if (path === '/events') {
        lastSignal = init?.signal;
        const response = body(calls, init?.signal);
        calls += 1;
        return response;
      }
      throw new Error(`想定していない path: ${path}`);
    }) as typeof fetch;
    return { fetchFn, eventsCalls: () => calls, lastSignal: () => lastSignal };
  }

  /**
   * **`#pump` が次の周回へ進むまで、微小タスクを回す。**
   *
   * `sleepFn` が解決しても、`#pump` の続き（次の `#stream`）はその場では走らない
   * ——テスト側の `await` と `#pump` の `await` は同じ待ち行列に並ぶだけである。
   * **`enough` を待っただけで数え上げると、まだ起きていないことを「起きなかった」
   * と読む。**
   *
   * 条件が満たされたら即座に抜ける（回数は上限であって歩調ではない）。
   */
  async function settleUntil(done: () => boolean, turns = 200): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
      if (done()) return;
      await Promise.resolve();
    }
  }

  /** `#pump` の `sleepFn`。**待ちを記録し、N 回目で合図する。** */
  function countingSleep(until: number): {
    sleepFn: (ms: number) => Promise<void>;
    waits: number[];
    enough: Promise<void>;
  } {
    const waits: number[] = [];
    let notify: () => void = () => undefined;
    const enough = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const sleepFn = async (ms: number): Promise<void> => {
      waits.push(ms);
      if (waits.length >= until) notify();
    };
    return { sleepFn, waits, enough };
  }

  /**
   * **この歯が単独で守るもの**: 見張りの窓が heartbeat の間隔から導かれていること。
   *
   * `DEFAULT_SSE_HEARTBEAT_MS * 3` を `* 2` や `* 4` へ変えれば、この
   * `toEqual` が落ちる。**そして「持続の判定窓より広い」も併せて名指しする** ——
   * この2つが逆転すると、無音の判定が持続の判定より先に閉じて競合する。
   */
  it('見張りの窓は heartbeat の間隔の3倍で、持続の判定窓より広い', async () => {
    const timers = fakeTimers();
    const { fetchFn } = eventsFetch((_, signal) => silentBody(signal, 'reject'));
    const { sleepFn } = countingSleep(Number.POSITIVE_INFINITY);

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect(() => undefined);
    await client.close();

    expect(timers.armed()[0]).toEqual(DEFAULT_SSE_HEARTBEAT_MS * 3);
    expect(timers.armed()[0]).toBeGreaterThan(DEFAULT_SSE_HEARTBEAT_MS * 2);
  });

  /**
   * **この歯が単独で守るもの**: 見張りが `fetch()` の前に張られていること。
   *
   * 固着は本文を読み始めてからだけではなく、**応答ヘッダが返る前にも起こる**
   * （Unix ソケット経路は素の `node:http` で期限を持たない）。`#read` の中だけを
   * 見張る実装だと、ここへ到達しない固着がまるごと残る。
   *
   * ここでは `fetch` そのものが永久に解決しない形にしてあるので、**見張りが
   * `fetch` より前に張られていなければ、そもそも1つも張られない。**
   */
  it('応答ヘッダが返る前に固着しても、見張りは張られていて切りに行く', async () => {
    const timers = fakeTimers();
    let hangingSignal: AbortSignal | null | undefined;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (pathOf(input) === '/health') {
        return Response.json({ runnerId: 'runner-stuck', workspacePath: '/workspace' });
      }
      hangingSignal = init?.signal;
      // **返らない。** `await this.#fetch(...)` がここで止まる。
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const { sleepFn } = countingSleep(Number.POSITIVE_INFINITY);

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect(() => undefined);

    expect(timers.armed()).toEqual([SILENCE_MS]);
    expect(hangingSignal?.aborted).toBe(false);
    timers.fire();
    expect(hangingSignal?.aborted).toBe(true);

    await client.close();
  });

  /**
   * **この歯が単独で守るもの**: 固着した接続が実際に切られ、`#pump` の再接続が
   * 動き出すこと。**#323 の症状1そのものである。**
   */
  it('無音のまま固着した接続は切られ、/events が張り直される', async () => {
    const timers = fakeTimers();
    const { fetchFn, eventsCalls } = eventsFetch((_, signal) => silentBody(signal, 'reject'));
    const { sleepFn, enough } = countingSleep(1);

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect(() => undefined);

    // 固着している間は1本目のまま。**誰も繋ぎ直さない。**
    expect(eventsCalls()).toBe(1);

    timers.fire();
    await enough;
    await settleUntil(() => eventsCalls() >= 2);
    await client.close();

    expect(eventsCalls()).toBeGreaterThanOrEqual(2);
  });

  /**
   * **この歯が単独で守るもの**: 切って繋ぎ直した先で、**溜まっていた出来事が
   * 実際に降りてくる**こと。
   *
   * #323 で失われかけていたのはこれである —— runner の `Outbox` は上限なしで
   * 溜め続け、`attach()`（＝新しい `GET /events`）が来たときにまとめて流す。
   * **切る歯だけでは「切れた」までしか言えない。** 報告が届くところまでを
   * 名指しする。
   */
  it('繋ぎ直した先で、溜まっていた報告が届く', async () => {
    const timers = fakeTimers();
    // **`runnerEventSchema` が要求する形をそのまま満たすこと。** 欠けていると
    // `safeParse` が落ちて `unknown-shape` として捨てられ、`onEvent` は呼ばれない
    // ——「届かない」が実装の欠陥ではなくフィクスチャの欠陥として出る。
    const report = {
      type: 'report',
      managerId: 'mgr-stuck',
      text: '溜まっていた報告',
      status: 'done',
    };
    const { fetchFn } = eventsFetch((call, signal) =>
      call === 0
        ? silentBody(signal, 'reject')
        : bodyThen([`data: ${JSON.stringify(report)}\n\n`], signal),
    );
    const { sleepFn, enough } = countingSleep(1);

    const received: unknown[] = [];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect((event) => received.push(event));

    // 固着している間は1件も届かない。
    expect(received).toEqual([]);

    timers.fire();
    await enough;
    await settleUntil(() => received.length > 0);
    await client.close();

    expect(received).toEqual([report]);
  });

  /**
   * **この歯が単独で守るもの**: 切ったことが「失敗」として扱われ、**何が起きたかを
   * 名乗る**こと。
   *
   * 黙って正常終了として返すと `#pump` は失敗と数えず `切れました` の行も出ない
   * ——**固着が起きたことがログから消える。** 4時間止まった原因が後から追えなく
   * なるのがまさにこの形である。
   */
  it('無音で切ったことは、失敗として stderr に名乗る', async () => {
    const timers = fakeTimers();
    const { fetchFn } = eventsFetch((_, signal) => silentBody(signal, 'reject'));
    const { sleepFn, enough } = countingSleep(1);

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect(() => undefined);
    timers.fire();
    await enough;
    await client.close();

    const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const failures = lines.filter((line: string) => line.includes('ストリームが切れました'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('無音');
    expect(failures[0]).toContain(String(SILENCE_MS));
  });

  /**
   * **この歯が単独で守るもの**: `abort()` が**棄却ではなく `done`** として現れる
   * 経路でも、正常終了として黙らないこと。
   *
   * `controller.abort()` の後に `reader.read()` がどちらの形で終わるかは経路に
   * よって違いうる（TCP は `fetch` の `signal`、Unix ソケットは `req.destroy()`）。
   * **`abort()` の効き方に賭けない**という設計判断を、この歯が固定する。
   */
  it('abort が done として畳まれても、正常終了として黙らない', async () => {
    const timers = fakeTimers();
    const { fetchFn, eventsCalls } = eventsFetch((_, signal) => silentBody(signal, 'done'));
    const { sleepFn, enough } = countingSleep(1);

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect(() => undefined);
    timers.fire();
    await enough;
    await settleUntil(() => eventsCalls() >= 2);
    await client.close();

    const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines.filter((line: string) => line.includes('無音'))).toHaveLength(1);
    expect(eventsCalls()).toBeGreaterThanOrEqual(2);
  });

  /**
   * **この歯が単独で守るもの**: **バイトが届いているあいだは切らない。**
   *
   * これが落ちる実装は、正常に張られている長命な SSE を一定周期で切る ——
   * 切るたびに runner が `hello` を書き直して `#reattach` が走るので、
   * `apps/runner/src/app.ts` の `/events` の doc が名指しで避けている症状を
   * 作り直すことになる。**「静かな接続を時間で切らない」（north_star 禁止2）は
   * ここで守られている。**
   *
   * 併せて、**残りぶんだけ張り直す**ことも名指しする（窓の起点が最後のバイトで
   * あって、接続の開始ではないこと）。
   */
  it('バイトが届いているあいだは切らず、見張りは残りぶんだけ張り直す', async () => {
    const timers = fakeTimers();
    const { fetchFn, eventsCalls, lastSignal } = eventsFetch((_, signal) =>
      bodyThen([HEARTBEAT_FRAME], signal),
    );
    const { sleepFn } = countingSleep(Number.POSITIVE_INFINITY);

    // **4つの時刻を全部違う値にしてある。** 揃えると「残りぶん」の式
    // （`最後のバイト + 窓 - いま`）が偶然の一致で通り、式を取り違えた実装を
    // 見逃す（実際、この歯を書いた最初の版はそれで期待値のほうを間違えた）。
    const connectedAt = 0;
    const firstByteAt = 10_000;
    const firedAt = 50_000;
    let nowCalls = 0;
    const nowFn = (): number => {
      // 1回目 = `connectedAt`、2回目 = heartbeat の到着、3回目 = 見張りの発火。
      nowCalls += 1;
      if (nowCalls === 1) return connectedAt;
      if (nowCalls === 2) return firstByteAt;
      return firedAt;
    };

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      nowFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect(() => undefined);
    // 本文（heartbeat 1本）が読まれるまで進める。
    await settleUntil(() => nowCalls >= 2);

    timers.fire();

    // **切っていない。** 窓の起点は接続の開始ではなく**最後のバイト**なので、
    // 閉じるのは `firstByteAt + SILENCE_MS`＝55000。発火した 50000 の時点では
    // まだ 5000 残っており、その残りぶんで張り直す。
    expect(lastSignal()?.aborted).toBe(false);
    expect(eventsCalls()).toBe(1);
    expect(timers.armed()).toEqual([SILENCE_MS, firstByteAt + SILENCE_MS - firedAt]);

    await client.close();
  });

  /**
   * **この歯が単独で守るもの**: 接続が終われば見張りは取り消されること。
   *
   * 取り消さないと、切れた接続ぶんのタイマーが接続のたびに積まれる。
   */
  it('接続が終わったら見張りは取り消される', async () => {
    const timers = fakeTimers();
    const { fetchFn } = eventsFetch(() => new Response(null, { status: 503 }));
    const { sleepFn, enough } = countingSleep(2);

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn,
      setTimerFn: timers.setTimerFn,
    });
    await client.connect(() => undefined);
    await enough;
    await client.close();

    // 張った数と取り消した数が揃っている（＝置き去りにしていない）。
    expect(timers.cancelled().length).toBe(timers.armed().length);
  });
});

/**
 * **`#pump` は、周回の途中で何が投げても止まらない**（#323）。
 *
 * ## なぜ `/events` の固着と同じ穴か
 *
 * `#pump` は `connect()` が `void` で切り離す背景タスクで、`ManagerPool#connectTo`
 * は `#connections` の旗で二度目の `connect()` を弾く。**旗が外れるのは
 * `connect()` が棄却したときだけ**で、`connect()` は中身が fire-and-forget なので
 * 既に成功として解決している。**＝ `#pump` から例外が抜けた瞬間、この runner へ
 * 再接続が二度と試されない。**
 *
 * #323 の症状はまさにそれ（4時間、再接続が一度も試されなかった）である。
 * **`#read` の固着だけを塞いで、同じ症状を作る他の枝を残さない。**
 */
describe('#pump は周回の途中で投げられても止まらない（#323）', () => {
  function pathOf(input: string | URL | Request): string {
    return new URL(typeof input === 'string' ? input : input.toString()).pathname;
  }

  /** `/events` が必ず 503 で失敗する runner。**`#pump` は延々と挑み直すはず。** */
  function failingFetch(): { fetchFn: typeof fetch; eventsCalls: () => number } {
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      const path = pathOf(input);
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-noisy', workspacePath: '/workspace' });
      }
      if (path === '/events') {
        calls += 1;
        return new Response(null, { status: 503 });
      }
      throw new Error(`想定していない path: ${path}`);
    }) as typeof fetch;
    return { fetchFn, eventsCalls: () => calls };
  }

  /**
   * **この歯が単独で守るもの**: stderr が書けなくても再接続をやめないこと。
   *
   * `process.stderr.write` は宛先が壊れていれば投げうる（`ERR_STREAM_DESTROYED`
   * / EPIPE）。**この1行は `#stream` を包む `catch` の外側に在る**ので、包んで
   * いなければ最初の失敗で `#pump` ごと死ぬ。
   */
  it('stderr が書けなくても、挑み直しは続く', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    try {
      const { fetchFn, eventsCalls } = failingFetch();
      const waits: number[] = [];
      let notify: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 3) notify();
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

      // 1回目で死んでいれば `/events` は1本しか開かれない。
      expect(eventsCalls()).toBeGreaterThanOrEqual(3);
      expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  /**
   * **この歯が単独で守るもの**: 差し替えられた待ちが投げても、`#pump` が死なず、
   * **かつ待たずに回り続けない**こと。
   *
   * 後半が要る —— 例外を握り潰すだけの実装は、待ちを飛ばして秒間に何度も
   * runner を叩く形になる。**それはバックオフを持っている意味を消す。**
   */
  it('差し替えた待ちが投げても止まらず、待ちそのものは飛ばさない', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { fetchFn, eventsCalls } = failingFetch();
      const asked: number[] = [];
      const sleepFn = async (ms: number): Promise<void> => {
        asked.push(ms);
        throw new Error('待ちの差し替えが壊れている');
      };

      // **既定の待ちへ落ちたときは実時間で待つ**ので、基準と上限は小さくする。
      // ただし 0 にはしない —— 下の経過時間の下限が測れなくなる。
      const base = 20;
      const max = 40;
      const client = await createHttpRunner({
        baseUrl: 'http://runner.test',
        token: TOKEN,
        fetchFn,
        sleepFn,
        retryDelayMs: base,
        retryMaxDelayMs: max,
      });
      const startedAt = Date.now();
      await client.connect(() => undefined);
      for (let i = 0; i < 400 && asked.length < 3; i += 1)
        await new Promise((r) => setTimeout(r, 1));
      const elapsedMs = Date.now() - startedAt;
      await client.close();

      expect(eventsCalls()).toBeGreaterThanOrEqual(3);
      // 投げた待ちを、次の周回でもちゃんと呼びに行っている（列も伸びている）。
      expect(asked.slice(0, 3)).toEqual([base, max, max]);
      // **待ちそのものを飛ばしていない。**
      //
      // `asked` の中身だけでは、これは測れない —— 例外を握り潰して**待たずに**
      // 回り続けても `asked` は同じ列になる。**測れるのは実時間だけである。**
      // `asked` が3本たまるまでに既定の待ちが2回（`base` と `max`）完了して
      // いるので、下限は `base + max`。**下限にしてあるので、器が遅い側へ
      // ぶれても落ちない**（速い側へはぶれようが無い）。
      expect(elapsedMs).toBeGreaterThanOrEqual(base + max - 15);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

/**
 * Issue #275: `await stream.writeSSE()` が例外を投げずに正常返却したのに相手
 * には届いていなかった1件（無音切断）を、SSE の `id` / `Last-Event-ID` で
 * 配り直す。
 *
 * **ここが測るのはデーモン側の配線だけ**——「フレームの `id` を受け取ったら
 * `#lastEventId` が進み、次の `/events` でそれを `Last-Event-ID` として申告
 * する」という契約である。runner 側の契約（`Outbox.recordSent` /
 * `Outbox.sentSince` が実際に読み返して配り直すこと）は
 * `apps/runner/src/events-silent-disconnect.test.ts` が本物の `createRunnerApp`
 * / `Outbox` を通して測る——**無音切断そのもの（書いている最中に相手が消える
 * 競合）を両側つないで再現する歯はここには無い**（`/events が無音のまま固着
 * したら切る（#323）」の describe の doc が断っている「本物のソケットの半開き
 * は再現していない」と同じ理由——2つの実装を跨いだ競合を決定的に作るのは
 * このリポジトリの他の歯もやっていない）。両側それぞれの契約を単独で測ることで
 * 代える。
 */
describe('Last-Event-ID の申告（#275）', () => {
  function pathOf(input: string | URL | Request): string {
    return new URL(typeof input === 'string' ? input : input.toString()).pathname;
  }

  /**
   * `/events` へ呼ばれるたびに `frame(callIndex)` の結果を返す `fetch`。
   * `null` を返した回以降は掴んだままにする（`fetchFramesOnce` と同じ
   * 「2回目以降の雑音を減らす」作法）。
   *
   * 受け取った `Last-Event-ID` ヘッダは呼び出し順に記録する。
   */
  function eventsFetchRecordingLastEventId(frame: (callIndex: number) => string[] | null): {
    fetchFn: typeof fetch;
    headersSeen: () => (string | undefined)[];
  } {
    const headersSeen: (string | undefined)[] = [];
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-275', workspacePath: '/workspace' });
      }
      if (path === '/events') {
        const headers = init?.headers as Record<string, string> | undefined;
        headersSeen.push(headers?.['last-event-id']);
        const callIndex = calls;
        calls += 1;
        const rawFrames = frame(callIndex);
        if (rawFrames === null) return new Promise<Response>(() => undefined);
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
    return { fetchFn, headersSeen: () => [...headersSeen] };
  }

  it('初回接続は Last-Event-ID を申告しない', async () => {
    const { fetchFn, headersSeen } = eventsFetchRecordingLastEventId((callIndex) =>
      callIndex === 0 ? [] : null,
    );
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn: async () => undefined,
    });
    await client.connect(() => undefined);
    await expect.poll(() => headersSeen().length >= 1, { timeout: 1000 }).toBe(true);
    await client.close();

    expect(headersSeen()[0]).toBeUndefined();
  });

  it('受け取った SSE フレームの id を、次の /events で Last-Event-ID として申告する', async () => {
    const { fetchFn, headersSeen } = eventsFetchRecordingLastEventId((callIndex) => {
      if (callIndex === 0) {
        return [
          'event: session\ndata: {"type":"session","managerId":"m1","sessionId":"s1"}\nid: 7\n\n',
        ];
      }
      if (callIndex === 1) return [];
      return null;
    });

    const events: unknown[] = [];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn: async () => undefined,
    });
    await client.connect((event) => events.push(event));

    await expect.poll(() => headersSeen().length >= 2, { timeout: 2000 }).toBe(true);
    await client.close();

    expect(events).toHaveLength(1);
    expect(headersSeen()[0]).toBeUndefined();
    // **これが要点。** 1本目で受け取れた `id: 7` を、2本目の `/events` で
    // `Last-Event-ID: 7` として申告する。
    expect(headersSeen()[1]).toBe('7');
  });

  it('id の無いフレーム（hello・heartbeat 相当）は申告を進めない', async () => {
    const { fetchFn, headersSeen } = eventsFetchRecordingLastEventId((callIndex) => {
      if (callIndex === 0) return ['data: {"type":"hello","runnerId":"r1"}\n\n'];
      if (callIndex === 1) return [];
      return null;
    });

    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn: async () => undefined,
    });
    await client.connect(() => undefined);

    await expect.poll(() => headersSeen().length >= 2, { timeout: 2000 }).toBe(true);
    await client.close();

    expect(headersSeen()[1]).toBeUndefined();
  });
});
