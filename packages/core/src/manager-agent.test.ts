import { describe, expect, it } from 'vitest';

import {
  describeManagerAgent,
  MANAGER_PROVIDER_UNKNOWN_LABEL,
  managerAgentOf,
} from './manager-provider-format.js';
import { collectRunnerModelLines, RUNNER_MODELS_UNVERIFIED } from './runner-models-lines.js';

const POOL = {
  runnerReportedManagerProvider: (id: string) => (id === 'r1' ? 'claude' : undefined),
  runnerReportedModels: (id: string, provider: string) =>
    id === 'r1' && provider === 'claude'
      ? { manager: 'opus', worker: 'sonnet' }
      : id === 'r1' && provider === 'codex'
        ? { manager: 'gpt', worker: 'なし' }
        : undefined,
};

describe('managerAgentOf（#3947）', () => {
  it('runner が名乗った provider とモデルを返す', () => {
    expect(managerAgentOf(POOL, { runnerId: 'r1' })).toEqual({
      managerProvider: 'claude',
      managerModel: 'opus',
      workerModel: 'sonnet',
    });
  });

  it('クローンが指名した provider のモデルを引く（runner の既定ではない）', () => {
    expect(managerAgentOf(POOL, { runnerId: 'r1', managerProvider: 'codex' })).toEqual({
      managerProvider: 'codex',
      managerModel: 'gpt',
      workerModel: 'なし',
    });
  });

  it('取れないものは欄ごと載せない（既定で埋めない）', () => {
    expect(managerAgentOf(POOL, { runnerId: 'r2' })).toEqual({});
    expect(managerAgentOf(POOL, {})).toEqual({});
    expect(managerAgentOf(undefined, { runnerId: 'r1' })).toEqual({});
    expect(managerAgentOf(POOL, { runnerId: 'r1', managerProvider: 'other' })).toEqual({
      managerProvider: 'other',
    });
  });
});

describe('describeManagerAgent（#3947）', () => {
  it('モデルが取れていれば添える', () => {
    expect(
      describeManagerAgent({
        managerProvider: 'claude',
        managerModel: 'opus',
        workerModel: 'sonnet',
      }),
    ).toBe('claude（マネージャー opus / 作業者 sonnet）');
  });

  it('provider だけ取れてモデルが取れなければ「不明」と書き足す', () => {
    expect(describeManagerAgent({ managerProvider: 'claude' })).toBe(
      `claude（モデルは${MANAGER_PROVIDER_UNKNOWN_LABEL}）`,
    );
  });

  it('provider が取れなければ従来の「不明」のまま', () => {
    expect(describeManagerAgent({})).toBe(MANAGER_PROVIDER_UNKNOWN_LABEL);
  });
});

describe('collectRunnerModelLines（#3947）', () => {
  const runners = async () => ({
    runners: [
      { label: 'a', state: 'connected', runnerId: 'r1' },
      { label: 'b', state: 'connected', runnerId: 'r2' },
      { label: 'c', state: 'lost', runnerId: 'r3' },
      { label: 'd', state: 'connected' },
    ],
  });

  it('接続中の runner ごとに名乗ったモデルを出し、名乗っていなければ不明と書く', async () => {
    expect(
      await collectRunnerModelLines({ runners, runnerReportedModels: POOL.runnerReportedModels }),
    ).toEqual([
      'runner a: claude → マネージャー opus / 作業者 sonnet; codex → マネージャー gpt / 作業者 なし',
      `runner b: ${MANAGER_PROVIDER_UNKNOWN_LABEL}`,
    ]);
  });

  it('名乗りを引く口を持たないプールは何も足さない', async () => {
    expect(await collectRunnerModelLines({ runners })).toEqual([]);
  });

  it('runner の一覧が読めなければ「確かめられなかった」と言う', async () => {
    const failing = async () => {
      throw new Error('boom');
    };
    expect(
      await collectRunnerModelLines({ runners: failing, runnerReportedModels: () => undefined }),
    ).toEqual([RUNNER_MODELS_UNVERIFIED]);
  });
});
