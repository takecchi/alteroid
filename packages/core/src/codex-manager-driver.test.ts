import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type { AgentUserInput } from './agent-session.js';
import type {
  AgentChildProcess,
  AgentManagerSessionSpec,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentSpawnOptions,
} from './agent-session.js';
import { CODEX_AUTH_NONE_REASON } from './codex-auth.js';
import {
  buildCodexAppServerArgs,
  CODEX_EPHEMERAL_AUTH_OVERRIDE,
  CodexManagerDriver,
  codexApprovalPolicyFor,
} from './codex-manager-driver.js';
import { toCodexMcpServersConfig } from './codex-mcp-config.js';
import { CODEX_PROVIDER } from './codex-provider.js';
import { codexUsageToLedgerTotals } from './codex-usage-ledger.js';
import { PERMISSION_MODES } from './permission-mode.js';
import { composeAttachmentInput, type PlacedAttachment } from './runner-attachments.js';

const FAKE_KEY = 'sk-fake-0000-test-key-not-real';

type Json = Record<string, unknown>;

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Json[] = [];
  killed = false;
  exitCode: number | null = null;
  readonly kills: string[] = [];
  readonly pid = 4242;
  #buffer = '';
  #turns = 0;
  readonly #waiting = new Map<number | string, (response: Json) => void>();
  nextServerRequestId = 9000;

  script: {
    account?: Json | null;
    loginError?: string;
    turnStartError?: string;
    onTurn?: (turnNumber: number, text: string, turnId: string) => void;
    model?: string;
  } = {};

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim() !== '') this.#handle(JSON.parse(line) as Json);
        index = this.#buffer.indexOf('\n');
      }
    });
  }

  kill(signal: string): boolean {
    this.kills.push(signal);
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }

  crash(): void {
    this.exitCode = 1;
    this.emit('exit', 1, null);
  }

  send(message: Json): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextServerRequestId++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  methods(): string[] {
    return this.received
      .filter((m) => typeof m['method'] === 'string')
      .map((m) => m['method'] as string);
  }

  paramsOf(method: string): Json[] {
    return this.received.filter((m) => m['method'] === method).map((m) => m['params'] as Json);
  }

  #handle(message: Json): void {
    this.received.push(message);
    const id = message['id'];
    const method = message['method'];
    if (typeof method !== 'string') {
      if (typeof id === 'number' || typeof id === 'string') this.#waiting.get(id)?.(message);
      return;
    }
    if (id === undefined) return;
    const reply = (result: unknown): void => this.send({ id, result });
    switch (method) {
      case 'initialize':
        reply({ userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' });
        return;
      case 'account/login/start':
        if (this.script.loginError !== undefined) {
          this.send({ id, error: { code: -32000, message: this.script.loginError } });
          return;
        }
        reply({ type: 'apiKey' });
        return;
      case 'account/read':
        reply({ requiresOpenaiAuth: true, account: this.script.account ?? null });
        return;
      case 'thread/start':
      case 'thread/resume': {
        const threadId =
          method === 'thread/resume' ? String((message['params'] as Json)['threadId']) : 'thr-1';
        reply({
          thread: { id: threadId, cwd: '/w' },
          model: this.script.model ?? 'gpt-5',
          approvalPolicy: 'on-request',
        });
        return;
      }
      case 'turn/start': {
        if (this.script.turnStartError !== undefined) {
          this.send({ id, error: { code: -32000, message: this.script.turnStartError } });
          return;
        }
        this.#turns += 1;
        const turnId = `turn-${this.#turns}`;
        const params = message['params'] as Json;
        const input = params['input'] as Json[];
        reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
        const text = String(input[0]?.['text'] ?? '');
        const turnNumber = this.#turns;
        setImmediate(() => this.script.onTurn?.(turnNumber, text, turnId));
        return;
      }
      case 'turn/interrupt':
        reply({});
        return;
      default:
        reply({});
    }
  }

  completeTurn(turnId: string, status = 'completed', error?: Json): void {
    this.notify('turn/completed', {
      threadId: 'thr-1',
      turn: { id: turnId, status, items: [], ...(error === undefined ? {} : { error }) },
    });
  }

  asChild(): AgentChildProcess {
    return this as unknown as AgentChildProcess;
  }
}

class InputFeed {
  readonly #items: (string | AgentUserInput)[] = [];
  #ended = false;
  #waiter: (() => void) | undefined;
  pulled = 0;

  push(text: string | AgentUserInput): void {
    this.#items.push(text);
    this.#waiter?.();
  }

  end(): void {
    this.#ended = true;
    this.#waiter?.();
  }

  async *stream(): AsyncGenerator<AgentUserInput> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        this.pulled += 1;
        yield typeof next === 'string' ? { text: next } : next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
      this.#waiter = undefined;
    }
  }
}

interface Harness {
  server: FakeAppServer;
  feed: InputFeed;
  events: AgentEvent[];
  spawned: AgentSpawnOptions[];
  permissionRequests: AgentPermissionRequest[];
  notes: string[];
  spec: AgentManagerSessionSpec;
  run: () => Promise<void>;
  session: ReturnType<CodexManagerDriver['open']>;
}

