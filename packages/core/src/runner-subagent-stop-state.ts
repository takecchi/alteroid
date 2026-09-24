/**
 * `RunnerSession`（`runner.ts`）が持っていた **SubagentStop / Stop 観測の
 * 8フィールド**を、独立の単位として切り出したもの（Issue #1190 段1）。
 *
 * **前例は PR #1359（`packages/core/src/clone-notices.ts`）——同じ形にそろえて
 * ある。** 新しいクラスは完全に private な状態の器だけを持ち、`#emit` /
 * `#id`（`RunnerEvent` を実際に日誌へ出す口と、このセッションの id）には
 * 触れない。日誌へ出すかどうか・`escalate` を立てるかどうかの判断は、これまで
 * どおり `RunnerSession` が持つ。
 *
 * ## 何を持っているか
 *
 * - **背景タスクの所有者表**（{@link RunnerSubagentStopState.setBackgroundTaskOwner} /
 *   {@link RunnerSubagentStopState.backgroundTaskOwner} /
 *   {@link RunnerSubagentStopState.hasBackgroundTaskOwner}）—— id → それを起こした
 *   主体（マネージャー自身は空文字）。作るのは `RunnerSession#onPostToolUse`
 *   （`#recordBackgroundTaskOwner` 経由）、引くのは `#onSubagentStop` / `#onStop`
 *   /（`#stopTaskOwnerKind` / `#renderStopTaskLine` 経由）。件数は
 *   {@link BACKGROUND_TASK_OWNER_LIMIT} を超えたら、`Map` の挿入順で古い側から
 *   捨てる（FIFO。**この枝刈りは下の `pruneOldestEntries` と共有しない**——
 *   もともと別々の実装だった歴史をそのまま持ち越している。理由は
 *   {@link RunnerSubagentStopState.setBackgroundTaskOwner} の doc）。
 * - **1セッションに1回だけ出す診断のための「もう出したか」フラグ3本**——
 *   {@link RunnerSubagentStopState.ownerLookupFailureNoted} /
 *   {@link RunnerSubagentStopState.settledOnlyNoted} /
 *   {@link RunnerSubagentStopState.stopIdleNoted}。日誌へ出すかどうかの判断
 *   （フラグを見て早期 return する・出した後に立てる）自体は `RunnerSession`
 *   側の `#noteOwnerLookupFailure` / `#noteSettledOnly` / `#noteStopIdle` が持つ。
 * - **観測専用の通算カウンタ1本**
 *   {@link RunnerSubagentStopState.incrementStopFirings}（`Stop` の発火回数。
 *   何の判定にも使わない）。
 * - **起こし直しの予算を数える表2本**——
 *   {@link RunnerSubagentStopState.recordSubagentWakeup} が触る
 *   `#subagentWakeups`（作業者 × 背景処理単位）・`#subagentWakeupTotals`
 *   （作業者単位の通算）。どちらも {@link SUBAGENT_WAKEUP_TRACKING_LIMIT} で
 *   同じ FIFO の枝刈りを受け、**ターン境界ではリセットしない**——`agent_id`
 *   は使い回されない、という前提の上に成り立つ（詳細と測った内容は
 *   `runner-subagent-stop.test.ts` と Issue #570 / #1190 のコメントに在る）。
 * - **上限到達 note の間引きを数える表1本**
 *   （{@link RunnerSubagentStopState.recordSubagentLimitReachedNote}）——
 *   作業者単位。1・3・9・27…の回だけ escalate するために数える（規則は
 *   `manager.ts` の `shouldEscalateDenial` と同じ。#1385）。
 *
 * ## なぜ切り出したか、そして切り出しの限界（PR #1359 と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `RunnerSession` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** 8フィールドを触るメンバーは
 *    `RunnerSession` 側に7本在る（`#recordBackgroundTaskOwner` /
 *    `#onSubagentStop` / `#renderSubagentStopTaskLines` / `#noteOwnerLookupFailure` /
 *    `#noteSettledOnly` / `#onStop` / `#stopTaskOwnerKind` / `#renderStopTaskLine` /
 *    `#noteStopIdle`）——どれも `#emit` と `#id` を併せて使う。**「通知だけを
 *    触るメンバー」は0本**である。⟹ この切り出しの実体は「疎結合な部分を
 *    剥がす」案ではなく、「暗黙の参照（`this.#backgroundTaskOwners` 等への
 *    直接アクセス）を、明示のメソッド呼び出し（`this.#stopState.get(...)` /
 *    `.record…(...)`）に変える」案である——PR #1359 の clone-notices.ts と
 *    同じ限界。
 * 2. **テストの分離は買えない。** `runner-subagent-stop.test.ts`（41本）・
 *    `runner-stop.test.ts` は切り出しの前後で一体のまま動く——ブラックボックス
 *    として見た経路は1つも変わっていない。保証しているのは「この状態の組み合わせは、
 *    この器の中だけで読めばよい」というレビューのしやすさだけである。
 * 3. **挙動は1ビットも変えていない。** 出力・代入の時点と順序・エラーの倒れ先は
 *    すべて `RunnerSession` に在ったときのままである。変わったのは「どこに
 *    書いてあるか」だけである。
 */
