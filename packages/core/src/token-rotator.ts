import { randomUUID } from 'node:crypto';

import {
  buildEnvToken,
  credentialOf,
  isEnvToken,
  markTokenUnusable,
  markTokenUsable,
  tokenAvailabilityAt,
  type TokenCredential,
  type ActiveAgentToken,
  type AgentToken,
  type TokenRotationSettings,
} from './token-pool.js';
import {
  cooldownUntilFrom,
  decideTokenRotation,
  observationFreshness,
  selectNextToken,
  type ObservationFreshness,
  type TokenRotationSignal,
  type TokenSelection,
} from './token-rotation.js';
import type { JournalEntryInput } from './schema.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { TokenCandidateVerdict } from './token-candidate.js';
import type { Stores } from './store.js';

/**
 * 回し手（Issue #393 PR3）。**デーモンの中の1本。**
 *
 * **クローンでもマネージャーでも runner でもない。** 枠に当たった瞬間、クローンは
 * ターンを回さない（`clone.ts` の `#usageBlocked` が立って受信箱の合図が保持される）
 * ので、**切替をクローンの判断に委ねる設計はいちばん要るときにいちばん動かない。**
 *
 * ## 撒く先は外から渡す（{@link TokenSpreadPort}）
 *
 * runner へ降ろす経路は `apps/daemon` に在り、クローンの `#childEnv()` は
 * `clone.ts` に在る。**core がそのどちらにも依存しない形にしてある** ——
 * `agent-ports.ts` と同じ理由で、境界を1ターンぶんの操作に引く。
 *
 * ## 直列化
 *
 * **書く操作はすべて1本の列を通る**（`profile-service.ts` / `token-pool-service.ts`
 * と同じ形）。支出上限に当たったとき走行中のマネージャーが2本同時に同じ文言を
 * 返した実測があり（`usage-limits.ts` の doc）、**並列に回すとプールを一気に食う。**
 * 世代の照合（{@link observationFreshness}）と合わせて二重に塞いである——照合だけだと
 * 「読んでから書くまで」の隙間に2本目が入る。
 */

/** 撒いた先1つぶんの結果。**「撒いた」と「効いた」は別である。** */
export interface TokenSpreadResult {
  /** 撒く先の名前（日誌に出る。`runner-primary` / `clone` など）。 */
  target: string;
  ok: boolean;
  /** 失敗した理由。**トークンの値を含めないこと。** */
  error?: string;
}

/**
 * 現役を撒く口。**core の外（デーモン）が実装する。**
 *
 * **⚠️ 撒いた先が「新しいトークンで走っている」ことは、この口では確かめられない。**
 * env はプロセス起動時に凍るので、**走っているマネージャーにも走っているクローンの
 * セッションにも届かない**（`credentials.ts` / `profile.ts` の doc が同じ境界を
 * 何度も書いている）。ここが `ok` を返すのは「置いた」までである。
 *
 * ⟹ **「撒いた」を「回った」として観測しないこと**（Issue #393 の地雷）。
 * 回ったことの権威ある証拠は、次のターンが成功することだけである。
 */
export interface TokenSpreadPort {
  /**
   * `generation` も渡す。**撒く先が「どの世代の鍵を持っているか」を名乗れないと、
   * 世代の照合（{@link observationFreshness}）が成立しない** — クローンは
   * セッションを起こす瞬間にこれを捕まえて、そのセッションの観測へ添える。
   */
  spread(token: { id: string; generation: number } & TokenCredential): Promise<TokenSpreadResult[]>;
}

/** 候補を1本試す口（PR2 の `probeTokenCandidate` を包んで渡す）。 */
export interface TokenProbePort {
  probe(
    token: { id: string } & TokenCredential,
  ): Promise<
    | { verdict: 'usable' }
    | { verdict: 'unusable'; reason: string; retryAt?: number }
    | { verdict: 'undecidable'; reason: string }
  >;
}

/**
 * {@link TokenRotator.reconsider} を呼んだ契機。**観測（`signal`）とは別の軸である。**
 *
 * `signal` が答えるのは「何を見て回すと決めたか」で、こちらが答えるのは
 * 「**なぜその判定をこの瞬間に走らせたか**」である。2つを1つの欄に畳むと、
 * 「冷却が明けたので見直した」と「記録の上で現役が通らない」が同じ顔になる。
 */
export type TokenReconsiderReason =
  /** プールが変わった（人間が足した・消した・並べ替えた・`enable` した）。 */
  | 'pool_changed'
  /** 回す契機・冷却の既定が変わった。 */
  | 'settings_changed'
  /**
   * 定期の見張り。**何も無ければ probe を1本も焼かない**（下の
   * {@link TokenRotator.reconsider}）。
   *
   * **⚠️ 「冷却が明けた」専用の値を持たせていない。** 見張り
   * （`apps/daemon/src/token-watch.ts`）は記憶ストアを読まないので、目盛りが
   * 鳴った回が冷却明けだったのかどうかを**言えない。** 言えないことを名前で
   * 主張する値を作ると、`AGENTS.md` の地雷「取れない軸に 0 の行を作る」と
   * 同じ形になる —— **誰も出さない enum の値は、schema がついた嘘である。**
   */
  | 'tick'
  /** runner が繋がった / 繋ぎ直してきた。 */
  | 'runner_connected'
  /** 現役を probe で観測した結果が届いた（セッションが1本も走っていなくても届く）。 */
  | 'account_probe'
  /** デーモンが起きた直後の1回。 */
  | 'startup';