function setup(
  options: {
    env?: Record<string, string>;
    permissionMode?: AgentManagerSessionSpec['permissionMode'];
    modelPlaced?: boolean;
    resume?: string;
    decision?: AgentPermissionDecision;
    script?: FakeAppServer['script'];
    closeGraceMs?: number;
    mcpServers?: Record<string, unknown>;
    plugins?: { path: string; skipMcpDiscovery: boolean }[];
    strictApprovals?: boolean;
  } = {},
): Harness {
  const server = new FakeAppServer();
  server.script = options.script ?? {};
  const feed = new InputFeed();
  const events: AgentEvent[] = [];
  const spawned: AgentSpawnOptions[] = [];
  const permissionRequests: AgentPermissionRequest[] = [];
  const notes: string[] = [];
  const spec = {
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    input: feed.stream(),
    model: 'opus',
    ...(options.modelPlaced === undefined ? {} : { modelPlaced: options.modelPlaced }),
    permissionMode: options.permissionMode ?? 'auto',
    ...(options.strictApprovals === undefined ? {} : { strictApprovals: options.strictApprovals }),
    systemPromptAppend: 'あなたはマネージャー',
    workerAgentName: 'worker',
    workerPrompt: 'w',
    workerModel: 'sonnet',
    cwd: '/work',
    env: options.env ?? {},
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    managerAutoMemoryEnabled: false,
    sessionLog: { append: async () => undefined, load: async () => null },
    spawnProcess: (spawnOptions: AgentSpawnOptions) => {
      spawned.push(spawnOptions);
      return server.asChild();
    },
    onNote: (text: string) => notes.push(text),
    onPermission: async (request: AgentPermissionRequest) => {
      permissionRequests.push(request);
      return options.decision ?? { behavior: 'allow' };
    },
    onPreToolUse: vi.fn(),
    onPermissionDenied: vi.fn(),
    onPostToolUse: vi.fn(),
    onPostToolUseFailure: vi.fn(),
    onPreCompact: vi.fn(),
    onUserPromptSubmit: vi.fn(),
    onSubagentStop: vi.fn(),
    onStop: vi.fn(),
  } as unknown as AgentManagerSessionSpec;
  const session = new CodexManagerDriver({ closeGraceMs: options.closeGraceMs ?? 0 }).open(spec);
  return {
    server,
    feed,
    events,
    spawned,
    permissionRequests,
    notes,
    spec,
    session,
    run: () =>
      session.readEvents(async (event) => {
        events.push(event);
      }),
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 20_000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`待ちが終わらない: ${what}`);
}

const types = (events: readonly AgentEvent[]): string[] => events.map((e) => e.type);

describe('純粋な部品', () => {
  it('権限モードから approvalPolicy: bypassPermissions だけが never、他は on-request', () => {
    for (const mode of PERMISSION_MODES) {
      expect(codexApprovalPolicyFor(mode)).toBe(
        mode === 'bypassPermissions' ? 'never' : 'on-request',
      );
    }
    expect(codexApprovalPolicyFor('dontAsk')).toBe('on-request');
  });

  it('起動引数: ephemeral は鍵のあるときだけ、-c は subcommand の前', () => {
    expect(buildCodexAppServerArgs({ ephemeralCredentials: true })).toEqual([
      '-c',
      CODEX_EPHEMERAL_AUTH_OVERRIDE,
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(CODEX_EPHEMERAL_AUTH_OVERRIDE).toBe('cli_auth_credentials_store="ephemeral"');
    expect(buildCodexAppServerArgs({ ephemeralCredentials: false })).toEqual([
      'app-server',
      '--listen',
      'stdio://',
    ]);
  });
});

describe('CodexManagerDriver: 起動・認証・thread', () => {
  it('鍵あり: ephemeral で起動し、account/login/start で鍵を渡し、sandbox と approvalPolicy を与える', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY, PATH: '/bin' } });
    h.feed.end();
    await h.run();

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.command).toBe('codex');
    expect(h.spawned[0]!.args).toEqual(buildCodexAppServerArgs({ ephemeralCredentials: true }));
    expect(h.spawned[0]!.cwd).toBe('/work');
    expect('CODEX_API_KEY' in h.spawned[0]!.env).toBe(false);
    expect(h.spawned[0]!.env['PATH']).toBe('/bin');
    expect(h.server.methods().slice(0, 4)).toEqual([
      'initialize',
      'initialized',
      'account/login/start',
      'thread/start',
    ]);
    expect(h.server.paramsOf('account/login/start')[0]).toEqual({
      type: 'apiKey',
      apiKey: FAKE_KEY,
    });
    const start = h.server.paramsOf('thread/start')[0]!;
    expect(start['sandbox']).toBe('danger-full-access');
    expect(start['approvalPolicy']).toBe('on-request');
    expect(start['cwd']).toBe('/work');
    expect(start['developerInstructions']).toBe('あなたはマネージャー');
    expect('model' in start).toBe(false);
    expect(h.events[0]).toMatchObject({
      type: 'session_started',
      sessionId: 'thr-1',
      runtime: { model: 'gpt-5', apiKeySource: 'CODEX_API_KEY', mcpServers: null },
    });
    expect(h.server.kills).toEqual(['SIGTERM']);
  });

  it('strictApprovals（peer のセッション）は、bypassPermissions でも untrusted にする', async () => {
    const h = setup({
      env: { CODEX_API_KEY: FAKE_KEY },
      permissionMode: 'bypassPermissions',
      strictApprovals: true,
    });
    h.feed.end();
    await h.run();
    expect(h.server.paramsOf('thread/start')[0]!['approvalPolicy']).toBe('untrusted');
  });

  it('モデルは人間が置いたときだけ渡す。bypassPermissions は never', async () => {
    const h = setup({
      env: { CODEX_API_KEY: FAKE_KEY },
      modelPlaced: true,
      permissionMode: 'bypassPermissions',
    });
    h.feed.end();
    await h.run();
    const start = h.server.paramsOf('thread/start')[0]!;
    expect(start['model']).toBe('opus');
    expect(start['approvalPolicy']).toBe('never');
  });

  it('resume は thread/resume に threadId を渡す', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY }, resume: 'thr-old' });
    h.feed.end();
    await h.run();
    expect(h.server.methods()).toContain('thread/resume');
    expect(h.server.methods()).not.toContain('thread/start');
    const resume = h.server.paramsOf('thread/resume')[0]!;
    expect(resume['threadId']).toBe('thr-old');
    expect(resume['sandbox']).toBe('danger-full-access');
    expect(h.events[0]).toMatchObject({ type: 'session_started', sessionId: 'thr-old' });
  });

  it('鍵なし・ChatGPT ログインあり: ephemeral にせず、login もしない', async () => {
    const h = setup({
      env: {},
      script: { account: { type: 'chatgpt', email: null, planType: 'plus' } },
    });
    h.feed.end();
    await h.run();
    expect(h.spawned[0]!.args).toEqual(buildCodexAppServerArgs({ ephemeralCredentials: false }));
    expect(h.spawned[0]!.args).not.toContain('-c');
    expect(h.server.methods()).toContain('account/read');
    expect(h.server.methods()).not.toContain('account/login/start');
    expect(h.server.methods()).toContain('thread/start');
    expect(h.events[0]).toMatchObject({ runtime: { apiKeySource: 'chatgpt' } });
  });

  it('鍵も ChatGPT ログインも無ければ、thread を開けずに失敗する（黙って進めない）', async () => {
    const h = setup({ env: { CODEX_API_KEY: '   ' }, script: { account: null } });
    h.feed.push('こんにちは');
    await expect(h.run()).rejects.toThrow(CODEX_AUTH_NONE_REASON);
    expect(h.server.methods()).not.toContain('thread/start');
    expect(h.server.methods()).not.toContain('turn/start');
    expect(h.server.kills).toEqual(['SIGTERM']);
  });

  it('鍵なしで account が apiKey 種別（auth.json の別の鍵）でも、ChatGPT ではないので失敗する', async () => {
    const h = setup({ env: {}, script: { account: { type: 'apiKey' } } });
    await expect(h.run()).rejects.toThrow(CODEX_AUTH_NONE_REASON);
  });

  it('子プロセスが途中で落ちたら readEvents は reject する', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    const done = h.run();
    done.catch(() => undefined);
    await until(() => h.events.length > 0, 'session_started');
    h.server.crash();
    await expect(done).rejects.toThrow(/終了した/);
  });
});