export class RunnerSubagentStopState {
  /**
   * 背景タスクの id → **それを起こした主体**（#570）。
   *
   * 値は作業者の `agent_id`。**マネージャー自身が起こしたものは空文字 `''`**
   * にする —— 「マネージャーのものだった」と「表に無い（引けなかった）」を
   * 混ぜないため。混ぜると、経路が壊れて表が空になった状態が「全部マネージャー
   * のものだった」に化ける。
   *
   * **作るのは `RunnerSession#onPostToolUse`、引くのは `#onSubagentStop` /
   * `#onStop`。** その間だけこの状態を持つ。寿命はセッションと同じで、
   * {@link BACKGROUND_TASK_OWNER_LIMIT} 件を超えたら古い側から捨てる。
   */
  #backgroundTaskOwners = new Map<string, string>();

  /**
   * 「所有者を引けなかった」診断を、このセッションで既に出したか（#570）。
   *
   * 診断は**1セッションに1回だけ**出す。毎回出すと、壊れていることの通知が
   * そのまま雑音になって読まれなくなる。判断（読む・立てるタイミング）は
   * `RunnerSession#noteOwnerLookupFailure` が持つ——ここは値の器だけを持つ。
   */
  #ownerLookupFailureNoted = false;

  /**
   * 「当人が起こした背景処理は在ったが、**全部もう終わっていた**」診断を、この
   * セッションで既に出したか（#570 の追跡）。
   *
   * `#ownerLookupFailureNoted` と同じ形・同じ理由で**1セッションに1回だけ**
   * 出す。毎回出すと、背景処理を使う作業者が畳むたびに1行増えて雑音になる。
   */
  #settledOnlyNoted = false;

  /**
   * `Stop`（マネージャー自身のターンが閉じる瞬間）がこのセッションで発火した
   * **通算の回数**（#861）。**観測専用の計数であり、何の判定にも使わない。**
   *
   * この値そのものが答えの一部である —— #861 が問うているのは「`Stop` は
   * いつ来て、いつ来ないか」であり、`note` が1行も出ないときに
   * 「発火していない」と「発火したが在り高が 0 だった」を割るのはこの数である。
   */
  #stopFirings = 0;

  /**
   * 「`Stop` が発火したが、背景処理も `session_crons` も 0件 だった」診断を、
   * このセッションで既に出したか（#861）。
   *
   * `#settledOnlyNoted` と同じ形・同じ理由で**1セッションに1回だけ**出す ——
   * こちらは**マネージャーのターンが閉じるたび**に来るので、毎回出せば日誌が
   * ターン数ぶんの同じ行で埋まる。
   *
   * ⚠️ **この間引きが落とすもの（#861 へ残す）。** 2回目以降の「0件で閉じた」
   * 回は個別には残らない。通算の回数（`#stopFirings`）は在り高が非0の回の
   * `note` に載るので、そこから復元できる範囲でしか復元できない ——
   * **在り高が最後まで 0 のままだったセッションでは、発火が1回だったのか
   * 200回だったのかをこの観測からは言えない。**
   */
  #stopIdleNoted = false;

