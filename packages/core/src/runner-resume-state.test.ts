import { describe, expect, it } from 'vitest';

import { RunnerResumeState } from './runner-resume-state.js';

/**
 * `runner-resume-state.ts` の歯。**純粋なクラスなので I/O のモック無しで
 * 全分岐に通せる**（`runner-cut-off-workers.test.ts` / `runner-turn-tally.test.ts`
 * と同じ作法。前例は PR #1551 / #1523）。
 *
 * ここが固定するのは、切り出した4フィールドの**状態の器としての性質**
 * ——resume の開始・投げた resume の消費・progressed が立つと seed を手放す・
 * session_started の観測が「変わったか」を返す・作り直しで sessionId と seed を
 * 手放す、である。`RunnerSession` が「いつ呼ぶか・`#emit` するかどうか・
 * SDK セッションをいつ開く／畳むか」の判断は既存のブラックボックステスト
 * （`runner-token-rotation.test.ts` / `runner-resume-recreate-worker-count.test.ts`
 * 等）が引き続き持つ——ここでは扱わない。
 */

describe('RunnerResumeState — 初期状態', () => {
  it('生成直後は sessionId / seed が undefined、progressed が false', () => {
    const state = new RunnerResumeState();
    expect(state.sessionId).toBeUndefined();
    expect(state.seed).toBeUndefined();
    expect(state.progressed).toBe(false);
  });

  it('生成直後は takeAttempt が null を返す（投げた resume が無い）', () => {
    const state = new RunnerResumeState();
    expect(state.takeAttempt()).toBeNull();
  });
});

describe('RunnerResumeState — beginResume（resume() が呼ぶ、3本まとめて立てる）', () => {
  it('sessionId / seed / 投げた resume の3本をまとめて立てる', () => {
    const state = new RunnerResumeState();
    const entries = [{ dummy: 'entry' }] as unknown as Parameters<
      RunnerResumeState['beginResume']
    >[1];
    state.beginResume('session-1', entries);
    expect(state.sessionId).toBe('session-1');
    expect(state.seed).toBe(entries);
    expect(state.takeAttempt()).toEqual({ sessionId: 'session-1' });
  });

  it('entries が undefined でも受け付ける（resume に生ログが無い回）', () => {
    const state = new RunnerResumeState();
    state.beginResume('session-1', undefined);
    expect(state.seed).toBeUndefined();
  });
});

describe('RunnerResumeState — takeAttempt（読んで null に戻す）', () => {
  it('立てた直後は読み出せて、読み出すと同時に null へ戻る', () => {
    const state = new RunnerResumeState();
    state.beginResume('session-1', undefined);
    expect(state.takeAttempt()).toEqual({ sessionId: 'session-1' });
    // 2回目は既に消費済みなので null。
    expect(state.takeAttempt()).toBeNull();
  });
});

describe('RunnerResumeState — armResumeAttempt（#reopenForTokenRotation が呼ぶ）', () => {
  it('resumeAttempt だけを立て、sessionId / seed には触れない', () => {
    const state = new RunnerResumeState();
    state.beginResume('session-1', [{ a: 1 }] as unknown as Parameters<
      RunnerResumeState['beginResume']
    >[1]);
    // 一度消費させてから、開き直しの armResumeAttempt を呼ぶ。
    state.takeAttempt();
    state.markProgressed();
    state.armResumeAttempt('session-1');
    expect(state.takeAttempt()).toEqual({ sessionId: 'session-1' });
    // markProgressed 済みなので seed は解放されたまま（armResumeAttempt では戻らない）。
    expect(state.seed).toBeUndefined();
    expect(state.sessionId).toBe('session-1');
  });
});

describe('RunnerResumeState — markProgressed（立てると同時に seed を解放する）', () => {
  it('progressed を true にし、seed を undefined へ解放する', () => {
    const state = new RunnerResumeState();
    state.beginResume('session-1', [{ a: 1 }] as unknown as Parameters<
      RunnerResumeState['beginResume']
    >[1]);
    expect(state.seed).not.toBeUndefined();
    state.markProgressed();
    expect(state.progressed).toBe(true);
    expect(state.seed).toBeUndefined();
  });

  it('既に立っていれば何もしない（idempotent）——後から積んだ seed を巻き戻さない', () => {
    const state = new RunnerResumeState();
    state.markProgressed();
    expect(state.progressed).toBe(true);
    // progressed が既に true の状態で、新しい resume の素材を積んでも……
    state.beginResume('session-2', [{ b: 2 }] as unknown as Parameters<
      RunnerResumeState['beginResume']
    >[1]);
    // ……markProgressed をもう一度呼んでも、この seed は解放されない
    // （`if (this.#progressed) return;` が2行目以降に到達させない——元の
    // `RunnerSession#markProgressed` と同じ「一度立てたら二度と下ろさない」挙動）。
    state.markProgressed();
    expect(state.seed).not.toBeUndefined();
  });
});

describe("RunnerResumeState — observeSessionStarted（case 'session_started' が呼ぶ）", () => {
  it('初回（sessionId が未設定）は必ず「変わった」を返し、値を立てる', () => {
    const state = new RunnerResumeState();
    expect(state.observeSessionStarted('session-1')).toBe(true);
    expect(state.sessionId).toBe('session-1');
  });

  it('同じ sessionId が続けて来ても「変わっていない」を返す（false）', () => {
    const state = new RunnerResumeState();
    state.observeSessionStarted('session-1');
    expect(state.observeSessionStarted('session-1')).toBe(false);
    expect(state.sessionId).toBe('session-1');
  });

  it('違う sessionId が来たら「変わった」を返し、値を更新する', () => {
    const state = new RunnerResumeState();
    state.observeSessionStarted('session-1');
    expect(state.observeSessionStarted('session-2')).toBe(true);
    expect(state.sessionId).toBe('session-2');
  });

  it('比較は代入より前に行う（戻り値は代入前の値との比較である）', () => {
    const state = new RunnerResumeState();
    state.beginResume('session-1', undefined);
    // beginResume 済みの sessionId と同じ値が session_started で来ても
    // 「変わっていない」——resume を投げた直後の init はここに来る通常の形。
    expect(state.observeSessionStarted('session-1')).toBe(false);
  });
});

describe('RunnerResumeState — discardForRecreate（作り直すとき、sessionId と seed を捨てる）', () => {
  it('sessionId と seed を両方 undefined に戻す', () => {
    const state = new RunnerResumeState();
    state.beginResume('session-1', [{ a: 1 }] as unknown as Parameters<
      RunnerResumeState['beginResume']
    >[1]);
    state.discardForRecreate();
    expect(state.sessionId).toBeUndefined();
    expect(state.seed).toBeUndefined();
  });

  it('progressed には触れない', () => {
    const state = new RunnerResumeState();
    state.markProgressed();
    state.discardForRecreate();
    expect(state.progressed).toBe(true);
  });

  it('投げた resume（resumeAttempt）には触れない——teardownForRecreate を呼ぶ経路は既に emitResumeFailed で消費済みだが、このメソッド自体は独立に確かめる', () => {
    const state = new RunnerResumeState();
    state.beginResume('session-1', undefined);
    state.discardForRecreate();
    // beginResume で立てた resumeAttempt は、discardForRecreate では消えない
    // （消費するのは takeAttempt だけ）。
    expect(state.takeAttempt()).toEqual({ sessionId: 'session-1' });
  });
});