describe('CodexManagerDriver: MCP サーバ', () => {
  const SECRET = 'sk-secret-value-123';
  const servers = {
    local: { command: 'node', args: ['srv.js'], env: { API_KEY: SECRET } },
    remote: {
      type: 'http',
      url: 'https://mcp.example/x',
      headers: { Authorization: SECRET },
      timeout: 5,
    },
    legacy: { type: 'sse', url: 'https://mcp.example/sse', headers: { Authorization: SECRET } },
    inproc: { type: 'sdk', name: 'inproc' },
  };

  it('thread/start の config に mcp_servers を渡し、写せない種別は名前と理由だけの note を残す', async () => {
    const h = setup({ env: { CODEX_API_KEY: 'k' }, mcpServers: servers });
    const done = h.run();
    await until(() => h.events.length > 0, 'session_started');
    const start = h.server.paramsOf('thread/start')[0]!;
    expect(start['config']).toEqual({
      mcp_servers: {
        local: { command: 'node', args: ['srv.js'], env: { API_KEY: SECRET } },
        remote: { url: 'https://mcp.example/x', http_headers: { Authorization: SECRET } },
      },
    });
    expect(h.events[0]).toMatchObject({
      type: 'session_started',
      runtime: {
        mcpServers: [
          { name: 'local', status: 'configured' },
          { name: 'remote', status: 'configured' },
        ],
      },
    });
    expect(h.notes.some((n) => n.includes('legacy') && n.includes('sse'))).toBe(true);
    expect(h.notes.some((n) => n.includes('inproc') && n.includes('インプロセス'))).toBe(true);
    expect(h.notes.some((n) => n.includes('remote') && n.includes('timeout'))).toBe(true);
    expect(JSON.stringify(h.notes)).not.toContain(SECRET);
    expect(JSON.stringify(h.spawned.map((s) => s.args))).not.toContain(SECRET);
    h.feed.end();
    await done;
  });

  it('thread/resume にも同じ config を渡す', async () => {
    const h = setup({ env: { CODEX_API_KEY: 'k' }, resume: 'thr-9', mcpServers: servers });
    const done = h.run();
    await until(() => h.events.length > 0, 'session_started');
    const resume = h.server.paramsOf('thread/resume')[0]!;
    expect(resume['threadId']).toBe('thr-9');
    expect(Object.keys((resume['config'] as { mcp_servers: object }).mcp_servers)).toEqual([
      'local',
      'remote',
    ]);
    h.feed.end();
    await done;
  });

  it('mcpServers が無い・空・全部写せないときは config を付けず、params は従来と同一', async () => {
    for (const mcpServers of [undefined, {}, { inproc: { type: 'sdk' } }]) {
      const h = setup({
        env: { CODEX_API_KEY: 'k' },
        ...(mcpServers === undefined ? {} : { mcpServers }),
      });
      const done = h.run();
      await until(() => h.events.length > 0, 'session_started');
      expect(JSON.stringify(h.server.paramsOf('thread/start')[0])).toBe(
        JSON.stringify({
          cwd: '/work',
          approvalPolicy: 'on-request',
          sandbox: 'danger-full-access',
          developerInstructions: 'あなたはマネージャー',
        }),
      );
      expect(h.events[0]).toMatchObject({ runtime: { mcpServers: null } });
      h.feed.end();
      await done;
    }
  });

  it('plugins が載っていても thread/start へは渡さず、渡していないことを note に残す', async () => {
    const h = setup({
      env: { CODEX_API_KEY: 'k' },
      plugins: [{ path: '/p/one@aaaa', skipMcpDiscovery: true }],
    });
    const done = h.run();
    await until(() => h.events.length > 0, 'session_started');
    expect(JSON.stringify(h.server.paramsOf('thread/start')[0])).not.toContain('/p/one');
    expect(
      h.notes.some((n) => n.includes('plugin') && n.includes('Codex') && n.includes('1')),
    ).toBe(true);
    expect(JSON.stringify(h.notes)).not.toContain('/p/one');
    h.feed.end();
    await done;
  });

  it('plugins が無ければ plugin の note は出さない', async () => {
    const h = setup({ env: { CODEX_API_KEY: 'k' }, plugins: [] });
    const done = h.run();
    await until(() => h.events.length > 0, 'session_started');
    expect(h.notes.some((n) => n.includes('plugin'))).toBe(false);
    h.feed.end();
    await done;
  });
});

