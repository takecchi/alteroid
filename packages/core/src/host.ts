import type { AgentPluginLoad } from './agent-events.js';
import type { ManagerPool } from './manager.js';
import type { ApprovalSelection, ChatStreamEvent, InboxEvent } from './schema.js';

/**
 * `answerApproval` を叩いた経路（Issue #863、#1479）。**プレーンな TS の型で
 * あって zod スキーマではない** —— `apps/daemon/src/auth.ts` の `Principal` と
 * 同じ立場（内部でしか組み立てられない、信頼された呼び出し専用の値。外部入力を
 * そのままここへ流し込む経路は無い）。`packages/core` は `apps/daemon` の
 * 型（`Principal`）を知らない（層が逆）ので、ここに同じ形の型を別名で持つ
 * ——`apps/daemon/src/app.ts` が `Principal` からこの型へ変換して渡す。
 *
 * **ここ（`host.ts`）に置くのは、`clone.ts` が `host.ts` を import しており
 * （`Clone implements CloneHost`）、逆向きの import は循環になるため。**
 *
 * **`kind: 'account'` だけが許可の記録に繋がる。** `Clone#recordPermissionGrantIfConsented`
 * の doc を見よ——`operator` を記録しない理由（operator の資格はクローンの
 * 器から読めるため、人間の証拠にならない）はそちらにまとめてある。
 *
 * **`kind: 'operator'` は2値に分かれる（Issue #1479）。** `auth: 'disabled'` は
 * 認証を設定していない構成（`authPlan.enabled` が偽）を通った要求、
 * `auth: 'operator-token'` は認証を設定していても実行環境の持ち主の token
 * （`isOperator`）で通った要求——`apps/daemon/src/app.ts` の `authenticate` の
 * 中でどちらの枝を通ったかは分かるので、そのまま運ぶ。**どちらも人間の証拠には
 * ならない**（同じ理由）が、認証を意図して設定していない構成のほうが一段緩い
 * ことを後から読む人が区別できるようにするため分けてある。
 *
 * **この形は `schema.ts` の `answeredViaSchema` と一致させること。** あちらは
 * `PendingApproval.answeredVia` / journal の `escalation.answeredVia` として
 * 永続化するための zod 版で、ここが zod を持たない理由（外部入力から来ない値に
 * 検査コストを払わせない）とは無関係に、**値の形そのものは同じでなければ
 * ならない**——一致は TypeScript の構造的型付けが検査時に守る（`clone.ts` の
 * `answerApproval` がこの型の値を `answeredVia` 欄へそのまま代入するため、
 * 形がずれれば代入の時点で型エラーになる）。
 */
export type AnswerApprovalVia =
  | { kind: 'operator'; auth: 'disabled' | 'operator-token' }
  | { kind: 'account'; accountId: string };

/** `interruptTurn` が止める対象の発言（`POST /chat` の `clientMessageId` で指す）。 */
export interface InterruptTarget {
  readonly conversationId: string;
  readonly clientMessageId: string;
}

/**
 * `interruptTurn` の結果。
 *
 * - `interrupted`: その発言のターン（対象を省いたときは走っているターン）を止めた
 * - `withdrawn`: 発言がまだ順番待ちだったので取り下げた（器からも外し、配らない）
 * - `not_target`: 走っているのは別の起点のターンなので、止めていない
 * - `starting`: 発言は取り出し済みだがターンはまだ始まっておらず、止めるものが無かった（もう一度呼べば止まる）
 * - `idle`: 止めるものが無かった（既に答え終わっている）
 */
export type InterruptOutcome = 'interrupted' | 'withdrawn' | 'not_target' | 'starting' | 'idle';

/**
 * 会話の中で、いま答えを待っている発言の状態（{@link PendingMessage}）。
 *
 * - `running`: ターンが走っている
 * - `starting`: 受信箱から取り出し済みで、ターンはまだ始まっていない
 * - `queued`: 受信箱で順番待ち
 * - `held`: 利用上限の枠で保持している
 */
export type PendingMessageState = 'running' | 'queued' | 'held' | 'starting';

/** `attach` が返す、いま答えを待っている発言（`POST /chat` の `clientMessageId` で指す）。 */
export interface PendingMessage {
  readonly clientMessageId: string;
  readonly state: PendingMessageState;
}

/**
 * クローン自身の**最後のセッション開始の init** が知らせた plugin の読み込み結果（Issue #3816）。
 * `at` はクローンが init を受けた時刻（ISO）。
 */
