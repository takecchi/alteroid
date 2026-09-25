/**
 * `RunnerSession`（`runner.ts`）が持っていた **起こし直しの上限で打ち切った
 * 作業者を追う2フィールド**（`#cutOffWorkers` / `#pendingCutOffNotifications`。
 * #901）を、独立の単位として切り出したもの（Issue #1190 段0）。
 *
 * **前例は PR #1359（`clone-notices.ts`）／ PR #1433（`runner-subagent-stop-state.ts`）／
 * PR #1523（`runner-turn-tally.ts`）／ PR #1532（`clone-redelivery-state.ts`）——
 * 同じ形にそろえてある。** 新しいクラスは完全に private な状態の器だけを持ち、
 * `#emit`（実際に日誌へ書く口）には一切触れない。**注記の文面を組み立てるか
 * どうか・note を出すかどうかの判断は、これまでどおり `RunnerSession` が持つ。**
 *
 * ## 何を持っているか
 *
 * - **`#cutOffWorkers`**——起こし直しの上限で打ち切った作業者の `agent_id`
 *   （{@link RunnerCutOffWorkers.recordCutOff} で記録し、
 *   {@link RunnerCutOffWorkers.consumeCutOff} で「在ったか」を見ながら消費する）。
 *   詳しい経路・SDK 側の相関の根拠は {@link RunnerCutOffWorkers.recordCutOff} /
 *   {@link RunnerCutOffWorkers.consumeCutOff} 自身の doc を見よ。
 * - **`#pendingCutOffNotifications`**——`task_notification` 経由で「打ち切られて
 *   いた」と判明したが、まだマネージャー自身の次の `PostToolUse` へ注記して
 *   いない作業者の `agent_id`（{@link RunnerCutOffWorkers.recordPendingNotification}
 *   で記録し、{@link RunnerCutOffWorkers.drainPendingNotifications} で全件
 *   まとめて取り出す）。なぜ要るか・配達の遅れの留保は
 *   {@link RunnerCutOffWorkers.recordPendingNotification} 自身の doc を見よ。
 *
 * どちらも `Set<string>` で、件数が {@link CUT_OFF_WORKERS_LIMIT} /
 * {@link PENDING_CUT_OFF_NOTIFICATIONS_LIMIT} を超えたら FIFO（挿入順）で
 * 古い側から捨てる——長寿のセッションで表が際限なく育たないための蓋
 * （`runner.ts` に元々在った doc のまま。意味は変えていない）。
 *
 * ## なぜ切り出したか、そして切り出しの限界（PR #1359 / #1433 / #1523 / #1532 と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `RunnerSession` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** 2フィールドの生の読み書き（`grep -n
 *    '#cutOffWorkers\.\|#pendingCutOffNotifications\.' packages/core/src/runner.ts`。
 *    切る前は14箇所14行）は、`RunnerSession` 側の5本のメンバーに散っていた
 *    ——`#onTaskNotification` / `#recordCutOffWorker` / `#recordPendingCutOffNotification` /
 *    `#annotateCutOffWorker` / `#drainPendingCutOffNotifications`（後の2本は
 *    それぞれ `#emit` で note を出す・`additionalContext` の文面を組み立てる
 *    処理も併せ持つ）。**「この2フィールドだけを触るメンバー」は、切り出し前の
 *    時点で `#recordCutOffWorker` / `#recordPendingCutOffNotification` の2本
 *    だけだった**——この2本はそのまま {@link RunnerCutOffWorkers.recordCutOff} /
 *    {@link RunnerCutOffWorkers.recordPendingNotification} として丸ごと移した。
 *    残り3本（`#onTaskNotification` / `#annotateCutOffWorker` /
 *    `#drainPendingCutOffNotifications`）は `#emit` や `#turnTally` の更新・
 *    `#windowClosing` の分岐・注記の文面組み立てなど、`RunnerSession` の他の
 *    状態も併せ持つので、**丸ごとは移さず、生の Set 操作の部分だけをこの
 *    クラスのメソッド呼び出しに置き換えた**——PR #1532 の `CloneRedeliveryState`
 *    と同じ形の切り分けである。
 * 2. **テストの分離は買えない。** `runner-subagent-stop.test.ts` の
 *    `打ち切った作業者の Task の結果に注記する（#901）` /
 *    `task_notification 経由で判明した打ち切りにも注記する（#901）` の9本は、
 *    切り出しの前後で一体のまま動く——`RunnerSession` をブラックボックスとして
 *    通した統合テストで、このクラスの内部を直接読んでいない。
 * 3. **挙動は1ビットも変えていない。** 呼び出し側（`RunnerSession`）の `await`
 *    の位置・操作の順序・分岐の条件は1つも動かしていない——変わったのは
 *    「どこに書いてあるか」だけである。とくに次の2点は、切り出しの前後で
 *    1文字も変わっていない:
 *    - **すべて同期メソッドである。** 元の5メンバーのどれも、この2フィールド
 *      を触る行の前後に `await` を挟んでいなかった（`#annotateCutOffWorker` /
 *      `#drainPendingCutOffNotifications` は `#emit` を呼ぶが、`#emit` 自体が
 *      同期である）。⟹ クラスをまたいでも、外から見える中間状態は増えない。
 *    - **`#recordCutOffWorker` / `#recordPendingCutOffNotification` の
 *      「delete → add → 上限まで while で古い側を削る」という3手の並びは、
 *      {@link RunnerCutOffWorkers.recordCutOff} /
 *      {@link RunnerCutOffWorkers.recordPendingNotification} へ1文字も
 *      変えずに移した**（`delete` を先にするのは「既に在る鍵の挿入順を
 *      更新順ではなく末尾へ動かす」ため——`Set` は `add` だけでは既存の鍵の
 *      順序を変えない）。
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（PR #1532 / #1523 / #1433 / #1359 と同じ言い方）。
 */
