import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { ManagerPool } from './manager.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import {
  RUNNER_PROVIDER_UNVERIFIED,
  describeProviderGaps,
  type ProviderGapSubject,
} from './provider-gaps.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { SelfFacts } from './self.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitFor, waitForDone, wireEvents } from './clone-test-harness.js';

/**
 * 欠落の表示の配線（#486 S2 の続き）。クローン層だけが起動時に確定してシステムプロンプトへ入り、
 * runner ごとのマネージャー層（と作業者層）は `runnerManagerProvider` を実行時に引いて
 * `self_status` と digest へ出る。偽の provider は `providerOf` で差す（本番の id は広げない）。
 */
const FAKE: ProviderGapSubject = {
  displayName: '偽',
  capabilities: { ...CLAUDE_PROVIDER.capabilities, usage: false },
};

const SELF: SelfFacts = {
  storage: 's',
  local: 'l',
  workspace: 'w',
  cwd: 'c',
  runner: 'r',
  entrypoint: 'e',
  auth: 'a',
  models: { clone: 'opus', manager: 'opus', worker: 'sonnet' },
  providerGaps: describeProviderGaps({ clone: CLAUDE_PROVIDER }),
};

const RUNNER_LINE = 'runner「edge-1」のマネージャー層（偽）は usage を持たない';

function poolWith(provider: string, failRunners = false): ManagerPool {
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
    appraise: () => {
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
    list: () => Promise.resolve([]),
    runners: () =>
      failRunners
        ? Promise.reject(new Error('boom'))
        : (Promise.resolve({
            runners: [
              { label: 'edge-1', state: 'connected', since: 'x', runnerId: 'r1' },
              { label: 'gone', state: 'lost', since: 'x', runnerId: 'r2' },
            ],
            unassigned: [],
          }) as unknown as ReturnType<ManagerPool['runners']>),
    runnerManagerProvider: () => provider,
  };
}

function boot(provider: string, failRunners = false) {
  const { fn, calls } = fakeSdk();
  let captured: ToolContext | undefined;
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    managers: poolWith(provider, failRunners),
    self: SELF,
    providerOf: (id) => (id === 'fake' ? FAKE : id === 'claude' ? CLAUDE_PROVIDER : undefined),
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

describe('クローン — provider の欠落の配線', () => {
  it('偽 provider を名乗る runner のマネージャー層が self_status・digest に出て、システムプロンプトには出ない', async () => {
    const s = boot('fake');
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(RUNNER_LINE);
    expect(body).toContain('runner「edge-1」の作業者層（偽）は usage を持たない');
    expect(body).not.toContain('gone');

    const prompt = JSON.stringify(s.calls[0]?.options.systemPrompt);
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt).not.toContain('edge-1');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-gap',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });
    await waitFor(
      () => s.calls.some((c) => c.inputs.join('\n').includes(RUNNER_LINE)),
      'tick の digest に runner の欠落が届く',
    );
    await s.clone.stop();
  });

  it('claude を名乗る runner なら self_status は欠落の節を持たない', async () => {
    const s = boot('claude');
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    expect(await s.selfStatus()).not.toContain('provider が持たない能力');
    await s.clone.stop();
  });

  it('未知の provider id は「確かめられない」と出る', async () => {
    const s = boot('mystery');
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    expect(await s.selfStatus()).toContain('未知の provider（mystery）');
    await s.clone.stop();
  });

  it('runners() が落ちたら「確かめられなかった」の行が self_status と digest に出る（欠落なしに見せない）', async () => {
    const s = boot('fake', true);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    expect(await s.selfStatus()).toContain(RUNNER_PROVIDER_UNVERIFIED);
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-unverified',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });
    await waitFor(
      () => s.calls.some((c) => c.inputs.join('\n').includes(RUNNER_PROVIDER_UNVERIFIED)),
      'tick の digest に届く',
    );
    await s.clone.stop();
  });
});
