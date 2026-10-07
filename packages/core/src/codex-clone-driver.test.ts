import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type { AgentCloneDriver, AgentCloneSessionSpec } from './agent-clone-session.js';
import type { AgentChildProcess, AgentSpawnOptions } from './agent-session.js';
import { missingRequirementCapabilities } from './agent-ports.js';
import {
  CodexCloneDriver,
  denyEveryApproval,
  toCodexCloneMcpServers,
  toCodexSessionSpec,
} from './codex-clone-driver.js';
import { CODEX_CLONE_PROVIDER, CODEX_PROVIDER } from './codex-provider.js';
import { resolveCloneToolsTransportFor } from './clone-tools-transport.js';
import { describeProviderGaps } from './provider-gaps.js';

const FAKE_KEY = 'sk-fake-0000-test-key-not-real';

type Json = Record<string, unknown>;

/** 最小の `codex app-server` の fake。 */
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Json[] = [];
  killed = false;
  exitCode: number | null = null;
  readonly pid = 1;
  #buffer = '';
  #turns = 0;
  onTurn?: (turnId: string, text: string) => void;

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

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }

  notify(method: string, params: Json): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  paramsOf(method: string): Json[] {
    return this.received.filter((m) => m['method'] === method).map((m) => m['params'] as Json);
  }

  #handle(message: Json): void {
    this.received.push(message);
    const id = message['id'];
    const method = message['method'];
    if (typeof method !== 'string' || id === undefined) return;
    const reply = (result: unknown): void => {
      this.stdout.write(`${JSON.stringify({ id, result })}\n`);
    };
    switch (method) {
      case 'initialize':
        reply({ userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' });
        return;
      case 'thread/start':
      case 'thread/resume':
        reply({
          thread: { id: 'thr-1', cwd: '/w' },
          model: 'gpt-5',
          approvalPolicy: 'never',
        });
        return;
      case 'turn/start': {
        this.#turns += 1;
        const turnId = `turn-${this.#turns}`;
        const input = (message['params'] as Json)['input'] as Json[];
        reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
        setImmediate(() => this.onTurn?.(turnId, String(input[0]?.['text'] ?? '')));
        return;
      }
      default:
        reply({});
    }
  }

  complete(turnId: string): void {
    this.notify('turn/completed', {
      threadId: 'thr-1',
      turn: { id: turnId, status: 'completed', items: [] },
    });
  }

  asChild(): AgentChildProcess {
    return this as unknown as AgentChildProcess;
  }
}

async function* once(text: string): AsyncGenerator<{ text: string }> {
  yield { text };
  // 次の入力は来ない（読み手が止めるまで待つ）。
  await new Promise<void>(() => undefined);
}

function cloneSpec(overrides: Partial<AgentCloneSessionSpec> = {}): AgentCloneSessionSpec {
  return {
    resume: null,
    input: once('こんにちは'),
    model: 'opus',
    permissionMode: 'auto',
    tools: {
      kind: 'stdio',
      command: '/usr/bin/node',
      args: ['/relay.js'],
      env: { SOCK: '/run/x', TOKEN: 't' },
    },
    externalMcpServers: { ext: { type: 'http', url: 'https://example.com/mcp' } },
    systemPrompt: 'あなたはクローン',
    env: { CODEX_API_KEY: FAKE_KEY, PATH: '/usr/bin' },
    cwd: '/data/alteroid',
    onPreToolUse: () => ({ kind: 'continue' }),
    onPreCompact: () => undefined,
    onPostToolUse: () => undefined,
    onPostToolUseFailure: () => undefined,
    onSubagentStop: () => undefined,
    ...overrides,
  };
}

