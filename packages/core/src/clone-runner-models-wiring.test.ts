import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { ManagerPool } from './manager.js';
import { MODEL_UNKNOWN_LABEL, RUNNER_MODELS_UNVERIFIED } from './manager-models.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { SelfFacts } from './self.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';

const SELF: SelfFacts = {
  storage: 's',
  local: 'l',
  workspace: 'w',
  cwd: 'c',
  runner: 'r',
  entrypoint: 'e',
  auth: 'a',
  models: { clone: 'opus' },
};

function poolWith(failRunners = false): ManagerPool {
  const base: ManagerPool = {
    start: () => {
      throw new Error('not implemented');
    },
    send: () => {
      throw new Error('not implemented');
    },
    abort: () => {
      throw new Error('not implemented');
    },
    list: () => Promise.resolve([]),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: () => {
      throw new Error('not implemented');
    },
    transcript: () => {
      throw new Error('not implemented');
    },
    unpushedWork: () => {
      throw new Error('not implemented');
    },
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: () => {
      throw new Error('not implemented');
    },
    vacate: () => {
      throw new Error('not implemented');
    },
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  return {
    ...base,
    runners: () =>
      failRunners
        ? Promise.reject(new Error('boom'))
        : (Promise.resolve({
            runners: [
              { label: 'edge-1', state: 'connected', since: 'x', runnerId: 'r1' },
              { label: 'edge-2', state: 'connected', since: 'x', runnerId: 'r2' },
              { label: 'gone', state: 'lost', since: 'x', runnerId: 'r3' },
            ],
            unassigned: [],
          }) as unknown as ReturnType<ManagerPool['runners']>),
    runnerReportedModels: (runnerId) =>
      runnerId === 'r1' ? { manager: 'opus', worker: 'sonnet' } : undefined,
  };
}

function boot(failRunners = false) {
  const { fn, calls } = fakeSdk();
  let captured: ToolContext | undefined;
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    managers: poolWith(failRunners),
    self: SELF,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
  });
  const { events } = wireEvents(clone, 'conv-1');
  async function selfStatus(): Promise<string> {
    if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
    const found = createCloneTools(captured).find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status が無い');
    const result = await found.handler({} as never, {});
    return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
  }
  return { clone, calls, events, selfStatus };
}

describe('クローン — runner が名乗ったモデルの配線（#3947）', () => {
  it('self_status は接続中の runner が名乗ったモデルを出し、名乗っていなければ不明と書く', async () => {
    const s = boot();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain('runner edge-1: マネージャー opus / 作業者 sonnet');
    expect(body).toContain(`runner edge-2: ${MODEL_UNKNOWN_LABEL}`);
    expect(body).not.toContain('runner gone');
    await s.clone.stop();
  });

  it('システムプロンプトには焼かない（実行時に引く）', async () => {
    const s = boot();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const prompt = JSON.stringify(s.calls[0]?.options.systemPrompt);
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt).not.toContain('edge-1');
    expect(prompt).not.toContain('sonnet');
    expect(prompt).toContain('self_status');
    await s.clone.stop();
  });

  it('runners() が落ちたら「確かめられなかった」の1行を出す（取れた顔をしない）', async () => {
    const s = boot(true);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(RUNNER_MODELS_UNVERIFIED);
    expect(body).not.toContain('マネージャー opus');
    await s.clone.stop();
  });
});
