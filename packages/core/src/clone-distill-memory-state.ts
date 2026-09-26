import type { MemoryDocument } from './schema.js';

/**
 * `Clone`（`clone.ts`）が持っていた**「蒸留・記憶」の状態12フィールド**を、
 * 独立の単位として切り出したもの（Issue #1190 の続き）。`RunnerSession` の
 * `RunnerSdkSession`（PR #1611）と同じ形にそろえてある。
 *
 * **前例は PR #1359（`clone-notices.ts`）／ #1507（`clone-inbox-flow.ts`）／
 * #1532（`clone-redelivery-state.ts`）／ #1611（`runner-sdk-session.ts`）。**
 * 新しいクラスは完全に private な状態の器だけを持ち、`#journal` / `#stores`
 * （実際に日誌へ書く口・記憶ストアの実体）には一切触れない。**蒸留を投げるか・
 * 断り書きの文面を組み立てるか・記憶をいつ読み直すかの判断は、これまでどおり
 * `Clone` が持つ。**
 *
 * ## 何を持っているか
 *
 * - **`#systemPromptChars` / `#promptMemoryChars`**——セッション構築時に焼き
 *   込んだ文字数（`CloneRuntimeFacts` へ運ぶ・記憶の床の基準に使う）。
 * - **`#lastTickMemoryFloorChars` / `#lastTickMemoryBaselineChars`**——直近の
 *   tick が測った記憶の床・基準（`#memoryFloorDigestLine` が読み比べて書き、
 *   末尾で次回のぶんへ更新する）。
 * - **`#transcriptPath`**——このセッションの生ログの在り処（`PostToolUse`
 *   フックの入力から控える。セッションを跨いで持ち越さない）。
 * - **`#contextWindowFoldNoticePending`**——文脈窓で畳んだことを、次の通常
 *   ターンで1度だけクローン自身へ断るための印。
 * - **`#memoryIndexRefreshPending`**——要約に潰されたので、次のターンで記憶の
 *   索引を丸ごと載せ直すための印（Issue #696）。
 * - **`#hasUndistilledActivity`**——前回の蒸留以降に新しいターンが走ったか。
 * - **`#memoryOnRecord`**——いまの SDK セッションでクローンが最後に見た記憶
 *   （slug → 本文）。
 * - **`#resumedHistoryHasMemory`**——resume で起こしたセッションかどうか
 *   （最初のターンで1度だけ断るために持つ）。
 * - **`#bootAt`**——この器が組み立てられた時刻（蒸留が間に合わなかった区間の
 *   上端。読み取り専用）。
 * - **`#distillGapNoticePending`**——蒸留が間に合わなかった区間の断り書きを、
 *   まだ1度も添えていないかどうか（Issue #564 の (b)）。
 *
 * 12フィールドそれぞれの詳しい意味・不変・相互の関係は、元々 `clone.ts` の
 * フィールド宣言に付いていた doc から要点を保ったまま、下の各フィールド・
 * メソッドの doc へ移した。
 *
 * ## ⛔ 器に入れていないもの
 *
 * - **記憶ストアの実体**（`#stores.persona` 等）は背骨なので触れない。この
 *   クラスが持つのは「最後に見た記憶の写し」（`#memoryOnRecord`）という状態
 *   だけで、実際の読み書きは呼び出し側（`Clone`）が行う。
 * - **許可まわり**（`#deniedToolUses` / `#allowedByGrantToolUses` /
 *   `#grantFunneledWarnedOnce`）は #1105 の担当の領域なので候補から外した
 *   （issuecomment-5843050193 の判定どおり）。
 * - **`#recycleForContextWindow`**（会話を切って畳み直す印）はここに含まない
 *   ——あちらは `#contextWindowFoldNoticePending` と同時に立つが、意味が違う
 *   （「畳んで作り直す」という意図そのものであって、「クローンへ断ったか」
 *   ではない）。呼び出し側（`Clone#noteContextWindowFold` /
 *   `#noteUnproductiveUsageBlockFold`）がそれぞれ別に持つ。
 *
 * ## なぜ切り出したか、そして切り出しの限界（前例4本と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `Clone` へ戻さないこと。**
 *
 * 1. **切る根拠は価値の軸の測定であって、構造的な孤立ではない**
 *    （issuecomment-5843050193）。母集団88本に対し、T のみ・w≥3・w≥2・w≥1 の
 *    4定義すべてで帰無Bに対する lift が有意（+5.68〜+27.27pt、p ≤ .019）——
 *    前例 #1581（`RunnerSession` の待つ窓）が 3/4 で切っている基準を、この束は
 *    4/4 で超えている。**構造の側は逆のことを言っている**——12フィールドを
 *    触るメンバーは `Clone` 側に多数散っており（`#buildOptions` /
 *    `#ensureQuery` / `#withFreshMemory` / `#memoryFloorDigestLine` /
 *    `#handle` / `#runTurn` / `#distillGapNotice` / `#contextWindowFoldNotice` /
 *    `#runtimeFacts` / `#noteContextWindowFold` / `#noteUnproductiveUsageBlockFold` /
 *    `#read` の `finally`）、**この12フィールドだけを触るメンバーは0本**である。
 *    ⟹ この切り出しの実体は「疎結合な部分を剥がす」案ではなく、「暗黙の参照
 *    （`this.#hasUndistilledActivity` 等への直接アクセス）を、明示のメソッド
 *    呼び出しに変える」案である——前例4本と同じ限界。
 * 2. **テストの分離は買えない。** `clone.test.ts` の蒸留・記憶を名指しする
 *    `describe`/`it` はどれも `Clone` をブラックボックスとして通した統合
 *    テストで、切り出しの前後で一体のまま動く——ここで直接テストするのは、
 *    このクラス自身の状態遷移だけである。
 * 3. **挙動は1ビットも変えていない。** 呼び出し側（`Clone`）の `await` の
 *    位置・操作の順序・分岐の条件は1つも動かしていない。
 *    - **`#distillGapNoticePending` / `#contextWindowFoldNoticePending` は
 *      「消費する読み」である**（`turn-input.ts` の doc、Issue #1190 の
 *      2026-09-19 のコメント）。{@link CloneDistillMemoryState.takeDistillGapNoticePending} /
 *      {@link CloneDistillMemoryState.takeContextWindowFoldNoticePending} は、
 *      元の「読んで真なら下ろす」という2行（`if (!pending) return; pending
 *      = false;`）を1回の呼び出しへ畳んだだけである——**既に偽のときに偽を
 *      代入し直しても観測できる違いは無い**ので、呼び出し側の「`kind ===
 *      'distill'` なら呼ばずに空文字を返す」という早期リターンより後に置く
 *      限り、読む回数・下ろすタイミングは変えていない。
 *    - **`#withFreshMemory` の `#memoryOnRecord` 操作は2つの遷移に分けた。**
 *      元は「差分を数える（`changed`/`removed`。読むだけ）」→「resume・索引の
 *      印を消費する読みで下ろす」→「両方0件かつ索引の印も無ければ早期
 *      return（この時点で `#memoryOnRecord` は1文字も変わらない）」→「変える
 *      なら、いまの控えを退避してから丸ごと差し替える」という順序だった。
 *      {@link CloneDistillMemoryState.diffAgainstRecorded}（読むだけ）と
 *      {@link CloneDistillMemoryState.commitMemory}（退避してから差し替える）
 *      へ分けたことで、**早期 return の経路では `commitMemory` を1度も呼ばない
 *      ——つまり `#memoryOnRecord` に触れない**という元の性質をそのまま保てる。
 *    - **`#buildOptions` の `#memoryOnRecord` 操作**（差分を見ずに丸ごと差し
 *      替える）も {@link CloneDistillMemoryState.commitMemory} を呼ぶ——戻り値
 *      （退避した旧い控え）は使わない。呼び出し側が使わないだけで、クラスの
 *      中身は`#withFreshMemory`と同じ「退避してから差し替える」という同じ
 *      1つの遷移である。
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（前例4本と同じ言い方）。
 */
