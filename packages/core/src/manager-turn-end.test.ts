import { describe, expect, it } from 'vitest';

import {
  createManagerPool,
  probeTurnEnd,
  type ManagerPool,
  type TurnEndProbe,
} from './manager.js';
import { createRunnerRegistry, type RunnerAnswerOutcome, type RunnerClient } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/**
 * Issue #567: マネージャーのセッションが `result` を受け取らないまま止まり、
 * `status` が `running` のまま固定される。生ログの末尾には報告の全文が
 * `stop_reason: end_turn` まで在るのに、報告がどこにも出ない。
 *
 * ここで固定するのは「デーモンが生ログの末尾を読んで、ターンが終わっている
 * らしいことを**計算し、知らせるだけ**」という向き（設計 c）である。
 * `probeTurnEnd`（純関数、末尾の解析）と `ManagerPool#probeTurnEnds`
 * （費用の門・書き込み）を分けて確かめる。
 *
 * **判定はしない。** `turnEndedAt` と `lastReportAt` を比べて「症状だ」と
 * 名乗る処理はどこにも実装していない——ここで測るのは事実の計算だけである。
 */

/**
 * JSONL の1行（assistant、本文つき）。`tools.test.ts` の `assistantLine`
 * （#323）と同じ形——`stopReason` は既定で付けない。
 */
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

/** JSONL の1行（assistant、思考だけ・本文なし）。 */
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

/** JSONL の1行（assistant、道具呼び出しだけ・本文なし）。 */
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
  /**
   * ⚠️⚠️ 偽陽性の回帰テスト（これが本命）。
   *
   * `tools.ts` の既存 `probeLastAssistantUtterance` は「本文が空の行を飛ばして、
   * 生成された本文を探す」ための道具で、`if (body.length === 0) continue;` を
   * 持つ。**それを流用すると、道具だけを回している最中のターンを飛ばして、
   * 1つ前のターンの `end_turn`（本文つき）まで遡ってしまう。**
   *
   * この repo の生ログ8本を時点ごとに再生した実測（2026-08-28 観測）:
   * ```
   * 既存の規則が「end_turn」と言う時点                          68
   *  うち 最後の assistant 行が実は tool_use（＝働いている最中）  37   ← 54% が偽陽性
   * 乖離が続いた最長の窓                                        12.6分
   * ```
   * `probeTurnEnd` は本文の有無で行を飛ばさない——最初に見つかった assistant
   * 行（ここでは思考だけ・道具だけの2行のうち末尾のもの）が答えで、その
   * `stop_reason` が `tool_use` である以上、働いている最中と読んで
   * `undefined` を返す。
   */
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
      tail: '', // 本文（type:'text'）が無いので抜粋は空文字。
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

// ---------------------------------------------------------------------------
// ManagerPool#probeTurnEnds — 費用の門と、記録への書き込み
// ---------------------------------------------------------------------------

/** `manager-lease.test.ts` の `LeasedRunner` と同じ形の、最小の偽 runner。 */
class TranscriptRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly starts: string[] = [];
  #transcripts = new Map<string, string | null>();

  /** テストから生ログの中身を差し替える。未設定なら `transcript()` は `null`。 */
  setTranscript(managerId: string, body: string | null): void {
    this.#transcripts.set(managerId, body);
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<void> {
    this.starts.push(command.managerId);
  }
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
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

/** 費用の門を満たす（`status: running` かつ `updatedAt` から10分超）まで進める。 */
const PAST_QUIET_GATE_MS = 11 * 60_000;
/** 旗が立っている相手のバックオフ（5分）を超えて進める。 */
const PAST_FLAGGED_BACKOFF_MS = 5 * 60_000 + 1_000;

describe('ManagerPool#probeTurnEnds — 費用の門・書き込み・巻き戻し', () => {
  it('transcript が null のとき、既に立っていた3つの欄が undefined に戻る', async () => {
    const h = await harnessOf();
    const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
    const managerId = started.managerId;

    // 1回目: 生ログが読める状態で探る。3欄が立つ。
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

    // 2回目: 生ログが読めなくなった（`transcript` が null）。バックオフを
    // 超えて進めてから、もう一度探る。
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

    // `done` を止めた直後の状態にする（`abort` は runner へ実際に届かせるので、
    // ここでは `status` を直接動かせる `send()` 経由の副作用を避け、単に
    // running のまま quiet gate を満たさずに probeTurnEnds を呼ぶ形で確かめる
    // のではなく、`abort` で確実に running から外す）。
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

    // 10分未満しか進めない。
    h.advance(60_000);
    await h.pool.probeTurnEnds();

    const after = (await h.pool.list()).find((entry) => entry.managerId === managerId);
    expect(after?.turnEndedAt).toBeUndefined();

    await h.close();
  });
});