describe('toCodexMcpServersConfig', () => {
  it('入力が無ければ config は null', () => {
    expect(toCodexMcpServersConfig(undefined)).toEqual({
      config: null,
      passed: [],
      skipped: [],
      droppedFields: [],
    });
  });
});

describe('CodexManagerDriver: ターン', () => {
  it('入力 → turn/start → 完了 → 次の入力。ターンの終わりまで次を引かない', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    let pendingCompletion: (() => void) | undefined;
    h.server.script.onTurn = (n, text, turnId) => {
      h.server.notify('item/started', {
        threadId: 'thr-1',
        turnId,
        item: { type: 'commandExecution', id: `cmd-${n}`, command: 'ls', status: 'inProgress' },
      });
      h.server.notify('item/completed', {
        threadId: 'thr-1',
        turnId,
        item: { type: 'commandExecution', id: `cmd-${n}`, command: 'ls', status: 'completed' },
      });
      h.server.notify('item/agentMessage/delta', {
        threadId: 'thr-1',
        turnId,
        itemId: `msg-${n}`,
        delta: '考え',
      });
      h.server.notify('item/completed', {
        threadId: 'thr-1',
        turnId,
        item: { type: 'agentMessage', id: `msg-${n}`, text: `答え: ${text}` },
      });
      if (n === 1) {
        pendingCompletion = () => h.server.completeTurn(turnId);
      } else {
        h.server.completeTurn(turnId);
      }
    };
    h.feed.push('一件目');
    h.feed.push('二件目');
    const done = h.run();

    await until(() => h.server.paramsOf('turn/start').length === 1, '1件目の turn/start');
    await until(() => pendingCompletion !== undefined, '1件目の応答');
    for (let i = 0; i < 200; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(h.server.paramsOf('turn/start')).toHaveLength(1);
    expect(h.feed.pulled).toBe(1);
    pendingCompletion!();

    await until(() => h.server.paramsOf('turn/start').length === 2, '2件目の turn/start');
    await until(
      () => h.events.filter((e) => e.type === 'turn_ended').length === 2,
      '2件の turn_ended',
    );
    h.feed.end();
    await done;

    const starts = h.server.paramsOf('turn/start');
    expect(starts[0]).toMatchObject({
      threadId: 'thr-1',
      input: [{ type: 'text', text: '一件目' }],
    });
    expect(starts[1]).toMatchObject({ input: [{ type: 'text', text: '二件目' }] });

    const first = h.events.slice(1, h.events.findIndex((e) => e.type === 'turn_ended') + 1);
    expect(types(first)).toEqual([
      'assistant_message',
      'tool_result',
      'text_delta',
      'assistant_message',
      'turn_ended',
    ]);
    expect(first[0]).toMatchObject({ blocks: [{ type: 'tool_use', name: 'commandExecution' }] });
    expect(first[3]).toMatchObject({ blocks: [{ type: 'text', text: '答え: 一件目' }] });
    expect(first[4]).toMatchObject({ succeeded: true, body: '答え: 一件目', denials: [] });
  });

  it('画像つきの入力は turn/start の input に text + image（data URL）で載り、画像が無ければ text だけ', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    h.server.script.onTurn = (_n, _t, id) => h.server.completeTurn(id);
    h.feed.push({ text: '見て', images: [{ mediaType: 'image/png', data: 'QUJD' }] });
    h.feed.push('画像なし');
    const done = h.run();
    await until(() => h.server.paramsOf('turn/start').length === 2, '2件の turn/start');
    await until(() => h.events.filter((e) => e.type === 'turn_ended').length === 2, '完了');
    h.feed.end();
    await done;
    const starts = h.server.paramsOf('turn/start');
    expect((starts[0] as Json)['input']).toEqual([
      { type: 'text', text: '見て', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,QUJD' },
    ]);
    expect((starts[1] as Json)['input']).toEqual([
      { type: 'text', text: '画像なし', text_elements: [] },
    ]);
  });

  it('担い手へ渡した添付（runner が置いて組んだ入力）は、通知行（path）つきの text と画像の data URL で turn/start に載る（#3111 段3）', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    h.server.script.onTurn = (_n, _t, id) => h.server.completeTurn(id);
    const placed: PlacedAttachment[] = [
      {
        id: 'att-img',
        name: 'shot.png',
        mediaType: 'image/png',
        size: 3,
        sha256: 'ab',
        path: '/tmp/alteroid-attachments/mgr-1/att-img/shot.png',
        image: { mediaType: 'image/png', data: 'QUJD', name: 'shot.png' },
      },
    ];
    h.feed.push(composeAttachmentInput('見て', placed));
    const done = h.run();
    await until(() => h.server.paramsOf('turn/start').length === 1, 'turn/start');
    await until(() => h.events.filter((e) => e.type === 'turn_ended').length === 1, '完了');
    h.feed.end();
    await done;
    const input = (h.server.paramsOf('turn/start')[0] as Json)['input'] as Json[];
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({ type: 'text' });
    expect(String(input[0]?.['text'])).toContain(
      'path=/tmp/alteroid-attachments/mgr-1/att-img/shot.png（画像としても渡した）（Read で開ける）',
    );
    expect(input[1]).toEqual({ type: 'image', url: 'data:image/png;base64,QUJD' });
  });

  it('turn/start が RPC エラーで返ったら、そのターンだけ失敗にして次の入力へ進む', async () => {
    const h = setup({
      env: { CODEX_API_KEY: FAKE_KEY },
      script: { turnStartError: 'model not found' },
    });
    h.feed.push('x');
    const done = h.run();
    await until(() => h.events.some((e) => e.type === 'turn_ended'), 'turn_ended');
    h.server.script.turnStartError = undefined as unknown as string;
    h.server.script.onTurn = (_n, _t, id) => h.server.completeTurn(id);
    h.feed.push('y');
    await until(() => h.events.filter((e) => e.type === 'turn_ended').length === 2, '2件目');
    h.feed.end();
    await done;
    const ended = h.events.filter((e) => e.type === 'turn_ended');
    expect(ended[0]).toMatchObject({
      succeeded: false,
      failure: { via: 'result_subtype', code: 'rpc_error', text: 'model not found' },
    });
    expect(ended[1]).toMatchObject({ succeeded: true });
  });

  it('失敗したターンは succeeded: false で、理由を運ぶ', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    h.server.script.onTurn = (_n, _t, id) =>
      h.server.completeTurn(id, 'failed', { message: 'upstream exploded' });
    h.feed.push('x');
    h.feed.end();
    await h.run();
    const ended = h.events.find((e) => e.type === 'turn_ended');
    expect(ended).toMatchObject({
      succeeded: false,
      outcome: 'failed',
      failure: { code: 'failed', text: 'upstream exploded' },
      errorLines: ['upstream exploded'],
    });
    expect((ended as { usage?: unknown }).usage).toBeUndefined();
  });
});

