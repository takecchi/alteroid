import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type {
  AgentChildProcess,
  AgentManagerSessionSpec,
  AgentSpawnOptions,
} from './agent-session.js';
import { CODEX_PEER_AUTH_EXPIRED_NOTICE } from './agent-provider-peers.js';
import { CodexManagerDriver, type CodexChatgptAuthHandle } from './codex-manager-driver.js';
import { createPeerBroker, describePeerTurnResult, type PeerTurnResult } from './peer-broker.js';

type Json = Record<string, unknown>;

// Codex の app-server の代役。turn/start のあと、決めた error で turn/completed を返す。
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  #buffer = '';

  constructor(
    private readonly turnError: Json,
    private readonly account: Json | null = {
      type: 'chatgpt',
      email: 'me@example.com',
      planType: 'plus',
    },
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
        reply({ requiresOpenaiAuth: true, account: this.account });
        return;
      case 'thread/start':
        reply({ thread: { id: 'thr-1', cwd: '/w' }, model: 'gpt-5', approvalPolicy: 'untrusted' });
        return;
      case 'turn/start':
        reply({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
        setImmediate(() =>
          this.stdout.write(
            `${JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: 'thr-1',
                turn: { id: 'turn-1', status: 'failed', items: [], error: this.turnError },
              },
            })}\n`,
          ),
        );
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

// 本物の CodexManagerDriver を通して、peer_run がマネージャーへ返す文面を得る。
async function peerRunFailing(turnError: Json, account?: Json | null): Promise<PeerTurnResult> {
  const broker = createPeerBroker({
    allowed: ['codex'],
    driverOf: () => new CodexManagerDriver({ closeGraceMs: 0, chatgptAuth: handle }),
    makeSpec: (_provider, given) =>
      ({
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
        spawnProcess: (_options: AgentSpawnOptions) =>
          new FakeAppServer(turnError, account) as unknown as AgentChildProcess,
        onPreToolUse: vi.fn(),
        onPermissionDenied: vi.fn(),
        onPostToolUse: () => ({ kind: 'continue' }),
        onPostToolUseFailure: vi.fn(),
        onPreCompact: vi.fn(),
        onUserPromptSubmit: vi.fn(),
        onSubagentStop: vi.fn(),
        onStop: vi.fn(),
      }) as unknown as AgentManagerSessionSpec,
    reportsUsage: () => true,
    onNote: () => undefined,
    onUsage: () => undefined,
    onTurn: () => undefined,
  });
  try {
    const result = await broker.run('codex', '調べて', { background: false });
    if (typeof result === 'string' || 'background' in result) throw new Error('想定外の戻り');
    return result;
  } finally {
    broker.closeAll();
  }
}

describe('peer の Codex が認証切れで落ちたとき、マネージャーに返る文面', () => {
  it('認証切れ（unauthorized）は、人間がログインし直す案件だと分かる文面になる', async () => {
    const result = await peerRunFailing({
      message: 'unexpected status 401',
      codexErrorInfo: 'unauthorized',
    });
    expect(result.ok).toBe(false);
    const body = describePeerTurnResult(result);
    // 同じ依頼を繰り返さず、人間に鍵の更新（codex login）を頼むべきだと読める
    expect(body).toContain(CODEX_PEER_AUTH_EXPIRED_NOTICE);
    expect(body).toContain(
      '`alteroid codex login` でログインし直すまで、同じ依頼を繰り返しても失敗する',
    );
    // 元の文は括弧で添える
    expect(body).toContain('（peer のターンが失敗した（failed）: unexpected status 401）');
  });

  it('セッションごと落ちる認証切れ（Codex が書き出したログインを読まない）も同じ案内になる', async () => {
    const result = await peerRunFailing({}, null);
    expect(result.ok).toBe(false);
    const body = describePeerTurnResult(result);
    expect(body).toContain('Codex の認証が無い');
    expect(body).toContain(CODEX_PEER_AUTH_EXPIRED_NOTICE);
  });

  it('認証以外の失敗は、そのまま通す（比べる対象。今も通る）', async () => {
    const result = await peerRunFailing({
      message: 'server exploded',
      codexErrorInfo: 'other',
    });
    expect(result.ok).toBe(false);
    const body = describePeerTurnResult(result);
    expect(body).toContain('peer のターンが失敗した（failed）: server exploded');
    expect(body).not.toContain('alteroid codex login');
  });
});
