import { describe, expect, it } from 'vitest';

import {
  endsResumeConfirmation,
  resumeConfirmMinutes,
  resumeEvidenceOf,
} from './resume-confirmation.js';

// 印は runner が resume の成否に使う `#markProgressed` と同じ事実に揃える（#4501）。
describe('resume が戻れた印', () => {
  it('道具の使用・確認の要求・失敗の無いターンの報告を印にする', () => {
    expect(
      resumeEvidenceOf({ type: 'tool_use', managerId: 'm', actor: 'manager:m', tool: 'Bash' }),
    ).toBe('tool_use');
    expect(
      resumeEvidenceOf({
        type: 'tool_running',
        managerId: 'm',
        actor: 'manager:m',
        tool: 'Bash',
        toolUseId: 't',
        startedAt: '2026-10-12T00:00:00.000Z',
      }),
    ).toBe('tool_running');
    expect(
      resumeEvidenceOf({
        type: 'ask',
        managerId: 'm',
        requestId: 'r',
        kind: 'permission',
        summary: '確認',
      }),
    ).toBe('ask');
    expect(
      resumeEvidenceOf({ type: 'report', managerId: 'm', text: '済んだ', status: 'done' }),
    ).toBe('report');
  });

  it('失敗したターン・結果を受け取らずに畳んだターンの報告、init（session）、note は印にしない', () => {
    expect(
      resumeEvidenceOf({
        type: 'report',
        managerId: 'm',
        text: '結果なしで終了',
        status: 'running',
        failure: { code: 'error_during_execution', via: 'result' },
      }),
    ).toBeUndefined();
    expect(
      resumeEvidenceOf({
        type: 'report',
        managerId: 'm',
        text: '途中',
        status: 'running',
        unreported: { reason: '畳んだ' },
      }),
    ).toBeUndefined();
    expect(resumeEvidenceOf({ type: 'session', managerId: 'm', sessionId: 's' })).toBeUndefined();
    expect(resumeEvidenceOf({ type: 'note', managerId: 'm', text: 'x' })).toBeUndefined();
  });

  it('resume_failed と closed は確定を打ち切る', () => {
    expect(
      endsResumeConfirmation({
        type: 'resume_failed',
        managerId: 'm',
        sessionId: 's',
        reason: 'x',
        recovered: false,
      }),
    ).toBe(true);
    expect(endsResumeConfirmation({ type: 'note', managerId: 'm', text: 'x' })).toBe(false);
  });

  it('分は丸め、1 分より短くは言わない', () => {
    expect(resumeConfirmMinutes(10 * 60_000)).toBe('10');
    expect(resumeConfirmMinutes(300)).toBe('1');
  });
});
