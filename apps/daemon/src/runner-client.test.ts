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
  RunnerHttpError,
  type ManagerPool,
  type InboxEvent,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createHttpRunner, type RunnerDroppedEventReport } from './runner-client.js';

const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

interface FakeSession {
  options: Options;
  inputs: string[];
  ask(toolName: string, requestId: string): Promise<PermissionResult>;
  report(text: string): Promise<void>;
  usedTool(tool: string): Promise<void>;
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
    await expect
      .poll(async () => (await r.stores.jobs.listJobs())[0]?.workspace, { timeout: 2000 })
      .toEqual({
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

    await expect
      .poll(() => r.inbox.filter((event) => event.type === 'manager_message').length, {
        timeout: 2000,
      })
      .toBe(1);
    const event = r.inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission', managerId, requestId: 'req-1' });

    const waiting = (await r.pool.list()).find((m) => m.managerId === managerId);
    expect(waiting?.status).toBe('waiting_human');
    expect(waiting?.waiting[0]?.requestId).toBe('req-1');

    const result = await r.pool.send(managerId, 'よい', { decision: 'allow', requestId: 'req-1' });
    expect(result.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });

    const escalations = (await r.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations.map((entry) => entry.answer)).toEqual(['[allow] よい', undefined]);
  });

  it('decision を明示しない回答は、承認とも拒否とも読めなければ unreadable として境界越しに journal へ残る（#322。issue #1827/#1837 で反転）', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: 'デプロイして' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    const asked = (r.sessions[0] as FakeSession).ask('Bash', 'req-2');
    await expect
      .poll(() => r.inbox.filter((event) => event.type === 'manager_message').length, {
        timeout: 2000,
      })
      .toBe(1);

    const result = await r.pool.send(managerId, 'よい、そのまま進めて', { requestId: 'req-2' });
    expect(result.outcome).toBe('answered');
    expect(await asked).toMatchObject({ behavior: 'deny' });

    const escalations = (await r.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations.map((entry) => entry.answer)).toEqual([
      '[unreadable] よい、そのまま進めて',
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
    await expect
      .poll(async () => (await r.stores.jobs.listJobs())[0]?.projectKey, { timeout: 2000 })
      .toBe('proj');
  });

  it('デーモンだけが再起動したら、走っているマネージャーへ繋ぎ直す（殺さない）', async () => {
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
    await first.stop();

    const second = await connect();
    const restored = await second.restore();

    expect(restored.map((m) => m.managerId)).toEqual([managerId]);
    expect(sessions).toHaveLength(1);

    await second.stop();
    await host.shutdown();
  });

  it('runner ごと作り直されたら、預かった生ログから resume して続きを進める', async () => {
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

    const r = await open({ stores, sessionId: 'sess-after' });
    const restored = await r.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual(['mgr-old']);
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    const session = r.sessions[0] as FakeSession;
    expect(session.options.resume).toBe('sess-before');
    expect(
      await (session.options.sessionStore as SessionStore).load({
        projectKey: 'any',
        sessionId: 'sess-before',
      }),
    ).toEqual(seeded);

    await expect
      .poll(() => session.inputs.join(''), { timeout: 2000 })
      .toContain('中断していた作業の続きを進めよ');

    expect(
      r.inbox.some(
        (event) => event.type === 'manager_message' && event.text.includes('再開させた'),
      ),
    ).toBe(true);
  });

  it('Unix ソケット越しでも同じように動く（コンテナ構成の実経路）', async () => {
    const { chmodSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { createAdaptorServer } = await import('@hono/node-server');

    const dir = makeTempDirSync('alteroid-sock-');
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

      await expect
        .poll(async () => (await stores.jobs.listJobs())[0]?.sessionId, { timeout: 3000 })
        .toBe('sess-sock');

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
    await pool.stop();

    void (sessions[0] as FakeSession).ask('Bash', 'req-late');

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

  it('unpushedWork は境界越しに未 push のコミット数を運ぶ（#1039）', async () => {
    const dir = makeTempDirSync('alteroid-runner-client-unpushed-');
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'a.txt'), 'first\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'first']);
    writeFileSync(join(dir, 'b.txt'), 'second\n');
    git(['add', 'b.txt']);
    git(['commit', '-q', '-m', 'second']);

    const r = await open();
    const { managerId } = await r.pool.start({ request: '確認', cwd: dir });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);

    const probe = await r.pool.unpushedWork(managerId);

    expect(probe.kind).toBe('ok');
    if (probe.kind !== 'ok') throw new Error('unreachable');
    expect(probe.result.worktrees).toHaveLength(1);
    expect(probe.result.worktrees[0]).toMatchObject({
      relativePath: '.',
      branch: 'main',
      unpushedCommitCount: 2,
      uncommittedChangeCount: 0,
    });
  });

  it('unpushedWork はセッションが無い managerId には「確かめられなかった」を返す', async () => {
    const r = await open();

    const probe = await r.pool.unpushedWork('mgr-does-not-exist');

    expect(probe.kind).toBe('unavailable');
  });
});

