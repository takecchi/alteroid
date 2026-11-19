import { describe, expect, it } from 'vitest';

import { workerLimitIdentities } from './runner-worker-limit-notice.js';

// `workerLimitIdentities`（作業者の上限の身元の別名）を、入力 → 出力で直に縛る。
describe('workerLimitIdentities', () => {
  it('task の id と tool_use の id が両方あれば、task が先で両方並べる', () => {
    expect(workerLimitIdentities(['toolu_1'], 'task-9')).toEqual([
      'task:task-9',
      'tool_use:toolu_1',
    ]);
  });

  it('tool_use の id だけなら tool_use だけ（agent_id を出さない古い CLI の発言）', () => {
    expect(workerLimitIdentities(['toolu_1'], undefined)).toEqual(['tool_use:toolu_1']);
  });

  it('task の id だけなら task だけ', () => {
    expect(workerLimitIdentities([undefined], 'task-9')).toEqual(['task:task-9']);
  });

  it('分かる tool_use の id は全部並べ、同じ id は重ねない（通知の id と task_started で控えた id が違う再開）', () => {
    expect(workerLimitIdentities(['toolu_new', 'toolu_old'], 'task-9')).toEqual([
      'task:task-9',
      'tool_use:toolu_new',
      'tool_use:toolu_old',
    ]);
    expect(workerLimitIdentities(['toolu_1', 'toolu_1'], 'task-9')).toEqual([
      'task:task-9',
      'tool_use:toolu_1',
    ]);
  });

  it('どれも無ければ背景の作業者 1 つ', () => {
    expect(workerLimitIdentities([undefined], undefined)).toEqual(['background-worker']);
    expect(workerLimitIdentities([], undefined)).toEqual(['background-worker']);
  });

  it('空文字の tool_use の id は「ある」として扱う（undefined だけを無しと読む）', () => {
    expect(workerLimitIdentities([''], 'task-9')).toEqual(['task:task-9', 'tool_use:']);
  });
});
