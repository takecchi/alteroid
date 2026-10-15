import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentManagerDriver,
  AgentManagerSession,
  AgentManagerSessionSpec,
} from './agent-session.js';
import {
  createPeerBroker,
  DEFAULT_PEER_LIMITS,
  resolvePeerLimits,
  type PeerCallResult,
  type PeerLimits,
  type PeerTurnResult,
} from './peer-broker.js';

const MINUTE = 60_000;

function turnEnded(body: string): AgentEvent {
  return { type: 'turn_ended', succeeded: true, body, errorLines: [], denials: [] };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('条件が満たされなかった');
}

type Script = (
  prompt: string,
  spec: AgentManagerSessionSpec,
) => Promise<AgentEvent[]> | AgentEvent[];

// 偽の driver: 依頼の文面ごとに振る舞いを変えられる。閉じられた数を数える
function makeBroker(script: Script, limits: PeerLimits) {
  const clock = { ms: 1_000_000 };
  const closed = { count: 0 };
  const notes: string[] = [];
  const stops: PeerTurnResult[] = [];
  const driver: AgentManagerDriver = {
    providerId: 'codex',
    open(spec) {
      const session: AgentManagerSession = {
        readEvents: async (onEvent) => {
          await onEvent({ type: 'session_started', sessionId: 'thr-1' } as never);
          for await (const input of spec.input) {
            const prompt = (input as { text: string }).text;
            for (const event of await script(prompt, spec)) await onEvent(event);
          }
        },
        close: () => {
          closed.count += 1;
        },
        contextUsage: async () => {
          throw new Error('unused');
        },
        sessionModelUsage: async () => undefined,
      };
      return session;
    },
  };
  const broker = createPeerBroker({
    allowed: ['codex'],
    driverOf: () => driver,
    makeSpec: (_provider, given) =>
      ({
        input: given.input,
        onPermission: given.onPermission,
        onNote: given.onNote,
        onPostToolUse: () => ({ kind: 'continue' }),
        onPostToolUseFailure: () => undefined,
      }) as unknown as AgentManagerSessionSpec,
    reportsUsage: () => false,
    onNote: (text) => notes.push(text),
    onUsage: () => undefined,
    onBackgroundStop: (result) => stops.push(result),
    now: () => new Date(clock.ms),
    limits,
  });
  return { broker, clock, closed, notes, stops };
}

function sessionIdOf(result: PeerCallResult): string {
  if (typeof result === 'string') throw new Error(result);
  return result.sessionId;
}

const REOPEN = 'peer_run で新しく頼み直すこと（前の文脈は引き継がれない）';

afterEach(() => {
  vi.useRealTimers();
});