describe('旧 runner への問い合わせ（kind / askedAt を持たない /managers 応答）', () => {
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

    expect(managers).toHaveLength(1);
    const manager = managers.find((m) => m.managerId === 'mgr-legacy');
    expect(manager?.waiting).toHaveLength(1);
    expect(manager?.waiting[0]?.requestId).toBe('req-legacy');
    expect(manager?.waiting[0]?.summary).toBe('許可してよいか');
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

describe('資源による配置の材料', () => {
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

    expect(resources?.managers).toBe(0);
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

    expect(await client.resources?.()).toEqual({ managers: 2 });
  });

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

  it('runner の /health が pendingEvents/oldestPendingAt を名乗り、デーモンがそれを採る', async () => {
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

    const resources = await client.resources?.();

    expect(resources?.pendingEvents).toBe(2);
    expect(typeof resources?.oldestPendingAt).toBe('string');

    await host.shutdown();
  });

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

    runnerId = 'runner-replaced';
    await client.resources?.();

    expect(client.runnerId).toBe('runner-primary');
  });
});

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
    expect(typeof identity?.instanceId).toBe('string');
    expect(identity?.instanceId?.length ?? 0).toBeGreaterThan(0);

    const again = await client.identity?.();
    expect(again?.instanceId).toBe(identity?.instanceId);
  });

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

    expect(identity?.runnerId).toBe('runner-replaced');
    expect(client.runnerId).toBe('runner-primary');
  });

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
        })) as typeof fetch,
    });
    cleanups.push(() => client.close());

    const identity = await client.identity?.();

    expect(identity?.runnerId).toBe('runner-legacy');
    expect(identity?.instanceId).toBe('boot-legacy');
    expect(identity).not.toHaveProperty('pendingEvents');
    expect(identity).not.toHaveProperty('oldestPendingAt');
  });

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

    // `known` 固定にしない: `CANON_REVISION` の焼き込み状態に依存するので `status` の型だけを見る。
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
        })) as typeof fetch,
    });
    cleanups.push(() => client.close());

    expect(client.revision).toBeUndefined();
  });
});