export interface ClonePluginLoadObservation {
  at: string;
  pluginLoad: AgentPluginLoad;
}

/** {@link CloneHost.postPersisted} の結果。 */
export type PostPersistOutcome = 'persisted' | 'unavailable';

/**
 * デーモンから見たクローン。
 *
 * HTTP 層はこのインターフェースしか知らない。クローンの生きたインスタンスは
 * デーモン内に常に1本だけ存在する（architecture.md「脳は1インスタンス」）。
 */
export interface CloneHost {
  /** 受信箱へイベントを積む。起点が人間でもタイマーでも入口はここ1つ。 */
  post(event: InboxEvent): void;

  /**
   * **受信箱（`stores.inbox`）へ書けたかを返す投函**（Issue #3679）。`post` と違い、書き込みの
   * 結果を待つ。HTTP の `POST /events`・`POST /events/:source` が「200 は永続化できたときだけ」を
   * 守るために使う。
   *
   * - `'persisted'` — 器へ書けた（以後は `post` と同じく配達される。片付けの窓に当たった場合も、
   *   行は器に在り次の起動で配り直される）。
   * - `'unavailable'` — 拾い直しが尽きても書けなかった。**受信箱のメモリにも積んでいない**
   *   （積むと、失敗を受けた呼び手の送り直しと二重に届く）。呼び手は 503 で断る。
   *
   * **reject しない**（失敗は戻り値で返す）。`post` の呼び手（定期の依頼・内部の起点・`POST /chat`）は
   * これを使わず、挙動は変わらない。
   */
  postPersisted(event: InboxEvent): Promise<PostPersistOutcome>;

  /**
   * **器から消した合図の配達を止める**（issue #1049）。戻り値は実際に配達待ち
   * から落とせた件数。⛔ **器（`stores.inbox`）から行を消すのはこの口ではない**
   * —— 消した呼び手が、同じ id でこれを呼ぶ。
   *
   * ## なぜこの面が太るのか
   *
   * ここに並んでいる他の口は**積む・読む・止める**であって、**待ち行列から
   * 特定の合図を抜く**口は無かった。`inbox_remove_many`（`POST /inbox/remove`）
   * が消すのは `InboxStore` の行だけで、**配達はクローンのメモリ上の待ち行列
   * から出る** ⟹ 消した後も配られ続けた。この面に口が無いことが、そのまま
   * #1049 の穴だった（`tools.ts` からは型の上で到達する経路が1つも無く、
   * `app.ts` は `clone` に届くのに呼べる操作が無かった）。
   *
   * **⚠️ 直に呼ばないこと。** 呼び手は `removeInboxEventsAndStopDelivery`
   * （`inbox-backlog.ts`）1本に寄せてある —— 器から消す操作とこの呼びが離れると、
   * **片方だけ直っている形**が戻る。詳細は `Clone#dropQueuedInboxEvents` の doc。
   */
  dropQueuedInboxEvents(ids: readonly string[]): Promise<number>;

  /**
   * ある会話に対するクローンの出力を購読する。
   * 戻り値を呼ぶと購読を解除する。
   */
  subscribe(conversationId: string, listener: (event: ChatStreamEvent) => void): () => void;

  /**
   * **いままでの分を受け取り、続きを購読する**（Issue #2652。`Clone#attach` の doc）。
   * `inProgress` は進行中のターンの途中経過（隣り合う `text` は1つ）。進行中でなければ
   * `null`。`pending` はその会話でいま答えを待っている発言（`clientMessageId` を持つものだけ。
   * 取り出し済み→保持→順番待ちの順）。写しを取ることと購読を張ることは同じ同期区間で行われ、
   * 継ぎ目で取りこぼしも二重渡しも起きない。
   *
   * **省略可能にしてある** —— この面を実装する偽物（テスト）が多く、足していない
   * 実装では HTTP の口が 503 で「この器では途中経過を持たない」と答える。
   */
  attach?(
    conversationId: string,
    listener: (event: ChatStreamEvent) => void,
  ): {
    inProgress: ChatStreamEvent[] | null;
    pending: PendingMessage[];
    unsubscribe: () => void;
  };

  /**
   * **いま走っているクローンのターンを止める**（#1398 c23-1）。止めるものが
   * 無ければ `'idle'`。`target` を渡したときは、その発言のターンだけを止め、順番待ちなら
   * 取り下げる（`Clone#interruptTurn` の doc）。
   *
   * **省略可能にしてある** —— この面を実装する偽物（テスト）が多く、足していない
   * 実装では HTTP の口が「この器では止められない」と答える。
   */
  interruptTurn?(target?: InterruptTarget): Promise<InterruptOutcome>;

