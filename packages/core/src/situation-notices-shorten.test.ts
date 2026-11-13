import { describe, expect, it } from 'vitest';

import { ORIGIN_NO_TASK_GUIDE } from './clone-batch-prompts.js';
import type { ManagerSummary } from './manager.js';
import type { JobStatus } from './schema.js';
import { describeSituation } from './situation.js';

function summary(id: string, status: JobStatus): ManagerSummary {
  return {
    managerId: id,
    status,
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
  };
}

describe('『いまの全体』の注意書きの短縮（意味を落とさない字面の pin）', () => {
  it('READINGS_NOTICE: 新しい1文字列で、旧の長い文は含まない', () => {
    const text = describeSituation({ managers: [], runners: [] });

    expect(text).toContain('「手が空いている」は空き枠でも、終わった／枠が空いたでもない');
    expect(text).toContain('背景処理待ちを含まない');
    expect(text).toContain('「手が空いている」');
    expect(text).not.toContain('**「手が空いている」は「空き枠」ではない**');
    expect(text).not.toContain('**「手が空いている」は「終わった」でもない**');
    expect(text).not.toContain('**「手が空いている」は「枠が空いた」でもない**');
    expect(text).not.toContain('**「走行中」は「宛先の runner が名簿に居る」でもない**');
  });

  it('LOST_NOTICE は不変（lost の意味と起こし直しの注意が残る）', () => {
    const text = describeSituation({ managers: [summary('m1', 'lost')], runners: [] });

    expect(text).toContain('**戻れなかった(lost) は「終わった」ではない。**');
    expect(text).toContain('**成果の有無は1度も観測していない**');
    expect(text).toContain('名指しで引くなら `manager_list` に status: ["lost"] を渡す');
  });

  it('直近のターンが失敗で終わっている注意に、残すべき語がある', () => {
    const manager = {
      ...summary('m1', 'done'),
      lastFailure: { code: 'rate_limit', via: 'sdk', at: '2026-09-05T00:00:00.000Z' },
    } as ManagerSummary;

    const text = describeSituation({ managers: [manager], runners: [] });

    expect(text).toContain(
      '**直近のターンが失敗で終わっている委譲は、区分の中では見分けが付かない。**',
    );
    expect(text).toContain(
      'この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。',
    );
    expect(text).toContain('**この軸で絞る綴りは無い**');
  });

  it('枠(利用上限)で止まっている注意に、残すべき語がある', () => {
    const manager = { ...summary('m1', 'done'), usageStoppedAt: '2026-09-19T09:00:00.000Z' };

    const text = describeSituation({ managers: [manager], runners: [] });

    expect(text).toContain(
      'この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。',
    );
    expect(text).toContain('Issue #1796');
    expect(text).toContain('⚠ 枠(利用上限)で止まっている');
  });

  it('宛先の runner が消えている注意に、残すべき語がある', () => {
    const manager = { ...summary('m1', 'running'), runnerVanished: true as const };

    const text = describeSituation({ managers: [manager], runners: [] });

    expect(text).toContain('⚠ 宛先の runner が名簿から消えている');
    expect(text).toContain('必ず「走行中」の内側に座る');
  });

  it('ORIGIN_NO_TASK_GUIDE は〔宛先の会話は器が決める〕の注釈を持たない', () => {
    expect(ORIGIN_NO_TASK_GUIDE).not.toContain('宛先の会話は器が決める');
    expect(ORIGIN_NO_TASK_GUIDE).toContain('無ければ task_add で足す。');
  });
});