describe('死んだ runner への SSE 再接続（バックオフ）', () => {
  // `stdout` も黙らせる: 黙らせないと `vitest.setup.ts` の歯が「繋ぎ直せた」を stdout へ書くテストを落とす。
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

  const HEALTHY_THRESHOLD_MS = DEFAULT_SSE_HEARTBEAT_MS * 2;

  // 経過時間は `nowFn` 側だけで作る: `ReadableStream` の `pull`/`start` は `reader.read()` より先出しで走ることがあり、ストリーム内部で時計を進めると `#stream` の計測と競合するため。
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
        return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`想定していない path: ${path}`);
    }) as typeof fetch;
    return { fetchFn, eventsCalls: () => calls };
  }

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

    expect(waits.slice(0, 4)).toEqual([1000, 2000, 1000, 1000]);
  });

  it('stderr は初回と間隔が変わったときだけ書き、繋ぎ直せたときは stdout に1行書く（切断の行は stdout に漏れない）', async () => {
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

    expect(failureLines).toHaveLength(4);
    expect(failureLines[0]).toContain('次は1000ms後に再試行');
    expect(failureLines[1]).toContain('次は2000ms後に再試行');
    expect(failureLines[2]).toContain('次は4000ms後に再試行');
    expect(failureLines[3]).toContain('次は1000ms後に再試行');
    expect(reconnectLines).toHaveLength(1);
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

    expect(failureLines).toHaveLength(6);
  });

  it('close() の後は挑み直さない（既存の保証がバックオフでも残る）', async () => {
    const { fetchFn, eventsCalls } = fetchEvents(() => 'fail');
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

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(eventsCalls()).toBe(1);
  });

  describe('リセットは「閾値を超えてからバイトが届いた」ときだけ効く（#274）', () => {
    it('hello 相当のバイトが接続直後に届いても、リセットされない（閾値未満）', async () => {
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
        nowFn: () => 0,
      });
      await client.connect(() => undefined);
      await enough;
      await client.close();

      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines.some((line: string) => line.includes('繋ぎ直せた'))).toBe(false);
    });

    it('バイトが1度も届かないまま閾値を超えて切れても、リセットされない（無音でぶら下がった死んだ接続）', async () => {
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

      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines.some((line: string) => line.includes('繋ぎ直せた'))).toBe(false);
    });

    it('繋ぎ直せた は、接続が生きたままの間に出る（接続が終わるのを待たない）', async () => {
      // 接続を閉じてから確認しない: 「`#stream()` が終わった後に書く」実装と「健全と判定した瞬間に書く」実装を区別できなくなるため。
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let eventsCalls = 0;
      const fetchFn = (async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path === '/health') {
          return Response.json({ runnerId: 'runner-flaky', workspacePath: '/workspace' });
        }
        if (path === '/events') {
          eventsCalls += 1;
          if (eventsCalls === 1) return new Response(null, { status: 503 });
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
        sleepFn: async () => undefined,
        nowFn: nowFnAtExactThreshold(),
      });
      await client.connect(() => undefined);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(controllerRef).toBeDefined();
      expect(
        stdoutSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes('繋ぎ直せた')),
      ).toBe(false);

      controllerRef?.enqueue(new TextEncoder().encode(HEARTBEAT_FRAME));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const lines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines.filter((line: string) => line.includes('繋ぎ直せた'))).toHaveLength(1);

      controllerRef?.close();
      await client.close();
    });
  });

  describe('stderr の cause 付記', () => {
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

    // `close()` は `sleepFn` の中から呼ぶ: 外側から呼ぶと `#pump` が次の周を始めてから `close()` が効くまでにレースが生まれ、2行目が書かれることがあるため。
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

      expect(failureLines).toHaveLength(7);
      expect(failureLines[5]).toContain('code=UND_ERR_SOCKET');
      expect(failureLines[6]).toContain('code=UND_ERR_BODY_TIMEOUT');
    });

    it('UND_ERR_BODY_TIMEOUT で頭打ち（30000ms）まで伸びた後、healthy へ回復すると「繋ぎ直せた」が出て基準へ戻る（#308）', async () => {
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
      const reconnectLines = stdoutLines.filter((line: string) => line.includes('繋ぎ直せた'));

      expect(failureLines).toHaveLength(6);
      for (const line of failureLines) {
        expect(line).toContain('code=UND_ERR_BODY_TIMEOUT');
      }
      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);

      expect(reconnectLines).toHaveLength(1);

      expect(waits[6]).toBe(1000);
    });
  });

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

      expect(waits.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);

      const lines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const quietLines = lines.filter((line: string) => line.includes('持続しないまま終わった'));

      expect(quietLines).toHaveLength(6);
      expect(quietLines[0]).toContain('次は1000ms後に再試行');
      expect(quietLines[5]).toContain('次は30000ms後に再試行');
      expect(lines.some((line: string) => line.includes('ストリームが切れました'))).toBe(false);
      expect(lines.some((line: string) => line.includes('繋ぎ直せた'))).toBe(false);
    });

    it('静かに閉じた経路と失敗経路の dedup は互いを消し合わない', async () => {
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

      expect(failureLines).toHaveLength(6);
      expect(quietLines).toHaveLength(1);
      expect(quietLines[0]).toContain('次は30000ms後に再試行');
      for (const line of [...failureLines, ...quietLines]) {
        expect(line).not.toContain('繋ぎ直せた');
      }
    });

    it('静かに閉じ続けて頭打ちへ張り付いた後、healthy へ回復すると「繋ぎ直せた」が出る（出の端）', async () => {
      const { fetchFn } = fetchEvents((i) => (i < 6 ? 'ok' : 'healthy'));

      const waits: number[] = [];
      let notifyEnough: () => void = () => undefined;
      const enough = new Promise<void>((resolve) => {
        notifyEnough = resolve;
      });
      const sleepFn = async (ms: number): Promise<void> => {
        waits.push(ms);
        if (waits.length >= 7) notifyEnough();
      };

      // `nowFnAtExactThreshold()` は使わない: 'ok' の接続も `connectedAt` のために `#nowFn` を1回ずつ消費するので、呼び出し回数を数える専用の `nowFn` が要る。
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

      const stderrLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const stdoutLines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const quietLines = stderrLines.filter((line: string) =>
        line.includes('持続しないまま終わった'),
      );
      const reconnectLines = stdoutLines.filter((line: string) => line.includes('繋ぎ直せた'));

      expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      expect(quietLines).toHaveLength(6);

      expect(reconnectLines).toHaveLength(1);

      expect(stdoutLines.some((line: string) => line.includes('持続しないまま終わった'))).toBe(
        false,
      );

      expect(waits[6]).toBe(1000);
    });
  });

  describe('ログの宛先識別子（#274 issue コメント）', () => {
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
      for (const line of [...failureLines, ...reconnectLines]) {
        expect(line).toContain('runner (http://runner.test / runner-flaky)');
      }
    });

    it('/health が runnerId を返さない（古い runner）ときは、既定値 runner-primary がログに出ない', async () => {
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
      expect(client.runnerId).toBe('runner-primary');
      expect(client.runnerIdKnown).toBe(false);

      await client.connect(() => undefined);
      await enough;
      await client.close();

      const stderrLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const stdoutLines = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      const failureLines = stderrLines.filter((line: string) =>
        line.includes('ストリームが切れました'),
      );
      const reconnectLines = stdoutLines.filter((line: string) => line.includes('繋ぎ直せた'));

      expect(failureLines.length).toBeGreaterThan(0);
      expect(reconnectLines).toHaveLength(1);
      for (const line of [...failureLines, ...reconnectLines]) {
        expect(line).not.toContain('runner-primary');
        expect(line).toContain('runner (http://runner.test)');
        expect(line).not.toMatch(/runner \(http:\/\/runner\.test \/ /);
      }
    });
  });

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
                // close しない: 閉じると `#pump` がすぐ次の周回へ進み、`connected` を見る前に `down` へ遷移しうるため。
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
      // `try/finally` で必ず `close()` する: アサーションが投げると、開いたままの接続を次のテストへ持ち越してテスト実行そのものが固まるため。
      try {
        expect(client.legState).toEqual({ status: 'never-connected' });

        await client.connect(() => undefined);
        // 待ちの上限を明示する: 無期限に待つと、壊したときに赤くならずテストごと固まるため。
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
      // `try/finally` で必ず `close()` する: `sleepFn` が即座に解決するので、`close()` を飛ばすと `#pump` が待ちなしで回り続けテスト実行が固まるため。
      try {
        await client.connect(() => undefined);
        await enough;

        expect(client.legState).toEqual({ status: 'never-connected' });
      } finally {
        await client.close();
      }
    });

    it('開いた接続が終わると down になり、いつから・直近の理由・次の再試行時刻が読める', async () => {
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
      try {
        await client.connect(() => undefined);
        await enough;

        const leg = client.legState;
        expect(leg?.status).toBe('down');
        if (leg?.status === 'down') {
          expect(leg.since).toEqual(expect.any(String));
          expect(leg.lastFailureReason).toContain('繋げない');
          expect(leg.nextRetryAt).toEqual(expect.any(String));
        }
      } finally {
        await client.close();
      }
    });

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