  /**
   * **いまクローンが走らせているターン**（稼働の地図 `GET /topology` の `clone.state`）。
   * 走っていなければ `null`。
   *
   * **省略可能にしてある** —— この面を実装する偽物（テスト）が多い。**実装していない
   * 器は「分からない」であって「止まっている」ではない**（呼び手は欄の不在を `unknown`
   * と読み、`idle` を作らない）。`conversationId` は人間に見せない内部ターン
   * （蒸留など）では無い。
   */
  activeTurn?(): { conversationId?: string; kind: 'normal' | 'distill' } | null;

  /** 会話の終了。蒸留の契機（寿命モデル: 蒸留は生存条件）。 */
  endConversation(conversationId: string): Promise<void>;

  /**
   * 承認待ちへの回答。止まっていたその仕事だけが再開する。
   *
   * `via` は回答の経路（Issue #863）。渡さなければ `request_permission` の
   * 要求への回答でも許可は記録されない（既定は不許可——`Clone#answerApproval`
   * の doc）。
   *
   * `selections`（issue #2525）は `questions` を持つ承認待ちへの構造化した回答。渡すと
   * `answer` は補足（空文字でもよい）になり、設問・選んだ選択肢・その他・補足を畳んだ文が
   * 回答として残る。`questions` と突き合わず断るときは `InvalidApprovalSelectionsError`。
   */
  answerApproval(
    approvalId: string,
    answer: string,
    via?: AnswerApprovalVia,
    selections?: readonly ApprovalSelection[],
  ): Promise<void>;

  /**
   * 委譲先の一覧と生ログ。HTTP 層はここから可観測性の下2層へ降りる。
   * 起こすのはクローンだけである（人間が直接マネージャーを起こす口は作らない）。
   */
  readonly managers: ManagerPool;

  /**
   * クローンがいま枠（利用上限）で止まっているか（Issue #783）。
   *
   * **デーモンの回し手が「合図を配るか畳むか」を決めるための読み取り専用の窓。**
   * 「認証トークンが通る状態に戻った」という合図は、クローンが枠で止まっていない
   * 限りターンを1本焼くだけで何もしない（`clone.ts` の `post()` の中で
   * `this.#releaseRequested = true;` を立てることが唯一の効果であり
   * ——この合図（`source: 'token-pool'`）は `usageBlockAlwaysRearms` が
   * 常に真を返す枝を通るので、Issue #1240 続きで足した回復予定時刻ぶんの
   * 抑止は当たらない——止まっていなければそこは1文字も動かない）。⟹
   * `apps/daemon/src/index.ts` の `wake()` はここを見て、止まっていないときは
   * 配らずに畳む。
   *
   * **⚠️ 「常に真を返す枝を通る」には1つだけ例外が在る**（Issue #1223 再発）。
   * 「また通るようになった」が**いま止まっている同じ鍵**の**同じ resetsAt**
   * に対する使い回しでしかないときは、`staleObservedRecoveryForBlockedKey`
   * （`daemon-self-notice.ts`）がその1点だけ外へ倒す——{@link
   * CloneHost.usageBlockedResetsAt} / {@link CloneHost.usageBlockedTokenId}
   * の doc を見よ。
   *
   * **真偽だけを返す。** 保持している通知の中身（文言など）はデーモンの判断に
   * 要らない——渡すと、渡した先が文言を読んで判定を重ねる経路を作りかねない。
   */
  readonly usageBlocked: boolean;

