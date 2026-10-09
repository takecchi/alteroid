export class RunnerSubagentStopState {
  /**
   * 値は作業者の `agent_id`。マネージャー自身が起こしたものは空文字 `''` にする:
   * 「マネージャーのものだった」と「表に無い」を混ぜると、経路が壊れて表が空になった
   * 状態が「全部マネージャーのものだった」に化ける。
   */
  #backgroundTaskOwners = new Map<string, string>();

  /**
   * `#backgroundTaskOwners` と同じ呼び出しで控え、別の枝刈りにはしない（所有者を引けない
   * id にだけ command が残っても使い道が無い）。`tool_input.command` が読めたときだけ控え、
   * 「取れなかった」を空文字と混ぜない。
   */
  #backgroundTaskCommands = new Map<string, string>();

  /** 1セッションに1回だけ出す: 毎回出すと壊れていることの通知が雑音になる。 */
  #ownerLookupFailureNoted = false;

  /** 1セッションに1回だけ出す: 毎回出すと、作業者が畳むたびに1行増えて雑音になる。 */
  #settledOnlyNoted = false;

  /** 観測専用で、何の判定にも使わない。 */
  #stopFirings = 0;

  /**
   * 1セッションに1回だけ出す: マネージャーのターンが閉じるたびに来るので、毎回出すと
   * 日誌がターン数ぶんの同じ行で埋まる。2回目以降の「0件で閉じた」回は残らないので、
   * 在り高が最後まで 0 のセッションでは発火回数を言えない。
   */
  #stopIdleNoted = false;

  /**
   * 観測専用で、起こし直しの可否には使わない（`note.stall.wakeupCount` が運ぶ値の出所）。
   * ターン境界ではリセットしない（積算の意味が変わるため）。
   */
  #subagentWakeupTotals = new Map<string, number>();

  /**
   * `limit_reached` の `note` を毎回 escalate すると、同じ内容の report がクローンの
   * 受信箱に積まれ続けて他の判断材料を押し流す。間引くのは `escalate` の有無だけで、
   * `note` 自体は毎回 emit する。`#subagentWakeupTotals` と同じくターン境界ではリセットしない。
   */
  #subagentLimitReachedNotes = new Map<string, number>();

  setBackgroundTaskOwner(taskId: string, owner: string, command?: string): void {
    this.#backgroundTaskOwners.set(taskId, owner);
    // 読めなかったときに、既に控えている値を空文字や `undefined` で上書きしない。
    if (typeof command === 'string') this.#backgroundTaskCommands.set(taskId, command);
    while (this.#backgroundTaskOwners.size > BACKGROUND_TASK_OWNER_LIMIT) {
      const oldest = this.#backgroundTaskOwners.keys().next();
      if (oldest.done === true) break;
      this.#backgroundTaskOwners.delete(oldest.value);
      this.#backgroundTaskCommands.delete(oldest.value);
    }
  }

  backgroundTaskOwner(taskId: string): string | undefined {
    return this.#backgroundTaskOwners.get(taskId);
  }

  backgroundTaskCommand(taskId: string): string | undefined {
    return this.#backgroundTaskCommands.get(taskId);
  }

  hasBackgroundTaskOwner(taskId: string): boolean {
    return this.#backgroundTaskOwners.has(taskId);
  }

  get ownerLookupFailureNoted(): boolean {
    return this.#ownerLookupFailureNoted;
  }

  markOwnerLookupFailureNoted(): void {
    this.#ownerLookupFailureNoted = true;
  }

  get settledOnlyNoted(): boolean {
    return this.#settledOnlyNoted;
  }

  markSettledOnlyNoted(): void {
    this.#settledOnlyNoted = true;
  }

  /** 呼び出し側のどの分岐を通っても通算が進むよう、最初に呼ぶ。加算後の値を返す。 */
  incrementStopFirings(): number {
    this.#stopFirings += 1;
    return this.#stopFirings;
  }

  get stopFirings(): number {
    return this.#stopFirings;
  }

  get stopIdleNoted(): boolean {
    return this.#stopIdleNoted;
  }

  markStopIdleNoted(): void {
    this.#stopIdleNoted = true;
  }

  subagentWakeupTotal(agentId: string): number {
    return this.#subagentWakeupTotals.get(agentId) ?? 0;
  }

  recordSubagentWakeup(agentId: string): number {
    const newTotal = (this.#subagentWakeupTotals.get(agentId) ?? 0) + 1;
    this.#subagentWakeupTotals.set(agentId, newTotal);
    pruneOldestEntries(this.#subagentWakeupTotals, SUBAGENT_WAKEUP_TRACKING_LIMIT);
    return newTotal;
  }

  recordSubagentLimitReachedNote(agentId: string): { count: number; shouldEscalate: boolean } {
    const count = (this.#subagentLimitReachedNotes.get(agentId) ?? 0) + 1;
    this.#subagentLimitReachedNotes.set(agentId, count);
    pruneOldestEntries(this.#subagentLimitReachedNotes, SUBAGENT_WAKEUP_TRACKING_LIMIT);
    return { count, shouldEscalate: shouldEscalateSubagentLimitReachedNote(count) };
  }
}

/**
 * 超えたら古い側（`Map` の挿入順）から捨てる。引くのは登録の直後の `SubagentStop` / `Stop`
 * なので、新しい側を落とすと、いま畳もうとしている作業者の分がまず消える。
 */
export const BACKGROUND_TASK_OWNER_LIMIT = 500;

/**
 * 回数の上限で止めない: 各回の起こし直しは進んでいる仕事で、回数で止めると追加制限になる。
 * 終わらない処理（`sleep infinity` 等）は完了通知が来ないので、この時間で必ず切る。
 * `claude-provider.ts` の `SUBAGENT_STOP_HOOK_TIMEOUT_SECONDS` はこの値より必ず長くする:
 * SDK の timeout が先に来ると `recordCutOff` を通らず完了の配達が働かない。
 */
export const SUBAGENT_BACKGROUND_WAIT_MS = 30 * 60_000;

/** 放置すると長時間走るセッションでメモリが際限なく伸びる。どちらの表も観測用なので、捨てても数え直しになるだけ。 */
const SUBAGENT_WAKEUP_TRACKING_LIMIT = 500;

/**
 * `manager.ts` の `DENIED_ESCALATE_AT` と同じ値で `1` に固定する。上げると、
 * 上限到達の1回目自体が受信箱へ届かなくなる。
 */
const SUBAGENT_LIMIT_REACHED_NOTE_ESCALATE_AT = 1;

/**
 * FIFO であって LRU ではない: `Map.set()` は既存の鍵の順を変えないので、
 * 何度書き込んでも古い鍵はそのまま先頭に留まり、先に捨てられる。
 */
function pruneOldestEntries<V>(map: Map<string, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * `manager.ts` の `shouldEscalateDenial`（`grep -Fn -- 'function shouldEscalateDenial(count: number): boolean {' packages/core/src/manager.ts`）
 * と同じ規則の複製（そちらは export されていず import できない）。規則を変えるときは両方を揃える:
 * 片方だけ直すと `permission_denied` と `limit_reached` の間引きが黙ってずれる。
 */
function shouldEscalateSubagentLimitReachedNote(count: number): boolean {
  if (count < SUBAGENT_LIMIT_REACHED_NOTE_ESCALATE_AT) return false;
  let step = SUBAGENT_LIMIT_REACHED_NOTE_ESCALATE_AT;
  while (step < count) step *= 3;
  return step === count;
}