describe('Codex のクローンの申告（オーナーの決定）', () => {
  it('承認と蒸留（圧縮の割り込み）は無いと申告し、マネージャー層の申告は変えない', () => {
    expect(missingRequirementCapabilities(CODEX_CLONE_PROVIDER.capabilities)).toEqual(
      expect.arrayContaining(['permissions', 'compactionHook']),
    );
    expect(CODEX_PROVIDER.capabilities.permissions).toBe(true);
    expect(CODEX_PROVIDER.capabilities.compactionHook).toBe(false);
    expect(CODEX_CLONE_PROVIDER.capabilities.toolAudit).toBe(true);
    expect(CODEX_CLONE_PROVIDER.capabilities.usage).toBe(true);
  });

  it('欠けは既存の provider-gaps の仕組みで「クローン層」の行に出る', () => {
    const lines = describeProviderGaps({ clone: CODEX_CLONE_PROVIDER });
    const text = lines.join('\n');
    expect(text).toContain('クローン層（Codex）は permissions を持たない');
    expect(text).toContain('クローン層（Codex）は compactionHook を持たない');
    expect(text).toContain('記憶への蒸留');
  });

  it('承認要求は常に拒否する（許可の代用を作らない）', () => {
    expect(denyEveryApproval().behavior).toBe('deny');
  });

  it('蒸留のサイドクエリを持たず、道具は stdio を要求する', () => {
    const driver = new CodexCloneDriver();
    expect((driver as AgentCloneDriver).distill).toBeUndefined();
    expect(driver.requiredToolsTransport).toBe('stdio');
    expect(driver.providerId).toBe('codex');
  });
});

describe('toCodexCloneMcpServers / toCodexSessionSpec', () => {
  it('クローンの道具を alteroid の名前で、人間の連携と並べて渡す（自作が勝つ）', () => {
    const servers = toCodexCloneMcpServers({
      tools: { kind: 'stdio', command: 'n', args: ['a'], env: { K: 'v' } },
      externalMcpServers: {
        alteroid: { type: 'http', url: 'https://x' },
        ext: { type: 'http', url: 'https://y' },
      },
    });
    expect(servers['alteroid']).toEqual({
      type: 'stdio',
      command: 'n',
      args: ['a'],
      env: { K: 'v' },
    });
    expect(Object.keys(servers).sort()).toEqual(['alteroid', 'ext']);
  });

  it('inproc の道具は渡せないので投げる（道具の無いクローンを黙って起こさない）', () => {
    expect(() =>
      toCodexCloneMcpServers({ tools: { kind: 'inproc', server: {} }, externalMcpServers: {} }),
    ).toThrow(/stdio/);
  });

  it('権限モードに関わらず bypassPermissions（approvalPolicy=never）で渡し、モデルは置いたときだけ', () => {
    for (const mode of ['auto', 'default', 'plan', 'dontAsk'] as const) {
      const spec = toCodexSessionSpec(cloneSpec({ permissionMode: mode }));
      expect(spec.permissionMode).toBe('bypassPermissions');
    }
    expect(toCodexSessionSpec(cloneSpec()).modelPlaced).toBe(false);
    expect(toCodexSessionSpec(cloneSpec({ modelPlaced: true })).modelPlaced).toBe(true);
  });
});