describe('CodexManagerDriver: 承認', () => {
  async function withOpenSession(decision: AgentPermissionDecision): Promise<Harness> {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY }, decision });
    h.run().catch(() => undefined);
    await until(() => h.events.length > 0, 'session_started');
    return h;
  }

  it('command の承認: allow → accept、deny → decline（cancel にしない）', async () => {
    const allow = await withOpenSession({ behavior: 'allow' });
    const accepted = await allow.server.request('item/commandExecution/requestApproval', {
      threadId: 'thr-1',
      turnId: 't',
      itemId: 'item-1',
      approvalId: 'appr-1',
      command: 'rm -rf build',
      cwd: '/work',
      reason: 'ビルド掃除',
    });
    expect(accepted['result']).toEqual({ decision: 'accept' });
    expect(allow.permissionRequests[0]).toMatchObject({
      requestId: 'appr-1',
      kind: 'permission',
      toolName: 'commandExecution',
      input: { command: 'rm -rf build', cwd: '/work', reason: 'ビルド掃除' },
    });
    allow.session.close();

    const deny = await withOpenSession({ behavior: 'deny', message: 'だめ' });
    const declined = await deny.server.request('item/commandExecution/requestApproval', {
      threadId: 'thr-1',
      turnId: 't',
      itemId: 'item-2',
      command: 'curl x',
    });
    expect(declined['result']).toEqual({ decision: 'decline' });
    expect(deny.permissionRequests[0]).toMatchObject({ requestId: 'item-2' });
    deny.session.close();
  });

  it('fileChange の承認も同じ写し', async () => {
    const h = await withOpenSession({ behavior: 'allow' });
    const accepted = await h.server.request('item/fileChange/requestApproval', {
      threadId: 'thr-1',
      turnId: 't',
      itemId: 'fc-1',
      reason: '設定を直す',
    });
    expect(accepted['result']).toEqual({ decision: 'accept' });
    expect(h.permissionRequests[0]).toMatchObject({
      kind: 'permission',
      toolName: 'fileChange',
      requestId: 'fc-1',
    });
    h.session.close();
  });

  it('serverRequest/resolved で、待っている承認の signal が abort される', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    let seen: AbortSignal | undefined;
    (h.spec as { onPermission: unknown }).onPermission = (request: AgentPermissionRequest) => {
      seen = request.signal;
      return new Promise(() => undefined);
    };
    h.run().catch(() => undefined);
    await until(() => h.events.length > 0, 'session_started');
    void h.server.request('item/fileChange/requestApproval', {
      threadId: 'thr-1',
      turnId: 't',
      itemId: 'fc-2',
    });
    await until(() => seen !== undefined, 'onPermission');
    expect(seen!.aborted).toBe(false);
    h.server.notify('serverRequest/resolved', { threadId: 'thr-1', requestId: 9000 });
    await until(() => seen!.aborted, 'abort');
    h.session.close();
  });

  it('elicitation / permissions / requestUserInput は、クローンへ回さず止まらずに答え、観測を残す', async () => {
    const h = await withOpenSession({ behavior: 'allow' });

    const elicitation = await h.server.request('mcpServer/elicitation/request', {
      threadId: 'thr-1',
      serverName: 'notion',
      message: 'トークンを入れて',
    });
    expect(elicitation['result']).toEqual({ action: 'decline' });

    const permissions = await h.server.request('item/permissions/requestApproval', {
      threadId: 'thr-1',
      turnId: 't',
      itemId: 'perm-1',
      cwd: '/work',
      permissions: { network: { enabled: true } },
    });
    expect(permissions['result']).toEqual({ permissions: {} });

    const userInput = await h.server.request('item/tool/requestUserInput', {
      threadId: 'thr-1',
      turnId: 't',
      itemId: 'ui-1',
      isBlocking: true,
      questions: [{ id: 'q', header: 'h', question: '?' }],
    });
    expect(userInput['error']).toMatchObject({ code: -32601 });
    expect(userInput['result']).toBeUndefined();

    expect(h.permissionRequests).toHaveLength(0);

    expect(h.notes).toHaveLength(3);
    expect(h.notes[0]).toContain('elicitation');
    expect(h.notes[1]).toContain('item/permissions/requestApproval');
    expect(h.notes[2]).toContain('requestUserInput');
    expect(h.events.some((e) => e.type === 'permission_denied')).toBe(false);
    expect(JSON.stringify(h.notes)).not.toContain('トークンを入れて');
    h.session.close();
  });
});

