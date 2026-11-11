import { describe, expect, it } from 'vitest';

import { workerLimitIdentity } from './runner-worker-limit-notice.js';

// `workerLimitIdentity`（作業者の上限の身元）を、入力 → 出力で直に縛る。
// 期待は、`clone.ts` と `runner.ts` の 4 か所に散っていた式の出力と同じ字（`worker-limit-identity-pin.test.ts` の snapshot と見比べて確かめた）。
describe('workerLimitIdentity', () => {
  it('tool_use の id があればそれ（task の id があっても tool_use が先）', () => {
    expect(workerLimitIdentity('toolu_1', undefined)).toBe('tool_use:toolu_1');
    expect(workerLimitIdentity('toolu_1', 'task-9')).toBe('tool_use:toolu_1');
  });

  it('tool_use の id が無く task の id だけならそれ', () => {
    expect(workerLimitIdentity(undefined, 'task-9')).toBe('task:task-9');
  });

  it('どちらも無ければ背景の作業者 1 つ', () => {
    expect(workerLimitIdentity(undefined, undefined)).toBe('background-worker');
  });

  it('空文字の tool_use の id は「ある」として扱う（undefined だけを無しと読む）', () => {
    expect(workerLimitIdentity('', 'task-9')).toBe('tool_use:');
  });
});