  /**
   * `subagentWakeupKey(agentId, taskId)` → **その組（作業者 × 背景処理）を
   * 起こし直した回数**（#570 の追跡の続き）。
   *
   * **ターン境界ではリセットしない。理由は2つ、両方必須。**
   *
   * 1. **リセットすると上限が意味を失う。** これは「これまで何回起こし直したか」
   *    という**積算**を持つ表なので、リセットすると上限が毎ターン（あるいは毎
   *    セッション再開）再装填され、同じ作業者を実質無限に起こし続けられて
   *    しまう —— 上限を置いた目的（#570 の追跡冒頭）がそのまま消える。
   * 2. **`agent_id` は使い回されない（測った。⚠️ ただし SDK の契約ではない）。**
   *    だから「リセットしないと際限なく増える」という心配は無く、リセット
   *    しない側に倒して安全に倒れる。増え続ける件数のほうは
   *    {@link SUBAGENT_WAKEUP_TRACKING_LIMIT} の枝刈りで別に抑える。
   *
   *    ⚠️ **その枝刈りは LRU ではない。FIFO である。** 実装
   *    （{@link pruneOldestEntries}）は `Map` の挿入順をそのまま使う。
   *    `Map.set()` は既に在る鍵の順を変えない ⟹ 何回起こし直しても、その鍵は
   *    捨てられる順番の先頭から離れない。**⟹ 歯として最も残したいもの（＝
   *    いちばん長く空転し続けている作業者）から先に落ちる。** 落ちた鍵は
   *    カウント0から再スタートする——その作業者の予算だけが黙って再装填される。
   *
   * **`note.stall.wakeupCount`（`runner-protocol.ts` / `schema.ts`）へ載る
   * 値は `#subagentWakeupTotals`（`agentId` 単位の通算）である。** こちら
   * （作業者 × 背景処理単位）はスキーマへは出ない、内部だけの積算表。
   *
   * ⚠️ **次にこのフィールドを読む人が、ターンの頭でリセットする形を足し
   * たくなったら、それは誤りである** —— PR #643 は別の表（`#liveBackgroundTasks`）を
   * 毎ターンリセットしていたのが誤りだったと直した回で、こちらは逆に
   * 「リセットしないことが正しい」側である。同じ形に見えても意味が違う。
   */
  #subagentWakeups = new Map<string, number>();

  /**
   * `agentId` → **その作業者を、背景処理の種類を問わず通算で起こし直した
   * 回数**（#570 の追跡の続き。{@link SUBAGENT_WAKEUP_LIMIT_PER_AGENT} の doc —
   * 「毎回違う背景処理を起こして空転する」と「背景処理の id が resume /
   * compaction を跨いで振り直される」の2つの穴を塞ぐのがこの表の役目）。
   *
   * `#subagentWakeups` と同じ理由・同じ形でターン境界ではリセットしない。
   * 増え続ける件数は {@link SUBAGENT_WAKEUP_TRACKING_LIMIT} の枝刈りで
   * `#subagentWakeups` と同じ FIFO で抑える。
   *
   * **`note.stall.wakeupCount`（`runner-protocol.ts` / `schema.ts`）へ載る
   * 値はこの表の値である。** スキーマ側の doc「この `agent_id` を起こし
   * 直した回数（今回を含む）」を真のまま保つ。
   */
  #subagentWakeupTotals = new Map<string, number>();

