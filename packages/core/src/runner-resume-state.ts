import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

/**
 * `RunnerSession`（`runner.ts`）が持っていた **resume/seed の状態4フィールド**
 * （`#seed` / `#resumeAttempt` / `#sessionId` / `#progressed`）を、独立の単位
 * として切り出したもの（Issue #1190 案X）。
 *
 * **前例は PR #1551（`runner-cut-off-workers.ts`）・PR #1523
 * （`runner-turn-tally.ts`）——同じ形にそろえてある。** 新しいクラスは完全に
 * private な状態の器だけを持ち、`#emit`（実際に日誌へ書く口）にも、SDK
 * セッションの生死を握る `#query` / `#reader` / `#generation` / `#input` にも
 * 一切触れない。**注記の文面を組み立てるかどうか・note を出すかどうか・SDK
 * セッションをいつ開く／畳むかの判断は、これまでどおり `RunnerSession` が持つ。**
 *
 * ## 何を持っているか
 *
 * - **`#seed`** —— resume のために預かった生ログ（SDK の `SessionStore.load`
 *   が返す素材）。{@link RunnerResumeState.markProgressed} が解放する
 * - **`#resumeAttempt`** —— 投げたが、まだ効いたと確かめられていない resume
 *   （`{ sessionId }` か `null`）。{@link RunnerResumeState.takeAttempt} が
 *   読み出すと同時に消費する
 * - **`#sessionId`** —— 直近に観測した SDK セッション ID
 * - **`#progressed`** —— このセッションが実際に何かをしたか（道具を使った・
 *   確認を出した・結果を返した）。一度立てたら二度と下ろさない
 *
 * 4フィールドそれぞれの詳しい意味・不変・相互の関係は、元々 `runner.ts` の
 * フィールド宣言に付いていた doc から1文字も削らずに、下の各フィールド・
 * メソッドの doc へ移した（`#sessionId` にはフィールド doc が無かったので、
 * ここで新しく書き足した）。
 *
 * ## なぜ切り出したか、そして切り出しの限界（PR #1551 / #1523 と同じ形の申告）
 *
 * **この節を読まずに「無駄な間接層だ」と思って `RunnerSession` へ戻さないこと。**
 *
 * 1. **束として孤立してはいない。** 4フィールドの生の読み書き（切る前は
 *    `grep -n '#seed\b\|#resumeAttempt\b\|#sessionId\b\|#progressed\b'
 *    packages/core/src/runner.ts` で25行——うちフィールド宣言4行・doc コメント
 *    中の言及8行を除く操作は13行）は、`RunnerSession` 側の9本のメンバー
 *    （`resume` / `state` / `#sessionStore` / `#atTokenRecycleBoundary` /
 *    `#read` / `#reopenForTokenRotation` / `#markProgressed` / `#apply` /
 *    `#flushUsage`）と、`#resumeRecoveryHost` のプロパティ初期化子の中の4メソッド
 *    （`takeResumeAttempt` / `hasProgressed` / `renderSeedRecord` /
 *    `teardownForRecreate`。PR #1550 案Zが `ResumeRecoveryHost` として先に
 *    切り出した口）に散っていた。**束だけを触るのは `resume` と
 *    `#markProgressed` の2本だけである**——この2本はそのまま
 *    {@link RunnerResumeState.beginResume} / {@link RunnerResumeState.markProgressed}
 *    として丸ごと移した。残りは `#liveBackgroundTasks` / `#query` / `#reader` /
 *    `#generation` / `#input` / `#emit` など `RunnerSession` の他の状態も
 *    併せ持つので、**丸ごとは移さず、4フィールドへの生の読み書きの部分だけを
 *    このクラスのメソッド呼び出しに置き換えた**——PR #1551 の
 *    `RunnerCutOffWorkers` と同じ形の切り分けである。
 * 2. **`ResumeRecoveryHost`（`runner-resume-recovery.ts`）は、このクラスを
 *    知らない。** `#resumeRecoveryHost` の4メソッドは、これまでどおり
 *    `RunnerSession` の private フィールドとして——`ResumeRecoveryHost` を
 *    `implements` せず——組み立てられており（`runner.ts` の
 *    `#resumeRecoveryHost` の doc がその理由を持つので、ここでは繰り返さない）、
 *    中身がこのクラスのメソッド呼び出しに変わっただけである。⟹ この切り出しは
 *    `RunnerSession` の**公開面を1つも増やさない**。
 * 3. **テストの分離は買えない。** resume・token-rotation・`session_started` の
 *    黒箱テスト（`runner-token-rotation.test.ts` /
 *    `runner-resume-recreate-worker-count.test.ts` /
 *    `runner-post-tool-use-failure-resume.test.ts` /
 *    `runner-closed-system-error.test.ts` 等）は、切り出しの前後で一体のまま
 *    `RunnerSession` を通して動く——ここで直接テストするのは、このクラス自身の
 *    状態遷移だけである。
 * 4. **挙動は1ビットも変えていない。** 呼び出し側（`RunnerSession`）の `await`
 *    の位置・操作の順序・分岐の条件は1つも動かしていない。**唯一、形が変わって
 *    見えるのは `case 'session_started'` である**——元は
 *
 *    ```
 *    if (this.#sessionId !== event.sessionId) this.#liveBackgroundTasks = [];
 *    this.#sessionId = event.sessionId;
 *    ```
 *
 *    という「比較 → 代入」の2行だったが、{@link RunnerResumeState.observeSessionStarted}
 *    は1回のメソッド呼び出しの中で「代入する前の値と比較し、代入してから、
 *    変わったかどうかを bool で返す」——比較の対象・比較のタイミング
 *    （代入より前）・呼び出し側が見る条件は1つも変えていない。`RunnerCutOffWorkers.consumeCutOff`
 *    が「`delete` があったかどうか」を bool 1つにまとめたのと同じ形の圧縮で
 *    あり、呼び出し側は次のとおり書き換わる:
 *
 *    ```
 *    if (this.#resumeState.observeSessionStarted(event.sessionId)) this.#liveBackgroundTasks = [];
 *    ```
 *
 * 得られるのは「この状態の組み合わせは、この器の中だけで読めばよい」という
 * レビューのしやすさだけである（PR #1551 / #1523 と同じ言い方）。
 */