/** 回した / 回さなかった結果。**日誌へそのまま出せる形にしてある。** */
export type TokenRotationOutcome =
  | {
      kind: 'ignored';
      signal: TokenRotationSignal;
      /**
       * 観測の新しさ。**観測から来ていない判定（{@link TokenRotator.reconsider}）
       * には付かない** —— あちらは照合する観測そのものを持たないので、`unknown`
       * を埋めると「身元を運べない観測が届いた」という嘘になる。
       */
      freshness?: ObservationFreshness;
      /** 状態から決めた判定のときだけ付く契機（{@link TokenReconsiderReason}）。 */
      reason?: TokenReconsiderReason;
      /**
       * **止まっていた現役が、また通ることを観測できた**（人間の決定 2026-09-07）。
       *
       * 付くのは {@link TokenRotator.reconsider} が `currentVerdict: 'usable'` を
       * 受けて、その行の**止まった記録を実際に消した**回だけである。
       *
       * ## なぜ「回さなかった」の中にこれが要るか
       *
       * **「いつ開いたか」を記録に残せる唯一の場所だからである。** これが無いと、
       * 日誌には「止まった」（`exhausted` / `parked`）しか残らず、**止まりが
       * 終わった時刻を後から誰も言えない。** 日誌は `event: 'recovered'` で出る
       * （`tokenRotationEntry`）。
       *
       * **回してはいない**ので `rotated` にはしない —— 鍵は1文字も変わっておらず、
       * 消したのは止まった記録だけである。
       *
       * ## ここが立ったら、止まっていた層を起こす
       *
       * 枠に当たったクローンは `#usageBlocked` が立ってターンを回さず、解除の
       * 契機は**新しい合図の到着**だけである（`clone.ts` の `#usageBlocked` の
       * doc: タイマーを持たない）。マネージャーも同じで、枠で落ちたセッションは
       * 引き取り（`ManagerPool#restore`）が走るまで再開しない。
       *
       * ⟹ **鍵が開いたことを知らせないと、止まったものは止まったままである。**
       * 起こすのは呼ぶ側で、`rotated` と揃えてある（`apps/daemon/src/index.ts` の
       * `settleTokenOutcome`）。**人間の決定 2026-09-07** —— それまでは
       * 「受信箱への通知は入れない」（2026-08-25）に従って入れていなかったが、
       * **あれは「知らせ」の話で、これは「再開の契機」である**（止まっている層は
       * 合図が来ないかぎり自分では動けない）。
       *
       * **`parked` では起こさない** —— 撒いた鍵は `cooldownUntil` まで通らないので、
       * 起こしても同じところで止まり、保持していた合図を1件無駄に焼く。
       */
      recovered?: { tokenId: string; label: string };
      /**
       * `freshness` が `stale` のとき、**いまの現役に対して何件目の取りこぼしか**
       * （この1件を含む）。それ以外では付かない。
       *
       * **これは計器であって、挙動を分岐させる値ではない。** 捨てる判断は
       * {@link observationFreshness} が既にしていて、この数はその判断が**何回
       * 効いたか**を後から数えられるようにするためだけに在る。
       *
       * **なぜ数が要るか。** `stale` は「1回の当たりでマネージャーの数だけ届く」
       * ので全件を日誌へ出すと埋まるが、**1件も出さないと「届いていない」と
       * 見分けが付かない**——2026-08-25 の2時間40分の停止では日誌が0件で、
       * **観測が届かなかったのか `stale` で捨てられたのかを、後から誰も言えなかった。**
       * 数を持たせて間引いて出すのは、その2つを分けるためである（間引き方は
       * {@link describeTokenRotation}）。
       */
      staleRun?: number;
      why: string;
    }
  | {
      kind: 'rotated';
      /** 降りたトークンの id。**まだ一度も指名していなければ無い。** */
      fromTokenId?: string;
      toTokenId: string;
      toLabel: string;
      generation: number;
      signal: TokenRotationSignal;
      freshness?: ObservationFreshness;
      reason?: TokenReconsiderReason;
      /** 撒いた先ごとの結果。**「撒いた」であって「効いた」ではない。** */
      spread: TokenSpreadResult[];
      why: string;
    }
  | {
      /**
       * **通る候補が1本も無かったので、いちばん早く戻る候補を撒いて待つ**
       * （人間の決定 2026-09-07）。
       *
       * ## なぜ `exhausted` と別の顔にするか
       *
       * `exhausted` は**何も撒かずに返る**ので、全コンテナは**降りたトークンを
       * 持ったまま**待つことになる。⟹ 冷却が明けても、いちばん早く戻る鍵は
       * どこにも置かれていないので、**もう一度誰かが本番で失敗して観測を上げる
       * まで回らない。** そのあいだ全層が止まる。
       *
       * `parked` は「待つ」までは同じだが、**待つあいだに全コンテナが持っている
       * のが、いちばん早く戻る鍵になっている。** ⟹ 冷却が明けた瞬間に、次の
       * セッションはそのまま通る（回し手を1回も通らずに復帰する）。
       *
       * ## 「回った」ではない。だから `rotated` にも畳まない
       *
       * 撒いた鍵は**まだ冷却中である**（{@link cooldownUntil} まで通らない）。
       * `rotated` と同じ顔にすると、日誌の「回した」が「いま通る鍵に移った」を
       * 意味しなくなる —— 読む側は次のターンが通ると読むが、実際には
       * `cooldownUntil` まで通らない。
       */
      kind: 'parked';
      /** 降りた側。**まだ一度も指名していなければ無い。** */
      fromTokenId?: string;
      tokenId: string;
      label: string;
      /** **増える。** 指名が変わったので、前の鍵で走っている観測は `stale` である。 */
      generation: number;
      /** その鍵が通るようになる見込みの時刻（epoch ミリ秒）。 */
      cooldownUntil: number;
      signal: TokenRotationSignal;
      freshness?: ObservationFreshness;
      reason?: TokenReconsiderReason;
      spread: TokenSpreadResult[];
      why: string;
    }
  | {
      /**
       * **撒くものが無いまま返った。**
       *
       * ⚠️ **`parked` が入ってから、ここへ落ちる道は3本だけになった。** 冷却中の
       * 候補が1本でも在れば、そちらは `parked`（撒いて待つ）へ行く。
       *
       * 1. **戻る見込みの立つ候補が1本も無い**（プールが空 / 全部 `disabled` /
       *    全部失効）。`earliest` は付かない
       * 2. **いちばん早く戻るのが現役自身だった** —— 撒き直しても同じ鍵なので、
       *    世代だけ増やして何も変えない、を避ける。`earliest` が付く
       * 3. **持ち時間で打ち切った**（`stoppedBy: 'budget'`）。まだ試していない
       *    候補が在るので、`earliest` は測っていない（付かない）
       */
      kind: 'exhausted';
      /** いちばん早く戻るもの。**無いことがある**（上の1と3）。 */
      earliest?: { tokenId: string; label: string; cooldownUntil: number };
      /**
       * **候補を試し切る前に打ち切ったか**（Issue #393）。付くのは
       * `'budget'`（壁時計の持ち時間を使い切った）のときだけである。
       *
       * **これが無いときの `exhausted` は「試し切って、どれも駄目だった」を意味する。**
       * 付いているときは**まだ試していない候補が残っている** —— 両者を同じ顔にすると、
       * 「全部だめ」と「時間切れ」が出力から区別できなくなる。
       *
       * **日誌の `event` でも分かれている**（`sweep_stopped` / `exhausted`。
       * `schema.ts` の `token_rotation.event`）。
       */
      stoppedBy?: 'budget';
      signal: TokenRotationSignal;
      freshness?: ObservationFreshness;
      reason?: TokenReconsiderReason;
      why: string;
    };

export interface TokenRotatorObservation {
  notice?: UsageLimitNotice;
  facts?: RateLimitFacts;
  transition?: 'entered_overage' | 'rejected';
  /**
   * その観測が**どのトークンで走っていたときのものか**。
   *
   * **省略できるようにしてあるのは、身元を運べない検知点が実在するからである**
   * ——省略された観測は {@link observationFreshness} が `unknown` を返し、
   * この回し手は**効かせる側へ倒す**（飲み込むほうが悪い。あちらの doc）。
   * 倒した事実は `freshness` として結果に残る。
   */
  observedBy?: { tokenId?: string; generation?: number };
}

export interface TokenRotatorOptions {
  stores: Stores;
  probe: TokenProbePort;
  spread: TokenSpreadPort;
  /** 現在時刻。テストで固定するため。 */
  now?: () => Date;
  /**
   * 器の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）が置かれているか（Issue #393）。
   *
   * **値そのものを受けない。** core は正本を持つが、**器の環境変数は器のもの**で
   * あって記憶ストアの正本ではない——値を持ち込むと「どちらが正か」が2つになる。
   * 要るのは「指す先が在るか」だけである。
   */
  hasEnvToken?: () => boolean;
  /** 新しい行の id を作る。テストで固定するため。 */
  newId?: () => string;
}

/**
 * 起動時の引き取りの結果（Issue #393 PR3）。**回した結果とは別の型にしてある。**
 *
 * 同じ型に畳むと、日誌から「回った」と「起動時に戻しただけ」が区別できなくなる
 * ——前者は枠に当たった証拠だが、後者は何も起きていない。
 */
export type TokenRestoreOutcome =
  | { kind: 'none'; why: string }
  | {
      kind: 'restored';
      tokenId: string;
      label: string;
      /** **増やさない。** 引き取りは回転ではないので、保存されていた値のまま。 */
      generation: number;
      /** 撒き直した相手が冷却中だったか。**撒くことは変えず、事実だけ返す。** */
      cooling: boolean;
      spread: TokenSpreadResult[];
      why: string;
    }
  | { kind: 'dangling'; tokenId: string; why: string }
  | { kind: 'withheld'; tokenId: string; label: string; why: string };