  /**
   * 枠（利用上限）の解除を試す印が、**まだ使われずに立っているか**
   * （Issue #1051）。
   *
   * **{@link CloneHost.usageBlocked} と組で読む窓である。** あちらが答えるのは
   * 「止まっているか」で、ここが答えるのは「**もう起こしてある**か」。
   *
   * ## なぜ要るか —— 「止まっている」だけでは、同じ合図を何度でも配ってしまう
   *
   * 直上の doc のとおり、「認証トークンが通る状態に戻った」の合図の効果は
   * `clone.ts` の `post()` の中で `this.#releaseRequested = true;` を
   * 立てること**だけ**である。⟹ **その印が既に立っているなら、2件目の合図は
   * もう立っている印をもう一度立てるだけで、状態を1文字も動かさない。**
   *
   * 実運用（Issue #1051）で起きたのはその形である —— 枠に当たっている間、
   * ある層が 429 を踏むと現役の記録にまた冷却が書かれ、別の層のターンが
   * 成功した瞬間にそれが消えて「戻った」が1件立つ。この往復はミリ秒間隔で
   * 回りうるので、**同一本文が 35 ミリ秒に3件・24時間で 3297 件**積まれた。
   * `usageBlocked` だけを見る門はその全部を通す（往復のあいだ、クローンは
   * ずっと止まっているからである）。
   *
   * ## 起こし損ねは作らない
   *
   * `#releaseRequested` は `#pump` の先頭で**必ず**消費される（`clone.ts` の
   * 解除ブロックの「どちらの道でも待ち行列は空でない」——印だけ立って誰も
   * 見ない、が起きない理由）。⟹ ここが真である窓は「次の再試行が始まるまで」
   * に限られ、**畳んだぶんは遅れではなく重複である。**
   *
   * **真偽だけを返す**（{@link CloneHost.usageBlocked} と同じ理由）。
   */
  readonly usageReleasePending: boolean;

  /**
   * いま保持している枠の通知（{@link CloneHost.usageBlocked}）の回復予定時刻
   * （epoch ミリ秒。Issue #1223 再発）。**止まっていなければ、または分から
   * なければ `undefined`。**
   *
   * **デーモンの回し手が「同じ鍵の観測ベースの回復を畳んでよいか」を決める
   * ための読み取り専用の窓。** `usageLimitNoticeSchema.resetsAt` と同じ値
   * （`分からなければ載せない`）——ここは新しい判定を作らず、その値をそのまま
   * 外へ見せるだけの薄い窓である（{@link CloneHost.usageBlocked} と同じ形）。
   *
   * `apps/daemon/src/index.ts` の `wake()` はここを読んで
   * `staleObservedRecoveryForBlockedKey`（`daemon-self-notice.ts`）へ渡す。
   */
  readonly usageBlockedResetsAt: number | undefined;

  /**
   * いまのセッションが使っている認証トークンの id（Issue #1223 再発）。
   * **セッションが起きた瞬間の身元**であって、枠で止まっているかどうかとは
   * 無関係に読める——回した直後にまだ枠が閉じていることもあるため、
   * `usageBlocked` と組み合わせて初めて「止まったときの鍵」を意味する。
   *
   * `tokenIdentity` を渡していない器（プールを使わない既定の構成）では
   * 常に `undefined`。**推測で埋めない**（`token-pool` スキルの
   * 「`tokensSince` が null なのは2つの意味を持つ」と同じ理由——
   * 「同じ鍵ではない」と「鍵が分からない」を混同しない）。
   *
   * `apps/daemon/src/index.ts` の `wake()` / `redeliveryGate` が読む——
   * {@link CloneHost.usageBlockedResetsAt} と組で {@link
   * staleObservedRecoveryForBlockedKey} へ渡す。
   */
  readonly usageBlockedTokenId: string | undefined;

  /**
   * 認証トークンを回したので、**次のターンの境界で** SDK セッションを畳んで
   * 作り直す（Issue #393 PR4）。
   *
   * **`stop()` とは別物である。** あちらはクローン全体の停止で、こちらは
   * 子プロセスだけの入れ替えである（会話は `resume` で続く）。**混ぜると
   * 「トークンを回したらクローンが止まる」になる。**
   *
   * 呼ぶのは回し手（デーモンの1本）だけで、**回ったときにだけ**呼ぶ。
   */
  recycleSessionForToken(): void;

  /**
   * クローンの最後のセッション開始の init が知らせた plugin の読み込み結果（Issue #3816）。
   * **省略可能**: 実装しない（テスト用の）ホストでは呼び出し側が「観測なし」に倒す。**init をまだ
   * 受けていない・セッションを開き直した直後・init に `plugins` が無かったときは `undefined`**
   * （「0件」とも「失敗した」とも読まない）。蒸留のサイドクエリの init は含まない。
   */
  pluginLoad?(): ClonePluginLoadObservation | undefined;

  /**
   * 走行中のターンを止めて片付ける。
   *
   * `farewellDeadlineAt`（Issue #2749）は、畳み始めた runner の最後の出来事を待つ絶対の
   * 締切（`ManagerPool#stop` の同名の欄）。デーモンが SIGTERM を起点に渡す。
   */
  stop(options?: { farewellDeadlineAt?: number }): Promise<void>;
}
