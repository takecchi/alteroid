/**
 * 背景処理の完了で CLI が起こすはずのターン（「借り」）を、まだ回していないかを数える。
 *
 * 担当のターンの外で背景処理（作業者・背景の Bash）が終わると、続きのターンは alteroid ではなく CLI が自分で起こす
 * （`RunnerSession#push` の doc。alteroid が起こすと二重に回る）。ところが鍵・環境変数の差し替えの畳み直し
 * （`#reopenForTokenRotation`）は、背景処理が0本になった瞬間を境界として入力を閉じる。そこは CLI が完了の知らせで
 * 次のターンを始めようとしている瞬間そのもので、知らせは閉じた古いプロセスに残ったまま、resume した新しいセッションには
 * 二度と届かない。新しいセッションは入力を待って黙り、担当は `manager_send` が来るまで止まる。
 * 畳み直しの側がこの借りを読み、残っていれば新しいセッションへ一言入れて起こす。
 *
 * 状態（`status`）で判定しない: `running` へ戻すのは `push()` と確認への答えだけで、CLI が自分で始めたターンの間も `done` のまま
 * だから。代わりに「借りが生じた後に始まったターンが終わったか」を、出来事の順番（`#seq`）で比べる。
 */
export class RunnerOwedWake {
  #seq = 0;
  #turnOpen = false;
  #turnStartedAt = 0;
  /** 借りが最初に生じた順番。借りが無ければ `undefined`。 */
  #owedSince: number | undefined;
  /** 借りの元になった背景処理（id → 種類）。挿入順を保つ。 */
  readonly #owed = new Map<string, string>();
  /** 直前の `background_tasks_changed` で載っていた背景処理（id → 種類）。 */
  #lastLive = new Map<string, string>();

  /**
   * ターンが動いている合図（ターンの頭の `init`・本体の発言）。閉じていたターンを開く。
   * 本体の発言でも開く: `init` がターンごとに来るのは SDK の doc の言い分で（"normally ahead of every other message of that turn"）、
   * 来なかった版でも「ターンが始まった」を取りこぼさないため。
   */
  noteTurnActivity(): void {
    if (this.#turnOpen) return;
    this.#turnOpen = true;
    this.#turnStartedAt = ++this.#seq;
  }

  /**
   * ターンの終わり。借りが生じた後に始まったターンが終われば、借りは返った（CLI が完了の知らせを読んだ）。
   * 借りより前に始まったターンの終わりでは返さない: 走っている途中に届いた知らせは、次のターンへ回されうるため。
   */
  noteTurnEnded(): void {
    const startedAfterOwed =
      this.#turnOpen && this.#owedSince !== undefined && this.#turnStartedAt > this.#owedSince;
    this.#turnOpen = false;
    if (startedAfterOwed) this.#clear();
  }

  /**
   * 背景処理の一覧（REPLACE 意味論）。前回載っていて今回消えたもの（完了・打ち切り）を借りに数える。
   * 増えた側は数えない: 起こしたのは担当自身で、CLI が起こすターンの理由にはならないため。
   */
  noteLiveSet(tasks: readonly { id: string; taskType: string }[]): void {
    const next = new Map(tasks.map((task) => [task.id, task.taskType] as const));
    for (const [id, taskType] of this.#lastLive) {
      if (!next.has(id)) this.#owe(id, taskType);
    }
    this.#lastLive = next;
  }

  /**
   * 完了の知らせ（`task_notification`）。一覧から消えるより前に届くことがあるので、ここでも借りに数える。
   * 一覧に載ったことのない id は数えない: 背景へ回していない（前景の）作業者の完了まで借りに数え、何も抱えていない担当を起こすため。
   */
  noteTaskFinished(taskId: string): void {
    const taskType = this.#lastLive.get(taskId);
    if (taskType !== undefined) this.#owe(taskId, taskType);
  }

  /** CLI のプロセスが（再）起動した: 一覧は空から数え直す（`SDKBackgroundTasksChangedMessage` の doc）。借りは消さない。 */
  resetLiveSet(): void {
    this.#lastLive = new Map();
  }

  /** 返っていない借りを取り出して空にする。借りが無ければ空の配列。 */
  takeOwed(): { id: string; taskType: string }[] {
    if (this.#owedSince === undefined) return [];
    const owed = [...this.#owed].map(([id, taskType]) => ({ id, taskType }));
    this.#clear();
    return owed;
  }

  #owe(id: string, taskType: string): void {
    this.#owedSince ??= ++this.#seq;
    this.#owed.set(id, taskType);
  }

  #clear(): void {
    this.#owedSince = undefined;
    this.#owed.clear();
  }
}

/**
 * 畳み直しで消えた完了の知らせの代わりに、新しいセッションへ入れる一言。
 * 「要るなら確かめよ」と任意の言い方にしない: 担当は完了の知らせを待ってターンを閉じており、任意に読むと「待つだけ」へ戻るため（#4902 と同じ形）。
 */
export function owedWakeReopenedNudge(
  owed: readonly { id: string; taskType: string; command?: string; outputFile: string | null }[],
): string {
  const lines = owed.map(
    (task) =>
      `- id=${task.id} 種類=${task.taskType}` +
      (task.command === undefined ? '' : ` command=${task.command}`) +
      ` 出力: ${task.outputFile ?? '取れなかった（完了の知らせを受け取っていないか、output_file が無い）'}`,
  );
  return [
    '（alteroid より: 背景処理が終わった直後に、鍵・環境変数の差し替えのためセッションを畳んで開き直した（会話は続いている）。' +
      '完了の知らせは畳んだ前のプロセスに届いたまま、このセッションには届かない。待っていても来ない。',
    '終わった背景処理:',
    ...lines,
    '待たずに、いま結果（作業者の報告・出力のファイル・CI などの状態）を自分で確かめ、続きを進めよ。' +
      'もう終わっていたなら、そう報告して終えること）',
  ].join('\n');
}