describe('CodexCloneDriver.open', () => {
  it('thread/start に never・danger-full-access・道具を渡し、ターンを中立イベントで返す', async () => {
    const server = new FakeAppServer();
    const spawned: AgentSpawnOptions[] = [];
    server.onTurn = (turnId) => {
      server.notify('item/completed', {
        threadId: 'thr-1',
        turnId,
        item: { type: 'agentMessage', id: 'm1', text: 'やあ' },
      });
      server.complete(turnId);
    };
    const driver = new CodexCloneDriver({
      defaultSpawn: (options) => {
        spawned.push(options);
        return server.asChild();
      },
    });
    const session = driver.open(cloneSpec());
    const events: AgentEvent[] = [];
    const done = session.readEvents(async (event) => {
      events.push(event);
      if (event.type === 'turn_ended') session.close();
    });
    await done;

    const start = server.paramsOf('thread/start')[0] as Json;
    expect(start['approvalPolicy']).toBe('never');
    expect(start['sandbox']).toBe('danger-full-access');
    expect(start['developerInstructions']).toBe('あなたはクローン');
    expect(start['model']).toBeUndefined();
    const mcp = (start['config'] as { mcp_servers: Record<string, Json> }).mcp_servers;
    expect(Object.keys(mcp).sort()).toEqual(['alteroid', 'ext']);
    expect(mcp['alteroid']).toMatchObject({ command: '/usr/bin/node', args: ['/relay.js'] });

    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['session_started', 'assistant_message', 'turn_ended']),
    );
    const ended = events.find((e) => e.type === 'turn_ended');
    expect(ended).toMatchObject({ type: 'turn_ended', succeeded: true, body: 'やあ' });
    // 鍵は子の env から外れ、argv には載らない。
    expect(spawned[0]?.env['CODEX_API_KEY']).toBeUndefined();
    expect(JSON.stringify(spawned[0]?.args)).not.toContain(FAKE_KEY);
    expect(spawned[0]?.args).toContain('cli_auth_credentials_store="ephemeral"');
  });

  it('interrupt はターン中なら turn/interrupt を送り、ターンが無ければ何もしない', async () => {
    const server = new FakeAppServer();
    const driver = new CodexCloneDriver({ defaultSpawn: () => server.asChild() });
    const session = driver.open(cloneSpec());
    const reading = session.readEvents(async () => undefined);
    reading.catch(() => undefined);
    await vi.waitFor(() => expect(server.paramsOf('turn/start')).toHaveLength(1));
    await session.interrupt();
    expect(server.paramsOf('turn/interrupt')).toEqual([{ threadId: 'thr-1', turnId: 'turn-1' }]);
    session.close();
    await reading.catch(() => undefined);
  });

  it('contextUsage は取れないことを reject で伝える（作り物を返さない）', async () => {
    const driver = new CodexCloneDriver({ defaultSpawn: () => new FakeAppServer().asChild() });
    const session = driver.open(cloneSpec());
    await expect(session.contextUsage()).rejects.toThrow(/context usage/);
    session.close();
  });
});

describe('クローンの道具の経路', () => {
  it('Codex の駆動役は stdio を要求し、env が sdk でも覆る。Claude（要求なし）は env のまま', () => {
    const required = new CodexCloneDriver().requiredToolsTransport;
    expect(resolveCloneToolsTransportFor(required, { ALTEROID_CLONE_TOOLS_TRANSPORT: 'sdk' })).toBe(
      'stdio',
    );
    expect(resolveCloneToolsTransportFor(required, {})).toBe('stdio');
    expect(resolveCloneToolsTransportFor(undefined, {})).toBe('sdk');
    expect(
      resolveCloneToolsTransportFor(undefined, { ALTEROID_CLONE_TOOLS_TRANSPORT: 'stdio' }),
    ).toBe('stdio');
  });
});

describe('Codex のクローンは plugin を渡さない', () => {
  const plugins = [{ path: '/data/plugins/one@' + 'a'.repeat(40), skipMcpDiscovery: true }];

  it('plugins があれば onNote で渡していないことを残し、thread/start には載せない', async () => {
    const server = new FakeAppServer();
    const notes: string[] = [];
    const driver = new CodexCloneDriver({ defaultSpawn: () => server.asChild() });
    const session = driver.open(cloneSpec({ plugins, onNote: (text) => notes.push(text) }));
    const reading = session.readEvents(async () => undefined);
    reading.catch(() => undefined);
    await vi.waitFor(() => expect(server.paramsOf('thread/start')).toHaveLength(1));
    session.close();
    await reading.catch(() => undefined);

    expect(notes.filter((text) => text.includes('plugin は Codex へ渡していない'))).toHaveLength(1);
    expect(JSON.stringify(server.paramsOf('thread/start'))).not.toContain('plugins/one@');
  });

  it('plugins が無い・空なら note を出さない', () => {
    for (const overrides of [{}, { plugins: [] }]) {
      const notes: string[] = [];
      const driver = new CodexCloneDriver({ defaultSpawn: () => new FakeAppServer().asChild() });
      const session = driver.open(cloneSpec({ ...overrides, onNote: (text) => notes.push(text) }));
      session.close();
      expect(notes.some((text) => text.includes('plugin'))).toBe(false);
    }
  });
});
