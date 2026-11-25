import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type { AgentChildProcess, AgentManagerSessionSpec } from './agent-session.js';
import { CODEX_PEER_CREDITS_EXHAUSTED_NOTICE } from './agent-provider-peers.js';
import {
  CodexManagerDriver,
  isCodexCreditsExhausted,
  type CodexChatgptAuthHandle,
} from './codex-manager-driver.js';
import { createPeerBroker, describePeerTurnResult, type PeerTurnResult } from './peer-broker.js';

type Json = Record<string, unknown>;

// Codex の app-server の代役。turn/start のあと、決めた通知を流してから、決めた error で turn/completed を返す。
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  #buffer = '';

  constructor(
    private readonly turnError: Json,
    private readonly beforeCompleted: readonly Json[] = [],
  ) {
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
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }

  #handle(message: Json): void {
    const id = message['id'];
    const method = message['method'];
    if (id === undefined || typeof method !== 'string') return;
    const reply = (result: unknown): void => {
      this.stdout.write(`${JSON.stringify({ id, result })}\n`);
    };
    switch (method) {
      case 'initialize':
        reply({ userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' });
        return;
      case 'account/read':
        reply({
          requiresOpenaiAuth: true,
          account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' },
        });
        return;
      case 'thread/start':
        reply({ thread: { id: 'thr-1', cwd: '/w' }, model: 'gpt-5', approvalPolicy: 'untrusted' });
        return;
      case 'turn/start':
        reply({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
        setImmediate(() => {
          for (const notification of this.beforeCompleted) {
            this.stdout.write(`${JSON.stringify(notification)}\n`);
          }
          this.stdout.write(
            `${JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: 'thr-1',
                turn: { id: 'turn-1', status: 'failed', items: [], error: this.turnError },
              },
            })}\n`,
          );
        });
        return;
      default:
        reply({});
    }
  }
}

const handle: CodexChatgptAuthHandle = {
  prepare: async () => '/home/worker/.codex',
  check: async () => undefined,
  reportFailure: () => undefined,
};

function specFor(
  server: FakeAppServer,
  given: { input: AsyncIterable<never>; onPermission: never; onNote: never },
): AgentManagerSessionSpec {
  return {
    input: given.input,
    onPermission: given.onPermission,
    onNote: given.onNote,
    model: 'opus',
    permissionMode: 'default',
    strictApprovals: true,
    systemPromptAppend: 'peer',
    workerAgentName: 'worker',
    workerPrompt: 'w',
    workerModel: 'sonnet',
    cwd: '/work',
    env: { PATH: '/bin' },
    managerAutoMemoryEnabled: false,
    sessionLog: { append: async () => undefined, load: async () => null },
    spawnProcess: () => server as unknown as AgentChildProcess,
    onPreToolUse: vi.fn(),
    onPermissionDenied: vi.fn(),
    onPostToolUse: () => ({ kind: 'continue' }),
    onPostToolUseFailure: vi.fn(),
    onPreCompact: vi.fn(),
    onSubagentStop: vi.fn(),
    onStop: vi.fn(),
  } as unknown as AgentManagerSessionSpec;
}

// 本物の CodexManagerDriver を通して、ターンの終わりのイベントを集める。
async function turnEndedOf(
  turnError: Json,
  beforeCompleted: readonly Json[] = [],
): Promise<Extract<AgentEvent, { type: 'turn_ended' }>> {
  const driver = new CodexManagerDriver({ closeGraceMs: 0, chatgptAuth: handle });
  const server = new FakeAppServer(turnError, beforeCompleted);
  let resolveInput: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    resolveInput = resolve;
  });
  const session = driver.open(
    specFor(server, {
      input: (async function* () {
        yield { text: '調べて' } as never;
        await gate;
      })(),
      onPermission: (() => undefined) as never,
      onNote: (() => undefined) as never,
    }),
  );
  const ended = await new Promise<Extract<AgentEvent, { type: 'turn_ended' }>>((resolve) => {
    void session.readEvents(async (event) => {
      if (event.type === 'turn_ended') resolve(event);
    });
  });
  resolveInput();
  session.close();
  return ended;
}

