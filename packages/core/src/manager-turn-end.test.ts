import { describe, expect, it } from 'vitest';

import { createManagerPool, probeTurnEnd, type ManagerPool, type TurnEndProbe } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

function assistantTextLine(
  text: string,
  options: { timestamp?: string; isSidechain?: boolean; stopReason?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: options.isSidechain ?? false,
    timestamp: options.timestamp ?? '2026-08-28T08:00:00.000Z',
    message: {
      role: 'assistant',
      id: 'msg_probe',
      content: [{ type: 'text', text }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

function assistantThinkingLine(
  thinking: string,
  options: { timestamp?: string; isSidechain?: boolean; stopReason?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: options.isSidechain ?? false,
    timestamp: options.timestamp ?? '2026-08-28T08:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

function assistantToolUseLine(
  options: { timestamp?: string; isSidechain?: boolean; stopReason?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: options.isSidechain ?? false,
    timestamp: options.timestamp ?? '2026-08-28T08:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: { command: 'ls' } }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

describe('probeTurnEnd — 生ログの末尾からターン終了を計算する（Issue #567）', () => {
  // `probeLastAssistantUtterance` を流用しない: 本文が空の行を飛ばすので、道具だけを回している
  // 最中のターンを越えて1つ前の `end_turn` まで遡り、偽陽性になる。
  it('古いターンの end_turn（本文つき）の後に、道具だけを回す新しいターンが続いていても、働いている最中と読む', () => {
    const transcript = [
      assistantTextLine('古いターンの報告本文（ここへ遡ってはいけない）', {
        timestamp: '2026-08-28T08:00:00.000Z',
        stopReason: 'end_turn',
      }),
      assistantThinkingLine('新しいターンの思考（本文なし）', {
        timestamp: '2026-08-28T08:05:00.000Z',
        stopReason: 'tool_use',
      }),
      assistantToolUseLine({
        timestamp: '2026-08-28T08:05:10.000Z',
        stopReason: 'tool_use',
      }),
    ].join('\n');

    expect(probeTurnEnd(transcript)).toBeUndefined();
  });

  it('末尾の assistant 行が思考だけ（本文なし）でも end_turn なら TurnEndProbe を返す（既存の関数はここを取りこぼす）', () => {
    const transcript = assistantThinkingLine('本文を書かずにターンを終えた', {
      timestamp: '2026-08-28T09:00:00.000Z',
      stopReason: 'end_turn',
    });

    const probe = probeTurnEnd(transcript);
    expect(probe).toEqual<TurnEndProbe>({
      timestamp: '2026-08-28T09:00:00.000Z',
      stopReason: 'end_turn',
      tail: '',
    });
  });

  it('生ログの最後の行が assistant ではなくても、遡って正しく見つける', () => {
    const transcript = [
      assistantTextLine('本物の最後の発言', {
        timestamp: '2026-08-28T10:00:00.000Z',
        stopReason: 'end_turn',
      }),
      JSON.stringify({
        type: 'last-prompt',
        lastPrompt: '調べて',
        leafUuid: 'leaf-1',
        sessionId: 'sess-1',
      }),
      JSON.stringify({
        type: 'pr-link',
        sessionId: 'sess-1',
        prNumber: 587,
        prUrl: 'https://github.com/takecchi/alteroid/pull/587',
        prRepository: 'takecchi/alteroid',
        timestamp: '2026-08-28T10:00:01.000Z',
      }),
    ].join('\n');

    const probe = probeTurnEnd(transcript);
    expect(probe?.timestamp).toBe('2026-08-28T10:00:00.000Z');
    expect(probe?.stopReason).toBe('end_turn');
  });

  it('stop_reason: stop_sequence のとき、stopReason にその値がそのまま入り、tail に本文が入る', () => {
    const transcript = assistantTextLine('ここでターンが枠の壁に当たって切れた', {
      timestamp: '2026-08-28T11:00:00.000Z',
      stopReason: 'stop_sequence',
    });

    const probe = probeTurnEnd(transcript);
    expect(probe?.stopReason).toBe('stop_sequence');
    expect(probe?.tail).toBe('ここでターンが枠の壁に当たって切れた');
  });

  it('isSidechain: true の assistant 行（作業者の発言）を飛ばす', () => {
    const transcript = [
      assistantTextLine('マネージャー本体の発言', {
        timestamp: '2026-08-28T12:00:00.000Z',
        stopReason: 'end_turn',
      }),
      assistantTextLine('作業者（サブエージェント）の発言。これを答えにしてはいけない', {
        timestamp: '2026-08-28T12:00:05.000Z',
        stopReason: 'end_turn',
        isSidechain: true,
      }),
    ].join('\n');

    const probe = probeTurnEnd(transcript);
    expect(probe?.timestamp).toBe('2026-08-28T12:00:00.000Z');
  });

  it('stop_reason の欄が無い、または文字列でないとき、undefined を返す（分からないものを症状に化けさせない）', () => {
    const withoutField = JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      timestamp: '2026-08-28T13:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '本文' }] },
    });
    expect(probeTurnEnd(withoutField)).toBeUndefined();

    const nonString = JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      timestamp: '2026-08-28T13:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '本文' }],
        stop_reason: 42,
      },
    });
    expect(probeTurnEnd(nonString)).toBeUndefined();
  });

  it('assistant 行が1行も無ければ undefined を返す', () => {
    const transcript = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '調べて' } }),
      JSON.stringify({ type: 'system', subtype: 'init' }),
    ].join('\n');
    expect(probeTurnEnd(transcript)).toBeUndefined();
  });
});

class TranscriptRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly starts: string[] = [];
  #transcripts = new Map<string, string | null>();

  setTranscript(managerId: string, body: string | null): void {
    this.#transcripts.set(managerId, body);
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<{ cwd?: string }> {
    this.starts.push(command.managerId);
    return {};
  }
  async resume(): Promise<{ cwd?: string }> {
    return {};
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list() {
    return [];
  }
  async transcript(managerId: string): Promise<string | null> {
    return this.#transcripts.get(managerId) ?? null;
  }
  async credentials() {
    return [];
  }
  async setCredentials() {
    return [];
  }
  async profile() {
    return undefined;
  }
  async setProfile() {
    return { ok: true as const };
  }
  async close(): Promise<void> {}
}

async function harnessOf(): Promise<{
  pool: ManagerPool;
  runner: TranscriptRunner;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}> {
  const runner = new TranscriptRunner();
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const stores = createMemoryStores();
  let clock = Date.now();
  const pool = createManagerPool({
    stores,
    post: () => {},
    runners: registry,
    now: () => clock,
  });
  return {
    pool,
    runner,
    advance: (ms) => {
      clock += ms;
    },
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

const PAST_QUIET_GATE_MS = 11 * 60_000;
const PAST_FLAGGED_BACKOFF_MS = 5 * 60_000 + 1_000;

describe('ManagerPool#probeTurnEnds — 費用の門・書き込み・巻き戻し', () => {
  it('transcript が null のとき、既に立っていた3つの欄が undefined に戻る', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    const managerId = started.managerId;

    h.runner.setTranscript(
      managerId,
      assistantTextLine('作業完了の報告', {
        timestamp: '2026-08-28T14:00:00.000Z',
        stopReason: 'end_turn',
      }),
    );
    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    const afterFirst = (await h.pool.list()).find((entry) => entry.managerId === managerId);
    expect(afterFirst?.turnEndedAt).toBe('2026-08-28T14:00:00.000Z');
    expect(afterFirst?.turnEndReason).toBe('end_turn');
    expect(afterFirst?.turnEndTail).toBe('作業完了の報告');

    h.runner.setTranscript(managerId, null);
    h.advance(PAST_FLAGGED_BACKOFF_MS);
    await h.pool.probeTurnEnds();

    const afterSecond = (await h.pool.list()).find((entry) => entry.managerId === managerId);
    expect(afterSecond?.turnEndedAt).toBeUndefined();
    expect(afterSecond?.turnEndReason).toBeUndefined();
    expect(afterSecond?.turnEndTail).toBeUndefined();

    await h.close();
  });

  it('status が running でない委譲は引かない（費用の門）', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    const managerId = started.managerId;
    h.runner.setTranscript(
      managerId,
      assistantTextLine('報告', { timestamp: '2026-08-28T15:00:00.000Z', stopReason: 'end_turn' }),
    );

    await h.pool.abort(managerId, 'テストで停止');
    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    const after = (await h.pool.list()).find((entry) => entry.managerId === managerId);
    expect(after?.turnEndedAt).toBeUndefined();

    await h.close();
  });

  it('updatedAt から10分経っていない（動いている）委譲は引かない（費用の門）', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    const managerId = started.managerId;
    h.runner.setTranscript(
      managerId,
      assistantTextLine('報告', { timestamp: '2026-08-28T16:00:00.000Z', stopReason: 'end_turn' }),
    );

    h.advance(60_000);
    await h.pool.probeTurnEnds();

    const after = (await h.pool.list()).find((entry) => entry.managerId === managerId);
    expect(after?.turnEndedAt).toBeUndefined();

    await h.close();
  });
});