describe('解釈できずに捨てた出来事の跡', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // 2回目以降の `/events` は返らないようにする: `#pump` は正常終了でも1秒後に張り直し、同じ跡が積み増して件数が読めなくなるため。
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

  // `data: ` で包まない: 前置きすると `: hb` が `data: : hb` になり、実物の runner が出す形と違ってしまうため。
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
    await expect
      .poll(() => dropped.some((r) => r.phase === 'closed') || events.length > 0, { timeout: 2000 })
      .toBe(true);
    await client.close();
    return { dropped, events };
  }

  it('HEARTBEAT_FRAME は ": hb\\n\\n" そのもの', () => {
    expect(HEARTBEAT_FRAME).toBe(': hb\n\n');
  });

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
    // まとめを待たない: 正常な回は跡が1件も出ないので、待つと永久に待つため。
    await expect
      .poll(() => dropped.some((r) => r.phase === 'closed') || events.length > 0, { timeout: 2000 })
      .toBe(true);
    await client.close();
    return { dropped, events };
  }

  it('スキーマに合わないフレームは、type つきで跡が出る', async () => {
    const { dropped } = await collect([JSON.stringify({ type: 'brand_new_event', at: 1 })]);

    const first = dropped.find((r) => r.phase === 'first');
    expect(first).toMatchObject({
      phase: 'first',
      reason: 'unknown-shape',
      type: 'brand_new_event',
    });
  });

  it('JSON にならないフレームでは、type を作らない', async () => {
    const { dropped } = await collect(['{壊れている']);

    const first = dropped.find((r) => r.phase === 'first');
    expect(first).toMatchObject({ phase: 'first', reason: 'unparsable' });
    expect(first && 'type' in first ? first.type : undefined).toBeUndefined();
    expect(first?.phase === 'first' ? first.bytes : 0).toBeGreaterThan(0);
  });

  it('正常なフレームでは跡を出さない', async () => {
    const { dropped, events } = await collect([JSON.stringify({ type: 'hello', runnerId: 'r1' })]);

    expect(events).toHaveLength(1);
    expect(dropped.filter((r) => r.phase === 'first')).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });

  it('同じ type は初出だけ。2件目以降は数えるだけ', async () => {
    const frame = JSON.stringify({ type: 'brand_new_event' });
    const { dropped } = await collect([frame, frame, frame]);

    expect(dropped.filter((r) => r.phase === 'first')).toHaveLength(1);
  });

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

