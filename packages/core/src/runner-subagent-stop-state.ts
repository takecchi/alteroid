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
 * - **起こし直した回数の通算を数える表1本（観測専用。Issue #3008 で回数の上限は外した）**——
 *   {@link RunnerSubagentStopState.recordSubagentWakeup} が触る `#subagentWakeupTotals`
 *   （作業者単位の通算）。
 *   FIFO の枝刈りを受け、**ターン境界ではリセットしない**（積算の意味が変わるため）。
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
   * 背景タスクの id → **それを起こした道具呼び出しの `command`**（Issue #1554）。
   *
   * `#backgroundTaskOwners` と常に同じ呼び出し（`setBackgroundTaskOwner`）で
   * 一緒に控える——**別の枝刈りにはしない**（`#backgroundTaskOwners` が
   * 忘れた id はこちらも忘れる。所有者を引けない id にだけ command が
   * 残っても使い道が無いため）。**任意欄。** `tool_input.command` が文字列で
   * 読めたときだけ控え、読めなければ何も持たない——「取れなかった」を
   * 空文字と混ぜない（他の任意欄と同じ作法）。
   *
   * **用途は1つ——打ち切った作業者が残した背景処理の `task_notification`
   * （`output_file` 付き）をマネージャーへ配達するとき、id と一緒に
   * command も名乗れるようにする**（`RunnerSession#onTaskNotification` の
   * Issue #1554 の節）。SubagentStop の `background_tasks[].command` から
   * その場で組み立てられる `#renderSubagentStopTaskLines` / 打ち切り時点の
   * 控え（`RunnerCutOffWorkers.recordCutOff` の `tasks`）とは別の出所——
   * こちらは背景処理が**始まった**瞬間（`PostToolUse`）の値で、あちらは
   * **打ち切られた**瞬間（`SubagentStop`）の値である。実運用では同じ値の
   * はずだが、結び目が違うので同じ変数に統合していない。
   */
  #backgroundTaskCommands = new Map<string, string>();

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
   * `agentId` → **その作業者を起こし直した通算回数**（観測専用。Issue #3008）。
   *
   * **起こし直しの可否には使わない。** 回数の上限（旧 `SUBAGENT_WAKEUP_LIMIT_PER_AGENT`）は外した
   * （{@link SUBAGENT_BACKGROUND_WAIT_MS} の doc）。残してあるのは、`note.stall.wakeupCount`
   * （`runner-protocol.ts` / `schema.ts` の「この `agent_id` を起こし直した回数（今回を含む）」）が
   * 運ぶ値の出所として要るからである。ターン境界ではリセットしない（積算の意味が変わるため）。
   * 件数は {@link SUBAGENT_WAKEUP_TRACKING_LIMIT} の FIFO で抑える。
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
   * report を積む。⟹ 同じ agentId が待ちの上限（30分）に達したまま何度も
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
  setBackgroundTaskOwner(taskId: string, owner: string, command?: string): void {
    this.#backgroundTaskOwners.set(taskId, owner);
    // **任意の3番目の引数（Issue #1554）。** 読めたときだけ控え、読めなければ
    // 何もしない——既に控えている値を空文字や `undefined` で上書きしない
    // （呼び出し側が毎回 `command` を渡せるとは限らないため。実際に呼ぶのは
    // `RunnerSession#recordBackgroundTaskOwner` の1箇所だけなので、いまは
    // 同じ id を2度書く経路は無いが、将来2度目の呼び出しが増えても安全側に倒す）。
    if (typeof command === 'string') this.#backgroundTaskCommands.set(taskId, command);
    while (this.#backgroundTaskOwners.size > BACKGROUND_TASK_OWNER_LIMIT) {
      const oldest = this.#backgroundTaskOwners.keys().next();
      if (oldest.done === true) break;
      this.#backgroundTaskOwners.delete(oldest.value);
      this.#backgroundTaskCommands.delete(oldest.value);
    }
  }

  /** 背景タスク `taskId` の所有者（控えていなければ `undefined`）。 */
  backgroundTaskOwner(taskId: string): string | undefined {
    return this.#backgroundTaskOwners.get(taskId);
  }

  /** 背景タスク `taskId` を起こした道具呼び出しの `command`（控えていなければ `undefined`）。 */
  backgroundTaskCommand(taskId: string): string | undefined {
    return this.#backgroundTaskCommands.get(taskId);
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

  /** `agentId` を通算で起こし直した回数（観測用。呼び出し時点の値）。 */
  subagentWakeupTotal(agentId: string): number {
    return this.#subagentWakeupTotals.get(agentId) ?? 0;
  }

  /**
   * `agentId` を起こし直す回に呼ぶ（`RunnerSession#onSubagentStop` の「起こし直す」分岐から）。
   * 通算（`#subagentWakeupTotals`）を+1して返す。**観測のための計数であって、起こし直しの
   * 可否には使わない**（回数の上限は Issue #3008 で外した）。`note.stall.wakeupCount`
   * （スキーマの doc「この `agent_id` を起こし直した回数（今回を含む）」）が運ぶ値である。
   */
  recordSubagentWakeup(agentId: string): number {
    const newTotal = (this.#subagentWakeupTotals.get(agentId) ?? 0) + 1;
    this.#subagentWakeupTotals.set(agentId, newTotal);
    pruneOldestEntries(this.#subagentWakeupTotals, SUBAGENT_WAKEUP_TRACKING_LIMIT);
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
 * `SubagentStop` のフックの中で、作業者が起こした背景処理の完了を待つ**1回あたりの上限**
 * （ミリ秒。Issue #3008）。**回数ではなく時間で数える。**
 *
 * ## 経緯 — 回数の上限（旧 `SUBAGENT_WAKEUP_LIMIT_PER_TASK = 2` / `_PER_AGENT = 8`）を外した
 *
 * 旧い上限は「完了していないのに起こし直す」空転（#357 / #894）を回数で止める歯だった。
 * ⚠️ 8 の根拠は「十分大きく、無限ではない」だけで、実測ではなかった。回数の上限は
 * AGENTS.md の地雷「ターン数上限・実行回数上限で暴走を止める」（追加の実行回数制限）に当たる。
 * そこで、**起こす条件を「背景処理が実際に終わった」に変え**（フックの中で待つ。
 * `RunnerBackgroundWaiters`）、**暴走を止める境界は時間で置く**。
 *
 * ## なぜ 30 分か（⚠️ 実測の上限ではなく、2つの要求から決めた値）
 *
 * 1. **待ち切れること。** #1554 の実例（`pnpm test` 一式・`pnpm verify`・変異テスト）は
 *    数分〜十数分かかる。これを待たずに打ち切ると、完了の知らせはマネージャー経由（#1563 / #2387）に
 *    なり、作業者が自分の文脈のまま結果を読めなくなる。30 分はそれらに余裕を持って届く。
 * 2. **終わらない処理を必ず切れること。** `sleep infinity`・サーバの起動のような処理は
 *    完了通知が来ない。待ちを時間で必ず終わらせないと、フックが永久に返らず、作業者もその親も
 *    止まる。上限に達したら **`limit_reached` の経路をそのまま使う**（note・間引いた escalate・
 *    `RunnerCutOffWorkers.recordCutOff`）ので、その後に処理が終わったときの配達（#1563 / #2387）は
 *    これまでどおり働く。
 *
 * **この値より SDK のフックの timeout（`claude-provider.ts` の
 * `SUBAGENT_STOP_HOOK_TIMEOUT_SECONDS`）を必ず長くする。** SDK の timeout が先に来ると、SDK は
 * 答え無しで続行して作業者を畳み、`recordCutOff` を通らないので完了の配達が働かない
 * （テストが不等式を固定している）。
 *
 * ## 穴A（起こされるたびに新しい背景処理を起こして畳む作業者）を回数で止めない理由
 *
 * 各回の起こし直しは「**背景処理が実際に終わった後の1ターン**」である。完了を待たずに起こす
 * 旧い形と違い、モデルを無駄に回しているのではなく、作業者は結果を読んで次の仕事をしている。
 * それを回数で止めるのは、進んでいる仕事を止める追加制限になる。新しい背景処理が終わらない
 * 場合は、上の30分で止まる。
 */
export const SUBAGENT_BACKGROUND_WAIT_MS = 30 * 60_000;

/**
 * `#subagentWakeupTotals`・`#subagentLimitReachedNotes` が持つ件数の上限。
 * （`BACKGROUND_TASK_OWNER_LIMIT` と同じ形 —— 超えたら「いちばん古いもの」から捨てる。
 * `Map` の挿入順をそのまま使う。実装は {@link pruneOldestEntries}）。
 *
 * `agent_id` は使い回されないので、件数は増え続ける一方である。放置すると長時間走る
 * セッションでメモリが際限なく伸びるので、同じ理由・同じ形の蓋を掛ける。**どちらの表も
 * 観測のための計数で、何かを止める歯ではない**ので、捨てても実害は計数が1から数え直しに
 * なるだけである。
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
 * `map` が `limit` 件を超えたら、いちばん古いもの（`Map` の挿入順の先頭）
 * から捨てる。**FIFO であって LRU ではない** —— `Map.set()` は既存の鍵の
 * 順を変えないので、何度書き込んでも古い鍵はそのまま先頭に留まり、
 * いちばん古い鍵から捨てられる。
 *
 * `#subagentWakeupTotals` と `#subagentLimitReachedNotes`
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