describe('peer-broker の上限（#4764）', () => {
  it('(a) 数の上限を超えると、いちばん長く使われていないものを閉じ、note を出し、続きには頼み直す文言を返す', async () => {
    const { broker, clock, closed, notes } = makeBroker(() => [turnEnded('済')], {
      maxLiveSessions: 2,
      idleMs: 30 * MINUTE,
    });
    const first = sessionIdOf(await broker.run('codex', 'a'));
    clock.ms += 1000;
    const second = sessionIdOf(await broker.run('codex', 'b'));
    clock.ms += 1000;
    expect(closed.count).toBe(0);
    const third = sessionIdOf(await broker.run('codex', 'c'));
    expect(closed.count).toBe(1);
    expect(
      notes.some((note) => note.includes(first) && note.includes('担当ごとの上限 2 本を超えた')),
    ).toBe(true);
    const gone = await broker.reply(first, '続き');
    expect(gone).toEqual(expect.stringContaining(`peer のセッション ${first} は閉じた`));
    expect(gone).toEqual(expect.stringContaining(REOPEN));
    // 残りは続けられる
    expect(typeof (await broker.reply(second, '続き'))).not.toBe('string');
    expect(typeof (await broker.reply(third, '続き'))).not.toBe('string');
    broker.closeAll();
  });

  it('(b) 確認待ち・背景で待っているものは、数の上限でも閉じず、超えたまま note を出す', async () => {
    const gate = deferred();
    const { broker, closed, notes, stops } = makeBroker(
      async (prompt, spec) => {
        if (prompt === 'pending') {
          await spec.onPermission({
            requestId: 'r1',
            kind: 'permission',
            toolName: 'commandExecution',
            input: { command: 'pnpm build' },
            signal: new AbortController().signal,
          });
        }
        if (prompt === 'background') await gate.promise;
        return [turnEnded('済')];
      },
      { maxLiveSessions: 1, idleMs: 30 * MINUTE },
    );
    const pending = await broker.run('codex', 'pending');
    expect(typeof pending === 'object' && 'pendingApproval' in pending).toBe(true);
    const pendingId = sessionIdOf(pending);
    const background = await broker.run('codex', 'background', { background: true });
    const backgroundId = sessionIdOf(background);
    const third = sessionIdOf(await broker.run('codex', 'c'));
    expect(closed.count).toBe(0);
    expect(
      notes.some((note) => note.includes('閉じてよいものが無いので上限 1 を超えて 3 本')),
    ).toBe(true);
    expect(await broker.reply(pendingId, '続き')).toContain('確認の答えを待っている');
    expect(await broker.reply(backgroundId, '続き')).toContain('前のターンの応答を待っている');
    expect(typeof (await broker.reply(third, '続き'))).not.toBe('string');
    gate.resolve();
    await until(() => stops.length === 1);
    broker.closeAll();
  });

  it('(c) 偽の時計で idleMs を過ぎると、閉じてよいものだけが閉じる（ターンの最中は閉じない）', async () => {
    const gate = deferred();
    const { broker, clock, closed, notes } = makeBroker(
      async (prompt) => {
        if (prompt === 'busy') await gate.promise;
        return [turnEnded('済')];
      },
      { maxLiveSessions: 10, idleMs: 5 * MINUTE },
    );
    const idle = sessionIdOf(await broker.run('codex', 'idle'));
    const inFlight = broker.run('codex', 'busy');
    await until(() => notes.length >= 2);
    clock.ms += 5 * MINUTE;
    // 境界は超えていない（ちょうどは閉じない）
    await broker.reply('peer-none', 'x');
    expect(closed.count).toBe(0);
    clock.ms += 1;
    // 見回りは reply の頭で行う
    await broker.reply('peer-none', 'x');
    expect(closed.count).toBe(1);
    expect(notes.some((note) => note.includes(idle) && note.includes('5 分使われなかった'))).toBe(
      true,
    );
    expect(await broker.reply(idle, '続き')).toContain(REOPEN);
    gate.resolve();
    const busyResult = await inFlight;
    expect(typeof busyResult).not.toBe('string');
    expect(closed.count).toBe(1);
    broker.closeAll();
  });

  it('(d) 使うと最後に使われた時刻が更新され、閉じる順が変わる', async () => {
    const { broker, clock, notes } = makeBroker(() => [turnEnded('済')], {
      maxLiveSessions: 2,
      idleMs: 30 * MINUTE,
    });
    const first = sessionIdOf(await broker.run('codex', 'a'));
    clock.ms += 1000;
    const second = sessionIdOf(await broker.run('codex', 'b'));
    clock.ms += 1000;
    await broker.reply(first, '続き');
    clock.ms += 1000;
    await broker.run('codex', 'c');
    expect(notes.some((note) => note.includes(second) && note.includes('閉じた'))).toBe(true);
    expect(notes.some((note) => note.includes(first) && note.includes('閉じた（'))).toBe(false);
    expect(typeof (await broker.reply(first, '続き'))).not.toBe('string');
    expect(await broker.reply(second, '続き')).toContain(REOPEN);
    broker.closeAll();
  });

  it('(e) 環境変数は、空・読めない・範囲外なら既定へ倒す', () => {
    expect(resolvePeerLimits({})).toEqual(DEFAULT_PEER_LIMITS);
    expect(DEFAULT_PEER_LIMITS).toEqual({ maxLiveSessions: 4, idleMs: 30 * MINUTE });
    expect(
      resolvePeerLimits({ ALTEROID_PEER_MAX_SESSIONS: '8', ALTEROID_PEER_IDLE_MINUTES: '10' }),
    ).toEqual({ maxLiveSessions: 8, idleMs: 10 * MINUTE });
    expect(
      resolvePeerLimits({ ALTEROID_PEER_MAX_SESSIONS: '1', ALTEROID_PEER_IDLE_MINUTES: '1440' }),
    ).toEqual({ maxLiveSessions: 1, idleMs: 1440 * MINUTE });
    for (const bad of ['', '  ', 'abc', '0', '-3', '65', '2.5', 'NaN', 'Infinity']) {
      expect(resolvePeerLimits({ ALTEROID_PEER_MAX_SESSIONS: bad }).maxLiveSessions).toBe(4);
    }
    for (const bad of ['', 'abc', '0', '-1', '1441', '1.5']) {
      expect(resolvePeerLimits({ ALTEROID_PEER_IDLE_MINUTES: bad }).idleMs).toBe(30 * MINUTE);
    }
  });

  it('(f) 定期の見回りは idleMs 超えを閉じ、closeAll で止まる', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { broker, clock, closed } = makeBroker(() => [turnEnded('済')], {
      maxLiveSessions: 10,
      idleMs: 5 * MINUTE,
    });
    expect(vi.getTimerCount()).toBe(0);
    const id = sessionIdOf(await broker.run('codex', 'a'));
    expect(vi.getTimerCount()).toBe(1);
    // 呼び出しが無くても、定期の見回りで閉じる
    clock.ms += 5 * MINUTE + 1;
    vi.advanceTimersByTime(60_000);
    expect(closed.count).toBe(1);
    expect(await broker.reply(id, '続き')).toContain(REOPEN);
    // 残りが無くなれば見回りも止まる
    expect(vi.getTimerCount()).toBe(0);
    await broker.run('codex', 'b');
    expect(vi.getTimerCount()).toBe(1);
    broker.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});
