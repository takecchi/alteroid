import type { TurnInputText } from './turn-input.js';

/**
 * `Clone`（`clone.ts`）が持っていた**通知8フィールド**を、独立の単位として
 * 切り出したもの（Issue #1190）。
 *
 * ## 何を持っているか
 *
 * - **1反復ぶんの断り書き6本**（{@link TurnNoticeKey}）——`redelivery` /
 *   `superseded` / `validity` / `mergedBatchTruncation` / `commitment` /
 *   `situation`。`Clone#pump` が受信箱の束を決めた直後に {@link CloneNotices.set}
 *   で1本ずつ代入し、`Clone#runTurn` が {@link CloneNotices.forTurn} で読んで
 *   `composeTurnInputText`（`turn-input.ts`）へ渡し、同じ反復の `finally` で
 *   {@link CloneNotices.clearTurn} が6本まとめて空文字へ戻す。**寿命は「1回の
 *   受信箱の反復」** である（`turn-input.ts` の `composeTurnInputText` の doc が
 *   言う「1反復ぶんの控え」）。
 * - **畳み込みの記憶2本**——会話ごとに「最後に人間へ返した1行」を覚える
 *   人間向け失敗通知（`Clone#post` と `Clone#endConversation` が
 *   {@link CloneNotices.forgetConversation} で忘れさせ、`Clone#reportFailure` が
 *   {@link CloneNotices.foldHumanFailure} で畳む）と、`kind` ごとに「最後に
 *   日誌へ書いた上限の文言」を覚える利用上限の通知（`Clone#noteUsageNotice` が
 *   {@link CloneNotices.noteUsage} で畳む）。**こちらは会話・`kind` をまたいで
 *   `Clone` のセッションが生きている間ずっと残る**——1反復では戻らない。
 *
 * ## なぜ切り出したか（Issue #1190）
 *
 * **⚠️ この節を読まずに「無駄な間接層だ」と思って `Clone` へ戻さないこと。**
 * 効果にも限界にも実測があり、以下の3点を読めば分かる。出典は Issue #1190 の
 * コメント（2026-09-22 の測り直し。それ以前の値はこの2本で置き換わっている）:
 *
 * - <https://github.com/takecchi/alteroid/issues/1190#issuecomment-5778423093>
 * - <https://github.com/takecchi/alteroid/issues/1190#issuecomment-5778651031>
 *
 * 1. **切り出しの効果の根拠は過去 PR の測定であり、「レビューが楽になった」は
 *    測れていない。** 測ったのは、直近のマージ済み PR 70本のうち、この8
 *    フィールドを独立の単位として切れば55本が「通知の状態を一切読まずに」
 *    レビューできるようになる、という数字である（confinement rate 80.0%、
 *    無作為に選んだ同じ活動量の群は32.9%、p=0.0002、4つの定義すべてで有意）。
 *    **これは静的参照からの代理指標であって、実際のレビューで人が何を読んだかは
 *    記録されていない。** confinement rate が上がっても「レビューが楽になった」
 *    とは測れていない——測ったのは「読む範囲が片側に収まった回数」だけである。
 * 2. **通知8本のうち7本が5〜6群を跨ぎ、通知だけを触るメンバーは0本である
 *    ⟹「通知は構造的に孤立しているから切れる」とは言えない。** `Clone` の
 *    91フィールドを群分けし（群の割り当ては Issue の測定者の判定）、各フィールドを
 *    触るメンバーが同じメンバーの中で一緒に触る他群の数を数えた実測
 *    （切り出し直前の `main` = `50ea415` で測り直した）: 断り書き5本
 *    （`redelivery` / `commitment` / `situation` / `superseded` /
 *    `validity`）と人間向け失敗通知が各5群、`mergedBatchTruncation` が6群。
 *    跨がないのは利用上限の畳み込み（1群）だけである。そして通知を触る
 *    メンバー7本のうち、**通知だけを触るものは0本**である。⚠️ Issue の要約は
 *    「6本」と書いていたが、同じ表の人間向け失敗通知（5群）が数え落ちていた。**切る根拠は構造的な孤立ではなく、
 *    上の1点が測った価値の軸だけである。構造の側は、むしろ「跨いでいる」と
 *    言っている。** ⟹ この切り出しの実体は「疎結合な部分を剥がす」案ではなく、
 *    「暗黙の参照（`this.#redeliveryNotice` 等への直接アクセス）を、明示の
 *    メソッド呼び出し（`this.#notices.set(...)` / `.forTurn()`）に変える」案
 *    である。
 * 3. **テストの分離は買えない。** `clone.test.ts`（測定当時 16,233行・428ブロック）は
 *    切り出しの前後で一体のまま動き続ける——通知固有の連動は測られておらず
 *    （p=0.68）、この切り出しで読み直しが要ったブロックは428本中7本だけだった
 *    （コードからの参照は0件）。**「テストが分割される」ことをこの切り出しの
 *    効果に数えない。**
 *
 * **挙動は1ビットも変えていない。** PR #1244（`composeTurnInputText` を
 * `turn-input.ts` の純粋関数へ出した抽出。Issue #1190 の最初の1歩を名乗る）と
 * 同じ性質の変更で、出力・代入の時点と順序・エラーの倒れ先はすべて `Clone` に
 * 在ったときのままである。変わったのは「どこに書いてあるか」だけである。
 */
