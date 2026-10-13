import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
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
  liveTranscript: string | null = null;
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

async function harnessOf(tailBody: string | null | undefined) {
  const runner = new EventfulRunner();
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
  const pool = createManagerPool({
    stores: {
      ...createMemoryStores(),
      ...(sessionTranscriptTail === undefined ? {} : { sessionTranscriptTail }),
    },
    post: () => {},
    runners: registry,
    now: () => clock,
  });
  const started = await pool.start({ request: '調べて', cwd: '/work/project' });
  return {
    pool,
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

  it('預かりに末尾が無ければ（null）、runner の全文に落ちる', async () => {
    const h = await harnessOf(null);
    h.runner.liveTranscript = endTurnLine('runner の全文で見えた報告');
    await nameSession(h);

    h.advance(PAST_QUIET_GATE_MS);
    await h.pool.probeTurnEnds();

    expect(h.tailCalls).toHaveLength(1);
    expect(h.runner.transcriptCalls).toEqual([h.managerId]);
    expect(await turnEndTailOf(h)).toBe('runner の全文で見えた報告');

    await h.close();
  });

  it('末尾の口が無い構成（fs）や、鍵がまだ名乗られていない委譲は、runner の全文に落ちる', async () => {
    const withoutStore = await harnessOf(undefined);
    withoutStore.runner.liveTranscript = endTurnLine('fs の構成');
    await nameSession(withoutStore);
    withoutStore.advance(PAST_QUIET_GATE_MS);
    await withoutStore.pool.probeTurnEnds();
    expect(await turnEndTailOf(withoutStore)).toBe('fs の構成');
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
