import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_TRANSCRIPT_TAIL,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
} from './runner-protocol.js';
import type { LostSessionGrave, SessionTranscriptTail } from './store.js';
import { createMemoryStores } from './testing.js';

// 見回り（probeTurnEnds）は末尾の20万字しか判定に使わないので、末尾だけを読む口があればそれを使い、
// runner の全文を取り寄せない（#4628 / #4485）。

const PROBE_CHARS = 200_000;
const PAST_QUIET_GATE_MS = 11 * 60_000;

function endTurnLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: '2026-08-28T14:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });
}

class EventfulRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly transcriptCalls: string[] = [];
  readonly transcriptTailCalls: { managerId: string; maxChars: number }[] = [];
  liveTranscript: string | null = null;
  // 口そのものを持たない旧い runner を作る（`transcriptTail` を省略できる型）
  hasTailMouth = true;
  #emit: ((event: RunnerEvent) => unknown) | null = null;

  async emit(event: RunnerEvent): Promise<void> {
    await this.#emit?.(event);
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  async connect(onEvent: (event: RunnerEvent) => unknown): Promise<void> {
    this.#emit = onEvent;
  }
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
    return this.liveTranscript;
  }
  get transcriptTail(): RunnerClient['transcriptTail'] {
    if (!this.hasTailMouth) return undefined;
    return async (managerId: string, maxChars: number) => {
      this.transcriptTailCalls.push({ managerId, maxChars });
      return this.liveTranscript;
    };
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

// `capabilities` が `undefined` なら、runner は `hello` で何も名乗らない（旧い runner）
async function harnessOf(
  tailBody: string | null | undefined,
  options: { capabilities?: string[]; hasTailMouth?: boolean } = {
    capabilities: [RUNNER_CAPABILITY_TRANSCRIPT_TAIL],
  },
) {
  const runner = new EventfulRunner();
  runner.hasTailMouth = options.hasTailMouth ?? true;
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const tailCalls: { key: LostSessionGrave; maxChars: number }[] = [];
  const sessionTranscriptTail: SessionTranscriptTail | undefined =
    tailBody === undefined
      ? undefined
      : ({
          readTail: async (key: LostSessionGrave, maxChars: number) => {
            tailCalls.push({ key, maxChars });
            return tailBody;
          },
        } as unknown as SessionTranscriptTail);
  let clock = Date.now();
  const stores = {
    ...createMemoryStores(),
    ...(sessionTranscriptTail === undefined ? {} : { sessionTranscriptTail }),
  };
  const pool = createManagerPool({
    stores,
    post: () => {},
    runners: registry,
    now: () => clock,
  });
  const started = await pool.start({ request: '調べて', cwd: '/work/project' });
  if (options.capabilities !== undefined) {
    await runner.emit({
      type: 'hello',
      runnerId: runner.runnerId,
      capabilities: options.capabilities,
    });
  }
  return {
    pool,
    stores,
    runner,
    tailCalls,
    managerId: started.managerId,
    advance: (ms: number) => {
      clock += ms;
    },
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

async function nameSession(h: Awaited<ReturnType<typeof harnessOf>>): Promise<void> {
  await h.runner.emit({ type: 'session', managerId: h.managerId, sessionId: 'sess-probe' });
  await h.runner.emit({ type: 'project_key', managerId: h.managerId, projectKey: 'proj-probe' });
}

async function turnEndTailOf(h: Awaited<ReturnType<typeof harnessOf>>) {
  return (await h.pool.list()).find((entry) => entry.managerId === h.managerId)?.turnEndTail;
}

describe('ターンの終わりの見回りは、生ログの末尾だけを読む（#4628）', () => {
  it('預かりの末尾の口があれば、同じ上限で末尾を読み、runner の全文は取り寄せない', async () => {
    const h = await harnessOf(endTurnLine('預かりの末尾で見えた報告'));
    h.runner.liveTranscript = endTurnLine('runner の全文で見えた報告');
    await nameSession(h);

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    expect(h.tailCalls).toEqual([
      { key: { projectKey: 'proj-probe', sessionId: 'sess-probe' }, maxChars: PROBE_CHARS },
    ]);
    expect(h.runner.transcriptCalls).toEqual([]);
    expect(await turnEndTailOf(h)).toBe('預かりの末尾で見えた報告');

    await h.close();
  });

  // 経緯（#5160）: この2本は「runner の全文（`transcript()`）に落ちる」を固めていた。全文を文字へ直すだけでデーモンの
  // ループを塞ぐので、`transcript-tail` を名乗る runner の末尾の口へ落ちる形に反転した（全文は取らない）。
  it('預かりに末尾が無ければ（null）、runner の末尾の口に落ちる。全文は取り寄せない', async () => {
    const h = await harnessOf(null);
    h.runner.liveTranscript = endTurnLine('runner の末尾で見えた報告');
    await nameSession(h);

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    expect(h.tailCalls).toHaveLength(1);
    expect(h.runner.transcriptTailCalls).toEqual([
      { managerId: h.managerId, maxChars: PROBE_CHARS },
    ]);
    expect(h.runner.transcriptCalls).toEqual([]);
    expect(await turnEndTailOf(h)).toBe('runner の末尾で見えた報告');

    await h.close();
  });

  it('末尾の口が無い構成（fs）や、鍵がまだ名乗られていない委譲は、runner の末尾の口に落ちる', async () => {
    const withoutStore = await harnessOf(undefined);
    withoutStore.runner.liveTranscript = endTurnLine('fs の構成');
    await nameSession(withoutStore);
    withoutStore.advance(PAST_QUIET_GATE_MS);
    await withoutStore.pool.probeTurnEnds();
    expect(await turnEndTailOf(withoutStore)).toBe('fs の構成');
    expect(withoutStore.runner.transcriptCalls).toEqual([]);
    await withoutStore.close();

    const unnamed = await harnessOf(endTurnLine('使われないはずの末尾'));
    unnamed.runner.liveTranscript = endTurnLine('鍵の無い委譲');
    unnamed.advance(PAST_QUIET_GATE_MS);
    await unnamed.pool.probeTurnEnds();
    expect(unnamed.tailCalls).toEqual([]);
    await vi.waitFor(async () => expect(await turnEndTailOf(unnamed)).toBe('鍵の無い委譲'));
    await unnamed.close();
  });
});

describe('ManagerPool#transcriptTail: 退避は末尾だけを読み、全文（archive.read）を取り寄せない（#4638）', () => {
  async function poolWithArchivedJob(body: string) {
    const stores = createMemoryStores();
    const written = await stores.archive.archive('sess-archived', body);
    await stores.jobs.putJob({
      id: 'mgr-archived',
      createdAt: '2026-10-13T00:00:00.000Z',
      updatedAt: '2026-10-13T00:00:00.000Z',
      status: 'done',
      summary: '退避だけが残る委譲',
      archiveIds: [written.id],
    });
    const fullRead = vi.spyOn(stores.archive, 'read');
    const registry = createRunnerRegistry();
    const pool = createManagerPool({ stores, post: () => {}, runners: registry });
    // 省略可能な口を `?.` で呼ばない: 口が無い回に黙って測らずに緑になるため
    const transcriptTail = pool.transcriptTail?.bind(pool);
    if (transcriptTail === undefined) throw new Error('Pool に transcriptTail の口が無い');
    return { stores, pool, transcriptTail, registry, fullRead, archiveId: written.id };
  }

  it('本文が上限より長ければ、上限を厳密に上回る末尾だけを返し、全文の読みを呼ばない', async () => {
    const body = `${'あ'.repeat(5000)}\n${endTurnLine('末尾の報告')}`;
    const h = await poolWithArchivedJob(body);

    const result = await h.transcriptTail('mgr-archived', 1000);

    expect(h.fullRead).not.toHaveBeenCalled();
    expect(result.kind).toBe('body');
    if (result.kind !== 'body') throw new Error('本文が返っていない');
    expect(result.archiveId).toBe(h.archiveId);
    expect(result.body.length).toBeGreaterThan(1000);
    expect(result.body.length).toBeLessThan(body.length);
    expect(body.endsWith(result.body)).toBe(true);

    await h.pool.stop();
    await h.registry.stop();
  });

  it('退避の本文が消されていれば removed を返す（missing に畳まない）', async () => {
    const h = await poolWithArchivedJob(endTurnLine('消される報告'));
    await h.stores.archive.remove(h.archiveId);

    const result = await h.transcriptTail('mgr-archived', 1000);

    expect(result.kind).toBe('removed');
    expect(h.fullRead).not.toHaveBeenCalled();

    await h.pool.stop();
    await h.registry.stop();
  });
});

describe('見回りの2の段: runner の末尾の口（transcript-tail）だけを使い、全文は取らない（#5160）', () => {
  const TAIL_LINE_SAMPLE = 'すり抜けない報告';

  async function withArchive(h: Awaited<ReturnType<typeof harnessOf>>, body: string) {
    const written = await h.stores.archive.archive('sess-probe', body);
    const job = await h.stores.jobs.getJob(h.managerId);
    if (job === null) throw new Error('台帳に委譲が無い');
    await h.stores.jobs.putJob({ ...job, archiveIds: [written.id] });
    return written.id;
  }

  async function tailOf(h: Awaited<ReturnType<typeof harnessOf>>, maxChars = 1000) {
    const transcriptTail = h.pool.transcriptTail?.bind(h.pool);
    if (transcriptTail === undefined) throw new Error('Pool に transcriptTail の口が無い');
    return transcriptTail(h.managerId, maxChars);
  }

  async function stageLines(h: Awaited<ReturnType<typeof harnessOf>>): Promise<string[]> {
    const entries = await h.stores.journal.list({ types: ['decision'] });
    return entries.flatMap((entry) =>
      entry.type === 'decision' &&
      entry.decision.includes('生ログの末尾を pg の預かりに見つけられず')
        ? [entry.decision]
        : [],
    );
  }

  it('名乗る runner では transcriptTail だけが呼ばれ、transcript は呼ばれない', async () => {
    const h = await harnessOf(null);
    h.runner.liveTranscript = endTurnLine(TAIL_LINE_SAMPLE);

    const result = await tailOf(h, 777);

    expect(result).toEqual({ kind: 'body', body: endTurnLine(TAIL_LINE_SAMPLE) });
    expect(h.runner.transcriptTailCalls).toEqual([{ managerId: h.managerId, maxChars: 777 }]);
    expect(h.runner.transcriptCalls).toEqual([]);
    await h.close();
  });

  it('⭐ 名乗らない runner では transcript も transcriptTail も呼ばれず、退避に本文が無ければ unreadable を返す', async () => {
    const h = await harnessOf(null, { capabilities: [] });
    h.runner.liveTranscript = endTurnLine('取りに行ってはいけない全文');

    const result = await tailOf(h);

    expect(h.runner.transcriptCalls).toEqual([]);
    expect(h.runner.transcriptTailCalls).toEqual([]);
    expect(result.kind).toBe('unreadable');
    if (result.kind !== 'unreadable') throw new Error('unreadable ではない');
    expect(result.detail).toContain('transcript-tail');
    expect(result.detail).toContain('全文は取らず');
    await h.close();
  });

  it('hello を受けていない runner も、名乗らないものとして全文へ落ちない', async () => {
    const h = await harnessOf(null, { capabilities: undefined as unknown as string[] });
    h.runner.liveTranscript = endTurnLine('取りに行ってはいけない全文');

    const result = await tailOf(h);

    expect(result.kind).toBe('unreadable');
    expect(h.runner.transcriptCalls).toEqual([]);
    await h.close();
  });

  it('名乗っていても口そのものを持たない runner は、全文へ落ちず unreadable を返す', async () => {
    const h = await harnessOf(null, {
      capabilities: [RUNNER_CAPABILITY_TRANSCRIPT_TAIL],
      hasTailMouth: false,
    });
    h.runner.liveTranscript = endTurnLine('取りに行ってはいけない全文');

    const result = await tailOf(h);

    expect(result.kind).toBe('unreadable');
    expect(h.runner.transcriptCalls).toEqual([]);
    await h.close();
  });

  it('名乗らない runner でも、退避に本文があればそれを返す', async () => {
    const h = await harnessOf(null, { capabilities: [] });
    const archiveId = await withArchive(h, endTurnLine('退避の報告'));

    const result = await tailOf(h);

    expect(result).toEqual({ kind: 'body', body: endTurnLine('退避の報告'), archiveId });
    expect(h.runner.transcriptCalls).toEqual([]);
    expect(h.runner.transcriptTailCalls).toEqual([]);
    await h.close();
  });

  it('名乗らない runner で、退避が消されていれば unreadable ではなく removed を優先する', async () => {
    const h = await harnessOf(null, { capabilities: [] });
    const archiveId = await withArchive(h, endTurnLine('消される報告'));
    await h.stores.archive.remove(archiveId);

    const result = await tailOf(h);

    expect(result.kind).toBe('removed');
    await h.close();
  });

  it('名乗る runner が本文を返さなければ（null）、退避へ進み、unreadable にはしない', async () => {
    const h = await harnessOf(null);
    h.runner.liveTranscript = null;

    expect((await tailOf(h)).kind).toBe('missing');
    expect(h.runner.transcriptCalls).toEqual([]);
    await h.close();
  });

  it('日誌の1行は、委譲ごと・種類ごとに、プロセスにつき1回だけ書かれる', async () => {
    const h = await harnessOf(null);
    h.runner.liveTranscript = endTurnLine(TAIL_LINE_SAMPLE);

    await tailOf(h);
    await tailOf(h);
    await tailOf(h);
    const taken = await stageLines(h);
    expect(taken).toEqual([
      `見回りが、生ログの末尾を pg の預かりに見つけられず、runner の末尾の口から取った（委譲 ${h.managerId}・runner runner-primary）`,
    ]);

    // 種類が変われば（名乗りが外れた runner を見たら）同じ委譲でももう1行書く。以降は重ねない
    await h.runner.emit({
      type: 'hello',
      runnerId: h.runner.runnerId,
      capabilities: [],
    });
    await tailOf(h);
    await tailOf(h);
    const both = await stageLines(h);
    expect(both).toHaveLength(2);
    expect(both).toContain(
      `見回りが、生ログの末尾を pg の預かりに見つけられず、runner が末尾の口（transcript-tail）を名乗っていないので、全文は取らずに読めないとした（委譲 ${h.managerId}・runner runner-primary）`,
    );
    await h.close();
  });

  it('日誌の1行は、委譲が違えば別に書かれる', async () => {
    const h = await harnessOf(null, { capabilities: [] });
    const second = await h.pool.start({ request: '別の調べ', cwd: '/work/project' });
    await tailOf(h);
    const transcriptTail = h.pool.transcriptTail?.bind(h.pool);
    if (transcriptTail === undefined) throw new Error('口が無い');
    await transcriptTail(second.managerId, 1000);
    await transcriptTail(second.managerId, 1000);

    expect(await stageLines(h)).toHaveLength(2);
    await h.close();
  });

  it('pg の預かりに末尾があれば、2の段へ入らず日誌も書かない', async () => {
    const h = await harnessOf(endTurnLine('預かりの末尾'));
    await nameSession(h);

    await tailOf(h);

    expect(await stageLines(h)).toEqual([]);
    await h.close();
  });

  it('見回り（probeTurnEnds）は unreadable を受けても止まらず、印を外して次の回へ進む', async () => {
    const h = await harnessOf(null, { capabilities: [] });
    h.runner.liveTranscript = endTurnLine('末尾の報告');
    await nameSession(h);

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();
    expect(await turnEndTailOf(h)).toBeUndefined();
    expect(h.runner.transcriptCalls).toEqual([]);

    // 次の回に名乗りが揃えば、同じ委譲の見回りがふつうに印を立てる
    await h.runner.emit({
      type: 'hello',
      runnerId: h.runner.runnerId,
      capabilities: [RUNNER_CAPABILITY_TRANSCRIPT_TAIL],
    });
    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();
    await vi.waitFor(async () => expect(await turnEndTailOf(h)).toBe('末尾の報告'));
    await h.close();
  });
});
