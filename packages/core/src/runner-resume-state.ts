/**
 * `RunnerSession`（`runner.ts`）の resume/seed の状態4フィールドの器。
 *
 * `RunnerSession` へ戻さない: 束だけを触るのは `resume` と `#markProgressed` だけで、
 * 他の読み書きはこのクラスのメソッド呼び出しに置き換えてある。resume の判断と
 * SDK セッションの開閉は `RunnerSession` が持ち、このクラスは private な状態だけを持つ。
 * `ResumeRecoveryHost`（`runner-resume-recovery.ts`）はこのクラスを知らない。
 */
export class RunnerResumeState {
  /**
   * resume のために預かった生ログ。
   *
   * `#markProgressed` で解放する: `load()` は SDK がセッションを開く最初の1回だけで、
   * `#progressed` が立つより必ず先に済んでいる。
   * `system/init` では解放しない: 成否の基準は `#progressed` であり、`init` の直後・
   * 何も手が動く前に切れた接続は「resume が効かなかった」として扱われ、その回復
   * （`renderSessionLog(this.#seed)`）に `#seed` が要る。
   */
  #seed: unknown[] | undefined;

  /**
   * 投げたが、まだ効いたと確かめられていない resume。
   *
   * 「resume を投げた」と「続きへ戻れた」は別物: SDK は開いた後に
   * `No conversation found with session ID: …` を投げてくるので、成否は
   * `system/init` が来たかどうかで見るしかない（`clone.ts` の `#sawInit` と同じ形）。
   */
  #resumeAttempt: { sessionId: string } | null = null;

  #sessionId: string | undefined;

  /**
   * 一度立てたら二度と下ろさない: 生ログからの作り直しを手が動く前だけに限る旗で、
   * 動いた後で作り直すと済んだ作業を記録から二度走らせる。
   */
  #progressed = false;

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get seed(): unknown[] | undefined {
    return this.#seed;
  }

  get progressed(): boolean {
    return this.#progressed;
  }

  beginResume(sessionId: string, entries: unknown[] | undefined): void {
    this.#sessionId = sessionId;
    this.#seed = entries;
    this.#resumeAttempt = { sessionId };
  }

  // `#sessionId` と `#seed` には触れない: 前者は開き直す前と同じ値で、後者の生ログからの引き継ぎは別経路が持つ。
  armResumeAttempt(sessionId: string): void {
    this.#resumeAttempt = { sessionId };
  }

  takeAttempt(): { sessionId: string } | null {
    const attempt = this.#resumeAttempt;
    this.#resumeAttempt = null;
    return attempt;
  }

  // `#progressed` を立てる唯一の口にする: 別の経路を作ると `#seed` の解放を足し忘れる経路が生まれる。
  markProgressed(): void {
    if (this.#progressed) return;
    this.#progressed = true;
    this.#seed = undefined;
  }

  // 比較は代入より前に行う。`init` はターンの頭ごとに来る（根拠は `runner.ts` の `#liveBackgroundTasks`）。
  observeSessionStarted(sessionId: string): boolean {
    const changed = this.#sessionId !== sessionId;
    this.#sessionId = sessionId;
    return changed;
  }

  discardForRecreate(): void {
    this.#sessionId = undefined;
    this.#seed = undefined;
  }
}