export class CloneDistillMemoryState {
  // ---------------------------------------------------------------------
  // セッション構築時に焼き込んだ文字数
  // ---------------------------------------------------------------------

  /** `#buildOptions` で組み立てたシステムプロンプトの文字数。セッションの間は固定。 */
  #systemPromptChars = 0;
  /**
   * システムプロンプトへ焼き込んだ記憶の文字数。**セッションの間は固定。**
   *
   * `#memoryOnRecord` の合計で代用しないこと — あちらは走行中に人間が記憶を
   * 直せば動く。`CloneRuntimeFacts.injectedMemoryChars` が名乗っているのは
   * 「このセッションを組み立てた時点」の値であり、動く数を渡せばその場で嘘に
   * なる。
   */
  #promptMemoryChars = 0;

  get systemPromptChars(): number {
    return this.#systemPromptChars;
  }

  get promptMemoryChars(): number {
    return this.#promptMemoryChars;
  }

  /**
   * `#buildOptions` がセッションを組んだ直後に呼ぶ。**2本まとめて立てる**——
   * 元の2行（`this.#systemPromptChars = …; this.#promptMemoryChars = …;`）を
   * 1回の呼び出しへ畳んだだけで、代入する値・順序は変えていない。
   */
  recordBuiltSizes(systemPromptChars: number, promptMemoryChars: number): void {
    this.#systemPromptChars = systemPromptChars;
    this.#promptMemoryChars = promptMemoryChars;
  }

