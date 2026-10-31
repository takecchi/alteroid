import { describe, expect, it } from 'vitest';

import { createManagerPool, managerKeyedStateSizes, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_TRANSCRIPT_TAIL,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

// 担当を作っては畳むことをくり返したあとに、委譲の鍵（managerId）で引く Map/Set が溜まっていないかを数える（#6019）。

class QuietRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';

  async identity(): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    return { runnerId: this.runnerId, instanceId: 'boot-1' };
  }
  emit: ((event: RunnerEvent) => unknown) | undefined;

  async connect(onEvent: (event: RunnerEvent) => unknown): Promise<void> {
    this.emit = onEvent;
    onEvent({
      type: 'hello',
      runnerId: this.runnerId,
      capabilities: [RUNNER_CAPABILITY_TRANSCRIPT_TAIL],
    });
  }
  async start(command: Parameters<RunnerClient['start']>[0]): Promise<{ cwd: string }> {
    return { cwd: command.cwd };
  }
  async resume(command: Parameters<RunnerClient['resume']>[0]): Promise<{ cwd: string }> {
    return { cwd: command.cwd };
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
  async transcript(): Promise<string | null> {
    return null;
  }
  async transcriptTail(): Promise<string | null> {
    return null;
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
  runner: QuietRunner;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}> {
  const runner = new QuietRunner();
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  let clock = Date.now();
  const pool = createManagerPool({
    stores: createMemoryStores(),
    post: () => {},
    runners: registry,
    now: () => clock,
    tokenIdentity: () => ({ tokenId: 'token-a', generation: 1 }),
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
const CYCLES = 30;

describe('担当の作成・畳みをくり返したあとの、委譲の鍵の Map/Set（#6019）', () => {
  async function runCycles(): Promise<Record<string, number>> {
    const h = await harnessOf();
    for (let i = 0; i < CYCLES; i += 1) {
      const started = await h.pool.start({ request: '調べて', cwd: '/work/project' });
      await h.runner.emit?.({
        type: 'session',
        managerId: started.managerId,
        sessionId: `sess-${started.managerId}`,
      });
      h.advance(PAST_QUIET_GATE_MS);
      await h.pool.probeTurnEnds();
      await h.pool.abort(started.managerId, 'テストで停止');
      // 畳んだ担当を起こし直し、もう一度畳む（resume が通った回数の欄を立てる）
      await h.pool.send(started.managerId, '続きを');
      await h.pool.abort(started.managerId, 'テストで再び停止');
    }
    const sizes = managerKeyedStateSizes(h.pool);
    await h.close();
    return sizes;
  }

  it('畳んだ担当の分が残らない欄は 0 件に戻る', async () => {
    const sizes = await runCycles();
    expect(sizes['records']).toBe(0);
    expect(sizes['withheldReports']).toBe(0);
    expect(sizes['synthesizedNoticeStreaks']).toBe(0);
    expect(sizes['rateLimitJournalFolds']).toBe(0);
    expect(sizes['lastStaleDecline']).toBe(0);
    expect(sizes['lastHeldStuckNotice']).toBe(0);
    expect(sizes['autoFoldSkipJournalWritten']).toBe(0);
    expect(sizes['reattachBusyRetries']).toBe(0);
    expect(sizes['resumeConfirmations']).toBe(0);
  });

  it('見回りの間隔の記憶（#turnEndProbedAt）は、畳んだ担当の分が残らない', async () => {
    const sizes = await runCycles();
    expect(sizes['turnEndProbedAt']).toBe(0);
  });

  // 次の3本は消さない欄（理由は manager.ts の各欄の doc）。増えるのは担当1本につき1件の小さな値で、消すと判定・日誌が変わる。
  it('消さない欄は、畳んだ担当の分が1本につき1件ずつ残る（現状の固定）', async () => {
    const sizes = await runCycles();
    expect(sizes['tokenIdentities']).toBe(CYCLES);
    expect(sizes['resumedCount']).toBe(CYCLES);
    expect(sizes['transcriptTailJournaled']).toBe(CYCLES);
  });
});