describe('/events が無音のまま固着したら切る（#323）', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const SILENCE_MS = DEFAULT_SSE_HEARTBEAT_MS * 3;

  interface FakeTimers {
    setTimerFn: (ms: number, onFire: () => void) => () => void;
    armed: () => number[];
    cancelled: () => number[];
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

  type OnAbort = 'reject' | 'done';
  function silentBody(signal: AbortSignal | null | undefined, onAbort: OnAbort): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
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

  async function settleUntil(done: () => boolean, turns = 200): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
      if (done()) return;
      await Promise.resolve();
    }
  }

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

  it('応答ヘッダが返る前に固着しても、見張りは張られていて切りに行く', async () => {
    const timers = fakeTimers();
    let hangingSignal: AbortSignal | null | undefined;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (pathOf(input) === '/health') {
        return Response.json({ runnerId: 'runner-stuck', workspacePath: '/workspace' });
      }
      hangingSignal = init?.signal;
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

    expect(eventsCalls()).toBe(1);

    timers.fire();
    await enough;
    await settleUntil(() => eventsCalls() >= 2);
    await client.close();

    expect(eventsCalls()).toBeGreaterThanOrEqual(2);
  });

  it('繋ぎ直した先で、溜まっていた報告が届く', async () => {
    const timers = fakeTimers();
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

    expect(received).toEqual([]);

    timers.fire();
    await enough;
    await settleUntil(() => received.length > 0);
    await client.close();

    expect(received).toEqual([report]);
  });

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

  it('バイトが届いているあいだは切らず、見張りは残りぶんだけ張り直す', async () => {
    const timers = fakeTimers();
    const { fetchFn, eventsCalls, lastSignal } = eventsFetch((_, signal) =>
      bodyThen([HEARTBEAT_FRAME], signal),
    );
    const { sleepFn } = countingSleep(Number.POSITIVE_INFINITY);

    // 4つの時刻は全部違う値にする: 揃えると「残りぶん」の式が偶然の一致で通り、式を取り違えた実装を見逃すため。
    const connectedAt = 0;
    const firstByteAt = 10_000;
    const firedAt = 50_000;
    let nowCalls = 0;
    const nowFn = (): number => {
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
    await settleUntil(() => nowCalls >= 2);

    timers.fire();

    expect(lastSignal()?.aborted).toBe(false);
    expect(eventsCalls()).toBe(1);
    expect(timers.armed()).toEqual([SILENCE_MS, firstByteAt + SILENCE_MS - firedAt]);

    await client.close();
  });

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

    expect(timers.cancelled().length).toBe(timers.armed().length);
  });
});