describe('CodexManagerDriver: close', () => {
  it('進行中のターンがあれば turn/interrupt を送ってから子を止める。readEvents は正常に終わる', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    h.server.script.onTurn = () => undefined;
    h.feed.push('長い仕事');
    const done = h.run();
    await until(() => h.server.paramsOf('turn/start').length === 1, 'turn/start');
    await until(() => h.events.length > 0, 'events');
    h.session.close();
    await done;

    await until(() => h.server.paramsOf('turn/interrupt').length === 1, 'turn/interrupt');
    expect(h.server.paramsOf('turn/interrupt')[0]).toEqual({ threadId: 'thr-1', turnId: 'turn-1' });
    expect(h.server.methods().indexOf('turn/interrupt')).toBeGreaterThan(
      h.server.methods().indexOf('turn/start'),
    );
    expect(h.server.kills).toEqual(['SIGTERM']);
  });

  it('ターンが無ければ interrupt は送らず、二度呼んでも投げない', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    const done = h.run();
    await until(() => h.events.length > 0, 'session_started');
    h.session.close();
    h.session.close();
    await done;
    expect(h.server.methods()).not.toContain('turn/interrupt');
    expect(h.server.kills).toEqual(['SIGTERM']);
  });
});

describe('CodexManagerDriver: 使用量', () => {
  const usage = (input: number, cached: number, output: number): Json => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  });

  it('last を通知ごとに足し、total は使わず、app-server が返した実際のモデル名で価格計算する', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY }, script: { model: 'gpt-5' } });
    h.server.script.onTurn = (n, _t, turnId) => {
      const total = usage(999_999, 0, 999_999);
      if (n === 1) {
        h.server.notify('thread/tokenUsage/updated', {
          threadId: 'thr-1',
          turnId,
          tokenUsage: { total, last: usage(1000, 200, 100) },
        });
        h.server.notify('thread/tokenUsage/updated', {
          threadId: 'thr-1',
          turnId,
          tokenUsage: { total, last: usage(2000, 0, 50) },
        });
        h.server.notify('model/rerouted', {
          threadId: 'thr-1',
          turnId,
          fromModel: 'gpt-5',
          toModel: 'gpt-5-mini',
          reason: 'highRiskCyberActivity',
        });
        h.server.notify('thread/tokenUsage/updated', {
          threadId: 'thr-1',
          turnId,
          tokenUsage: { total, last: usage(4000, 1000, 400) },
        });
      } else {
        h.server.notify('thread/tokenUsage/updated', {
          threadId: 'thr-1',
          turnId,
          tokenUsage: { total, last: usage(500, 0, 10) },
        });
      }
      h.server.completeTurn(turnId);
    };
    h.feed.push('a');
    h.feed.push('b');
    const done = h.run();
    await until(() => h.events.filter((e) => e.type === 'turn_ended').length === 2, '2ターン');
    h.feed.end();
    await done;

    const ended = h.events.filter((e) => e.type === 'turn_ended') as Extract<
      AgentEvent,
      { type: 'turn_ended' }
    >[];
    const expectedFirst = {
      'gpt-5': codexUsageToLedgerTotals('gpt-5', {
        kind: 'requests',
        requests: [
          { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 },
          { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 50 },
        ],
      }),
      'gpt-5-mini': codexUsageToLedgerTotals('gpt-5-mini', {
        kind: 'requests',
        requests: [{ inputTokens: 4000, cachedInputTokens: 1000, outputTokens: 400 }],
      }),
    };
    expect(ended[0]!.usage!.models).toEqual(expectedFirst);
    expect(ended[0]!.usage!.sessionId).toBe('thr-1');
    expect(expectedFirst['gpt-5'].costUsd).toBeGreaterThan(0);
    expect(expectedFirst['gpt-5-mini'].costUsd).toBeGreaterThan(0);
    expect(expectedFirst['gpt-5'].inputTokens).toBe(800 + 2000);
    expect(ended[1]!.usage!.models['gpt-5']).toEqual(expectedFirst['gpt-5']);
    expect(ended[1]!.usage!.models['gpt-5-mini']).toEqual(
      codexUsageToLedgerTotals('gpt-5-mini', {
        kind: 'requests',
        requests: [
          { inputTokens: 4000, cachedInputTokens: 1000, outputTokens: 400 },
          { inputTokens: 500, cachedInputTokens: 0, outputTokens: 10 },
        ],
      }),
    );
    expect(await h.session.sessionModelUsage()).toEqual(ended[1]!.usage!.models);
  });

  it('表に無いモデルは、費用を読めなかったことにする（0 を使っていないと読ませない）', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY }, script: { model: 'gpt-unknown-9' } });
    h.server.script.onTurn = (_n, _t, turnId) => {
      h.server.notify('thread/tokenUsage/updated', {
        threadId: 'thr-1',
        turnId,
        tokenUsage: { total: usage(1, 0, 1), last: usage(100, 0, 10) },
      });
      h.server.completeTurn(turnId);
    };
    h.feed.push('a');
    h.feed.end();
    await h.run();
    const ended = h.events.find((e) => e.type === 'turn_ended') as Extract<
      AgentEvent,
      { type: 'turn_ended' }
    >;
    const row = ended.usage!.models['gpt-unknown-9']!;
    expect(row.costUsd).toBe(0);
    expect(row.unreadable).toMatchObject({ costUsd: 1, webSearchRequests: 1 });
    expect(row.inputTokens).toBe(100);
  });

  it('使用量の通知が1件も無いターンは usage を付けない', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    h.server.script.onTurn = (_n, _t, turnId) => h.server.completeTurn(turnId);
    h.feed.push('a');
    h.feed.end();
    await h.run();
    const ended = h.events.find((e) => e.type === 'turn_ended') as { usage?: unknown };
    expect(ended.usage).toBeUndefined();
    expect(await h.session.sessionModelUsage()).toBeUndefined();
  });

  it('contextUsage は作り物を返さず reject する', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    await expect(h.session.contextUsage()).rejects.toThrow();
  });
});

