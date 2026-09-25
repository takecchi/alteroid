/**
 * `RunnerSession#recoverFromFailedResume`（`runner.ts`）——前のセッションへ resume
 * できなかったときの後始末——を、独立の単位として切り出したもの（Issue #1190
 * 案Z）。
 *
 * **前例（PR #1433 の `runner-turn-tally.ts`・PR #1523 の
 * `runner-subagent-stop-state.ts`）とは切り出しの形が違う。** あちらは
 * 「フィールドの束」——複数のメンバーが共同で持つ状態そのもの——を器へ移した。
 * こちらは**1つの遷移（メソッド）**を移す。触っているフィールド（`#resumeAttempt`
 * `#progressed` `#seed` `#generation` `#query` `#reader` `#sessionId` `#input`
 * ほか）は resume/seed の束・待つ窓の束・SDK セッション生存の束の**3つにまたがって
 * おり、どの束の専有物でもない**（Issue #1190 のコメント「(b) 設計案」§1・§2）ので、
 * フィールドごと移す前例の形は使えない。移せるのは「どの器のどの操作を、どの順で
 * 呼ぶか」という**手順**だけである。
 *
 * ## 何が変わり、何が変わっていないか
 *
 * - **触るフィールドの持ち主は変わっていない。** `#resumeAttempt` / `#progressed` /
 *   `#seed` / `#generation` / `#query` / `#reader` / `#sessionId` / `#input` /
 *   `#openTasks` / `#turnTally` / `#emit` は、すべて `RunnerSession` 側に残る。
 *   この器はそれらを1バイトも持たない。
 * - **変わったのは「暗黙の直接アクセス」を「{@link ResumeRecoveryHost} 越しの
 *   明示のメソッド呼び出し」に変えたことだけである。** `RunnerSession` は
 *   `ResumeRecoveryHost` を実装し、{@link recoverFromFailedResume} へ `this` を渡す。
 * - **呼ぶ順序・await の位置・条件・emit の中身と順序・戻り値は1文字も変えていない。**
 *   `RunnerSession#recoverFromFailedResume` は、この関数を呼ぶだけの薄い口になる。
 *
 * ## 順序の約束（関数の境界の内側に入ったもの）
 *
 * > [runner.ts-verbatim #recoverFromFailedResume]
 * > **`close()` を先に、`clear()` を後に。** `#closeWorkerWaitWindow` は
 * > `settled` を「その時点の `#openTasks` が空か」から導く。先に `clear()`
 * > すると、`task-2` が開いたまま resume に失敗した回まで「全員から完了通知を
 * > 受け切った」（`settled: true`）に化ける — 開いたままの委譲を握り潰して
 * > 帳消しにする形になり、`settled: false` の意味（受け切る前に畳まれた）が
 * > 崩れる。先に読ませてから、読み終わった後で捨てる。
 *
 * この約束は {@link recoverFromFailedResume} の中で
 * `host.closeWorkerWaitWindow()` → `host.discardCarriedOverWork()` の順に
 * ハードコードしてあり、**呼び出し側（`RunnerSession`）からは順序を破れない**
 * ——案Zの動機そのものである（Issue #1190 §4「関数の中に閉じ込めた約束は
 * 守られる」）。
 *
 * ## 限界（このリファクタが直していないもの）
 *
 * - **`#read` 側の順序の約束は、この切り出しの外にある。** 例えば
 *   `#recoverFromFailedResume` を呼ぶ前に `#endedInputForTokenRotation` を
 *   見る、という約束（`runner.ts` の `#read`）は呼び出し側にそのまま残る。
 *   この切り出しが閉じ込めるのは、`#recoverFromFailedResume` **自身の内部**の
 *   手順だけである。
 * - **`stop()` / `#finish` が持つ、似た形の畳む手順とは統合していない。**
 *   両者は同じ部品（`#closeWorkerWaitWindow` / `#shipArchive` /
 *   `#flushUnreported` 等）を**違う順序**で持っており（Issue #1190 のコメント
 *   §3）、統合は挙動を変える可能性がある問いなので、この PR の範囲に含めない。
 * - **テストの分離は買えない。** `runner-resume-recreate-worker-count.test.ts` /
 *   `runner-post-tool-use-failure-resume.test.ts` /
 *   `runner-closed-system-error.test.ts` はブラックボックスのまま、切り出しの
 *   前後で一体で動く。ここで直接テストするのは {@link decideResumeRecoveryOutcome}
 *   （3値の判定そのもの）だけである。
 */

/** `RunnerSession#recoverFromFailedResume` の戻り値の3値。 */
export type ResumeRecoveryOutcome = 'recovered' | 'unresumable' | 'not-a-resume-failure';

/**
 * 3値の判定だけを行う純関数。I/O にも `RunnerSession` の状態にも触れない。
 *
 * - `hadAttempt` が `false`（投げた resume が無かった）なら常に
 *   `not-a-resume-failure`
 * - `progressed`（このセッションで既に手が動いた）が `true` なら
 *   `not-a-resume-failure`（`unresumable` と混ぜない理由は `RunnerSession` 側の
 *   `#recoverFromFailedResume` の doc を見よ——ここでは繰り返さない）
 * - 残るのは「resume が効かず、まだ何も手が動いていない」場合だけで、生ログから
 *   の作り直しに使える記録（`record`）が取れたかどうかで `recovered` /
 *   `unresumable` に分かれる
 */