  /**
   * `agentId` → **この作業者について `stall.outcome === 'limit_reached'` の
   * `note` を出した通算回数**（#1385）。
   *
   * **背景 —— 上限に達した作業者が畳もうとするたびに、同じ内容の report が
   * クローンの受信箱に積まれ続けていた。** `RunnerSession#onSubagentStop` は
   * `limit_reached` に落ちるたびに `escalate: true` を立てており、`manager.ts`
   * の `case 'note'` は `escalate === true` のときだけクローンの受信箱へ
   * report を積む。⟹ 同じ agentId が起こし直しの上限に達したまま何度も
   * `SubagentStop` を送ってくると、その回数ぶんだけ同じ内容の report が
   * 積まれ、他の判断材料を押し流す。
   *
   * **間引き方は `manager.ts` の `shouldEscalateDenial` と同じ規則**
   * （`grep -Fn -- 'function shouldEscalateDenial(count: number): boolean {' packages/core/src/manager.ts`。
   * 1・3・9・27…と3倍ごとにだけ上げ、上げ続けないし、黙りもしない）。
   * この表がその回数を数え、{@link shouldEscalateSubagentLimitReachedNote}
   * が間引く。**`note` 自体は今までどおり毎回 emit する**
   * （呼び出し側 `RunnerSession#onSubagentStop` の責務。日誌には全件残る）——
   * 間引くのは `escalate` の有無だけである。
   *
   * ⚠️ **`manager.ts` を変更できない事情でこの規則をここへ複製している。**
   * `shouldEscalateDenial` 自身と間引きの規則（1・3・9…）は同じだが、
   * **実体は2箇所に分かれている** —— 片方だけ規則を変えると、
   * `permission_denied` の間引きと `limit_reached` の間引きが黙って
   * ずれる。次にこの規則を変えるときは両方を揃えること。
   *
   * `#subagentWakeupTotals` と同じ理由・同じ形でターン境界ではリセットせず、
   * {@link SUBAGENT_WAKEUP_TRACKING_LIMIT} の枝刈りで件数を抑える。
   */
  #subagentLimitReachedNotes = new Map<string, number>();

  /**
   * 背景タスク `taskId` の所有者を `owner` として控える
   * （`RunnerSession#recordBackgroundTaskOwner` から呼ぶ）。
   *
   * **⚠️ ここだけ枝刈りが {@link pruneOldestEntries} と別実装（`while` ループを
   * このメソッドの中に持つ）である。** 元の `runner.ts` の時点で既にそうだった
   * ——`pruneOldestEntries` を切り出した PR の doc が「`#backgroundTaskOwners`
   * の枝刈り（別の `while` ループ）はその PR では触っていない（別の穴。
   * 範囲外）——同じ形だが、共有はしていない」と明記している。**この段（#1190
   * 段1）でも挙動を変えないことを優先し、共有化はしない。**
   */
  setBackgroundTaskOwner(taskId: string, owner: string): void {
    this.#backgroundTaskOwners.set(taskId, owner);
    while (this.#backgroundTaskOwners.size > BACKGROUND_TASK_OWNER_LIMIT) {
      const oldest = this.#backgroundTaskOwners.keys().next();
      if (oldest.done === true) break;
      this.#backgroundTaskOwners.delete(oldest.value);
    }
  }

  /** 背景タスク `taskId` の所有者（控えていなければ `undefined`）。 */
  backgroundTaskOwner(taskId: string): string | undefined {
    return this.#backgroundTaskOwners.get(taskId);
  }

  /** 背景タスク `taskId` の所有者を控えているか。 */
  hasBackgroundTaskOwner(taskId: string): boolean {
    return this.#backgroundTaskOwners.has(taskId);
  }

  /** 「所有者を引けなかった」診断を、このセッションで既に出したか。 */
  get ownerLookupFailureNoted(): boolean {
    return this.#ownerLookupFailureNoted;
  }

  /** 「所有者を引けなかった」診断を出したことを記録する（以後1セッションで1回きり）。 */
  markOwnerLookupFailureNoted(): void {
    this.#ownerLookupFailureNoted = true;
  }

  /** 「当人が起こした背景処理は全部もう終わっていた」診断を、既に出したか。 */
  get settledOnlyNoted(): boolean {
    return this.#settledOnlyNoted;
  }

  /** 「当人が起こした背景処理は全部もう終わっていた」診断を出したことを記録する。 */
  markSettledOnlyNoted(): void {
    this.#settledOnlyNoted = true;
  }

  /**
   * `Stop` の発火を1回分数える。**数えるのは何より先**——呼び出し側
   * （`RunnerSession#onStop`）のどの分岐を通っても（間引かれても）通算は
   * 進むことの意味を、この関数を最初に呼ぶ形で保つ。加算後の値を返す。
   */
  incrementStopFirings(): number {
    this.#stopFirings += 1;
    return this.#stopFirings;
  }