  // ---------------------------------------------------------------------
  // 記憶の床の tick 差分
  // ---------------------------------------------------------------------

  /**
   * 直近の tick（`self_initiative` / `timer`）が測った「記憶の床」の絶対値
   * （`measureMemoryFloor(...).totalChars`）。`null` は「まだこのプロセスで
   * 一度も測れていない」（＝前回の tick が無い、または在っても測定に失敗した）。
   *
   * **永続化しない。** 器が再起動すればここは失われ、再起動後の最初の tick は
   * 「前回の tick が無い」として扱われる——それが正しい（#553 F2、依頼者の
   * 明示指定）。測定に失敗した回は更新しない。
   */
  #lastTickMemoryFloorChars: number | null = null;
  /**
   * 直近の tick が見た `#promptMemoryChars`（＝そのときの「セッション構築
   * 時点」の基準）。`#lastTickMemoryFloorChars` と対で更新する。
   *
   * これを次回の tick 時点の `#promptMemoryChars` と突き合わせることで、
   * 「セッションが組み直されて基準が取り直された」（resume 等）を検出する。
   * **この値も永続化しない。**
   */
  #lastTickMemoryBaselineChars: number | null = null;

  get lastTickMemoryFloorChars(): number | null {
    return this.#lastTickMemoryFloorChars;
  }

  get lastTickMemoryBaselineChars(): number | null {
    return this.#lastTickMemoryBaselineChars;
  }

  /**
   * `#memoryFloorDigestLine` が、その回に測れた値で末尾にまとめて呼ぶ
   * （測れなかった回は呼ばない——元のとおり、どちらも更新しない）。**2本
   * まとめて立てる**——元の2行の代入順序・値は変えていない。
   */
  recordTick(floorChars: number, baselineChars: number): void {
    this.#lastTickMemoryFloorChars = floorChars;
    this.#lastTickMemoryBaselineChars = baselineChars;
  }

  // ---------------------------------------------------------------------
  // 生ログの在り処
  // ---------------------------------------------------------------------

  /**
   * このセッションの生ログ（トランスクリプト）の在り処。**フックの入力から
   * 控える。** セッションを跨いで持ち越さない——`#ensureQuery` で `null` へ
   * 戻す。持ち越すと、別のセッションの生ログをいまの `sessionId` の名前で
   * 退避することになる。
   */
  #transcriptPath: string | null = null;

  get transcriptPath(): string | null {
    return this.#transcriptPath;
  }

  /**
   * `Clone#noteTranscriptPath` が呼ぶ。**`unknown` から入る値の型検査は
   * 呼び出し側が持つ**——ここは検査済みの文字列を受け取って代入するだけ。
   */
  setTranscriptPath(path: string): void {
    this.#transcriptPath = path;
  }

  /** `#ensureQuery`（新しいセッションを組む直前）が呼ぶ。持ち越さない。 */
  clearTranscriptPath(): void {
    this.#transcriptPath = null;
  }

  // ---------------------------------------------------------------------
  // 文脈窓で畳んだことの断り（消費する読み）
  // ---------------------------------------------------------------------

  /**
   * 文脈窓で畳んだので、次の通常のターンで1度だけクローン自身へ断るための印。
   * `#distillGapNoticePending` と同じ形で持つ——印を立て、次の通常のターンの
   * 入力の先頭へ1度だけ差し込み、印を下ろす。
   */
  #contextWindowFoldNoticePending = false;

  /**
   * `Clone#noteContextWindowFold` / `#noteUnproductiveUsageBlockFold` が、
   * 畳むと決めた回に呼ぶ。
   */
  armContextWindowFoldNotice(): void {
    this.#contextWindowFoldNoticePending = true;
  }