export function decideResumeRecoveryOutcome(input: {
  readonly hadAttempt: boolean;
  readonly progressed: boolean;
  readonly record: string | null;
}):
  | { readonly outcome: 'not-a-resume-failure' }
  | { readonly outcome: 'unresumable' }
  | { readonly outcome: 'recovered'; readonly record: string } {
  if (!input.hadAttempt) return { outcome: 'not-a-resume-failure' };
  if (input.progressed) return { outcome: 'not-a-resume-failure' };
  return input.record === null
    ? { outcome: 'unresumable' }
    : { outcome: 'recovered', record: input.record };
}

/**
 * `RunnerSession` が実装する狭い host。**手順が呼ぶ操作だけを名乗る**——
 * `RunnerSession` の中身をそのまま晒す形（`#query` / `#seed` 等を直接読み書き
 * させる）にはしていない。9メソッドで、AGENTS.md 的な「10 を大きく超えたら
 * 晒しているだけ」の目安の内側に収まる。
 */
export interface ResumeRecoveryHost {
  /**
   * 投げたが効いたと確かめられていない resume を読み出し、同時に消費する
   * （`RunnerSession#resumeAttempt` の読み出し＋null 化）。**呼ぶたびに毎回
   * `null` へ戻す**——既に `null` であっても書き直しは無害（識別子への代入に
   * 副作用は無い）ので、これ自体が分岐を作らない。
   */
  takeResumeAttempt(): { sessionId: string } | null;
  /** このセッションが既に何かをしたか（`RunnerSession#progressed` の読み出し）。 */
  hasProgressed(): boolean;
  /**
   * 預かった生ログから、新しいセッションへ渡せる記録を組み立てる
   * （`renderSessionLog(this.#seed)` を実行する）。**まだ `#seed` を消さない**
   * ——`recovered` に決まった後で {@link ResumeRecoveryHost.teardownForRecreate}
   * が消す。
   */
  renderSeedRecord(): string | null;
  /** 開いている委譲区間を1件の `worker_wait` として降ろし、閉じる。 */
  closeWorkerWaitWindow(): void;
  /**
   * 前のセッションが開いていた作業者の在り高を捨てる——`#openTasks.clear()` と
   * `#turnTally.discardOpenedWorkersAndRejections()` の2本を、この順で。
   * **必ず {@link ResumeRecoveryHost.closeWorkerWaitWindow} の後に呼ぶこと**
   * （このモジュール冒頭の「順序の約束」）。
   */
  discardCarriedOverWork(): void;
  /** `resume_failed` イベントを emit する。`managerId` は host 側が持つ `#id` から補う。 */
  emitResumeFailed(input: { sessionId: string; reason: string; recovered: boolean }): void;
  /**
   * `recovered` に決まった後だけ呼ぶ、セッションの畳み直し。世代を進め、
   * 死んだ `#query` / `#reader` を畳み、`#sessionId` / `#seed` を手放し、
   * 前の器へ向けていた未消費の入力を文字列へ均して返す（新しいセッションへ
   * 引き継ぐため）。
   */
  teardownForRecreate(): string[];
  /** 生ログからの引き継ぎ一言を組み立て、新しいセッションの入力として積む。 */
  pushHandoff(input: {
    sessionId: string;
    reason: string;
    record: string;
    carried: readonly string[];
  }): void;
  /** 新しいセッション（SDK の子プロセス）を開く（`#open()`）。 */
  openSession(): void;
}

/**
 * `RunnerSession#recoverFromFailedResume` の実体。**呼び出し側（`#read` の2箇所・
 * `#apply` の1箇所、計3箇所）は1行も変わらない**——`RunnerSession` 側はこの関数へ
 * 委譲するだけの薄い口になる。
 *
 * 戻り値の意味は変わっていない:
 *
 * - `recovered`: 新しいセッションへ引き継いだ。呼び出し側は `#finish` しない
 * - `unresumable`: 戻れないと確定した。**呼び出し側はこのセッションを畳む**
 * - `not-a-resume-failure`: resume の失敗ではない。呼び出し側は普段どおり
 */
export function recoverFromFailedResume(
  host: ResumeRecoveryHost,
  reason: string,
): ResumeRecoveryOutcome {
  const attempt = host.takeResumeAttempt();
  if (attempt === null) return 'not-a-resume-failure';

  const progressed = host.hasProgressed();
  const record = host.renderSeedRecord();
  const decision = decideResumeRecoveryOutcome({ hadAttempt: true, progressed, record });

  if (decision.outcome === 'not-a-resume-failure') return decision.outcome;

  // **`close()` を先に、`clear()` を後に。** このモジュール冒頭の「順序の約束」。
  host.closeWorkerWaitWindow();
  host.discardCarriedOverWork();

  if (decision.outcome === 'unresumable') {
    host.emitResumeFailed({ sessionId: attempt.sessionId, reason, recovered: false });
    return 'unresumable';
  }

  // decision.outcome === 'recovered'
  const carried = host.teardownForRecreate();
  host.emitResumeFailed({ sessionId: attempt.sessionId, reason, recovered: true });
  host.pushHandoff({ sessionId: attempt.sessionId, reason, record: decision.record, carried });
  host.openSession();
  return 'recovered';
}