export class CloneNotices {
  readonly #turn: Record<TurnNoticeKey, string> = {
    redelivery: '',
    superseded: '',
    validity: '',
    mergedBatchTruncation: '',
    commitment: '',
    situation: '',
  };

  /**
   * 会話ごとに、**最後に人間へ返した1行**（`Clone#reportFailure` の
   * `with: 'human'`）と、そのあと同じ1行を何件畳んだか。
   *
   * ## 何が壊れていたか（人間の報告: 「定期的に積み上がり続ける」）
   *
   * 枠（利用上限）が閉じている間、**保持した発言は新しい合図が届くたびに
   * 試し直される**（`Clone#usageBlocked` の doc。誰も話しかけなければ
   * `self_initiative` が既定間隔ごとに試す）。試し直しは毎回同じ理由で落ちるので、
   * `Clone#reportFailure` は同じ会話へ**一字一句同じ1行**を書き足す。⟹ 人間が
   * 何もしなくても、会話の画面が「いま利用上限に当たっているので…」だけで
   * 埋まっていく。
   *
   * 実測の形（`clone.test.ts` の「枠が閉じている間に届いた2本目は…」）: 発言2本を
   * 保持しているだけで、tick 1回につき2行増える。**枠が開くまで止まらない。**
   *
   * ## 畳む単位は「人間からの新しい発言」である
   *
   * 消してよいのは**繰り返し**だけで、**新しい発言への返事**は消してはいけない
   * （#92 が塞いだ「自分の発言だけがあって返信が無い」へ戻る）。だから
   * `Clone#post` が人間の発言を受理した時点でこの記憶を落とす（その会話のぶんだけ、
   * {@link CloneNotices.forgetConversation}）。⟹ **人間の発言1件につき、必ず
   * 1行返る。試し直しでは増えない。**
   *
   * **判定は「最後に返した1行と文字列が同じか」だけである。** 文言が変わる
   * （長さにも当たった・次の境界で畳む、などの断りが付く／消える）なら、それは
   * 人間が知らない新しい事実なので畳まない。
   *
   * ## 畳んだことは日誌に残す（`with: 'self'`）
   *
   * 畳みすぎ＝黙って失う、はこのリポジトリが何度も踏んでいる型なので、**畳んだ
   * 回は1件ずつ日誌に残し、何件目かも書く**（{@link CloneNotices.noteUsage} と
   * 同じ形）。失敗そのものの記録（`with: 'self'` の `Clone#reportFailure` 前半）
   * は**畳まない**——あちらは全件そのまま残る。⟹ 何回試して落ちたかは日誌から
   * 数えられる。
   */
  readonly #humanFailure = new Map<string, { text: string; folded: number }>();

  /**
   * 種類（`kind`）ごとに最後に日誌へ書いた上限の文言。
   *
   * **同じ知らせで日誌を埋めないためにある。** `reached` は一度立てば `Clone#pump`
   * がターンを回さなくなるので `rate_limit_event` はもう来ないが、`transition`
   * / `warning` はまだ動く分類なのでターンが回り続け、`system` 通知が毎ターン
   * 届く（`usage-limits.ts` の `usageTransitionOf` の doc「毎ターン届く同じ
   * 事実で受信箱を埋めないこと」と同じ理由）。畳まなければ日誌が同じ文言で
   * 埋まり、本当に変わった1回が埋もれる。
   *
   * **`manager.ts` の `Pool#usageNotices` を写して作った**（マネージャー側に
   * あってクローン側に無いのは非対称だった）。**ただし、あちらはもう同じ形では
   * ない。** あちらは「最後に見た文言」1つではなく「配った文言の集合」を覚える
   * 形へ変えてある——同じ種類で文言が2通り交互に届くと `!==` が毎回「違う」と
   * 答え、配達のたびに**クローンのターンが1本焼かれる**からである（`manager.ts`
   * の `Pool#usageNotices` の doc）。**ここを揃えていないのは、畳んでいる先が
   * 違うためである**——こちらが畳むのは日誌への書き込みだけで、交互の文言で
   * 起きるのは日誌の行が増えることだけ（ターンは焼かれない）。**揃えたくなったら、
   * まず「こちらでも配達が焼かれているか」を確かめること。**
   *
   * 畳むのは**日誌への書き込みだけ**にする——`reached` の `Clone#usageBlocked`
   * を立てる処理と `usage_limited` の emit はここでは畳まない
   * （`Clone#noteUsageNotice` 参照）。2件目以降の合図は別の会話から来ているかも
   * しれず、`usage_limited` まで畳むとその送り主に何も見えなくなる。
   */
  readonly #usage = new Map<string, string>();

  /**
   * 1反復ぶんの断り書き6本のうち1本を代入する。
   *
   * **代入の時点と順序は呼び出し側（`Clone#pump`）が持つ。** ここは値を保持
   * するだけで、いつ・どの順で呼ぶかについては何も強制しない——6本は `await`
   * を挟んで1本ずつ代入されることがあり（各断り書きの組み立てが非同期のため）、
   * その途中で別の経路が走ることが挙動として許されている。この関数を「複数の
   * 断り書きをまとめて渡す」形に変えると、その途中状態の見え方が変わる。
   */
  set(key: TurnNoticeKey, text: string): void {
    this.#turn[key] = text;
  }

  /**
   * 1反復ぶんの断り書き6本を、`composeTurnInputText`（`turn-input.ts`）へ
   * そのまま展開して渡すための形で返す。
   *
   * **並び順はここでは決めない。** `composeTurnInputText` が `TurnInputText`
   * のプロパティ名で読むので、この関数がオブジェクトのキーをどの順で並べて
   * 返しても結果は変わらない——並び順の規則は `turn-input.ts` 側の関心である
   * （同ファイルの「規則が違うものを同じ場所に置かない」）。
   */
  forTurn(): Pick<TurnInputText, TurnNoticeKey> {
    return { ...this.#turn };
  }

  /**
   * 1反復ぶんの断り書き6本を、まとめて空文字へ戻す。
   *
   * **同期で6本を書き換えるだけなので、6行を1行にまとめても挙動は変わらない**
   * （間に `await` を挟まない代入は、まとめても1本ずつでも観測できる途中状態が
   * 無い）。呼び出し側（`Clone#pump` の `finally`）が「反復の終わりに必ず戻す」
   * ことの意味を持つ——ここは持たない。
   */
  clearTurn(): void {
    for (const key of TURN_NOTICE_KEYS) this.#turn[key] = '';
  }

  /**
   * 会話 `conversationId` へ返す1行 `text` を、直前に返した1行と比べて畳む。
   *
   * - **直前と同じ文字列なら**、畳んだ件数（1以上）を進めて返す
   *   （呼び出し側はこれを「畳んだ」として `with: 'self'` の日誌へ書く）。
   * - **直前と違う・初めての会話なら**、`folded: 0` で新しく記録し、`null` を
   *   返す（呼び出し側はこれを「新しい1行」として `with: 'human'` の日誌へ
   *   書く）。
   *
   * 判定と記憶の更新は同期で1つの操作として起きる——呼び出し側が `get` して
   * から自分で `set` し直す必要はない（`#humanFailure` の doc の「判定は
   * 『最後に返した1行と文字列が同じか』だけである」をこの1メソッドへ閉じる）。
   */
  foldHumanFailure(conversationId: string, text: string): number | null {
    const said = this.#humanFailure.get(conversationId);
    if (said !== undefined && said.text === text) {
      const folded = said.folded + 1;
      this.#humanFailure.set(conversationId, { text, folded });
      return folded;
    }
    this.#humanFailure.set(conversationId, { text, folded: 0 });
    return null;
  }

  /**
   * ある会話について畳み込みの記憶を落とす（`#humanFailure` の doc）。
   *
   * **落とすのはその会話のぶんだけである。** 会話をまたいで消すと、別の会話で
   * 既に返してある1行の記憶が消え、そちらの試し直しでまた1行増える
   * （`Clone#post` / `Clone#endConversation` の呼び出し側の doc に同じ注記が
   * ある）。
   */
  forgetConversation(conversationId: string): void {
    this.#humanFailure.delete(conversationId);
  }

  /**
   * `kind` の通知が、前回日誌へ書いた文言と違えば記録して `true` を返す
   * （＝呼び出し側は日誌へ書く）。同じなら記録を変えずに `false` を返す
   * （＝呼び出し側は畳んで書かない）。
   *
   * `#usage` の doc の「同じ知らせで日誌を埋めないためにある」をこの1メソッドへ
   * 閉じる——`reached` の `Clone#usageBlocked` を立てる処理・`usage_limited` の
   * emit は畳まないので、この関数の戻り値で分岐させるのは日誌への書き込みだけに
   * すること。
   */
  noteUsage(kind: string, text: string): boolean {
    if (this.#usage.get(kind) !== text) {
      this.#usage.set(kind, text);
      return true;
    }
    return false;
  }
}