export interface TokenRotator {
  /**
   * 観測を1つ受ける。**回すかどうかもここが決める。**
   *
   * 呼ぶ側（クローンの `#noteUsageNotice` と `ManagerPool#onEvent`）は判定を持たない
   * ——6つの検知点が同じ1本へ合流する形にしてあるのが、この設計の骨である。
   *
   * **⚠️ ここへ来る観測はすべて「セッションが回っているあいだ」に届く。**
   * ⟹ **全層が止まると、この口は誰からも呼ばれない。** 動く鍵がプールに残って
   * いても回らない、という形がそこで生まれる（{@link TokenRotator.reconsider}）。
   */
  observe(observation: TokenRotatorObservation): Promise<TokenRotationOutcome>;
  /**
   * **観測を待たずに、記録の状態だけを見て回すか決める**（人間の決定 2026-09-07）。
   *
   * ## なぜ要るか —— `observe` だけでは「止まったら回らない」
   *
   * `observe` の6つの検知点は**すべてセッション由来**である（クローンのターン /
   * マネージャーの `usage_notice` / `rate_limit`）。⟹ 全層が枠で止まった状態は、
   * **観測を上げる主体が1つも居ない状態**でもある。そこから抜けるには誰かが
   * もう一度本番で失敗して観測を上げるしかなく、**プールに通る鍵が残っていても
   * 何も起きない**時間ができる。人間が新しい鍵を足しても同じで、`PUT /tokens` は
   * 記憶ストアを書くだけだった。
   *
   * ⟹ **契機を状態の側にも持つ。** 見るのは1つだけである ——
   * **「記録の上でいまの現役が通らないのに、通る候補が在る」なら回す。**
   *
   * ## 回さない側の条件（`observe` と揃えてある）
   *
   * - プールが空 → 何もしない（受け入れ基準7。既定の構成を1文字も変えない）
   * - 設定が `off` → 回さない（記録だけ。人間が自動を切った意思）
   * - **記録の上で現役が `ready` → 回さない。** ここが「健全な鍵から勝手に移らない」
   *   の歯止めである
   *
   * ## probe を焼かない場合がはっきりしている
   *
   * 候補選び（`selectNextToken`）は**記録だけを見る純粋関数**で、`ready` な行が
   * 1本も無ければ probe を始める前に `none` を返す。⟹ **定期の目盛りで呼んでも、
   * (a) 現役が `ready`（＝ふつうの状態） (b) 候補が全部冷却中 のどちらでも
   * サブプロセスは1本も起きない。** 焼くのは「現役が通らないのに `ready` な候補が
   * 在る」＝まさに回したい瞬間だけである。
   *
   * @param input.currentVerdict
   *   **現役をこの回に probe して分かったこと**（セッションを1本も使わない観測。
   *   `apps/daemon/src/usage-poller.ts` が5分ごとに取っているものを
   *   `judgeTokenCandidate` へ通した値）。
   *
   *   - `unusable` → **記録が `ready` でも冷却へ入れて回す。** これが「観測が
   *     どこからも上がらないまま止まり続ける」を塞ぐ本体である
   *   - `usable` → 現役は通る。**止まった記録が残っていれば消す**
   *     （`markTokenUsable`）—— 冷却が既定の5時間で入っていて、実際には枠が
   *     もっと早く開いていた回がここで直る
   *   - `undecidable` / 省略 → **記録だけで判定する**（判定材料が無いことを
   *     `unusable` へ丸めない。`judgeTokenCandidate` の doc と同じ規律）
   *
   *   **⚠️ この判定が見ているのはアカウントの枠だけである**（`five_hour` /
   *   `seven_day` / … と課金枠。`usage-snapshot.ts` の窓の一覧に**セッション
   *   単位の上限に対応する枠は無い**）。⟹ `You've hit your session limit` で
   *   止まっている鍵に対して `usable` が返りうる:
   *
   *   - **その形は `unusable` として検出できない** —— 上の「塞ぐ本体」が効くのは
   *     アカウントの枠を使い切った形だけである
   *   - **`usable` で記録を消すと、通らない鍵を `ready` に戻しうる。** そこから
   *     先は自己修復する（起こされた層が失敗し、その失敗が新鮮な観測になって
   *     `observe` が冷却を書く）が、**1ターンぶんの空振りを払う**
   *
   *   **⟹ `usable` は「アカウントの枠は空いている」であって「次のセッションが
   *   起きる」ではない。** 呼ぶ側の言葉での同じ注意は
   *   `apps/daemon/src/token-watch.ts` の doc に在る。
   */
  reconsider(input: {
    reason: TokenReconsiderReason;
    currentVerdict?: TokenCandidateVerdict;
  }): Promise<TokenRotationOutcome>;
  /**
   * **起動時に1度だけ**、記憶ストアが「現役」と言っているトークンを撒き直す。
   *
   * ## なぜ要るか
   *
   * 撒いた先（runner の env・クローンの箱）は**プロセスと一緒に消える**が、現役の
   * 指名は記憶ストアに残る。⟹ これが無いと、デーモンを再起動した直後は**器の
   * 環境変数のトークンが走っているのに、記憶ストアは別のトークンを現役だと思って
   * いる**という食い違いが残る。その状態で枠に当たると、**走ってもいないトークンを
   * 冷却へ入れて**候補を1本無駄に飛ばす。
   *
   * ## 引き取りは回転ではない
   *
   * - **世代を増やさない**（増やすと、まだ有効な観測が `stale` として捨てられる）
   * - **記憶ストアへ書かない**（`updatedAt` が動くと「変わっていないのに変わった」になる）
   * - **候補を選び直さない。** 現役が冷却中でも**そのまま撒く** — 引き取りは
   *   「記憶ストアが言っている現役を、消えた撒き先へもう一度置く」だけの操作で
   *   あって、選ぶ操作ではない。冷却中だったことは `cooling` で返す
   *
   *   **⚠️ ここは「起動では選び直さない」を意味しない**（2026-09-07 に変わった）。
   *   選び直す判定は {@link TokenRotator.reconsider} が持ち、デーモンは引き取りの
   *   直後にそれを1回呼ぶ（`reason: 'startup'`）。⟹ **起動時に現役が冷却中で
   *   通る候補が在れば、引き取りの後に回る。** 分けてあるのは順序のためである ——
   *   先に「記録どおりの状態」を作り、そのうえで見直す。逆にすると、撒き直せて
   *   いない状態を見て判定することになる
   *
   * ## 4つの結果を畳まない
   *
   * | 結果 | 何が起きたか | この後どうなるか |
   * | --- | --- | --- |
   * | `none` | 一度も回していない | 器の環境変数がそのまま効く |
   * | `restored` | 撒き直した | 記憶ストアと実際が揃う |
   * | `dangling` | 指名の先の行が消えている | 環境変数が効く。**次に枠へ当たれば直る** |
   * | `withheld` | 人間がその行を外した / 失効している | 同上 |
   *
   * **`dangling` と `withheld` では撒かない。** 人間が外したものを起動時に戻すのは、
   * **人間の判断を実装が黙って覆すこと**である。食い違いは残るが、次の当たりで
   * 回し手が正しい候補へ移る（消えた / 外された id は候補から外れる）——だから
   * `why` に出して見えるようにするだけにしてある。
   */
  restore(): Promise<TokenRestoreOutcome>;
  /**
   * 器の環境変数を指す行が無ければ足す（Issue #393）。**起動時に1度だけ。**
   *
   * ## なぜ要るか
   *
   * 器の環境変数のトークンには、これまでプールの行が無かった。⟹ **それが枠に
   * 当たっても、いつ・何と言われたかがどこにも残らない。** 回し手は現役の行を
   * 冷却へ入れるが、環境変数は行を持たないので入れる先が無い。**最初に止まった
   * 1本だけが台帳から消える**——しかもそれは、たいてい人間が最初に踏む1本である。
   *
   * ## 人間が書いた行ではなく、事実の射影である
   *
   * 器に環境変数が置かれているという事実を1行として表しているだけなので、
   * **消しても次の起動で戻る。** 「もう使わない」を表したいなら
   * `alteroid token disable`（{@link AgentToken.disabledAt}）を使う——そちらは
   * 人間の判断なので戻らない（この関数は行が在れば何もしない）。
   *
   * ## ⚠️ プールが空なら足さない
   *
   * **受け入れ基準7（プールが空の既定構成の挙動を1文字も変えない）を字義どおり
   * 守るためである。** 人間が1本も登録していない＝プールを使うと決めていない器で、
   * 記憶ストアに行が生えて日誌に線が増えるのは、たとえ挙動が同じでも「1文字も
   * 変えない」ではない。**人間が1本でも登録した時点で**環境変数の行が生える。
   *
   * **環境変数が置かれていなければ足さない**（指す先が無いので）。
   */
  ensureEnvToken(): Promise<TokenEnsureEnvOutcome>;
}

/** {@link TokenRotator.ensureEnvToken} の結果。**足したかどうかを畳まない。** */
export type TokenEnsureEnvOutcome =
  | { kind: 'added'; tokenId: string; why: string }
  | { kind: 'exists'; tokenId: string }
  | { kind: 'skipped'; why: string };

/**
 * 1回の観測で、候補を試すことに使ってよい壁時計の持ち時間（ミリ秒）。
 *
 * **件数ではなく時間で切る。** 件数の上限は**占有する時間を縛らない** ——
 * probe は1本あたり最大 `USAGE_PROBE_TIMEOUT_MS`（20秒）待つので、
 * 「3本まで」は「最悪60秒まで」であって、守りたいものを守っていない。
 *
 * **何を守っているか。** `observe` は `serial()` の1本の列を通るので、ここで
 * 止まっているあいだ**他の観測が全部待たされる** —— 枠に当たった知らせが列の
 * 後ろで待つ、という形になる。
 *
 * **1本目は必ず試す。** 判定は「選んでから、probe を始める前」に見るので、
 * 経過が 0 の初回はここで止まらない。**持ち時間を 0 にしても、1本は試す。**
 *
 * **打ち切ったことは黙らない**（`TokenRotationOutcome` の `stoppedBy`）。
 * 黙って打ち切ると「候補を全部試した」と「時間切れでやめた」が出力から
 * 区別できなくなる。
 */
export const CANDIDATE_SWEEP_BUDGET_MS = 60_000;

/**
 * 候補を1本ずつ試した結果。**保存も撒きもしていない。**
 *
 * **1回の周のあいだに起きたことを全部持って返る。** 途中で保存しないのは、
 * 「一部の候補にだけ冷却が付いて、結果は誰にも届かない」版を残さないためである
 * （保存する1箇所の doc に理由が在る）。
 */
interface CandidateSweep {
  /**
   * 撒くと決めた候補。**`usable` が1本も無ければ `undecidable` の先頭へ倒した分。**
   */
  chosen?: { token: AgentToken; verdict: TokenCandidateVerdict };
  /** 倒した結果か（`usable` を見つけられなかったか）。**言い分けるために持つ。** */
  fellBackToUndecided: boolean;
  /** `unusable` と判定して飛ばした候補の label（試した順）。 */
  unusableLabels: string[];
  /** 冷却の印を積んだ集合。**保存するのは呼ぶ側である。** */
  tokens: AgentToken[];
  /** 候補を使い切ったときの見立て（`selectNextToken` の `none`）。 */
  ranOut?: Extract<TokenSelection, { kind: 'none' }>;
  /** 持ち時間で打ち切ったか。**まだ試していない候補が残っている。** */
  stoppedByBudget: boolean;
}

/**
 * その候補へ park し直すのは改善か。**改善でなければ撒かない。**
 *
 * ## なぜ要るか —— 世代が延々と増える形を塞ぐ
 *
 * park して待っているあいだ、見張りは目盛り（60秒）ごとに同じ状態を見る。
 * 現役（＝前に park した鍵）は冷却中なので毎回「通らない」と判定され、候補の
 * 中でいちばん早いものが**より遅い別の鍵**だと、そちらへ park し直してしまう。
 *
 * **遅い鍵へ移すのは改善ではないうえ、増えた世代が走行中の観測を全部 `stale` に
 * する**（`observationFreshness`）—— つまり**待っているだけで、本物の当たりを
 * 飲み込む側が強くなっていく。**
 *
 * ## 判定
 *
 * | いまの現役 | 改善か |
 * | --- | --- |
 * | 冷却中（`cooldownUntil` が在る） | **候補のほうが早いときだけ**（同着は移さない） |
 * | 冷却中ではない（`disabled` / 失効 / 指名の先が消えた / 撒けていない） | **常に改善** —— 待っても戻らない側に居るので、戻る見込みの立つ鍵へ移す |
 */