export class RunnerResumeState {
  /**
   * resume のために預かった生ログ（SDK の `SessionStore.load` が返す素材）。
   *
   * **正常フローでは `#markProgressed` が解放する。** `#sessionStore().load()`
   * が読むのは SDK がセッションを開く最初の1回だけで、それは `#progressed` が
   * 立つ（道具を使った・確認を出した・結果を返した）よりも必ず先に済んでいる
   * ── モデルが手を動かすには、動かす前にセッションが開いていないといけない。
   * だから `#progressed` が立った時点で `load()` はもう `#seed` を読み終えており、
   * 二度と呼ばれない。
   *
   * **`system/init` が来た時点では解放しない。** `init` は「開いた」ことしか
   * 示さず、`recoverFromFailedResume`（`runner-resume-recovery.ts`）が resume の
   * 成否を判定するのに使う基準は `#progressed`（「続けられた」）であって `init`
   * の有無ではない。`init` の直後・何も手が動く前に接続が切れる形は「resume が
   * 効かなかった」として扱われ、そのときの回復（`renderSessionLog(this.#seed)`）
   * にはまだ `#seed` が要る。ここで解放すると、その回復だけが静かに材料を失う。
   */
  #seed: SessionStoreEntry[] | undefined;

  /**
   * 投げたが、まだ効いたと確かめられていない resume。
   *
   * **「resume を投げた」と「続きへ戻れた」は別物である。** SDK は開いた後に
   * `No conversation found with session ID: …` を投げてくるので、成否は
   * `system/init` が来たかどうかで見るしかない（`clone.ts` の `#sawInit` と同じ形）。
   * 効いたら消す。消えないまま閉じたなら、その resume は効かなかった。
   */
  #resumeAttempt: { sessionId: string } | null = null;

  /**
   * 直近に観測した SDK セッション ID。
   *
   * `resume()` で最初の値を立て、`case 'session_started'` の `init` が来るたびに
   * 上書きし、`recoverFromFailedResume` が作り直しを決めたとき
   * （{@link discardForRecreate}）に手放す。`state()` が運ぶ・`#flushUsage` /
   * `turn_ended` の `usage`/`context_usage` イベントに乗る・
   * `#atTokenRecycleBoundary()` の境界条件の1つになる、と読み手が多い。
   */
  #sessionId: string | undefined;

  /**
   * このセッションが実際に何かをしたか（道具を使った・確認を出した・結果を返した）。
   *
   * 生ログからの作り直しを**手が動く前だけ**に限るための旗である。動いた後で
   * 作り直すと、済んだ作業を記録から二度走らせる。
   *
   * **一度立てたら二度と下ろさない。** `recoverFromFailedResume`
   * （`runner-resume-recovery.ts`）はこれが立っていれば `#seed` を読む前に
   * `not-a-resume-failure` を返して抜けるので、これが立った時点で `#seed` は
   * この先このインスタンスの寿命が尽きるまで二度と読まれないことが確定する
   * （{@link markProgressed} 参照）。
   */
  #progressed = false;