export class RunnerCutOffWorkers {
  /**
   * 起こし直しの上限で打ち切った作業者の `agent_id`（#901）。
   *
   * `Task` の結果（`AgentOutput`）は打ち切りも正常な完了も同じ `status: 'completed'`
   * の顔で返る（#901 の段0の実測）。打ち切ったのは alteroid 自身
   * （`RunnerSession#onSubagentStop`）なので、その事実をここに控え、マネージャー
   * 側の `PostToolUse` で結果の `agentId` と突き合わせて注記する
   * （`RunnerSession#annotateCutOffWorker` が {@link consumeCutOff} で消費する）。
   * **注記したら消す**（1回だけ）。
   *
   * **同期の `Task`（`status:'completed'`）だけがここを通る。** `async_launched`
   * （背景委譲。既定）の完了は `PostToolUse` を経由せず `system/task_notification`
   * としてだけ届く——そちらは `RunnerSession#onTaskNotification` が
   * {@link consumeCutOff} で同じこの Set から消し、{@link recordPendingNotification}
   * で `#pendingCutOffNotifications` へ付け替える（下のフィールドの doc）。
   */
  readonly #cutOffWorkers = new Set<string>();

  /**
   * `task_notification` 経由で「起こし直しの上限で打ち切られていた」と判明したが、
   * まだマネージャー自身の次の `PostToolUse` へ注記していない作業者の `agent_id`
   * （#901）。
   *
   * ## なぜ要るか
   *
   * 同期の `Task` は `#cutOffWorkers` → `RunnerSession#onPostToolUse` →
   * `RunnerSession#annotateCutOffWorker` で閉じる。だが `async_launched`
   * （背景委譲。既定）の完了は `PostToolUse` を経由しない——`system/task_notification`
   * という別のメッセージとしてだけ届く。**この `task_notification` に
   * `additionalContext` を注げるフックが存在しない**（SDK
   * `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.281` の `sdk.d.ts` を静的に
   * 走査し、`hook_event_name` を持つ21種・`hookEventName`（出力側）を持つ20種の
   * **どちらにも** `task_notification` に対応するものが無いことを確認した。
   * 近い名前の `TaskCompleted`/`TaskCreated` フックは別機能——
   * `task_subject`/`teammate_name` という欄を持つ「Teams」機能のもので、
   * `local_agent`（Task ツールの subagent）タスクとは無関係）。
   *
   * だから `RunnerSession#onTaskNotification` で `task_id` が `#cutOffWorkers`
   * に在れば（＝同期経路でまだ消費されていない。{@link consumeCutOff} が
   * `true` を返す）、そこから消してここへ付け替え、**次にマネージャー自身の
   * 道具（種類は問わない）が `PostToolUse` を通ったときに相乗りする**
   * （`RunnerSession#onPostToolUse` の `#annotateCutOffWorkers`。取り出しは
   * {@link drainPendingNotifications}）。
   *
   * ## 相関の根拠（`task_id === agentId`）
   *
   * `task_notification`/`task_started` の `task_id` と `AgentOutput`（`Task` の
   * 結果）の `agentId`、そして `SubagentStop` の `agent_id` は、SDK 内部では
   * **同じ変数**である——バイナリを走査すると、タスク登録の共通コンストラクタ
   * `function rm(t,s,a,e){return{id:t,...,toolUseId:e,...}}` に対し、
   * `local_agent`（Task ツールの subagent）を登録する関数 `m6({agentId:e,...})`
   * が `rm(e,"local_agent",g,U)` の形で**第1引数（＝ `id`）に `agentId` の値
   * そのもの**を渡している。`SubagentStop` を発火する側も、同じ関数内で
   * `taskRegistry` のキー（＝この `id`）をそのまま `agent_id` として渡す
   * （`BJ(void 0,void 0,5000,!1,ue,...)` と `n.taskRegistry.get(ue)` が同じ
   * 変数 `ue` を指す）。
   *
   * ⚠️ **これは SDK バイナリの静的走査（`Buffer.indexOf` によるオフセット特定と
   * 周辺コードの目視）による確認であって、本物の `query()` を実行した確認ではない。**
   * マネージャーの器での実行時観測1件（起動時の `agentId` と、後で届いた
   * `task_notification` の `task_id` が同一だった）と整合する。#1475 の
   * `RunnerSession#annotateCutOffWorker` の doc にあった「本物の `query()` では
   * 測っていない」という留保は、この2つの根拠（静的走査＋実行時観測1件）で
   * ここまで更新した——ただし `query()` そのものを流した確認ではない、という
   * 限定は残る。
   *
   * ## 配達の遅れ（留保）
   *
   * ⚠️ **配達はマネージャーが次に道具を呼ぶまで遅れる。** `task_notification` を
   * 読んだ直後に道具を呼ばずターンを閉じれば、次のターンの最初の道具呼び出しまで
   * 届かない。マネージャーは通知を読んだ後ほぼ必ず道具を呼ぶ（返答・次の委譲等）
   * はずだが、これは実測していない。
   *
   * ⚠️ **`push()` は使わない。** 作業者（Task サブエージェント）の完了を契機に
   * 呼ぶと SDK 側の自己継続と二重にターンが回る（`push` 自身の doc、
   * `runner-wakeup.test.ts` の「`task_notification` を受けても `#input` へは
   * 1件も積まれない」がこの前提を歯として固定している）。ここはその制約の中で
   * 選べる、唯一の観測可能な相乗り先（マネージャー自身の次の `PostToolUse`）を
   * 使う。
   */
  readonly #pendingCutOffNotifications = new Set<string>();