describe('#pump は周回の途中で投げられても止まらない（#323）', () => {
  function pathOf(input: string | URL | Request): string {
    return new URL(typeof input === 'string' ? input : input.toString()).pathname;
  }

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

      expect(eventsCalls()).toBeGreaterThanOrEqual(3);
      expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('差し替えた待ちが投げても止まらず、待ちそのものは飛ばさない', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { fetchFn, eventsCalls } = failingFetch();
      const asked: number[] = [];
      const sleepFn = async (ms: number): Promise<void> => {
        asked.push(ms);
        throw new Error('待ちの差し替えが壊れている');
      };

      // 基準と上限は小さくするが 0 にはしない: 下の経過時間の下限が測れなくなるため。
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
      expect(asked.slice(0, 3)).toEqual([base, max, max]);
      // 下限にする: 器が遅い側へぶれても落ちない（速い側へはぶれようが無い）。
      expect(elapsedMs).toBeGreaterThanOrEqual(base + max - 15);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('Last-Event-ID の申告（#275）', () => {
  function pathOf(input: string | URL | Request): string {
    return new URL(typeof input === 'string' ? input : input.toString()).pathname;
  }

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
    expect(headersSeen()[1]).toBe('7');
  });

  const sessionFrame = (seq: number): string =>
    `event: session\ndata: {"type":"session","managerId":"m1","sessionId":"s${String(seq)}"}\nid: ${String(seq)}\n\n`;

  it('runner が入れ替わって連番が小さくなったら、接続の最初の id で申告を置き換える（#3036）', async () => {
    const { fetchFn, headersSeen } = eventsFetchRecordingLastEventId((callIndex) => {
      if (callIndex === 0) return [sessionFrame(50)];
      if (callIndex === 1) return [sessionFrame(1)];
      if (callIndex === 2) return [];
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
    await expect.poll(() => headersSeen().length >= 3, { timeout: 2000 }).toBe(true);
    await client.close();

    expect(headersSeen().slice(0, 3)).toEqual([undefined, '50', '1']);
    expect(events).toHaveLength(2);
  });

  it('同じ接続の中では、小さい id が来ても申告は戻らない（置き換えは接続の最初の id だけ）', async () => {
    const { fetchFn, headersSeen } = eventsFetchRecordingLastEventId((callIndex) => {
      if (callIndex === 0) return [sessionFrame(5), sessionFrame(3)];
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

    expect(headersSeen()[1]).toBe('5');
  });

  it('同じ runner の繋ぎ直し（最初の id が申告より大きい）では進む', async () => {
    const { fetchFn, headersSeen } = eventsFetchRecordingLastEventId((callIndex) => {
      if (callIndex === 0) return [sessionFrame(7)];
      if (callIndex === 1) return [sessionFrame(8), sessionFrame(9)];
      if (callIndex === 2) return [];
      return null;
    });
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      sleepFn: async () => undefined,
    });
    await client.connect(() => undefined);
    await expect.poll(() => headersSeen().length >= 3, { timeout: 2000 }).toBe(true);
    await client.close();

    expect(headersSeen().slice(0, 3)).toEqual([undefined, '7', '9']);
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

describe('RunnerHttpError の message は本文を伏せて切る（issue #2415）', () => {
  const FAKE = 'FAKE_SECRET_VALUE_2415B';

  const failWith = async (status: number, body: string): Promise<unknown> => {
    const fetchFn = (async () => new Response(body, { status })) as unknown as typeof fetch;
    return createHttpRunner({ baseUrl: 'http://runner.test', token: TOKEN, fetchFn }).then(
      () => undefined,
      (error: unknown) => error,
    );
  };

  it('本文の値は出ず、status は残り、診断の語（host）は残る', async () => {
    const error = await failWith(
      400,
      `connect postgres://u:${FAKE}@db.internal:5432/x Authorization: Bearer ${FAKE}`,
    );

    expect(error).toBeInstanceOf(RunnerHttpError);
    const httpError = error as RunnerHttpError;
    expect(httpError.status).toBe(400);
    expect(httpError.message).toContain('(400)');
    expect(httpError.message).not.toContain(FAKE);
    expect(httpError.message).toContain('db.internal:5432');
  });

  it('params: 以降は落ちる', async () => {
    const error = (await failWith(
      400,
      `Failed query: select 1\nparams: ${FAKE}`,
    )) as RunnerHttpError;

    expect(error.message).not.toContain(FAKE);
    expect(error.message).toContain('Failed query: select 1');
    expect(error.message).toContain('params: [REDACTED]');
  });

  it('長い本文は切る（前置きの分を除いて 512 字＋印）', async () => {
    const error = (await failWith(400, 'z'.repeat(100_000))) as RunnerHttpError;

    expect(error.status).toBe(400);
    expect(error.message).toContain('z'.repeat(512));
    expect(error.message).not.toContain('z'.repeat(513));
    expect(error.message.endsWith('…')).toBe(true);
    expect(error.message.length).toBeLessThan(700);
  });

  it('切り口をまたぐトークンの断片は残らない（伏せてから切る）', async () => {
    const token = `ghp_${'1234567890abcdef1234567890abcdef1234'}`;
    const error = (await failWith(400, `${'a '.repeat(250)}${token} tail`)) as RunnerHttpError;

    expect(error.message).not.toContain('ghp_');
    expect(error.message).not.toContain('1234567890abcdef');
  });
});

describe('awaitStreamEnd（Issue #2749。畳み始めた runner の最後の出来事を受け切る）', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  function streamingFetch(): {
    fetchFn: typeof fetch;
    eventsCalls: () => number;
    endStream: () => void;
  } {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    let calls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      const path = new URL(
        typeof input === 'string' ? input : 'url' in input ? input.url : input.href,
      ).pathname;
      if (path === '/health') {
        return Response.json({ runnerId: 'runner-farewell', workspacePath: '/workspace' });
      }
      if (path === '/events') {
        calls += 1;
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
    return { fetchFn, eventsCalls: () => calls, endStream: () => controllerRef?.close() };
  }

  it('ストリームが開いている間は解けず、閉じたら解ける。閉じたあとは繋ぎ直さない', async () => {
    const { fetchFn, eventsCalls, endStream } = streamingFetch();
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: 'tok',
      fetchFn,
      sleepFn: async () => undefined,
    });
    await client.connect(() => undefined);
    await vi.waitFor(() => expect(eventsCalls()).toBe(1));
    expect(eventsCalls()).toBe(1);

    let ended = false;
    const waiting = client.awaitStreamEnd?.().then(() => (ended = true));
    await flush();
    expect(ended).toBe(false);

    endStream();
    await waiting;
    expect(ended).toBe(true);

    await flush();
    expect(eventsCalls()).toBe(1);
    await client.close();
  });

  it('ストリームが開いていなければ即座に解ける', async () => {
    const { fetchFn } = streamingFetch();
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: 'tok',
      fetchFn,
    });
    await client.awaitStreamEnd?.();
    await client.close();
  });
});
