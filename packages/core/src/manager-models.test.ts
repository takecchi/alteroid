import { describe, expect, it } from 'vitest';

import {
  collectRunnerModelLines,
  describeManagerModels,
  managerModelsOf,
  MODEL_UNKNOWN_LABEL,
  RUNNER_MODELS_UNVERIFIED,
} from './manager-models.js';

const POOL = {
  runnerReportedModels: (id: string) => {
    if (id === 'r1') return { manager: 'opus', worker: 'sonnet' };
    if (id === 'half') return { worker: 'haiku' };
    return undefined;
  },
};

describe('managerModelsOf（#3921・#3947）', () => {
  it('runner が名乗ったモデルを返す', () => {
    expect(managerModelsOf(POOL, { runnerId: 'r1' })).toEqual({
      managerModel: 'opus',
      workerModel: 'sonnet',
    });
  });

  it('片方だけ名乗られたら、名乗られた側だけ返す', () => {
    expect(managerModelsOf(POOL, { runnerId: 'half' })).toEqual({ workerModel: 'haiku' });
  });

  it('取れないものは欄ごと載せない（既定で埋めない）', () => {
    expect(managerModelsOf(POOL, { runnerId: 'r2' })).toEqual({});
    expect(managerModelsOf(POOL, {})).toEqual({});
    expect(managerModelsOf(undefined, { runnerId: 'r1' })).toEqual({});
    expect(managerModelsOf({}, { runnerId: 'r1' })).toEqual({});
  });
});

describe('describeManagerModels', () => {
  it('取れない側は「不明」と書く', () => {
    expect(describeManagerModels({ managerModel: 'opus', workerModel: 'sonnet' })).toBe(
      'マネージャー opus / 作業者 sonnet',
    );
    expect(describeManagerModels({ workerModel: 'haiku' })).toBe(
      'マネージャー 不明 / 作業者 haiku',
    );
    expect(describeManagerModels({})).toBe('マネージャー 不明 / 作業者 不明');
  });
});

describe('collectRunnerModelLines（#3947）', () => {
  const runners = async () => ({
    runners: [
      { label: 'a', state: 'connected', runnerId: 'r1' },
      { label: 'b', state: 'connected', runnerId: 'r2' },
      { label: 'c', state: 'lost', runnerId: 'r3' },
      { label: 'd', state: 'connected' },
      { label: '', state: 'vacating', runnerId: 'half' },
    ],
  });

  it('接続中の runner ごとに名乗ったモデルを出し、名乗っていなければ不明と書く', async () => {
    expect(
      await collectRunnerModelLines({ runners, runnerReportedModels: POOL.runnerReportedModels }),
    ).toEqual([
      'runner a: マネージャー opus / 作業者 sonnet',
      `runner b: ${MODEL_UNKNOWN_LABEL}`,
      'runner half: マネージャー 不明 / 作業者 haiku',
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