  /**
   * `agentId` を「起こし直しの上限で打ち切った」と記録する
   * （`RunnerSession#onSubagentStop` の上限到達の分岐から呼ぶ）。
   *
   * 既に在っても一度 `delete` してから `add` し直す——同じ鍵の挿入順を
   * 「いま記録した」側（末尾）へ動かすため。件数が
   * {@link CUT_OFF_WORKERS_LIMIT} を超えたら、いちばん古いもの（`Set` の
   * 挿入順の先頭）から捨てる。
   */
  recordCutOff(agentId: string): void {
    this.#cutOffWorkers.delete(agentId);
    this.#cutOffWorkers.add(agentId);
    while (this.#cutOffWorkers.size > CUT_OFF_WORKERS_LIMIT) {
      const oldest = this.#cutOffWorkers.values().next().value;
      if (oldest === undefined) break;
      this.#cutOffWorkers.delete(oldest);
    }
  }

  /**
   * `agentId` が「打ち切った」と記録されていれば、そこから消して `true` を
   * 返す。無ければ何もせず `false`。
   *
   * **1回消費したら控えは消える**（呼び出し側の「注記は1回だけ」という性質を
   * 保つ）。2つの呼び出し元がある——
   *
   * - `RunnerSession#onTaskNotification`——`task_id` がここに在れば、同期
   *   経路ではまだ消費されていない（＝背景委譲の完了として先に判明した）
   *   ということなので、消してから {@link recordPendingNotification} へ
   *   付け替える。
   * - `RunnerSession#annotateCutOffWorker`——同期の `Task` 結果
   *   （`tool_response.agentId`）がここに在れば、それが打ち切られていた
   *   作業者だったということなので、消してから注記を組み立てる。
   */
  consumeCutOff(agentId: string): boolean {
    return this.#cutOffWorkers.delete(agentId);
  }