async function peerRunFailing(turnError: Json): Promise<{
  result: PeerTurnResult;
  settled: { ok: boolean; failureKind?: string; detail: string }[];
}> {
  const settled: { ok: boolean; failureKind?: string; detail: string }[] = [];
  const broker = createPeerBroker({
    allowed: ['codex'],
    driverOf: () => new CodexManagerDriver({ closeGraceMs: 0, chatgptAuth: handle }),
    makeSpec: (_provider, given) => specFor(new FakeAppServer(turnError), given as never),
    reportsUsage: () => true,
    onNote: () => undefined,
    onUsage: () => undefined,
    onTurn: () => undefined,
    onTurnSettled: (event) => settled.push(event),
  });
  try {
    const result = await broker.run('codex', '調べて', { background: false });
    if (typeof result === 'string' || 'background' in result) throw new Error('想定外の戻り');
    return { result, settled };
  } finally {
    broker.closeAll();
  }
}

describe('Codex の残高切れを失敗の種類として読む（isCodexCreditsExhausted）', () => {
  it('「out of credits」「out of usage credits」「credits_depleted」の文を残高切れと読む', () => {
    expect(
      isCodexCreditsExhausted('Your workspace is out of credits. Add credits.', undefined),
    ).toBe(true);
    expect(isCodexCreditsExhausted('You are out of usage credits', undefined)).toBe(true);
    expect(isCodexCreditsExhausted('error: workspace_owner_credits_depleted', undefined)).toBe(
      true,
    );
    expect(isCodexCreditsExhausted('Credits depleted', undefined)).toBe(true);
  });

  it('到達した枠の種類が _credits_depleted で終わるなら、文が空でも残高切れと読む', () => {
    expect(isCodexCreditsExhausted(undefined, 'workspace_owner_credits_depleted')).toBe(true);
    expect(
      isCodexCreditsExhausted('ターンが failed で終わった', 'workspace_member_credits_depleted'),
    ).toBe(true);
  });

  it('ほかの失敗・ほかの枠（利用上限・spend control）は残高切れと読まない', () => {
    expect(isCodexCreditsExhausted('server exploded', undefined)).toBe(false);
    expect(isCodexCreditsExhausted('usage limit reached', 'usage_limit_reached')).toBe(false);
    expect(isCodexCreditsExhausted(undefined, 'spend_control_reached')).toBe(false);
    expect(isCodexCreditsExhausted(undefined, undefined)).toBe(false);
  });
});

describe('Codex のターンの失敗の種類（turn_ended の failureKind）', () => {
  it('out of credits の失敗は failureKind: credits で上がる', async () => {
    const ended = await turnEndedOf({
      message: 'Your workspace is out of credits. Add credits to continue.',
      codexErrorInfo: 'other',
    });
    expect(ended.succeeded).toBe(false);
    expect(ended.failureKind).toBe('credits');
  });

  it('直前の account/rateLimits/updated が workspace_owner_credits_depleted なら、文が曖昧でも credits', async () => {
    const ended = await turnEndedOf({ message: 'request failed', codexErrorInfo: 'other' }, [
      {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: 'codex',
            primary: null,
            secondary: null,
            rateLimitReachedType: 'workspace_owner_credits_depleted',
          },
        },
      },
    ]);
    expect(ended.failureKind).toBe('credits');
  });

  it('unauthorized は、文が残高切れに見えても auth が先に勝つ', async () => {
    const ended = await turnEndedOf({
      message: 'Your workspace is out of credits.',
      codexErrorInfo: 'unauthorized',
    });
    expect(ended.failureKind).toBe('auth');
  });

  it('ほかの失敗には failureKind を付けない', async () => {
    const ended = await turnEndedOf({ message: 'server exploded', codexErrorInfo: 'other' });
    expect(ended.succeeded).toBe(false);
    expect(ended.failureKind).toBeUndefined();
  });
});

describe('peer の Codex が残高切れで落ちたとき、マネージャーに返る文面', () => {
  it('人間が残高を足す案件だと分かる案内と原文が返り、onTurnSettled が credits で呼ばれる', async () => {
    const { result, settled } = await peerRunFailing({
      message: 'Your workspace is out of credits. Add credits to continue.',
      codexErrorInfo: 'other',
    });
    expect(result.ok).toBe(false);
    expect(describePeerTurnResult(result)).toContain(
      `${CODEX_PEER_CREDITS_EXHAUSTED_NOTICE}（peer のターンが失敗した（failed）: Your workspace is out of credits. Add credits to continue.）`,
    );
    expect(settled).toEqual([
      {
        provider: 'codex',
        ok: false,
        failureKind: 'credits',
        detail: 'Your workspace is out of credits. Add credits to continue.',
      },
    ]);
  });
});