  /** `Stop` がこのセッションで発火した通算回数（観測専用）。 */
  get stopFirings(): number {
    return this.#stopFirings;
  }

  /** 「`Stop` が発火したが在り高は 0 件だった」診断を、既に出したか。 */
  get stopIdleNoted(): boolean {
    return this.#stopIdleNoted;
  }

  /** 「`Stop` が発火したが在り高は 0 件だった」診断を出したことを記録する。 */
  markStopIdleNoted(): void {
    this.#stopIdleNoted = true;
  }

  /** `agentId` × `taskId` の組を起こし直した回数（呼び出し時点の値）。 */
  subagentWakeupCount(agentId: string, taskId: string): number {
    return this.#subagentWakeups.get(subagentWakeupKey(agentId, taskId)) ?? 0;
  }

  /** `agentId` を、背景処理の種類を問わず通算で起こし直した回数（呼び出し時点の値）。 */
  subagentWakeupTotal(agentId: string): number {
    return this.#subagentWakeupTotals.get(agentId) ?? 0;
  }

  /**
   * `agentId` を起こし直す回に呼ぶ（`RunnerSession#onSubagentStop` の
   * 「起こし直す」分岐から）。**通算（`#subagentWakeupTotals`）を+1し、
   * `remainingIds`（その回に残っていた背景処理の**全件**の id）ぶんの
   * per-task カウント（`#subagentWakeups`）も+1する。**「全件」なのは、
   * その回に「待たされた」のは残っている背景処理の全部だからである ——
   * 上限未満の1本だけを対象に選んでも、他の背景処理が同じ回に一緒に
   * 残っていたという事実は変わらない（元の `RunnerSession#onSubagentStop`
   * の doc をそのまま引き継ぐ）。
   *
   * 両方の表を、それぞれ加算した直後に {@link SUBAGENT_WAKEUP_TRACKING_LIMIT}
   * で枝刈りする——順序（通算→枝刈り→per-task 全件→枝刈り）は元の
   * `runner.ts` の実装のままである。加算後の通算値（`#subagentWakeupTotals`
   * の新しい値）を返す。
   */
  recordSubagentWakeup(agentId: string, remainingIds: readonly string[]): number {
    const newTotal = (this.#subagentWakeupTotals.get(agentId) ?? 0) + 1;
    this.#subagentWakeupTotals.set(agentId, newTotal);
    pruneOldestEntries(this.#subagentWakeupTotals, SUBAGENT_WAKEUP_TRACKING_LIMIT);

    for (const id of remainingIds) {
      const key = subagentWakeupKey(agentId, id);
      this.#subagentWakeups.set(key, (this.#subagentWakeups.get(key) ?? 0) + 1);
    }
    pruneOldestEntries(this.#subagentWakeups, SUBAGENT_WAKEUP_TRACKING_LIMIT);

    return newTotal;
  }

  /**
   * `agentId` について `limit_reached` の `note` を出す回に呼ぶ
   * （`RunnerSession#onSubagentStop` の「起こし直さない」分岐から）。
   *
   * 通算カウントを+1・枝刈りしたうえで、その新しい回数が escalate すべき
   * 回（1・3・9・27…）かどうかを {@link shouldEscalateSubagentLimitReachedNote}
   * で判定して一緒に返す——呼び出し側は `count` を `note` の本文に、
   * `shouldEscalate` を `escalate` の有無にそのまま使う。
   */
  recordSubagentLimitReachedNote(agentId: string): { count: number; shouldEscalate: boolean } {
    const count = (this.#subagentLimitReachedNotes.get(agentId) ?? 0) + 1;
    this.#subagentLimitReachedNotes.set(agentId, count);
    pruneOldestEntries(this.#subagentLimitReachedNotes, SUBAGENT_WAKEUP_TRACKING_LIMIT);
    return { count, shouldEscalate: shouldEscalateSubagentLimitReachedNote(count) };
  }
}

/**
 * `#backgroundTaskOwners`（背景タスクの id → それを起こした主体）が持つ件数の
 * 上限（#570）。
 *
 * **超えたら「いちばん古いもの」から捨てる。** `Map` の挿入順をそのまま使う。
 * 落ちるのが古い側なのは、この表を引くのが `SubagentStop` / `Stop` の瞬間 ——
 * つまり**登録の直後**だからである（実測: 登録から 1.4 秒後に引いた）。新しい
 * 側を落とすと、いま畳もうとしている作業者の分がまず消える。
 *
 * ⚠️ **捨てたことは外から見えない。** 捨てた分は「所有者を引けない」に落ち、
 * `RunnerSession#noteOwnerLookupFailure` の診断（1セッションに1回）でだけ表に出る。
 */
export const BACKGROUND_TASK_OWNER_LIMIT = 500;

/**
 * 同じ作業者（`agent_id`）が起こした**同じ背景処理（`taskId`）**を、それが
 * 残ったまま畳もうとした回に対して起こし直す（`additionalContext` を
 * 返す）回数の上限（#570 の追跡の続き）。
 *
 * **これが守るもの — 同じ背景処理を待って永久に空転するのを止める歯。**
 * 単位が背景処理なので、**別々の背景処理には別々に配られる** —— 背景処理 A
 * をこの上限まで使い切っても、新しい背景処理 B が残っていれば B は「1回目」
 * から起こし直される。
 *
 * **`export` してある。** テストがこの数字を直書きしないで済むようにする
 * ためで、値そのものの意味は変わらない。
 */
export const SUBAGENT_WAKEUP_LIMIT_PER_TASK = 2;

/**
 * 同じ作業者（`agent_id`）を、**背景処理の種類を問わず通算で**起こし直す
 * 回数の上限（#570 の追跡の続き）。
 *
 * **これが要る理由 —— `SUBAGENT_WAKEUP_LIMIT_PER_TASK` を「背景処理ごと」に
 * 配ったことで、新たに2つの穴が開く。**
 *
 * - **穴A（`id` の安定性とは無関係に効く。こちらが重い）:** 起こし直される
 *   たびに**新しい背景処理を起こして畳む**作業者は、毎回まっさらな
 *   per-task の予算を得る ⟹ **無限に空転できる。**
 * - **穴B（`id` の安定性に依存する）:** 背景処理の `id` が resume /
 *   compaction / プロセス再起動を跨いで保たれるかは未測。振り直されれば
 *   per-task のカウントは毎回「1回目」に戻る。この上限はその保険である。
 *
 * ⚠️ **この値（8）の根拠は「`SUBAGENT_WAKEUP_LIMIT_PER_TASK` より十分
 * 大きく、無限ではない」だけで、実測ではない。**
 *
 * **優先順位（両方の上限に同時に達したとき）:** 通し上限
 * （`total >= SUBAGENT_WAKEUP_LIMIT_PER_AGENT`）を先に見る。⟹ 通し上限の
 * ほうが重い歯なので、両方成り立つ回は `'per-agent'` を名乗る
 * （`RunnerSession#onSubagentStop` の `limitReason`）。
 *
 * 測った内容の詳細（`BackgroundTaskSummary.id` の安定性・`agent_id` の
 * 生成規則）は `runner-subagent-stop.test.ts` と Issue #570 のコメントに在る
 * ——切り出しにあたり要約していない全文は、この定数が元々在った
 * `runner.ts` の履歴（`git log -p` で辿れる）に残る。
 */
export const SUBAGENT_WAKEUP_LIMIT_PER_AGENT = 8;

/**
 * `#subagentWakeups`（`${agentId} ${taskId}` → その組で起こし直した回数）と
 * `#subagentWakeupTotals`（`agentId` → その作業者を起こし直した通算回数）が
 * それぞれ持つ件数の上限。**両方に同じ形で掛ける**（`BACKGROUND_TASK_OWNER_LIMIT`
 * と同じ形 —— 超えたら「いちばん古いもの」から捨てる。`Map` の挿入順を
 * そのまま使う。実装は {@link pruneOldestEntries}）。
 *
 * `agent_id` は使い回されないので、件数は増え続ける一方である。放置すると
 * 長時間走るセッションでメモリが際限なく伸びるので、同じ理由・同じ形の蓋を
 * 掛ける。**捨てたことは外から見えない** — 捨てられた鍵はカウント0から
 * 再スタートするので、上限に近い側から捨てるより古い側から捨てるほうが
 * 実害が小さい（`BACKGROUND_TASK_OWNER_LIMIT` の doc と同じ理由）。
 */
const SUBAGENT_WAKEUP_TRACKING_LIMIT = 500;

/**
 * `shouldEscalateSubagentLimitReachedNote` の入口（何回目から間引き始めるか）。
 * `manager.ts` の `DENIED_ESCALATE_AT` と同じ値・同じ理由（1回目を黙らせない）
 * で `1` に固定する。この定数を上げると、上限到達の1回目自体が受信箱へ
 * 届かなくなる——「黙って壊れる側ではない」を壊す方向なので、上げないこと。
 */
const SUBAGENT_LIMIT_REACHED_NOTE_ESCALATE_AT = 1;

/**
 * `#subagentWakeups` の鍵を組み立てる（`agentId` と `taskId` の組）。
 *
 * **区切りに `\u0000`（NUL）を使う。** `agent_id` も背景処理の `id` も SDK 側の
 * 不透明な文字列で、SDK は値の文字集合を約束していない。`-` や `:` や半角
 * スペースを区切りに使うと、値そのものに同じ文字が含まれたときに連結の
 * 曖昧さが理屈の上で残る（`"a-b"` と `"a"` / `"b-c"` の組み合わせが同じ
 * 文字列になる、という形）。実測した id の形にはどの区切り候補も現れないが、
 * 「文字として現れない」まで言えるほうが強いので NUL を採る。
 */
function subagentWakeupKey(agentId: string, taskId: string): string {
  return `${agentId}\u0000${taskId}`;
}

/**
 * `map` が `limit` 件を超えたら、いちばん古いもの（`Map` の挿入順の先頭）
 * から捨てる。**FIFO であって LRU ではない** —— `Map.set()` は既存の鍵の
 * 順を変えないので、何度書き込んでも古い鍵はそのまま先頭に留まり、
 * いちばん古い鍵から捨てられる。
 *
 * `#subagentWakeups` と `#subagentWakeupTotals` と `#subagentLimitReachedNotes`
 * の枝刈りをここへ切り出してある。⚠️ **`#backgroundTaskOwners` の枝刈り
 * （`RunnerSubagentStopState.setBackgroundTaskOwner` の中の別の `while`
 * ループ）はここを使わない**（別の穴。同じ形だが共有はしていない——理由は
 * そちらの doc）。
 */
function pruneOldestEntries<V>(map: Map<string, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * `agentId` ごとの「`limit_reached` の note を出した通算回数」（`count`）を
 * 受け取り、その回にクローンの受信箱へ上げるかどうかを返す（#1385）。
 *
 * **`manager.ts` の `shouldEscalateDenial` と同じ規則**
 * （`grep -Fn -- 'function shouldEscalateDenial(count: number): boolean {' packages/core/src/manager.ts`）
 * ——1・3・9・27…と3倍ごとにだけ `true` を返す。実装もほぼそのまま写した
 * （唯一の違いは定数名）。⚠️ **同じ規則が2箇所に実体を持つ。** `manager.ts`
 * 側の関数は export されていないため import できず、この関数へ複製してある。
 * 次にこの規則そのもの（1・3・9…や3倍という刻み）を変えるときは、この関数と
 * `shouldEscalateDenial` の両方を揃えて直すこと——片方だけ直すと、
 * `permission_denied` の間引きと `limit_reached` の間引きが黙ってずれる。
 */
function shouldEscalateSubagentLimitReachedNote(count: number): boolean {
  if (count < SUBAGENT_LIMIT_REACHED_NOTE_ESCALATE_AT) return false;
  let step = SUBAGENT_LIMIT_REACHED_NOTE_ESCALATE_AT;
  while (step < count) step *= 3;
  return step === count;
}