describe('CodexManagerDriver: 鍵が出力に漏れない', () => {
  it('login の失敗・ターンの失敗・イベント・例外文のどこにも鍵の値が載らない', async () => {
    const login = setup({
      env: { CODEX_API_KEY: FAKE_KEY },
      script: { loginError: `Incorrect API key provided: ${FAKE_KEY}` },
    });
    login.feed.push('x');
    let thrown: unknown;
    try {
      await login.run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const dump = (value: unknown): string =>
      JSON.stringify(value, (_k, v: unknown) =>
        v instanceof Error
          ? { name: v.name, message: v.message, stack: v.stack, cause: v.cause }
          : v,
      );
    expect(dump(thrown)).not.toContain(FAKE_KEY);
    expect(dump(login.events)).not.toContain(FAKE_KEY);
    expect(
      login.server.received
        .filter((m) => JSON.stringify(m).includes(FAKE_KEY))
        .map((m) => m['method']),
    ).toEqual(['account/login/start']);

    const turn = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    turn.server.script.onTurn = (_n, _t, id) =>
      turn.server.completeTurn(id, 'failed', { message: `401 for key ${FAKE_KEY}` });
    turn.feed.push('x');
    turn.feed.end();
    await turn.run();
    expect(dump(turn.events)).not.toContain(FAKE_KEY);
    expect(dump(turn.events)).toContain('401 for key');

    const rpc = setup({
      env: { CODEX_API_KEY: FAKE_KEY },
      script: { turnStartError: `bad ${FAKE_KEY}` },
    });
    rpc.feed.push('x');
    rpc.feed.end();
    await rpc.run();
    expect(dump(rpc.events)).not.toContain(FAKE_KEY);
  });
});

async function runOneTurn(h: Harness, script: (turnId: string) => void): Promise<void> {
  h.server.script.onTurn = (_n, _t, turnId) => {
    script(turnId);
    h.server.completeTurn(turnId);
  };
  h.feed.push('x');
  h.feed.end();
  await h.run();
}

function completed(h: Harness, turnId: string, item: Json): void {
  h.server.notify('item/completed', { threadId: 'thr-1', turnId, item });
}

describe('CodexManagerDriver: ツール監査', () => {
  const hooks = (h: Harness) => ({
    ok: h.spec.onPostToolUse as unknown as ReturnType<typeof vi.fn>,
    ng: h.spec.onPostToolUseFailure as unknown as ReturnType<typeof vi.fn>,
  });

  it('道具の item の種類ごとに onPostToolUse を呼ぶ。turn_ended はフックが全部済んでから', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    const order: string[] = [];
    const { ok } = hooks(h);
    ok.mockImplementation(async (record: { toolName?: string }) => {
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`hook:${record.toolName}`);
      return { kind: 'continue' };
    });
    await runOneTurn(h, (id) => {
      completed(h, id, {
        type: 'commandExecution',
        id: 'i1',
        command: 'ls -la',
        cwd: '/work',
        commandActions: [],
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'SECRET-OUTPUT',
      });
      completed(h, id, {
        type: 'fileChange',
        id: 'i2',
        status: 'completed',
        changes: [{ path: '/work/a.ts', kind: { type: 'add' }, diff: 'SECRET-DIFF' }],
      });
      completed(h, id, {
        type: 'mcpToolCall',
        id: 'i3',
        server: 'srv',
        tool: 'lookup',
        arguments: { q: 1 },
        status: 'completed',
        result: { content: [] },
      });
      completed(h, id, {
        type: 'dynamicToolCall',
        id: 'i4',
        tool: 'dyn',
        namespace: 'ns',
        arguments: {},
        status: 'completed',
        success: true,
      });
      completed(h, id, { type: 'webSearch', id: 'i5', query: 'alteroid' });
      completed(h, id, { type: 'imageView', id: 'i6', path: '/work/x.png' });
      completed(h, id, { type: 'sleep', id: 'i7', durationMs: 10 });
      completed(h, id, {
        type: 'collabAgentToolCall',
        id: 'i8',
        tool: 'spawnAgent',
        prompt: 'p',
        status: 'completed',
        agentsStates: {},
        receiverThreadIds: [],
        senderThreadId: 't',
      });
      completed(h, id, { type: 'imageGeneration', id: 'i9', status: 'completed', result: 'r' });
      completed(h, id, { type: 'functionCallOutput', id: 'i10', name: 'fn', output: 'o' });
      completed(h, id, { type: 'reasoning', id: 'r1' });
      completed(h, id, { type: 'plan', id: 'p1', text: 't' });
    });
    const calls = ok.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.map((c) => c['toolName'])).toEqual([
      'commandExecution',
      'fileChange',
      'mcp__srv__lookup',
      'ns.dyn',
      'webSearch',
      'imageView',
      'sleep',
      'collabAgentToolCall',
      'imageGeneration',
      'fn',
    ]);
    expect(calls[0]).toMatchObject({
      toolInput: { command: 'ls -la', cwd: '/work' },
      toolResponse: { exitCode: 0 },
      toolUseId: 'i1',
    });
    expect(calls[1]).toMatchObject({ toolInput: { changes: [{ path: '/work/a.ts' }] } });
    expect(calls[2]).toMatchObject({ toolInput: { q: 1 } });
    expect(JSON.stringify(calls)).not.toMatch(/SECRET-/);
    expect(hooks(h).ng).not.toHaveBeenCalled();
    expect(order).toHaveLength(10);
    expect(types(h.events).filter((t) => t === 'tool_result')).toHaveLength(10);
    const last = h.events.findLastIndex((e) => e.type === 'tool_result');
    expect(last).toBeLessThan(h.events.findIndex((e) => e.type === 'turn_ended'));
  });

  it('失敗: status failed・終了コード非0・MCP error・success false は onPostToolUseFailure。declined は呼ばない', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    const { ok, ng } = hooks(h);
    await runOneTurn(h, (id) => {
      completed(h, id, {
        type: 'commandExecution',
        id: 'f1',
        command: 'false',
        cwd: '/w',
        commandActions: [],
        status: 'failed',
        exitCode: 1,
      });
      completed(h, id, {
        type: 'commandExecution',
        id: 'f2',
        command: 'exit 3',
        cwd: '/w',
        commandActions: [],
        status: 'completed',
        exitCode: 3,
      });
      completed(h, id, {
        type: 'mcpToolCall',
        id: 'f3',
        server: 's',
        tool: 't',
        arguments: {},
        status: 'failed',
        error: { message: `boom ${FAKE_KEY}` },
      });
      completed(h, id, {
        type: 'dynamicToolCall',
        id: 'f4',
        tool: 'd',
        arguments: {},
        status: 'completed',
        success: false,
      });
      completed(h, id, { type: 'fileChange', id: 'f5', status: 'failed', changes: [] });
      completed(h, id, { type: 'fileChange', id: 'f6', status: 'declined', changes: [] });
      completed(h, id, {
        type: 'commandExecution',
        id: 'f7',
        command: 'rm -rf /',
        cwd: '/w',
        commandActions: [],
        status: 'declined',
      });
    });
    expect(ok).not.toHaveBeenCalled();
    const failures = ng.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(failures.map((f) => f['toolUseId'])).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(failures[0]).toMatchObject({
      toolName: 'commandExecution',
      toolInput: { command: 'false' },
    });
    expect(String(failures[1]!['error'])).toContain('3');
    expect(String(failures[2]!['error'])).toContain('boom');
    expect(JSON.stringify(failures)).not.toContain(FAKE_KEY);
  });

  it('入力の中の鍵の値も伏せる。フックが投げても止まらず note に残る（鍵は載らない）', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    const { ok } = hooks(h);
    ok.mockRejectedValue(new Error(`hook failed ${FAKE_KEY}`));
    await runOneTurn(h, (id) => {
      completed(h, id, {
        type: 'commandExecution',
        id: 'k1',
        command: `curl -H "Authorization: ${FAKE_KEY}" x`,
        cwd: '/w',
        commandActions: [],
        status: 'completed',
        exitCode: 0,
      });
    });
    expect(JSON.stringify(ok.mock.calls)).not.toContain(FAKE_KEY);
    expect(h.events.map((e) => e.type)).toContain('turn_ended');
    expect(h.notes.join('\n')).toContain('フックが失敗');
    expect(h.notes.join('\n')).not.toContain(FAKE_KEY);
  });

  it('toolAudit を名乗る（スキーマの全道具の種類を覆う番人は codex-protocol.test.ts）', () => {
    expect(CODEX_PROVIDER.capabilities.toolAudit).toBe(true);
    expect(CODEX_PROVIDER.capabilities.compactionHook).toBe(false);
  });
});