/**
 * 1反復ぶんの断り書き6本のキー。`turn-input.ts` の `TurnInputText` のうち、
 * 「1反復ぶんの控え」に属する6本（`distillGap` / `contextWindowFold` の
 * **消費する読み**2本と、`body` を除く）と同じ名前を使う——並び順の規則は
 * `composeTurnInputText` が持ち、ここは値の器だけを持つ。
 *
 * ## 6本それぞれの理由
 *
 * 元は `clone.ts` の各プライベートフィールド（`#redeliveryNotice` /
 * `#commitmentNotice` / `#situationNotice` / `#supersededNotice` /
 * `#validityNotice` / `#mergedBatchTruncationNotice`）の doc だった。**移設に
 * あたり要約していない**（north_star 禁止2）。
 *
 * ### `redelivery`
 *
 * いま処理している合図が配り直しなら、その断り書き。ターンの本文の先頭に載る。
 *
 * **断り書きを起点ごとに配らない。** プロンプトの組み立ては起点の数だけ
 * （7か所）散っていて、そのうち1か所へ入れ忘れると「二度目だと分からない
 * 配達」がその起点にだけ生まれる。ターンの入口（`Clone#runTurn`）は1か所しか
 * ないので、そこに置けば起点を問わず必ず載る。
 *
 * ### `commitment`
 *
 * いま処理している合図の未了 id と、台帳の全体像。ターンの本文の先頭に載る。
 *
 * **`redelivery` と同じ場所に置く理由も同じである。** プロンプトの組み立ては
 * 起点の数だけ散っていて、どれか1か所へ入れ忘れると「閉じ方の分からない未了」が
 * その起点にだけ生まれる。ターンの入口は1か所しかない。
 *
 * ### `situation`
 *
 * いまの全体（委譲の状態別の本数と、器の台数・state の内訳）。ターンの本文の
 * 先頭に載る。**doc は `situation.ts` が持つ。**
 *
 * **`commitment` と同じ場所に置く理由も同じである**（プロンプトの組み立ては
 * 起点の数だけ散っていて、どれか1か所へ入れ忘れると、その起点にだけ全体の
 * 見えないターンが生まれる。ターンの入口は1か所しかない）。
 *
 * **それでも `#commitmentNoticeFor` には混ぜない。** 材料の器も、読めなかった
 * ときの倒れ先も違う（`situation.ts` 冒頭。`turn-input.ts` の「規則が違うものを
 * 同じ場所に置かない」）。
 *
 * ### `superseded`
 *
 * 「この委譲（マネージャー）から、いま配っているこの合図より後に報告が届いて
 * いる」の断り書き。ターンの本文の先頭に載る（doc の本体は `superseded.ts`）。
 *
 * **`situation` の隣に置く理由も同じである。** プロンプトの組み立ては起点の数
 * だけ（7か所）散っていて、どれか1か所へ入れ忘れると、その起点にだけ「もう
 * 古いかもしれない」と気づけないターンが生まれる。ターンの入口（`Clone#runTurn`）
 * は1か所しかないので、そこに置けば起点を問わず必ず載る。
 *
 * **`redelivery` とは別に持つ。** あちらは「この合図そのものが配り直しか」、
 * こちらは「同じ委譲から後続の報告が来ているか」で、判定の材料も倒れ先も
 * 別物である（`superseded.ts` 冒頭）。
 *
 * ### `validity`
 *
 * **「この合図が名乗った前提が、まだ生きているか」の断り書き**（Issue #879。
 * doc の本体は `inbox-validity.ts`）。
 *
 * **`superseded` とは別に持つ。** あちらは「**同じ委譲から、より新しい報告が
 * 来ているか**」を数え、こちらは「**この報告が積まれた当時の状態が、いまも
 * 同じか**」を見る——鍵も倒れ先も別物である。
 *
 * ### `mergedBatchTruncation`
 *
 * `Clone#drainMergeableWithinLimit` が上限（`#mergedBatchLimit`）で束を打ち切った
 * ときだけの断り書き。ターンの本文の先頭に載る（issue #783 の続き——PR #836
 * が上限そのものは足したが、切った事実がクローンから1文字も見えなかった
 * 欠陥の直し）。
 *
 * **`redelivery` / `superseded` と同じ場所に置く理由も同じである。** まとめ
 * 読みの起点は2つ（`#mergedHumanBatch` / `#mergedManagerReportBatch`）だが、
 * どちらも共通の `#drainMergeableWithinLimit` を経由するので、断り書きも
 * ここへ1本だけ持てば両方に効く。
 *
 * **切っていないときは必ず空文字のまま。** いちばん多い経路（切っていない）の
 * 出力を1文字も変えないための既定値——`describeReopenedTokenNotice` の
 * 「`folded` が0のときは何も足さない」と同じ理由（余計な行をいちばん多い
 * 経路に足さない）。
 *
 * **`Clone#pump` の各反復の先頭で必ずリセットする。** まとめ読みの対象になら
 * ない起点（タイマー・外部イベント・`question`/`permission` 等）では
 * `#drainMergeableWithinLimit` 自体が呼ばれないため、リセットしないと前の
 * 反復の断り書きが誤って持ち越される。
 */
export type TurnNoticeKey =
  'redelivery' | 'superseded' | 'validity' | 'mergedBatchTruncation' | 'commitment' | 'situation';

const TURN_NOTICE_KEYS: readonly TurnNoticeKey[] = [
  'redelivery',
  'superseded',
  'validity',
  'mergedBatchTruncation',
  'commitment',
  'situation',
];
