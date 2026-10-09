import { describe, expect, it } from 'vitest';

import { createManagerPool, probeToolUseStall, probeTurnEnd, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/** JSONL の1行（assistant、`tool_use` ブロックつき）。 */
function assistantToolUseLine(
  toolUses: { id: string; name?: string }[],
  options: { timestamp?: string | null; isSidechain?: boolean; stopReason?: string | null } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: options.isSidechain ?? false,
    ...(options.timestamp === null
      ? {}
      : { timestamp: options.timestamp ?? '2026-08-28T08:00:00.000Z' }),
    message: {
      role: 'assistant',
      id: 'msg_stall',
      content: toolUses.map((entry) => ({
        type: 'tool_use',
        id: entry.id,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        input: {},
      })),
      ...(options.stopReason === null ? {} : { stop_reason: options.stopReason ?? 'tool_use' }),
    },
  });
}

/** JSONL の1行（assistant、本文だけ）。 */
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
      id: 'msg_text',
      content: [{ type: 'text', text }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

/** JSONL の1行（user、`tool_result` ブロックつき＝道具の応答が返った形）。 */
function toolResultLine(toolUseId: string, options: { isSidechain?: boolean } = {}): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: options.isSidechain ?? false,
    timestamp: '2026-08-28T08:00:05.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  });
}

describe('probeToolUseStall — 応答が返っていない tool_use を生ログから計算する（Issue #572）', () => {
  it('末尾の assistant 行が tool_use で、対応する tool_result が無ければ、その id と name を返す', () => {
    const transcript = assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }], {
      timestamp: '2026-08-28T10:00:00.000Z',
    });

    const probe = probeToolUseStall(transcript);

    expect(probe?.timestamp).toBe('2026-08-28T10:00:00.000Z');
    expect(probe?.pending).toEqual([{ id: 'toolu_ask', name: 'AskUserQuestion' }]);
  });

  it('対応する tool_result が後ろの行に在れば undefined（応答は届いている）', () => {
    const transcript = [
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }]),
      toolResultLine('toolu_ask'),
      assistantToolUseLine([{ id: 'toolu_next', name: 'Bash' }]),
      toolResultLine('toolu_next'),
    ].join('\n');

    expect(probeToolUseStall(transcript)).toBeUndefined();
  });

  it('同じ行の複数の tool_use のうち、応答が来ていないものだけを返す', () => {
    const transcript = [
      assistantToolUseLine([
        { id: 'toolu_a', name: 'Bash' },
        { id: 'toolu_b', name: 'AskUserQuestion' },
      ]),
      toolResultLine('toolu_a'),
    ].join('\n');

    const probe = probeToolUseStall(transcript);

    expect(probe?.pending).toEqual([{ id: 'toolu_b', name: 'AskUserQuestion' }]);
  });

  // 前は見ない: 採用した行より前の tool_result は別の呼び出しへの応答で、id が再利用されると読み違える。
  it('採用した行より前にある tool_result は突き合わせに使わない', () => {
    const transcript = [
      toolResultLine('toolu_ask'),
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }]),
    ].join('\n');

    expect(probeToolUseStall(transcript)?.pending).toEqual([
      { id: 'toolu_ask', name: 'AskUserQuestion' },
    ]);
  });

  it('末尾の assistant 行の stop_reason が tool_use でなければ undefined（この検出の対象外）', () => {
    const transcript = assistantTextLine('報告本文', { stopReason: 'end_turn' });

    expect(probeToolUseStall(transcript)).toBeUndefined();
  });

  it('stop_reason が無い行なら undefined（分からないものを症状に化けさせない）', () => {
    const transcript = assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }], {
      stopReason: null,
    });

    expect(probeToolUseStall(transcript)).toBeUndefined();
  });

  it('isSidechain の行は飛ばして、その手前の本流の assistant 行を採る', () => {
    const transcript = [
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }], {
        timestamp: '2026-08-28T11:00:00.000Z',
      }),
      assistantToolUseLine([{ id: 'toolu_worker', name: 'Bash' }], {
        isSidechain: true,
        timestamp: '2026-08-28T11:01:00.000Z',
      }),
    ].join('\n');

    const probe = probeToolUseStall(transcript);

    expect(probe?.timestamp).toBe('2026-08-28T11:00:00.000Z');
    expect(probe?.pending).toEqual([{ id: 'toolu_ask', name: 'AskUserQuestion' }]);
  });

  // sidechain の tool_result も落とさない: 突き合わせは id で行うので、絞ると応答があるのに拾えず偽陽性になる。
  it('tool_result 側は isSidechain でも拾う（応答が在るのに症状と名乗らない）', () => {
    const transcript = [
      assistantToolUseLine([{ id: 'toolu_task', name: 'Task' }]),
      toolResultLine('toolu_task', { isSidechain: true }),
    ].join('\n');

    expect(probeToolUseStall(transcript)).toBeUndefined();
  });

  it('行に timestamp が無くても検出する（timestamp は undefined のまま。値を捏造しない）', () => {
    const transcript = assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }], {
      timestamp: null,
    });

    const probe = probeToolUseStall(transcript);

    expect(probe).not.toBeUndefined();
    expect(probe?.timestamp).toBeUndefined();
    expect(probe?.pending).toEqual([{ id: 'toolu_ask', name: 'AskUserQuestion' }]);
  });

  it('name が無い tool_use は id だけを運ぶ（「不明」のような文字列を作らない）', () => {
    const transcript = assistantToolUseLine([{ id: 'toolu_noname' }]);

    expect(probeToolUseStall(transcript)?.pending).toEqual([{ id: 'toolu_noname' }]);
  });

  it('壊れた JSON 行は飛ばして、その手前の行を読む', () => {
    const transcript = [
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }], {
        timestamp: '2026-08-28T12:00:00.000Z',
      }),
      '{"type":"assistant", これは壊れている',
      '',
    ].join('\n');

    expect(probeToolUseStall(transcript)?.timestamp).toBe('2026-08-28T12:00:00.000Z');
  });

  it('tool_use ブロックが1つも無ければ undefined（待っている対象が特定できない）', () => {
    const transcript = assistantTextLine('本文だけ', { stopReason: 'tool_use' });

    expect(probeToolUseStall(transcript)).toBeUndefined();
  });

  it('assistant 行が1行も無ければ undefined', () => {
    expect(probeToolUseStall(toolResultLine('toolu_orphan'))).toBeUndefined();
  });

  it('空の生ログでも投げない', () => {
    expect(probeToolUseStall('')).toBeUndefined();
  });

  it('生ログが窓（20万字）を超えていても、末尾の矛盾を拾う', () => {
    const filler = `${'x'.repeat(300_000)}\n`;
    const transcript =
      filler +
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }], {
        timestamp: '2026-08-28T13:00:00.000Z',
      });

    expect(probeToolUseStall(transcript)?.timestamp).toBe('2026-08-28T13:00:00.000Z');
  });

  // probeTurnEnd の規則6（tool_use なら undefined）は外さない: 外すと 54% が偽陽性になる。
  it('同じ生ログに対して probeTurnEnd は undefined を返し続ける（規則6 は外していない）', () => {
    const transcript = assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }]);

    expect(probeTurnEnd(transcript)).toBeUndefined();
    expect(probeToolUseStall(transcript)).not.toBeUndefined();
  });

  it('ターンが終わっている生ログでは probeTurnEnd だけが値を返す（両方が同時に立たない）', () => {
    const transcript = [
      assistantToolUseLine([{ id: 'toolu_a', name: 'Bash' }]),
      toolResultLine('toolu_a'),
      assistantTextLine('作業完了の報告', {
        timestamp: '2026-08-28T14:00:00.000Z',
        stopReason: 'end_turn',
      }),
    ].join('\n');

    expect(probeTurnEnd(transcript)?.stopReason).toBe('end_turn');
    expect(probeToolUseStall(transcript)).toBeUndefined();
  });
});

class CountingTranscriptRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly transcriptCalls: string[] = [];
  #transcripts = new Map<string, string | null>();

  setTranscript(managerId: string, body: string | null): void {
    this.#transcripts.set(managerId, body);
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  async connect(): Promise<void> {}
  async start(): Promise<{ cwd?: string }> {
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
    this.transcriptCalls.push(managerId);
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
  runner: CountingTranscriptRunner;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}> {
  const runner = new CountingTranscriptRunner();
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
const PAST_BACKOFF_MS = 60_000 + 1_000;

describe('ManagerPool#probeTurnEnds — #572 の2欄を書く（Issue #572）', () => {
  it('末尾が応答待ちの tool_use なら、toolUseStallAt / toolUseStallPending が一覧に出る', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    h.runner.setTranscript(
      started.managerId,
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }], {
        timestamp: '2026-08-28T14:00:00.000Z',
      }),
    );

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    const after = (await h.pool.list()).find((entry) => entry.managerId === started.managerId);
    expect(after?.toolUseStallAt).toBe('2026-08-28T14:00:00.000Z');
    expect(after?.toolUseStallPending).toEqual([{ id: 'toolu_ask', name: 'AskUserQuestion' }]);
    expect(after?.turnEndReason).toBeUndefined();

    await h.close();
  });

  it('探りが2つになっても、1本の委譲につき transcript() は1回しか呼ばない', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    h.runner.setTranscript(
      started.managerId,
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }]),
    );

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    expect(h.runner.transcriptCalls).toEqual([started.managerId]);

    await h.close();
  });

  it('応答が届いた後に探り直すと、2欄が消える（古い観測を残さない）', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    const managerId = started.managerId;
    h.runner.setTranscript(
      managerId,
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }]),
    );
    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();
    expect(
      (await h.pool.list()).find((entry) => entry.managerId === managerId)?.toolUseStallPending,
    ).toHaveLength(1);

    h.runner.setTranscript(
      managerId,
      [
        assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }]),
        toolResultLine('toolu_ask'),
        assistantTextLine('答えをもらったので続けた', {
          timestamp: '2026-08-28T15:00:00.000Z',
          stopReason: 'end_turn',
        }),
      ].join('\n'),
    );
    h.advance(PAST_BACKOFF_MS);
    await h.pool.probeTurnEnds();

    const after = (await h.pool.list()).find((entry) => entry.managerId === managerId);
    expect(after?.toolUseStallAt).toBeUndefined();
    expect(after?.toolUseStallPending).toBeUndefined();
    expect(after?.turnEndReason).toBe('end_turn');

    await h.close();
  });

  it('生ログが読めなくなったら 2欄も undefined に戻る', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    const managerId = started.managerId;
    h.runner.setTranscript(
      managerId,
      assistantToolUseLine([{ id: 'toolu_ask', name: 'AskUserQuestion' }]),
    );
    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    h.runner.setTranscript(managerId, null);
    h.advance(PAST_BACKOFF_MS);
    await h.pool.probeTurnEnds();

    const after = (await h.pool.list()).find((entry) => entry.managerId === managerId);
    expect(after?.toolUseStallPending).toBeUndefined();

    await h.close();
  });
});