describe('CodexManagerDriver: 圧縮', () => {
  const usage = (input: number): Json => ({
    inputTokens: input,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: input + 1,
  });

  it('thread/compacted → compaction（trigger auto・preTokens は直近の入力トークン）。contextCompaction item と二重に数えない', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    await runOneTurn(h, (id) => {
      h.server.notify('thread/tokenUsage/updated', {
        threadId: 'thr-1',
        turnId: id,
        tokenUsage: { total: usage(9), last: usage(1234) },
      });
      h.server.notify('thread/compacted', { threadId: 'thr-1', turnId: id });
      completed(h, id, { type: 'contextCompaction', id: 'c1' });
      completed(h, id, { type: 'contextCompaction', id: 'c2' });
      h.server.notify('thread/compacted', { threadId: 'thr-1', turnId: id });
    });
    const compactions = h.events.filter((e) => e.type === 'compaction');
    expect(compactions).toEqual([
      { type: 'compaction', trigger: 'auto', preTokens: 1234 },
      { type: 'compaction', trigger: 'auto', preTokens: 1234 },
    ]);
    expect(h.spec.onPostToolUse).not.toHaveBeenCalled();
  });

  it('直前の使用量が読めていなければ作り物を出さず note だけ', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    await runOneTurn(h, (id) =>
      h.server.notify('thread/compacted', { threadId: 'thr-1', turnId: id }),
    );
    expect(h.events.some((e) => e.type === 'compaction')).toBe(false);
    expect(h.notes.join('\n')).toContain('圧縮');
  });
});

describe('CodexManagerDriver: 枠', () => {
  it('account/rateLimits/updated → 窓ごとの rate_limit。到達していなければ usage_notice は出ない', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    await runOneTurn(h, () =>
      h.server.notify('account/rateLimits/updated', {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          secondary: { usedPercent: 10 },
          rateLimitReachedType: null,
        },
      }),
    );
    const limits = h.events.filter((e) => e.type === 'rate_limit');
    expect(limits).toEqual([
      {
        type: 'rate_limit',
        facts: {
          kind: 'codex.primary',
          status: 'allowed',
          utilization: 40,
          resetsAt: 1_900_000_000_000,
        },
      },
      {
        type: 'rate_limit',
        facts: { kind: 'codex.secondary', status: 'allowed', utilization: 10 },
      },
    ]);
    expect(h.events.some((e) => e.type === 'usage_notice')).toBe(false);
  });

  it('rateLimitReachedType が付けば usage_notice(reached)。同じ到達は繰り返さず、provider を切り替えない', async () => {
    const h = setup({ env: { CODEX_API_KEY: FAKE_KEY } });
    const reached = (percent: number): Json => ({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: percent, resetsAt: 1_900_000_000 },
        rateLimitReachedType: 'rate_limit_reached',
      },
    });
    await runOneTurn(h, () => {
      h.server.notify('account/rateLimits/updated', reached(100));
      h.server.notify('account/rateLimits/updated', reached(100));
    });
    const notices = h.events.filter((e) => e.type === 'usage_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      notice: { kind: 'reached', resetsAt: 1_900_000_000_000 },
    });
    expect(JSON.stringify(notices)).toContain('rate_limit_reached');
    expect(h.events.filter((e) => e.type === 'rate_limit')[0]).toMatchObject({
      facts: { status: 'rejected', utilization: 100 },
    });
    expect(h.spawned).toHaveLength(1);
  });
});