  /**
   * `agentId` を「未配達の打ち切り注記」として記録する
   * （`RunnerSession#onTaskNotification` が {@link consumeCutOff} で
   * `#cutOffWorkers` から付け替えるときに呼ぶ）。
   *
   * {@link recordCutOff} と同じ形——既に在っても `delete` してから `add` し
   * 直し、件数が {@link PENDING_CUT_OFF_NOTIFICATIONS_LIMIT} を超えたら
   * いちばん古いものから捨てる。
   */
  recordPendingNotification(agentId: string): void {
    this.#pendingCutOffNotifications.delete(agentId);
    this.#pendingCutOffNotifications.add(agentId);
    while (this.#pendingCutOffNotifications.size > PENDING_CUT_OFF_NOTIFICATIONS_LIMIT) {
      const oldest = this.#pendingCutOffNotifications.values().next().value;
      if (oldest === undefined) break;
      this.#pendingCutOffNotifications.delete(oldest);
    }
  }

  /**
   * 控えている「未配達の打ち切り注記」を全件取り出し、控えを空にする
   * （`RunnerSession#drainPendingCutOffNotifications` から呼ぶ）。
   *
   * 1件も無ければ空配列を返す（このときは呼び出し側で `#emit` を呼ばずに
   * 済ませられるよう、「空だった」と「取り出した」を区別できる形にしてある
   * ——`size === 0` を先に見ていた元の実装と同じ判断を、戻り値の長さで
   * 呼び出し側に渡す）。
   */
  drainPendingNotifications(): string[] {
    if (this.#pendingCutOffNotifications.size === 0) return [];
    const agentIds = [...this.#pendingCutOffNotifications];
    this.#pendingCutOffNotifications.clear();
    return agentIds;
  }
}

/**
 * `#cutOffWorkers`（起こし直しの上限で打ち切った作業者）を控える件数の上限
 * （#901）。長寿のセッションで表が際限なく育たないための蓋。
 */
export const CUT_OFF_WORKERS_LIMIT = 500;

/**
 * `#pendingCutOffNotifications`（`task_notification` 経由で判明した「未配達の
 * 打ち切り注記」）を控える件数の上限（#901）。`CUT_OFF_WORKERS_LIMIT` と同じ
 * 考え方——長寿のセッションで表が際限なく育たないための蓋。
 */
export const PENDING_CUT_OFF_NOTIFICATIONS_LIMIT = 500;