  /**
   * 消費する読み——読んで、真なら下ろす。`Clone#contextWindowFoldNotice` が
   * `kind === 'distill'` の早期リターンより後で呼ぶ（蒸留のターンでは呼ばれ
   * ないので、印は下りない）。
   */
  takeContextWindowFoldNoticePending(): boolean {
    const pending = this.#contextWindowFoldNoticePending;
    this.#contextWindowFoldNoticePending = false;
    return pending;
  }

  // ---------------------------------------------------------------------
  // 記憶の索引の載せ直し（消費する読み）
  // ---------------------------------------------------------------------

  /**
   * 要約に潰されたので、次のターンで記憶の索引を丸ごと載せ直すための印
   * （Issue #696）。立てるのは `#onPreCompact`、下ろすのは
   * `#withFreshMemory`（載せた回）と `#buildOptions`（セッションを組み直した
   * 回）。
   */
  #memoryIndexRefreshPending = false;

  /** `#onPreCompact`（compaction が起きる直前）が呼ぶ。 */
  armMemoryIndexRefresh(): void {
    this.#memoryIndexRefreshPending = true;
  }

  /**
   * 消費する読み——読んで、無条件に下ろす。`#withFreshMemory` が呼ぶ
   * （載せるものが無くても下ろす。残すと無関係な更新に相乗りする）。
   */
  takeMemoryIndexRefreshPending(): boolean {
    const pending = this.#memoryIndexRefreshPending;
    this.#memoryIndexRefreshPending = false;
    return pending;
  }

  // ---------------------------------------------------------------------
  // 未蒸留の活動
  // ---------------------------------------------------------------------

  /**
   * このセッションが実際に何かをしたか（`kind !== 'distill'` のターンが
   * 1本でも走ったか）。**前回の蒸留以降に新しいことが無ければ、同一内容の
   * 蒸留を重ねて払わない**判定にだけ使う。
   *
   * **初期値は `true`。** プロセスを起こした直後・新しいセッションを開いた
   * 直後は、前のプロセスが shutdown 蒸留を済ませたかをこの層からは知れない。
   * 知れないなら蒸留する側を既定にする。
   */
  #hasUndistilledActivity = true;

  get hasUndistilledActivity(): boolean {
    return this.#hasUndistilledActivity;
  }

  /**
   * 蒸留が成功で終わった時点（`#handle` の `'distill'` 分岐、
   * `outcome.status === 'answered'`）でだけ呼ぶ。失敗した蒸留（枠で保持
   * された場合を含む）で下ろすと、移せなかった記憶を「移した」ことにして
   * 記憶を落とす——迷ったら蒸留する側へ倒す（AGENTS.md「蒸留は生存条件」）。
   */
  markDistilled(): void {
    this.#hasUndistilledActivity = false;
  }

  /**
   * `#runTurn` が、`kind !== 'distill'` のターンを起こすたびに呼ぶ。蒸留
   * そのもののターンで立て直すと印は永久に下りず、`stop()` の重複防止は
   * 何もしないのと同じになる——だから呼び出し側は `kind === 'distill'` の
   * ときは呼ばない。
   */
  markActivity(): void {
    this.#hasUndistilledActivity = true;
  }

  // ---------------------------------------------------------------------
  // いま SDK セッションが見ている記憶の写し
  // ---------------------------------------------------------------------

  /**
   * いまの SDK セッションでクローンが最後に見た記憶。slug → 本文。
   *
   * **全文の1文字列ではなく文書ごとに持つ。** 全文で持って全文と比べていた
   * 頃は、人間が1つの文書の1行を直しただけで記憶の全文をもう一度クローンの
   * 文脈へ載せていた——文書ごとに持てば、載せ直すのは実際に変わった文書
   * だけで済む。
   */
  readonly #memoryOnRecord = new Map<string, string>();

