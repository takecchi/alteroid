import { describe, expect, it } from 'vitest';

import { CLAUDE_PROVIDER } from './claude-provider.js';
import { collectRunnerProviderGaps, type RunnerProviderSource } from './provider-gaps.js';

/** 指名された provider で動く委譲の欠落が、runner の既定に隠れない（#486 S7）。 */

const CLAUDE = CLAUDE_PROVIDER;
const LACKING = {
  displayName: '偽の codex',
  capabilities: { ...CLAUDE.capabilities, usage: false },
};
const providerOf = (id: string) =>
  id === 'codex' ? LACKING : id === 'claude' ? CLAUDE : undefined;

function pool(
  jobs: { status: string; runnerId?: string; managerProvider?: string }[] | undefined,
): RunnerProviderSource {
  return {
    async runners() {
      return { runners: [{ label: 'r-a', state: 'connected', runnerId: 'runner-a' }] };
    },
    runnerManagerProvider: () => 'claude',
    ...(jobs === undefined ? {} : { list: async () => jobs }),
  };
}

describe('collectRunnerProviderGaps と委譲ごとの provider', () => {
  it('既定が claude の runner で codex を指名して動く委譲があれば、codex の欠落が出る', async () => {
    const lines = await collectRunnerProviderGaps(
      pool([{ status: 'running', runnerId: 'runner-a', managerProvider: 'codex' }]),
      providerOf,
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('provider を指名して動いている委譲');
    expect(lines.join('\n')).toContain('偽の codex');
  });

  it('指名の無い委譲・終わった委譲・既定と同じ指名は何も足さない（従来どおり）', async () => {
    const baseline = await collectRunnerProviderGaps(pool(undefined), providerOf);
    const withJobs = await collectRunnerProviderGaps(
      pool([
        { status: 'running', runnerId: 'runner-a' },
        { status: 'done', runnerId: 'runner-a', managerProvider: 'codex' },
        { status: 'running', runnerId: 'runner-a', managerProvider: 'claude' },
      ]),
      providerOf,
    );
    expect(withJobs).toEqual(baseline);
  });

  it('同じ runner・同じ provider の委譲が複数あっても1回だけ数える', async () => {
    const one = await collectRunnerProviderGaps(
      pool([{ status: 'running', runnerId: 'runner-a', managerProvider: 'codex' }]),
      providerOf,
    );
    const two = await collectRunnerProviderGaps(
      pool([
        { status: 'running', runnerId: 'runner-a', managerProvider: 'codex' },
        { status: 'running', runnerId: 'runner-a', managerProvider: 'codex' },
      ]),
      providerOf,
    );
    expect(two).toEqual(one);
  });
});
