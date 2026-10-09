import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerPlacementResources,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  reply: 'ok' | 'error' = 'ok';
  started: string[] = [];

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    return this.report;
  }

  async ping(): Promise<void> {
    if (this.reply === 'error') throw new Error('fetch failed');
  }

  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<{ cwd?: string }> {
    this.started.push(command.managerId);
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
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

describe('指名（select({ runnerId })）', () => {
  it('指名した器が使えるなら、資源の点数計算を通さずそこへ置く', async () => {
    const roomy = new FakeRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const tight = new FakeRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const registry = createRunnerRegistry([roomy, tight]);

    const chosen = await registry.select({ runnerId: 'runner-tight' });

    expect(chosen.runnerId).toBe('runner-tight');
    await registry.stop();
  });

  describe('指名した器が使えないとき', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('失敗する。他の器へは落とさない', async () => {
      const alive = new FakeRunner('runner-alive');
      const dying = new FakeRunner('runner-dying');
      const registry = createRunnerRegistry([alive, dying]);

      dying.reply = 'error';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(registry.entries()).toMatchObject([
        { label: 'runner-alive', state: 'connected' },
        { label: 'runner-dying', state: 'lost' },
      ]);

      await expect(registry.select({ runnerId: 'runner-dying' })).rejects.toThrow(/lost/);

      await registry.stop();
    });
  });

  it('名簿にその名前が無いとき失敗する', async () => {
    const a = new FakeRunner('runner-a');
    const b = new FakeRunner('runner-b');
    const registry = createRunnerRegistry([a, b]);

    await expect(registry.select({ runnerId: 'runner-does-not-exist' })).rejects.toThrow(
      /runner-does-not-exist.*一致しない/s,
    );

    await registry.stop();
  });

  it('まだ一度も開けていない器が残っているときは「無い」と断定しない', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 10_000, retryMaxMs: 10_000 });
    void registry.register({
      label: 'まだ開いていない器',
      open: () => new Promise(() => undefined),
    });

    await expect(registry.select({ runnerId: 'runner-unknown' })).rejects.toThrow(
      /まだ一度も開けていないので.*分からない/s,
    );

    await registry.stop();
  });

  it('同じ名前を名乗る2台が開けているとき失敗する（名前が一意でない）', async () => {
    const registry = createRunnerRegistry();
    await registry.register({ label: 'label-a', open: async () => new FakeRunner('dup-name') });
    await registry.register({ label: 'label-b', open: async () => new FakeRunner('dup-name') });

    await expect(registry.select({ runnerId: 'dup-name' })).rejects.toThrow(/一意でない/);

    await registry.stop();
  });

  it('同じ名前を名乗る器が大量に開けていても、一覧は抜粋の合図で締まる', async () => {
    const registry = createRunnerRegistry();
    const count = 30;
    for (let index = 0; index < count; index += 1) {
      await registry.register({
        label: `label-${index}`,
        open: async () => new FakeRunner('dup-name-many'),
      });
    }

    let caught: unknown;
    try {
      await registry.select({ runnerId: 'dup-name-many' });
    } catch (error) {
      caught = error;
    }
    const message = String((caught as Error | undefined)?.message);
    expect(message).toMatch(/一意でない/);
    expect(message.length).toBeLessThan(1_000);
    expect(message).toMatch(/省略/);

    await registry.stop();
  });
});