  /**
   * いまの記憶ストアの中身（`documents`）を、控え（`#memoryOnRecord`）と
   * 比べて「変わった文書」「消えた文書の slug」を返す。**読むだけで、
   * `#memoryOnRecord` には触れない**——`Clone#withFreshMemory` はこの結果と
   * 消費する読み2本（resume・索引）を見てから、載せ直すものが無ければここで
   * 早期 return する。載せ直すなら {@link commitMemory} を呼ぶ。
   */
  diffAgainstRecorded(documents: readonly MemoryDocument[]): {
    changed: MemoryDocument[];
    removed: string[];
  } {
    const changed = documents.filter((doc) => this.#memoryOnRecord.get(doc.slug) !== doc.content);
    const present = new Set(documents.map((doc) => doc.slug));
    const removed = [...this.#memoryOnRecord.keys()].filter((slug) => !present.has(slug));
    return { changed, removed };
  }

  /**
   * いまの控え（＝クローンが直前まで見ていた版）を退避してから、`documents`
   * で丸ごと差し替える。**退避した版をそのまま返す**——
   * `Clone#withFreshMemory` はこれを `renderMemoryDocuments` の `seenContent`
   * （「変わった範囲だけ」を描くための比較対象）へそのまま渡す。
   *
   * **順序（退避 → クリア → 詰め直し）は変えていない。** 逆にすると、退避
   * したつもりの控えが新しい内容で埋まり、差分が常に空になる。
   *
   * `Clone#buildOptions`（セッションを新しく組む・組み直す回）もこれを呼ぶ
   * ——戻り値（退避した旧い控え）は使わない。あちらは差分を見ずに焼き込みを
   * 丸ごと差し替えるだけなので、同じ「退避してから差し替える」という1つの
   * 遷移で足りる。
   */
  commitMemory(documents: readonly MemoryDocument[]): ReadonlyMap<string, string> {
    const seenContent = new Map(this.#memoryOnRecord);
    this.#memoryOnRecord.clear();
    for (const doc of documents) this.#memoryOnRecord.set(doc.slug, doc.content);
    return seenContent;
  }

  /**
   * 控えだけを空にする（差し替えない）。`#read` の `finally`（セッションが
   * 閉じる経路）が呼ぶ——次のセッションは `#buildOptions` が
   * {@link commitMemory} で控え直す。ここで空にしておかないと、前のセッション
   * で見せた分を「もう見せた」と数えたまま新しいシステムプロンプトを組む
   * ことになる（実害は無いが、控えの出所が2か所になる）。
   */
  forgetMemory(): void {
    this.#memoryOnRecord.clear();
  }

  // ---------------------------------------------------------------------
  // resume で起こしたセッションの記憶の断り（消費する読み）
  // ---------------------------------------------------------------------

  /**
   * resume で起こしたセッションかどうか（最初のターンで1度だけ断るために
   * 持つ）。**履歴には前のセッションで載せ直した記憶の写しが残っている**——
   * それが正本（システムプロンプト）より新しいと誤読されないよう、1文で
   * 断る。
   */
  #resumedHistoryHasMemory = false;

  /** `#buildOptions` が、セッションを組んだ直後に呼ぶ（`resume !== null`）。 */
  setResumedHistoryHasMemory(resumed: boolean): void {
    this.#resumedHistoryHasMemory = resumed;
  }

  /**
   * 消費する読み——読んで、無条件に下ろす。`#withFreshMemory` が呼ぶ（載せ
   * 直すものが無くても、断りだけは1度出す。それが目的である）。
   */
  takeResumedHistoryHasMemory(): boolean {
    const had = this.#resumedHistoryHasMemory;
    this.#resumedHistoryHasMemory = false;
    return had;
  }

  // ---------------------------------------------------------------------
  // 蒸留が間に合わなかった区間（消費する読み）
  // ---------------------------------------------------------------------

  /**
   * この器が組み立てられた時刻。**蒸留が間に合わなかった区間の上端である**
   * （Issue #564 の (b)。`distill-gap.ts` の `deriveDistillGapFromJournal` の
   * `until`）。この時刻より後に日誌へ入った行は、定義上いまの器が書いたもの
   * ＝いまの会話の中に在る。
   */
  readonly #bootAt = new Date().toISOString();

  get bootAt(): string {
    return this.#bootAt;
  }

  /**
   * 蒸留が間に合わなかった区間の断り書きを、まだ1度も添えていないかどうか
   * （Issue #564 の (b)）。**`#contextWindowFoldNoticePending` と同じ形で
   * 持つ**——最初のターンで1度だけ添えて下ろす。
   */
  #distillGapNoticePending = true;

  /**
   * 消費する読み——読んで、真なら下ろす。`Clone#distillGapNotice` が
   * `kind === 'distill'` の早期リターンより後で呼ぶ（蒸留のターンでは呼ば
   * れないので、印は下りない）。**再び立てる口は無い**——`#bootAt` は固定
   * （読み取り専用）で、この印は器の生涯で1度だけ立つ。
   */
  takeDistillGapNoticePending(): boolean {
    const pending = this.#distillGapNoticePending;
    this.#distillGapNoticePending = false;
    return pending;
  }
}
