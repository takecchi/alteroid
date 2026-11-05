import { describe, expect, it } from 'vitest';

import { measureToolResults } from './tool-result-size.test-support.js';
import type { FixtureConfig } from './tool-result-size.test-support.js';

describe('道具の返り値が履歴へ積む量', () => {
  const CONFIG: FixtureConfig = {
    memory: 'small',
    tasks: 327,
    jobs: 40,
    journalRows: 200,
    humanChars: 80,
    reportChars: 1_500,
  };

  it('一覧・読み取りは予算（約 8,000 字）で頭打ちになり、書き込みは数十字で済む', async () => {
    const samples = await measureToolResults(CONFIG, [
      { name: 'manager_list', args: {} },
      { name: 'task_list', args: {} },
      { name: 'journal_read', args: { limit: 100 } },
      { name: 'manager_report', args: { managerId: 'mgr-103' } },
      { name: 'task_add', args: { title: '確認', body: '了解しました。' } },
    ]);
    const by = Object.fromEntries(samples.map((sample) => [sample.call.name, sample]));
    for (const sample of samples) expect(sample.isError).toBe(false);
    // 予算は字数。表示の見出しの分の余裕を見て 9,000 字で縛る
    for (const name of ['manager_list', 'task_list', 'journal_read']) {
      expect(by[name]!.result.chars).toBeLessThan(9_000);
      expect(by[name]!.result.chars).toBeGreaterThan(3_000);
    }
    expect(by['manager_report']!.result.chars).toBeLessThan(2_500);
    expect(by['task_add']!.result.chars).toBeLessThan(300);
  }, 60_000);
});