function parkImprovesOn(
  candidateCooldownUntil: number,
  activeRow: AgentToken | undefined,
): boolean {
  const current = activeRow?.cooldownUntil;
  if (current === undefined) return true;
  return candidateCooldownUntil < current;
}

export function createTokenRotator(options: TokenRotatorOptions): TokenRotator {
  const { stores, probe, spread } = options;
  const now = options.now ?? (() => new Date());
  const hasEnvToken = options.hasEnvToken ?? (() => false);
  const newId = options.newId ?? (() => randomUUID());

  /**
   * いまの現役に対して、`stale` で捨てた観測が続けて何件になったか。
   *
   * **鍵は「現役の身元」である**（id と世代の両方）——世代だけだと、同じ世代の
   * まま指名が変わったときに数え続けてしまう。回れば鍵が変わるので、数は自然に
   * 1 から数え直しになる。**明示的に消す経路を持たない**のはそのためである。
   *
   * **プロセスの寿命でしか持たない。** 記憶ストアへは書かない——これは「いま
   * 走っているデーモンが何回捨てたか」の計器であって、事実の記録ではない
   * （事実の側は日誌に出る）。
   */
  let staleRun: { key: string; count: number } | null = null;

  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * 降りるトークンを冷却へ入れて保存する。
   *
   * **選ぶより先に保存する。** 選んでから保存する順にすると、保存が落ちたときに
   * 「降りたはずのものが記録の上ではまだ健在」という版が残る——次の観測で同じ
   * トークンがまた選ばれる。
   *
   * **`resetsAt` が権威ある期限である**（`cooldownUntilFrom`）。取れなければ設定の
   * 既定へ倒す——**この関数の中に既定を持たない。**
   */
  async function coolDown(
    tokens: readonly AgentToken[],
    outgoingId: string,
    settings: TokenRotationSettings,
    observation: TokenRotatorObservation,
  ): Promise<AgentToken[]> {
    const at = now().toISOString();
    const resetsAt = cooldownUntilFrom(observation.facts);
    return stores.tokens.replace(
      tokens.map((token) =>
        token.id === outgoingId
          ? markTokenUnusable(token, {
              at,
              // **文言をそのまま残す。** 無いときは印を文言の代わりにしない
              // ——観測できたものだけを書く（`TokenFailureObservation.message`）。
              message: observation.notice?.text ?? '枠から追い返された（文言は届いていない）',
              ...(resetsAt === undefined ? {} : { resetsAt }),
              fallbackCooldownMs: settings.cooldownMs,
            })
          : token,
      ),
    );
  }

  /**
   * **候補を1本ずつ試す（Issue #393「回し方」の 2〜4 の繰り返し）。**
   *
   * Issue 本文は逐語で「`使えない` → **2 へ戻って次の候補**」と書いている。
   * ここが1本で打ち切っていたので、**候補が残っていても `exhausted`（＝全層が
   * 止まる、の顔）になっていた。**
   *
   * **外すのは記録ではなく、その場の集合である。** 冷却の印を配列へ反映した
   * だけでは次の周でまた選ばれうる —— `resetsAt` が既に過去なら印を付けた
   * 直後でも `ready` に見える（`markTokenUnusable` の doc: 過去の値を未来へ
   * 丸めない）。
   *
   * **⚠️ `ready` な行が1本も無ければ probe を1本も焼かない。** `selectNextToken`
   * は記録だけを見る純粋関数で、その場合は最初の周で `none` を返す ⟹
   * {@link TokenRotator.reconsider} を定期の目盛りで呼んでもサブプロセスは
   * 起きない（あちらの doc が同じことを呼ぶ側の言葉で書いている）。
   *
   * **保存しない。撒かない。** どちらも {@link finishSweep} が1回だけ行う。
   */
  async function sweepCandidates(
    startTokens: readonly AgentToken[],
    exclude: readonly string[],
    settings: TokenRotationSettings,
  ): Promise<CandidateSweep> {
    const tried = new Set<string>(exclude);
    const sweepStartedAt = now().getTime();

    let sweptTokens = [...startTokens];
    const unusableLabels: string[] = [];
    let chosen: { token: AgentToken; verdict: TokenCandidateVerdict } | undefined;
    /**
     * **判定できなかった候補のうち、いちばん先に出会ったもの。**
     *
     * `undecidable` は**順位を下げるのであって、捨てるのではない**
     * （`judgeTokenCandidate` の「迷ったら `unusable` にしない」）。`usable` と
     * 確かめられたものが1本でも在ればそちらが勝つが、**1本も無ければここへ倒す。**
     *
     * **列は order 昇順なので、ここに入るのは「判定できなかった中で order が
     * いちばん小さいもの」である** ⟹ 全部 `undecidable` のときの結果は、
     * 順位を下げる前と同じになる。
     */
    let undecided: { token: AgentToken; verdict: TokenCandidateVerdict } | undefined;
    let ranOut: Extract<TokenSelection, { kind: 'none' }> | undefined;
    let stoppedByBudget = false;

    for (;;) {
      const selection = selectNextToken(sweptTokens, {
        at: now().getTime(),
        exclude: [...tried],
      });
      if (selection.kind === 'none') {
        ranOut = selection;
        break;
      }
      // **持ち時間は「選んでから、probe を始める前」に見る。** 初回は経過が 0 なので
      // 必ず1本は試す（`CANDIDATE_SWEEP_BUDGET_MS` の doc）。
      if (now().getTime() - sweepStartedAt >= CANDIDATE_SWEEP_BUDGET_MS) {
        stoppedByBudget = true;
        break;
      }
      tried.add(selection.token.id);

      // **候補を本番の仕事で試さない**（Issue #393 の設計の骨）。推論が走らない
      // probe で確かめる。3値のうち `unusable` だけが候補を1本飛ばす。
      const verdict = await probe.probe({
        id: selection.token.id,
        ...credentialOf(selection.token),
      });
      // **`usable` と確かめられたものだけが、ここで列を止める。**
      //
      // **`undecidable` で止めていた**ので、`usable` が後ろに居ても届かなかった
      // ——「判定できなかった候補を撒いて本番で確かめる」が、**確かめられた候補
      // より先に選ばれていた。** 2026-08-25 の回転はこの形である（order -1 の
      // 行が `undecidable` を返し、そこで確定した）。
      if (verdict.verdict === 'usable') {
        chosen = { token: selection.token, verdict };
        break;
      }
      if (verdict.verdict === 'undecidable') {
        // **捨てない。順位を下げるだけである。** 先に出会ったものを覚えておき、
        // `usable` が1本も見つからなければここへ倒す。**上書きしない**
        // （order 昇順なので、最初のものがいちばん小さい）。
        undecided ??= { token: selection.token, verdict };
        continue;
      }

      // **飛ばした候補も冷却へ入れる。** 入れないと次の観測で同じものが
      // 最初の候補として選ばれ、probe を毎回焼く。
      const at = now().toISOString();
      sweptTokens = sweptTokens.map((token) =>
        token.id === selection.token.id
          ? markTokenUnusable(token, {
              at,
              message: verdict.reason,
              ...(verdict.retryAt === undefined ? {} : { resetsAt: verdict.retryAt }),
              fallbackCooldownMs: settings.cooldownMs,
            })
          : token,
      );
      unusableLabels.push(selection.token.label);
    }

    // **`usable` が見つからなければ、判定できなかった候補へ倒す。**
    //
    // **手元に撒ける候補が在るのに何もしない、を作らない。** ここを省くと、
    // 「`usable` を探しているうちに持ち時間を使い切って、見つけてあった
    // `undecidable` を捨てる」が起きる —— **順位を下げたことが、捨てたことに
    // 化ける。** 打ち切り（`stoppedByBudget`）でも同じで、**倒せる先が在るなら
    // 倒す。**
    const fellBackToUndecided = chosen === undefined && undecided !== undefined;
    if (fellBackToUndecided) chosen = undecided;

    return {
      ...(chosen === undefined ? {} : { chosen }),
      fellBackToUndecided,
      unusableLabels,
      tokens: sweptTokens,
      ...(ranOut === undefined ? {} : { ranOut }),
      stoppedByBudget,
    };
  }

  /**
   * 1周ぶんの結果を、**保存 → 指名 → 撒く**の順で片付けて1つの結果にする。
   *
   * **`observe` と `reconsider` が同じここを通る。** 契機（観測 / 状態）で分かれる
   * のは判定までで、**回った後に起きることは1本でなければならない** —— 2本に
   * すると、片方だけが `parked` を持つ・片方だけが保存の順序を守る、という形が
   * 静かに生まれる。
   */
  async function finishSweep(input: {
    sweep: CandidateSweep;
    active: ActiveAgentToken | null;
    /** 降りるトークン。**まだ一度も指名していなければ無い。** */
    outgoingId?: string;
    signal: TokenRotationSignal;
    freshness?: ObservationFreshness;
    reason?: TokenReconsiderReason;
    /** 「なぜ回すと決めたか」の1行。**`rotated` / `parked` の頭に付く。** */
    whyHead: string;
  }): Promise<TokenRotationOutcome> {
    const { sweep, active, outgoingId, signal, freshness, reason, whyHead } = input;
    /**
     * いま指名されている行（`parked` の改善判定に使う）。
     *
     * **`sweep.tokens` から引く。** 冷却の印を積んだ後の集合なので、この周で
     * 冷やした分も反映されている —— 元の配列から引くと、**いま冷やしたばかりの
     * 現役を「冷却中ではない」と読む。**
     */
    const activeRow =
      active === null ? undefined : sweep.tokens.find((token) => token.id === active.tokenId);
    const common = {
      signal,
      ...(freshness === undefined ? {} : { freshness }),
      ...(reason === undefined ? {} : { reason }),
    };

    // **冷却の印は、ここで1回だけ保存する。**
    //
    // **周ごとに保存すると、途中で落ちたときに「一部の候補にだけ冷却が付いて、
    // 結果は誰にも届かない」版が残る** —— 保存の失敗はこの関数の外まで投げ、
    // 呼ぶ側は跡を1行残してそのターンを捨てる（再送も再試行も無い）。
    //
    // **無駄と嘘を分ける。** まとめて1回にすると、落ちたときは印が丸ごと残らず、
    // 次の観測が同じ候補をもう一度 probe する —— **それは無駄なだけで、記憶ストア
    // と現実をずらさない。** 一部だけ残るほうは、ずらす。
    //
    // **回す前に保存する。** ここで落ちたら回さない —— `writeActive` が落ちた
    // ときと同じ倒れ方である（`it('撒く前に正本を書く（保存が落ちたら撒かない）')`
    // が固定している形）。
    if (sweep.unusableLabels.length > 0) await stores.tokens.replace(sweep.tokens);

    const skipped =
      sweep.unusableLabels.length === 0
        ? ''
        : `。試した候補「${sweep.unusableLabels.join('」「')}」はどれも使えなかった`;

    /**
     * 指名を書いて撒く。**正本を先に書く。** 撒いてから保存する順にすると、
     * 保存が落ちたときに「誰も成功と言っていない版を1層だけが使う」が残る
     * （`profile-service.ts` が同じ失敗をして直した形）。
     */
    const nominate = async (
      token: AgentToken,
    ): Promise<{ generation: number; spread: TokenSpreadResult[] }> => {
      const generation = (active?.generation ?? 0) + 1;
      const nextActive: ActiveAgentToken = {
        tokenId: token.id,
        generation,
        rotatedAt: now().toISOString(),
      };
      await stores.tokens.writeActive(nextActive);
      const results = await spread.spread({
        id: token.id,
        generation,
        ...credentialOf(token),
      });
      return { generation, spread: results };
    };

    if (sweep.chosen !== undefined) {
      const { token, verdict } = sweep.chosen;
      const placed = await nominate(token);
      return {
        kind: 'rotated' as const,
        ...(outgoingId === undefined ? {} : { fromTokenId: outgoingId }),
        toTokenId: token.id,
        toLabel: token.label,
        generation: placed.generation,
        ...common,
        spread: placed.spread,
        // **倒したことを言い分ける。** 黙って倒すと、「`usable` を選んだ」と
        // 「探しきれずに妥協した」が同じ顔になる —— 打ち切りに `sweep_stopped` を
        // 与えたのと同じ理由である。**言い分けるのは `why`（＝日誌の `text`）で、
        // `event` は `rotated` のままにしてある** —— `event` の軸は「何が起きたか」
        // で、**候補をどう選んだかは別の軸**である（そしてその軸は、この変更より前から
        // `why` が運んでいる）。
        why: (() => {
          const head = `${whyHead}。`;
          if (verdict.verdict === 'usable') {
            return `${head}候補「${token.label}」は観測できた`;
          }
          const stopped = sweep.stoppedByBudget
            ? `（候補を試す持ち時間（${String(CANDIDATE_SWEEP_BUDGET_MS)}ms）を使い切ったところで倒した）`
            : '';
          if (sweep.fellBackToUndecided) {
            return (
              `${head}**\`usable\` と確かめられた候補は見つからなかった**ので、` +
              `判定できなかった候補「${token.label}」へ倒した${stopped}` +
              `——撒いて本番で確かめる（${verdict.reason}）`
            );
          }
          return `${head}候補「${token.label}」は判定できなかったので撒いて本番で確かめる（${verdict.reason}）`;
        })(),
      };
    }

    /**
     * **通る候補が1本も無い。いちばん早く戻る鍵を撒いて待つ**（`parked`）。
     *
     * **条件を4つ課している。1つでも欠けたら `exhausted` へ落とす:**
     *
     * 1. **打ち切っていないこと。** 打ち切った回はまだ試していない候補が在るので、
     *    「いちばん早く戻る」を測れていない（`ranOut` が無い）
     * 2. **戻る見込みの立つ候補が在ること**（`earliest`）。無いのは「全部
     *    `disabled` / 失効 / プールが空」で、撒く相手が居ない
     * 3. **それが現役自身でないこと。** 同じ鍵を撒き直すと**世代だけが増えて
     *    何も変わらない** —— 増えた世代は、いま走っている観測を `stale` として
     *    捨てさせるので、**害だけが残る**
     * 4. **いま撒いてあるものより早く戻ること**（{@link parkImprovesOn}）。
     *    **ここが無いと世代が延々と増える** —— 待っているあいだ、見張りは目盛り
     *    ごとに同じ状態を見る。現役（＝前に park した鍵）は冷却中なので毎回
     *    「通らない」と判定され、候補の中でいちばん早いものが**より遅い別の鍵**
     *    だと、そちらへ park し直してしまう。**遅い鍵へ移すのは改善ではないうえ、
     *    増えた世代が走行中の観測を全部 `stale` にする。**
     */
    const earliest = sweep.stoppedByBudget ? undefined : sweep.ranOut?.earliest;
    if (
      earliest !== undefined &&
      earliest.tokenId !== active?.tokenId &&
      parkImprovesOn(earliest.cooldownUntil, activeRow)
    ) {
      const row = sweep.tokens.find((token) => token.id === earliest.tokenId);
      if (row !== undefined) {
        const placed = await nominate(row);
        return {
          kind: 'parked' as const,
          ...(outgoingId === undefined ? {} : { fromTokenId: outgoingId }),
          tokenId: row.id,
          label: row.label,
          generation: placed.generation,
          cooldownUntil: earliest.cooldownUntil,
          ...common,
          spread: placed.spread,
          why:
            `${whyHead}。**いま通る候補は1本も無い**${skipped}。` +
            `いちばん早く戻る「${row.label}」を撒いて待つ` +
            `（${new Date(earliest.cooldownUntil).toISOString()} まで通らない）`,
        };
      }
    }

    return {
      kind: 'exhausted' as const,
      // **打ち切ったときは `earliest` を出さない。** 出せる材料が無い
      // （まだ試していない候補は冷却中ではないので、`selectNextToken` の
      // 見立てが取れていない）。**無いものを埋めない。**
      ...(sweep.stoppedByBudget || sweep.ranOut?.earliest === undefined
        ? {}
        : { earliest: sweep.ranOut.earliest }),
      ...(sweep.stoppedByBudget ? { stoppedBy: 'budget' as const } : {}),
      ...common,
      // **試した後は `selectNextToken` の文言をそのまま使わない。** あちらは
      // 「プールが空、または降りた1本しか無い」と書く —— **試して外した分も
      // 「無い」に見えているだけ**なので、そのまま出すと**候補が4本在ったのに
      // 「プールが空」と読める行**になる。
      why: sweep.stoppedByBudget
        ? `候補を試す持ち時間（${String(CANDIDATE_SWEEP_BUDGET_MS)}ms）を使い切った${skipped}`
        : earliest !== undefined
          ? // `parked` の条件3か4で落ちた。**どちらも「候補が無い」ではない。**
            // **2つを言い分ける** —— 前者は「同じ鍵」、後者は「もっと遅い鍵」で、
            // 読む側が次に確かめるものが違う。
            earliest.tokenId === active?.tokenId
            ? `いちばん早く戻る候補が現役自身だった（撒き直しても同じ鍵なので、世代だけ増やすことはしない）${skipped}`
            : `いま撒いてある鍵のほうが早く戻る（いちばん早い候補「${earliest.label}」は ${new Date(earliest.cooldownUntil).toISOString()}）。遅い鍵へ移すのは改善ではないので撒き直さない${skipped}`
          : sweep.unusableLabels.length > 0
            ? `試せる候補を使い切った${skipped}`
            : (sweep.ranOut?.why ?? '候補が無い'),
    };
  }

  return {
    ensureEnvToken: () =>
      serial(async () => {
        const tokens = await stores.tokens.list();
        // **プールが空なら足さない**（受け入れ基準7。この関数の doc）。
        if (tokens.length === 0) {
          return {
            kind: 'skipped' as const,
            why: 'プールが空（人間がまだ1本も登録していない器では、行を作らない）',
          };
        }
        const existing = tokens.find(isEnvToken);
        // **人間が外した行でも「在る」である。** 外した判断を無視して足し直さない。
        if (existing !== undefined) return { kind: 'exists' as const, tokenId: existing.id };
        if (!hasEnvToken()) {
          return {
            kind: 'skipped' as const,
            why: '器に CLAUDE_CODE_OAUTH_TOKEN が置かれていない（指す先が無い）',
          };
        }

        const row = buildEnvToken(tokens, { id: newId(), at: now().toISOString() });
        // **既存の行に触らない。** `buildEnvToken` が既存より小さい `order` を
        // 選ぶので、振り直しが要らない（振り直すと全行の `updatedAt` が動く）。
        await stores.tokens.replace([row, ...tokens]);
        return {
          kind: 'added' as const,
          tokenId: row.id,
          why: '器の環境変数を指す行をプールへ足した（枠に当たったときに記録が残るようになる）',
        };
      }),

    // **同じ列を通す。** 引き取りと観測が並ぶと、撒き直しの途中に回転が割り込んで
    // 「古い方を後から撒く」が起きる。
    restore: () =>
      serial(async () => {
        const [tokens, active] = await Promise.all([
          stores.tokens.list(),
          stores.tokens.readActive(),
        ]);

        if (active === null) {
          return {
            kind: 'none' as const,
            why: 'まだ一度も回していない（器の環境変数がそのまま効く）',
          };
        }

        const row = tokens.find((token) => token.id === active.tokenId);
        if (row === undefined) {
          // **記憶ストアへ書いて直さない。** 次の当たりで回し手が正しい候補へ移る
          // ので、ここで消すのは「見えなくする」だけの操作になる。
          return {
            kind: 'dangling' as const,
            tokenId: active.tokenId,
            why: '現役として記録された行がプールに無い（人間が消した）。器の環境変数が効いたままである',
          };
        }

        const availability = tokenAvailabilityAt(row, now().getTime());
        if (availability === 'disabled' || availability === 'invalidated') {
          // **人間が外したものを起動時に戻さない。**
          return {
            kind: 'withheld' as const,
            tokenId: row.id,
            label: row.label,
            why:
              availability === 'disabled'
                ? `現役として記録された「${row.label}」は人間が外している。撒き直さない（器の環境変数が効いたままである）`
                : `現役として記録された「${row.label}」は失効している。撒き直さない（器の環境変数が効いたままである）`,
          };
        }

        const cooling = availability === 'cooling';
        const spreadResults = await spread.spread({
          id: row.id,
          // **保存されていた世代をそのまま渡す。** ここで増やすと、まだ有効な
          // 観測が `stale` として捨てられる。
          generation: active.generation,
          ...credentialOf(row),
        });
        return {
          kind: 'restored' as const,
          tokenId: row.id,
          label: row.label,
          generation: active.generation,
          cooling,
          spread: spreadResults,
          why: cooling
            ? `現役の「${row.label}」を撒き直した。**ただし冷却中である**（次に枠へ当たれば回し手が次の候補へ移す）`
            : `現役の「${row.label}」を撒き直した`,
        };
      }),

    observe: (observation: TokenRotatorObservation) =>
      serial(async () => {
        const [tokens, settings, active] = await Promise.all([
          stores.tokens.list(),
          stores.tokens.readSettings(),
          stores.tokens.readActive(),
        ]);

        const freshness = observationFreshness(active, observation.observedBy ?? {});
        const decision = decideTokenRotation(settings.rotateOn, observation);

        // **遅れて届いた通知は、判定より先に捨てる。** 判定が「回す」でも、
        // それは*前の現役*についての話である。
        //
        // **⚠️ ここは冷却を書く処理（下の `coolDown`）より手前で `return` する。**
        // ⟹ 捨てた回は**記録に何も残らない** —— 実運用で「記録は `ready`、実際は
        // 429」の状態が観測されている（2026-09-07。走行中の alteroid の日誌）。
        // **追跡は #667。** いまは `reconsider` が枠の probe（5分ごと）の判定で
        // 記録が `ready` でも冷却を書けるので塞がっているが、**そのぶん復帰の下限が
        // 目盛りの60秒ではなく5分になる**（`apps/daemon/src/token-watch.ts` の doc）。
        // **捨てる判断そのものを変えるときは、あちらを一緒に読むこと。**
        if (freshness === 'stale') {
          // **捨てた回数を数える。捨てる判断そのものは変えない。** ここで足して
          // いるのは「その判断が何回効いたか」だけである（{@link staleRun}）。
          const key = active === null ? 'none' : `${active.tokenId}#${String(active.generation)}`;
          staleRun = staleRun?.key === key ? { key, count: staleRun.count + 1 } : { key, count: 1 };
          return {
            kind: 'ignored' as const,
            signal: decision.signal,
            freshness,
            staleRun: staleRun.count,
            why: 'もう回した後の通知（世代が合わない）',
          };
        }

        if (!decision.rotate) {
          return {
            kind: 'ignored' as const,
            signal: decision.signal,
            freshness,
            why: decision.why,
          };
        }

        // **プールが空なら何もしない。** 器の環境変数1本きりの既定の構成が
        // ここへ来ても、記録も撒きも起こらない（受け入れ基準7）。
        if (tokens.length === 0) {
          return {
            kind: 'exhausted' as const,
            signal: decision.signal,
            freshness,
            why: 'プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）',
          };
        }

        // 降りるトークン。**まだ指名していなければ、降りるものは無い**——
        // その場合は冷却へ入れる相手も居ないので、選ぶだけになる。
        const outgoingId = active?.tokenId;
        const afterCoolDown =
          outgoingId === undefined
            ? tokens
            : await coolDown(tokens, outgoingId, settings, observation);

        const sweep = await sweepCandidates(
          afterCoolDown,
          outgoingId === undefined ? [] : [outgoingId],
          settings,
        );
        return finishSweep({
          sweep,
          active,
          ...(outgoingId === undefined ? {} : { outgoingId }),
          signal: decision.signal,
          freshness,
          whyHead: decision.why,
        });
      }),

    reconsider: (input: {
      reason: TokenReconsiderReason;
      currentVerdict?: TokenCandidateVerdict;
    }) =>
      serial(async () => {
        const { reason, currentVerdict } = input;
        const [tokens, settings, active] = await Promise.all([
          stores.tokens.list(),
          stores.tokens.readSettings(),
          stores.tokens.readActive(),
        ]);

        // **プールが空なら何もしない**（受け入れ基準7。既定の構成を1文字も変えない）。
        // **`exhausted` にしない** —— あちらは「全層が止まる」の顔で、ここは
        // 何も起きていない（`observe` の同じ分岐が `exhausted` なのは、**枠に
        // 当たったという観測が既に在る**からである。こちらには無い）。
        if (tokens.length === 0) {
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: 'プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）',
          };
        }

        /**
         * いまの現役の行。
         *
         * **指名が無ければ、器の環境変数の行が de facto の現役である。** そこを
         * 「現役が居ない」と読むと、**既定の構成から1度も回っていない器では
         * 永久に何も起きない** —— 器の環境変数のトークンが冷却へ入っていても
         * （probe が `unusable` を返した回など）、見る相手が居ないことになる。
         *
         * **`isEnvToken` の行が無ければ `undefined` である。** 埋めない ——
         * 「いま何が走っているのか記録から言えない」は、それ自体が答えである。
         */
        const currentId = active?.tokenId ?? tokens.find(isEnvToken)?.id;
        const currentRow =
          currentId === undefined ? undefined : tokens.find((token) => token.id === currentId);

        if (currentId === undefined) {
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: 'まだ一度も指名しておらず、器の環境変数を指す行も無い（いま何が走っているのか記録から言えないので、状態からは決めない）',
          };
        }

        /**
         * **現役を probe で観測できていて、それが「通る」だったとき。**
         *
         * 止まった記録が残っていれば消す（`markTokenUsable`）。**冷却が既定の
         * 5時間で入っていて、実際には枠がもっと早く開いていた回がここで直る** ——
         * 消さないと、その鍵は「使えるのに候補から外れている」状態で残り続け、
         * **`selectNextToken` は在るのに見えない候補を数え落とす。**
         *
         * **人間が外した印（`disabledAt`）と失効（`invalidatedAt`）には触らない。**
         * あれは枠の話ではなく人間の判断なので、probe が通ったことを理由に
         * 覆すのは「実装が人間の判断を黙って戻す」ことである。
         */
        if (currentVerdict?.verdict === 'usable' && currentRow !== undefined) {
          const availability = tokenAvailabilityAt(currentRow, now().getTime());
          const hasRejection =
            currentRow.lastRejectedAt !== undefined || currentRow.cooldownUntil !== undefined;
          if (hasRejection && availability !== 'disabled' && availability !== 'invalidated') {
            await stores.tokens.replace(
              tokens.map((token) =>
                token.id === currentRow.id ? markTokenUsable(token, now().toISOString()) : token,
              ),
            );
            return {
              kind: 'ignored' as const,
              signal: 'none' as const,
              reason,
              // **「いつ開いたか」を記録に残す材料を返す**（`recovered` の doc）。
              recovered: { tokenId: currentRow.id, label: currentRow.label },
              why: `現役「${currentRow.label}」は probe で通ることを観測できた（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）`,
            };
          }
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: `現役「${currentRow.label}」は probe で通ることを観測できた（回す契機が無い）`,
          };
        }

        /**
         * **現役をこの回に probe して「通らない」と分かったとき。**
         *
         * **記録が `ready` でも冷却へ入れる。** ここが「観測がどこからも上がらない
         * まま止まり続ける」を塞ぐ本体である —— セッションが1本も走っていなければ
         * `observe` の6つの検知点はどれも鳴らないが、**この probe はセッションを
         * 1本も使わない**（`usage-probe.ts` はプロンプトを送らない）。
         *
         * **文言は probe が返したものをそのまま入れる**（言い換えない。
         * `TokenFailureObservation.message` の規律）。
         */
        let pool = tokens;
        let blockedByProbe = false;
        if (currentVerdict?.verdict === 'unusable' && currentRow !== undefined) {
          const at = now().toISOString();
          pool = await stores.tokens.replace(
            tokens.map((token) =>
              token.id === currentRow.id
                ? markTokenUnusable(token, {
                    at,
                    message: currentVerdict.reason,
                    ...(currentVerdict.retryAt === undefined
                      ? {}
                      : { resetsAt: currentVerdict.retryAt }),
                    fallbackCooldownMs: settings.cooldownMs,
                  })
                : token,
            ),
          );
          blockedByProbe = true;
        }

        const row = pool.find((token) => token.id === currentId);
        /**
         * 記録の上でいまの現役が通るか。**指名の先の行が消えていたら通らない側で
         * ある**（`dangling`）—— 撒く値そのものが取れないので、次のセッションは
         * 器の環境変数で走る。`restore()` はそれを直さないと決めているが、
         * **通る候補が在るならここで移してよい**（あちらは「起動時に人間の判断を
         * 覆さない」の話で、これは「通る鍵へ移す」の話である）。
         */
        const availability =
          row === undefined ? 'dangling' : tokenAvailabilityAt(row, now().getTime());

        if (availability === 'ready') {
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: `記録の上ではいまの現役「${row?.label ?? currentId}」が通る（回す契機が無い。健全な鍵から勝手に移らない）`,
          };
        }

        /**
         * ここから先は「現役が通らない」が確定している。**印は `stranded` である**
         * —— 枠の観測ではなく、記録（と probe）からそう言っている
         * （`TokenRotationSignal` の `stranded` の doc）。
         */
        const stranded =
          availability === 'dangling'
            ? `現役として記録された id（${currentId}）の行がプールに無い`
            : blockedByProbe
              ? `現役「${row?.label ?? currentId}」は probe で通らないことを観測した（${currentVerdict?.verdict === 'unusable' ? currentVerdict.reason : ''}）`
              : `記録の上でいまの現役「${row?.label ?? currentId}」は通らない（${availability}）`;

        // **人間が自動を切っている。記録はするが回さない**（`observe` と同じ扱い）。
        if (settings.rotateOn === 'off') {
          return {
            kind: 'ignored' as const,
            signal: 'stranded' as const,
            reason,
            why: `${stranded}。回す契機の設定が off なので回さない（記録だけする）`,
          };
        }

        const sweep = await sweepCandidates(pool, [currentId], settings);
        return finishSweep({
          sweep,
          active,
          // **降りるのは「指名されていた側」だけである。** 指名が無い（＝器の
          // 環境変数で走っていた）ときに `fromTokenId` を名乗ると、**回したことの
          // ない鍵から回ったことになる。**
          ...(active === null ? {} : { outgoingId: active.tokenId }),
          signal: 'stranded' as const,
          reason,
          whyHead: stranded,
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// 日誌へ出す（Issue #393 PR5）
// ---------------------------------------------------------------------------

/**
 * 撒いた先の結果を1行に畳む。**失敗した先を落とさない。**
 *
 * 「2台のうち1台だけ落ちた」を消さないために、**成功だけを数えて `2/3` のように
 * 書かない** —— どれが落ちたのかが読めなくなる。落ちた先は名前と理由をそのまま出す。
 */
function describeSpread(results: readonly TokenSpreadResult[]): string {
  if (results.length === 0) return '撒いた先: 無し';
  const failed = results.filter((result) => !result.ok);
  const ok = results.filter((result) => result.ok).map((result) => result.target);
  const parts: string[] = [];
  if (ok.length > 0) parts.push(`置けた: ${ok.join(', ')}`);
  for (const result of failed) {
    parts.push(`**置けなかった: ${result.target}**（${result.error ?? '理由不明'}）`);
  }
  return parts.join(' / ');
}

/**
 * 回した / 回せなかった結果を、日誌の1行にする。**出さないときは `null`。**
 *
 * ## 何を出さないか
 *
 * - **世代が合わない通知（`stale`）の2件目以降** —— 同じ当たりでマネージャーの数だけ
 *   届くので、全件出すと1回の当たりで日誌が何行も埋まる。**間引いて出す**——
 *   初出と、以降は10の冪（10件目・100件目…）だけ。数は `staleRun` が運ぶ
 *
 *   **⚠️ かつてここは1件も出していなかった。それをやめた理由を残す。**
 *   `stale` は「本物の当たりを飲み込む」側の倒し方で、しかも
 *   {@link observationFreshness} の doc 自身が「**見えない**（何も起きないので）」と
 *   書いている。**実際に見えなくなった**——2026-08-25T22:03Z からの2時間40分、
 *   マネージャー層が全滅しているあいだ日誌は0件で、**観測が回し手へ届かなかったのか、
 *   届いて `stale` で捨てられたのかを、後から誰も言えなかった。** 間引きは
 *   「埋まる」を避けるためのもので、**0件にすることは、その2つを見分ける手段を
 *   捨てることだった**
 * - **`signal` が `none`（回す材料が何も無い観測）** —— 毎ターン届く `rate_limit_event`
 *   がここへ落ちるので、出すと日誌が枠の状態で埋まる
 *
 * **⚠️ それ以外は出す。** 「回さないと決めた」も記録である（受け入れ基準8:
 * 回した事実・回せなかった事実が日誌に残る）——設定が `off` のあいだに何回止まったか、
 * `org_policy` で何回見送ったかは、後から効いてくる。
 *
 * ## 値を出さない
 *
 * {@link TokenRotationOutcome} は**そもそも値を持たない型**なので、ここで書き
 * 忘れる余地が無い。出るのは `label` と `id` と、SDK が出した文言だけである。
 *
 * ## 文言はそのまま
 *
 * 当たった文言は呼ぶ側が `notice.text` として添える。**言い換えないこと**
 * （Issue #393「当たった文言は言い換えずそのまま残す」）——人間が claude.ai と
 * 突き合わせられる形であることと、`limitRecoveryOf` の分類が効くことの両方が
 * ここに乗っている。
 */
/**
 * 間引いて出す位置か。**初出（1件目）と、以降は10の冪だけ。**
 *
 * **件数で上限を切らない**（`AGENTS.md` の地雷「一覧の上限を件数だけで決める」と
 * 同じ向き）——上限だと、越えた先が丸ごと見えなくなる。10の冪なら**桁が上がる
 * たびに1行出る**ので、「まだ続いている」ことと「どれくらい続いたか」が両方残る。
 *
 * **落としたことは出力に書く**（呼ぶ側が「これは連番ではない」と添える）。
 * 黙って間引くと、読み手には全件出ているように見える。
 */
function isThinnedMilestone(count: number): boolean {
  if (count === 1) return true;
  if (count < 10) return false;
  // 10 / 100 / 1000 … だけ。**浮動小数の対数を使わない**（`Math.log10(1000)` が
  // 2.9999… になる器が在り、桁が上がった回だけ静かに出なくなる）。
  for (let milestone = 10; milestone <= count; milestone *= 10) {
    if (milestone === count) return true;
  }
  return false;
}

export function describeTokenRotation(
  outcome: TokenRotationOutcome,
  observed?: { noticeText?: string },
): string | null {
  const tail = observed?.noticeText === undefined ? '' : `\n当たった文言: ${observed.noticeText}`;

  if (outcome.kind === 'ignored') {
    if (outcome.freshness === 'stale') {
      const run = outcome.staleRun;
      // **数が無ければ出さない**（この分岐へ数を付けない呼び方が在れば、そちらは
      // 従来どおり黙る）。**数を 1 で埋めない**——埋めると「初出」が捏造される。
      if (run === undefined || !isThinnedMilestone(run)) return null;
      return (
        `認証トークン: 回さなかった（${outcome.signal}）。${outcome.why}。` +
        `いまの現役に対して${String(run)}件目である（**捨てた側の計器**。` +
        '初出と10の冪だけ出しているので、これは連番ではない)' +
        tail
      );
    }
    // **回復は `signal: 'none'` でも出す。** 「また通るようになった」は、
    // 止まっていたあいだの記録と対になる**唯一の行**である —— これが出ないと、
    // 日誌には「止まった」しか残らず、**いつ開いたかを後から誰も言えない。**
    if (outcome.recovered !== undefined) {
      return (
        `認証トークン: **止まっていた現役が、また通ることを観測できた**` +
        `（id ${outcome.recovered.tokenId} / 「${outcome.recovered.label}」）。${outcome.why}\n` +
        '**回してはいない** — 鍵は1文字も変わっていない。消したのは止まった記録だけである' +
        tail
      );
    }
    if (outcome.signal === 'none') return null;
    return `認証トークン: 回さなかった（${outcome.signal}）。${outcome.why}${tail}`;
  }

  if (outcome.kind === 'exhausted') {
    // **打ち切ったときに「戻る見込みが1本も無い」と言わない。** 既定の文言は
    // 「試し切って、どれも戻る見込みが無かった」を意味する —— 持ち時間で
    // 打ち切った回にそれを出すと、**まだ試していない候補が在るのに「1本も無い」と
    // 言う**ことになる（`stoppedBy` の doc）。
    const earliest =
      outcome.stoppedBy === 'budget'
        ? '**まだ試していない候補が残っている**（戻る見込みは測っていない）'
        : outcome.earliest === undefined
          ? '**戻る見込みの立っている候補が1本も無い**'
          : `いちばん早く戻るのは「${outcome.earliest.label}」（${new Date(outcome.earliest.cooldownUntil).toISOString()}）`;
    return `認証トークン: **回せなかった**（${outcome.signal}）。${outcome.why}。${earliest}${tail}`;
  }

  const from = outcome.fromTokenId === undefined ? '（指名なし）' : outcome.fromTokenId;

  if (outcome.kind === 'parked') {
    return (
      `認証トークン: **いま通る鍵は無い。いちばん早く戻る鍵を撒いて待つ**` +
      `（${outcome.signal} / 世代 ${String(outcome.generation)}）。` +
      `${from} → 「${outcome.label}」（id ${outcome.tokenId}）。${outcome.why}\n` +
      `${describeSpread(outcome.spread)}\n` +
      // **「回った」と読ませない。** 撒いた鍵はまだ通らない。
      `**⚠️ この鍵は ${new Date(outcome.cooldownUntil).toISOString()} まで通らない** — ` +
      'それまでのターンは失敗する。撒いてあるのは「開いた瞬間にそのまま通る」ため' +
      `である（回し手をもう一度通らずに復帰する）${tail}`
    );
  }

  return (
    `認証トークン: **回した**（${outcome.signal} / 世代 ${String(outcome.generation)}）。` +
    `${from} → 「${outcome.toLabel}」（id ${outcome.toTokenId}）。${outcome.why}\n` +
    `${describeSpread(outcome.spread)}\n` +
    '**⚠️ 撒いたのであって、回ったのではない** — 走行中のセッションには届かない。' +
    `回ったことの証拠は次のターンが成功することだけである${tail}`
  );
}

/**
 * 起動時の引き取りを、日誌の1行にする。**出さないときは `null`。**
 *
 * **`none`（一度も回していない）は出さない。** 既定の構成では毎回の起動で出る
 * ことになり、意味のある行が埋もれる。
 */
export function describeTokenRestore(outcome: TokenRestoreOutcome): string | null {
  if (outcome.kind === 'none') return null;
  if (outcome.kind === 'restored') {
    return (
      `認証トークン: 起動時に現役を撒き直した（世代 ${String(outcome.generation)}、増やしていない）。` +
      `「${outcome.label}」（id ${outcome.tokenId}）${outcome.cooling ? '。**冷却中である**' : ''}\n` +
      describeSpread(outcome.spread)
    );
  }
  return `認証トークン: 起動時に撒き直せなかった。${outcome.why}`;
}

/**
 * 認証トークンの日誌エントリ（追記の入力の形）。
 *
 * **`JournalEntryInput` をそのまま返さない。** あちらは全種別の union なので、
 * 呼ぶ側が `entry.text` を読めない（`text` を持たない種別が混ざっている）。
 * stderr へ出す1行はこの `text` そのものなので、**union へ広げると呼ぶ側が
 * 文言を自分で組み直すことになり、日誌と stderr で言い方が分かれる。**
 */
export type TokenRotationEntry = Extract<JournalEntryInput, { type: 'token_rotation' }>;

/**
 * 回した / 回さなかったを**日誌の1件**にする。**出さないときは `null`。**
 *
 * **出す・出さないの判定は {@link describeTokenRotation} 1つに任せる。** ここで
 * もう一度書くと、stderr には出るのに日誌には出ない（あるいは逆）という食い違いが
 * 静かに生まれる —— そして「出なかった」は、出ていないので気づけない。
 *
 * **`exchange` ではなく専用の種別を使う理由**は `schema.ts` の `token_rotation` の
 * doc に在る（`exchange` は53箇所が書く雑多入れで、絞る先が無い）。
 */
export function tokenRotationEntry(
  outcome: TokenRotationOutcome,
  observed?: { noticeText?: string },
): TokenRotationEntry | null {
  const text = describeTokenRotation(outcome, observed);
  if (text === null) return null;
  const common = {
    type: 'token_rotation' as const,
    signal: outcome.signal,
    // **無いものを埋めない。** 状態から決めた判定には照合する観測が無いので、
    // `freshness` は付かない（`TokenRotationOutcome` の doc）。`unknown` で埋めると
    // 「身元を運べない観測が届いた」という別の事実になる。
    ...(outcome.freshness === undefined ? {} : { freshness: outcome.freshness }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(observed?.noticeText === undefined ? {} : { noticeText: observed.noticeText }),
    text,
  };
  if (outcome.kind === 'rotated') {
    return {
      ...common,
      event: 'rotated',
      tokenId: outcome.toTokenId,
      label: outcome.toLabel,
      ...(outcome.fromTokenId === undefined ? {} : { fromTokenId: outcome.fromTokenId }),
      generation: outcome.generation,
    };
  }
  if (outcome.kind === 'parked') {
    return {
      ...common,
      event: 'parked',
      tokenId: outcome.tokenId,
      label: outcome.label,
      ...(outcome.fromTokenId === undefined ? {} : { fromTokenId: outcome.fromTokenId }),
      generation: outcome.generation,
      // **`earliestAt` に入れる。** これは「撒いた鍵が通るようになる時刻」で、
      // `exhausted` の同じ欄（「いちばん早く戻る候補の時刻」）と**同じ意味である**
      // ——`parked` はまさにその候補を撒いた回だからである。
      earliestAt: new Date(outcome.cooldownUntil).toISOString(),
    };
  }
  if (outcome.kind === 'exhausted') {
    return {
      ...common,
      // **打ち切りを `exhausted` と名乗らせない。** `exhausted` は「候補が無い ＝
      // 全層が止まる」で、`earliestAt` が無ければ「戻る見込みの立つ候補が1本も無い」
      // を意味する（`schema.ts` の doc）。**打ち切った回は候補がまだ残っている。**
      event: outcome.stoppedBy === 'budget' ? 'sweep_stopped' : 'exhausted',
      // **無いことを埋めない。** 「戻る見込みの立っている候補が1本も無い」と
      // 「すぐ戻る」を同じ形にしない（`earliest` の doc）。
      ...(outcome.earliest === undefined
        ? {}
        : {
            tokenId: outcome.earliest.tokenId,
            label: outcome.earliest.label,
            earliestAt: new Date(outcome.earliest.cooldownUntil).toISOString(),
          }),
    };
  }
  if (outcome.kind === 'ignored' && outcome.recovered !== undefined) {
    // **`not_rotated` へ潰さない**（`schema.ts` の `token_rotation.event` の doc）。
    // 止まった側と対になる唯一の行なので、絞って引ける形で残す。
    return {
      ...common,
      event: 'recovered',
      tokenId: outcome.recovered.tokenId,
      label: outcome.recovered.label,
    };
  }
  return { ...common, event: 'not_rotated' };
}

/**
 * 起動時の引き取りを**日誌の1件**にする。**出さないときは `null`。**
 *
 * 判定を {@link describeTokenRestore} に任せる理由は {@link tokenRotationEntry} と
 * 同じである。
 */
export function tokenRestoreEntry(outcome: TokenRestoreOutcome): TokenRotationEntry | null {
  const text = describeTokenRestore(outcome);
  if (text === null) return null;
  if (outcome.kind === 'restored') {
    return {
      type: 'token_rotation',
      event: 'restored',
      tokenId: outcome.tokenId,
      label: outcome.label,
      // **増えていない**（引き取りは回転ではない。`TokenRestoreOutcome` の doc）。
      generation: outcome.generation,
      text,
    };
  }
  // `dangling` / `withheld` / `failed`。**`tokenId` は在れば載せる** —— どの指名が
  // 撒けなかったのかは、次に何を確かめるかを決める材料である。
  return {
    type: 'token_rotation',
    event: 'restore_failed',
    ...('tokenId' in outcome ? { tokenId: outcome.tokenId } : {}),
    ...('label' in outcome ? { label: outcome.label } : {}),
    text,
  };
}