  /** 直近に観測した SDK セッション ID。無ければ `undefined`。 */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** 預かっている生ログ。無ければ `undefined`。 */
  get seed(): SessionStoreEntry[] | undefined {
    return this.#seed;
  }

  /** このセッションが既に何かをしたか。 */
  get progressed(): boolean {
    return this.#progressed;
  }

  /**
   * `RunnerSession#resume`（前のセッションの続きから開く口）が呼ぶ。
   * `#sessionId` / `#seed` / `#resumeAttempt` の3本をまとめて立てる
   * ——元の `resume()` 本体にあった3行をそのまま1本のメソッドへまとめただけで、
   * 3行の順序・代入する値は変えていない。
   */
  beginResume(sessionId: string, entries: SessionStoreEntry[] | undefined): void {
    this.#sessionId = sessionId;
    this.#seed = entries;
    this.#resumeAttempt = { sessionId };
  }

  /**
   * `RunnerSession#reopenForTokenRotation`（認証トークンの畳み直しで開き直す口）
   * が呼ぶ。`#resumeAttempt` だけを立て直す——このときは `#sessionId` は
   * 開き直す前と同じ値のまま渡ってくるので（呼び出し側が `this.#sessionId` を
   * 読んでから渡す）、ここで代入し直す必要は無い。`#seed` にも触れない
   * （resume の素材は無く、生ログからの引き継ぎは別経路——
   * `recoverFromFailedResume` の `teardownForRecreate`/`pushHandoff`——が持つ）。
   */
  armResumeAttempt(sessionId: string): void {
    this.#resumeAttempt = { sessionId };
  }

  /**
   * 投げたが効いたと確かめられていない resume を読み出し、同時に消費する
   * （`ResumeRecoveryHost.takeResumeAttempt` の実体）。**呼ぶたびに毎回
   * `null` へ戻す**——既に `null` であっても書き直しは無害（識別子への代入に
   * 副作用は無い）ので、これ自体が分岐を作らない。
   */
  takeAttempt(): { sessionId: string } | null {
    const attempt = this.#resumeAttempt;
    this.#resumeAttempt = null;
    return attempt;
  }

  /**
   * `#progressed` を立てる唯一の口。**必ずここを通す** — 直接
   * `progressed` を立てる別の経路を作ると、`#seed` の解放を足し忘れる経路が
   * 生まれる。
   *
   * 立てると同時に `#seed` を解放する。安全な理由は `#seed` のフィールド
   * doc を参照。既に立っている（＝既に解放済み）なら何もしない
   * （`RunnerSession#markProgressed` はこのメソッドを呼ぶだけの薄い口になる）。
   */
  markProgressed(): void {
    if (this.#progressed) return;
    this.#progressed = true;
    this.#seed = undefined;
  }

  /**
   * `RunnerSession#apply` の `case 'session_started'` が呼ぶ。
   *
   * **`init`（`system_started`）はターンの頭ごとに来る。** 器（CLI プロセス）が
   * (re)start したときにしか来ないのではない——詳しい根拠は `runner.ts` の
   * `#liveBackgroundTasks` の doc を見よ（ここでは繰り返さない）。ここで見て
   * いるのは、SDK 側でセッションが差し替わった場合の保険——`event.sessionId`
   * が直前の値と違うときだけ、判定できないときは配る側へ倒すという原則に沿って
   * 呼び出し側へ「変わった」を伝える。
   *
   * **比較は代入するより前に行う。** 初回は `#sessionId === undefined` なので
   * 必ず「変わった」側になる（空→空で無害）。戻り値は「セッションが差し替わった
   * か」——呼び出し側はこれが `true` のときだけ `#liveBackgroundTasks` を空へ
   * 戻す（`RunnerSession#apply` 側に残った判断）。
   */
  observeSessionStarted(sessionId: string): boolean {
    const changed = this.#sessionId !== sessionId;
    this.#sessionId = sessionId;
    return changed;
  }

  /**
   * `ResumeRecoveryHost.teardownForRecreate` が、生ログからの作り直しを決めた
   * ときに呼ぶ。`#sessionId` / `#seed` の2本を手放す——新しいセッションは
   * resume しない（`#sessionId` を持たない）ので、素材は本文へ畳んで渡す
   * （`#seed` も要らない）。`teardownForRecreate` が触る他のフィールド
   * （`#generation` / `#query` / `#reader` / `#input`）は `RunnerSession` 側に
   * 残る——このクラスが持つのはこの2本の解放だけである。
   */
  discardForRecreate(): void {
    this.#sessionId = undefined;
    this.#seed = undefined;
  }
}
