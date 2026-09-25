import { describe, expect, it } from 'vitest';

import {
  decideResumeRecoveryOutcome,
  recoverFromFailedResume,
  type ResumeRecoveryHost,
} from './runner-resume-recovery.js';

/**
 * `runner-resume-recovery.ts` の歯。
 *
 * **`decideResumeRecoveryOutcome` は純関数なので、I/O のモック無しで3値の
 * 全分岐に通せる**（`runner-subagent-stop-state.test.ts` と同じ作法）。
 *
 * **`recoverFromFailedResume`（手順そのもの）は、`ResumeRecoveryHost` の
 * フェイクを1つ用意して固定する。** ここで固定したいのは主に、
 * `RunnerSession#recoverFromFailedResume` の doc に逐語である**順序の約束**
 * （`close()` を先に、`clear()` を後に）が、host の呼び出し順として実際に
 * 守られていることである——`RunnerSession`（`runner.ts`）側のブラックボックス
 * テスト（`runner-resume-recreate-worker-count.test.ts` /
 * `runner-post-tool-use-failure-resume.test.ts` 等）は、この保証を実配線越しに
 * 重ねて確かめる。
 */

function createFakeHost(input: {
  attempt: { sessionId: string } | null;
  progressed: boolean;
  record: string | null;
}): ResumeRecoveryHost & { readonly calls: string[] } {
  const calls: string[] = [];
  let attempt = input.attempt;
  return {
    calls,
    takeResumeAttempt() {
      calls.push('takeResumeAttempt');
      const current = attempt;
      attempt = null;
      return current;
    },
    hasProgressed() {
      calls.push('hasProgressed');
      return input.progressed;
    },
    renderSeedRecord() {
      calls.push('renderSeedRecord');
      return input.record;
    },
    closeWorkerWaitWindow() {
      calls.push('closeWorkerWaitWindow');
    },
    discardCarriedOverWork() {
      calls.push('discardCarriedOverWork');
    },
    emitResumeFailed() {
      calls.push('emitResumeFailed');
    },
    teardownForRecreate() {
      calls.push('teardownForRecreate');
      return ['carried-1'];
    },
    pushHandoff() {
      calls.push('pushHandoff');
    },
    openSession() {
      calls.push('openSession');
    },
  };
}

describe('decideResumeRecoveryOutcome — 3値の判定（純関数）', () => {
  it('投げた resume が無ければ、progressed / record の値によらず not-a-resume-failure', () => {
    expect(
      decideResumeRecoveryOutcome({ hadAttempt: false, progressed: false, record: 'x' }),
    ).toEqual({ outcome: 'not-a-resume-failure' });
    expect(
      decideResumeRecoveryOutcome({ hadAttempt: false, progressed: true, record: null }),
    ).toEqual({ outcome: 'not-a-resume-failure' });
  });

  it('resume を投げていて、既に手が動いていれば not-a-resume-failure（unresumable と混ぜない）', () => {
    expect(
      decideResumeRecoveryOutcome({ hadAttempt: true, progressed: true, record: 'x' }),
    ).toEqual({ outcome: 'not-a-resume-failure' });
    expect(
      decideResumeRecoveryOutcome({ hadAttempt: true, progressed: true, record: null }),
    ).toEqual({ outcome: 'not-a-resume-failure' });
  });

  it('resume を投げていて、手が動いておらず、生ログから記録が組み立てられなければ unresumable', () => {
    expect(
      decideResumeRecoveryOutcome({ hadAttempt: true, progressed: false, record: null }),
    ).toEqual({ outcome: 'unresumable' });
  });

  it('resume を投げていて、手が動いておらず、生ログから記録が組み立てられれば recovered（記録を運ぶ）', () => {
    expect(
      decideResumeRecoveryOutcome({ hadAttempt: true, progressed: false, record: '記録' }),
    ).toEqual({ outcome: 'recovered', record: '記録' });
  });
});

describe('recoverFromFailedResume — 手順（host への呼び出し順）', () => {
  it('投げた resume が無ければ、host の他のメソッドを一切呼ばずに not-a-resume-failure を返す', () => {
    const host = createFakeHost({ attempt: null, progressed: false, record: 'x' });
    expect(recoverFromFailedResume(host, '理由')).toBe('not-a-resume-failure');
    expect(host.calls).toEqual(['takeResumeAttempt']);
  });

  it('既に手が動いていれば、待つ窓や作業者の在り高には触れずに not-a-resume-failure を返す', () => {
    const host = createFakeHost({
      attempt: { sessionId: 's1' },
      progressed: true,
      record: '記録',
    });
    expect(recoverFromFailedResume(host, '理由')).toBe('not-a-resume-failure');
    expect(host.calls).toEqual(['takeResumeAttempt', 'hasProgressed', 'renderSeedRecord']);
  });

  it('記録が組み立てられなければ unresumable。closeWorkerWaitWindow → discardCarriedOverWork の順で呼び、テアダウンはしない', () => {
    const host = createFakeHost({ attempt: { sessionId: 's1' }, progressed: false, record: null });
    expect(recoverFromFailedResume(host, '理由')).toBe('unresumable');
    expect(host.calls).toEqual([
      'takeResumeAttempt',
      'hasProgressed',
      'renderSeedRecord',
      'closeWorkerWaitWindow',
      'discardCarriedOverWork',
      'emitResumeFailed',
    ]);
  });

  it('記録が組み立てられれば recovered。closeWorkerWaitWindow → discardCarriedOverWork の後にテアダウンし、pushHandoff → openSession の順で開き直す', () => {
    const host = createFakeHost({
      attempt: { sessionId: 's1' },
      progressed: false,
      record: '記録',
    });
    expect(recoverFromFailedResume(host, '理由')).toBe('recovered');
    expect(host.calls).toEqual([
      'takeResumeAttempt',
      'hasProgressed',
      'renderSeedRecord',
      'closeWorkerWaitWindow',
      'discardCarriedOverWork',
      'teardownForRecreate',
      'emitResumeFailed',
      'pushHandoff',
      'openSession',
    ]);
  });

  it('⚠️ 変異: closeWorkerWaitWindow と discardCarriedOverWork の順序を入れ替えると、この歯が赤くなる', () => {
    // **順序の約束（`close()` を先に、`clear()` を後に）が、この歯でも守られて
    // いることの直接証拠。** host 側で意図的に順序を逆にすると、上の2本
    // （unresumable / recovered）の `toEqual` がここで落ちるはずである——
    // 逆に言えば、`recoverFromFailedResume` の実装がこの順を保っている限り
    // 常に緑になる。
    const host = createFakeHost({ attempt: { sessionId: 's1' }, progressed: false, record: null });
    recoverFromFailedResume(host, '理由');
    const closeIndex = host.calls.indexOf('closeWorkerWaitWindow');
    const discardIndex = host.calls.indexOf('discardCarriedOverWork');
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(discardIndex).toBeGreaterThan(closeIndex);
  });
});
