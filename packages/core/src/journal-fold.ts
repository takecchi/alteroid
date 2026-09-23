/**
 * 日誌の「同じ合図の連なり」を、書く時点で畳む（issue #1311）。
 *
 * ## なぜ要るか
 *
 * `journal` は本番で **4,394 MB ＝ DB 最大**まで育ち、**約 1.9 GB/日**で増えて
 * いる。内訳を測ると **1行あたり約 985 バイト**で、そのうち **618 バイトは
 * 本文に依存しない固定費**である（`entry` の jsonb・`id` の uuid・索引5本。
 * 索引だけで 312 B/行 ＝ 4,673,991 行で約 1,392 MB）。
 *
 * ⟹ 🔑 **効く梃子は「本文を短くすること」ではなく「行を減らすこと」である。**
 * 本文を短くしても最大 37% しか効かないが、行を1本減らすと 985 バイトが丸ごと
 * 減る（**10万行減らすごとに約 94 MB**）。
 *
 * そして本番には、**同じ本文が4時間で162行・間隔 4.6〜8.2 秒**という反復が
 * 実際に在る（`entry->>'text'` が「枠から追い返された」を含む行。本文は md5 で
 * 1種類だけ）。**畳む価値が在るのはこの形である。**
 *
 * ## ⛔ 追記専用の契約を破らない
 *
 * 日誌が追記専用なのは「聞かずに実行した判断は必ず日誌に残る」ことが人間の
 * 事後否定＝最終承認の実体だからである（`docs/PRD.md`「権限境界」。逐語は
 * `grep -Fn -- '聞かずに実行した判断は必ず日誌に残る' docs/PRD.md`）。
 *
 * **ここはその契約を1ビットも破らない**:
 *
 * 1. **`UPDATE` を1回も使わない。** 畳んだ結果は**新しい1行の追記**として出る。
 *    既に書いた行は書き換えも削除もしない
 * 2. ⭐ **1件目は必ず即座に書く。** 畳むのは2件目以降だけなので、**「それが
 *    起きた」が日誌から消える瞬間が無い**
 * 3. **畳む対象は呼び出し側が名指しする。** この機構は自分では何も決めない
 *
 * ⟹ **追記専用は「一度書いたものを消さない」契約であって、「同じ文を162回
 * 書く義務」ではない。**
 *
 * ## これは新しい原則ではない（前例が2つ在る）
 *
 * この repo は既に2箇所で「日誌へ書く回数を絞る」判断をしている:
 *
 * - **`describeTokenRotation`** は `stale` の観測を**初出と10の冪のときだけ**
 *   書き、それ以外は `null` を返して書かない
 *   （`grep -Fn -- 'export function describeTokenRotation(' packages/core/src/token-rotator.ts`）
 * - **`SynthesizedNoticeStreak`** は同一本文の機構合成通知を畳む
 *   （`grep -Fn -- 'interface SynthesizedNoticeStreak {' packages/core/src/manager.ts`）
 *
 * ⚠️ **ただし後者が畳むのは「受信箱への配達」だけで、日誌の行数には1行も
 * 効かない。** ⟹ **ここが足すのは、既に在る扱いを日誌の側へ広げる1本である。**
 *
 * ## ⚠️ 畳んではいけないもの（呼び出し側が守る線）
 *
 * **この機構は渡されたものを畳むだけなので、線は呼び出し側が引く。**
 *
 * - ⛔ 人間・クローン・マネージャーの**実際の発話**（`exchange` の本体）
 * - ⛔ `decision` / `escalation` / `memory_update` —— 判断そのものの記録
 * - ⛔ `tool_use` —— 「全層の全ツール実行がここに落ちる（監査）」。網羅性が要件
 * - ⛔ `context_usage` —— 「ターンの境界で毎回1行」が仕様（#976 が足したもの）
 *
 * ⟹ **畳んでよいのは「機構が自分で文言を組み立てて出している合図」だけ**で
 * ある。迷ったら畳まない側へ倒すこと —— **容量は後から減らせるが、書かなかった
 * 行は戻らない。**
 */

/**
 * 連なりが「途切れた」と見なす空き時間（ミリ秒）。
 *
 * ⭐ **これは「畳み始めてからの経過」ではなく「直前の観測からの空き」である。**
 * ここを取り違えると、**間隔の空いた本物の再発を畳んでしまう。**
 *
 * 🔴 **実際にこの罠を踏みかけた。** 最初は「畳み始めた時刻からの経過」で切って
 * いたが、それだと *10 分後に起きた別の出来事*が、直前の連なりと同じ本文という
 * だけで**書かれずに抱え込まれる。** ⟹ **空きで切れば、速い反復だけが畳まれ、
 * 間の空いた再発は必ず書かれる**（＝迷ったら書く側へ倒れる）。
 *
 * 60 秒を選んだ理由: 本番の実測の反復間隔が **4.6〜8.2 秒**なので、この空きは
 * その反復を途切れさせない。一方 **枠が開いてから再び閉じるまで**は通常これより
 * ずっと長いので、本物の再発は別の連なりとして必ず1行になる。
 */
export const JOURNAL_FOLD_IDLE_GAP_MS = 60_000;

/**
 * 1本の連なりを畳み続ける総経過の上限（ミリ秒）。
 *
 * **空きだけで切ると、連なりの長さに上限が無くなる。** 8 秒間隔の反復が1時間
 * 続けば、1本の連なりが1時間ぶんを抱えたまま日誌に何も出ない ⟹ **器が落ちた
 * ときに失う量が青天井になる。**
 *
 * ⟹ **総経過でも切って途中経過を吐き出す**（連なり自体は切らずに数え直す）。
 */
export const JOURNAL_FOLD_MAX_SPAN_MS = 5 * 60_000;

/**
 * 畳みを打ち切る件数の上限。
 *
 * **時間の2つの物差しと合わせて3本で刻む。** 時間だけだと、間隔が極端に詰まった
 * 暴走（例: 10ms 間隔）で1回の要約に数千件が入り、**落ちたときの損失がそのまま
 * 数千件になる。** 件数でも切ることで、**どの壊れ方でも損失に上限が付く。**
 */
export const JOURNAL_FOLD_MAX_SUPPRESSED = 100;

/** 畳んだ連なり1本ぶん。**要約の1行はこれだけから組み立てられる。** */
export interface JournalFoldRun {
  /** 畳んだ連なりの署名（呼び出し側が決める）。 */
  readonly signature: string;
  /**
   * ⭐ **畳んだ本文そのもの。**
   *
   * 要約に「N 回あった」としか書かないと、**後から読む人間が「何が N 回
   * 起きたのか」を別の場所から探すことになる。** 日誌だけで閉じるために、
   * 本文をそのまま持たせる。
   */
  readonly text: string;
  /** 畳んだ件数（**1件目は含まない** ＝ 書かずに済ませた行の数）。 */
  readonly suppressed: number;
  /** 畳んだ最初の観測の時刻（ISO 8601）。 */
  readonly firstAt: string;
  /** 畳んだ最後の観測の時刻（ISO 8601）。 */
  readonly lastAt: string;
}

/** {@link JournalFoldWindow.observe} の判定。 */
export interface JournalFoldVerdict {
  /** この観測そのものを日誌へ書くか。 */
  readonly write: boolean;
  /**
   * 直前までの連なりを畳んだ要約。在れば **`write` の行より先に**書く。
   *
   * 順序が決まっているのは、**日誌が時系列で読まれる**からである。要約は
   * 「ここまでの連なり」を指すので、次の1件目より後ろに出ると係り先がずれる。
   */
  readonly flush?: JournalFoldRun;
}

interface OpenRun {
  signature: string;
  text: string;
  suppressed: number;
  /** 直前の観測の時刻。**空きの判定はここから測る。** */
  seenAtMs: number;
  /** この連なりを畳み始めた時刻（総経過の上限を測る起点）。 */
  spanFromMs: number;
  firstAtMs?: number;
  lastAtMs?: number;
}

/**
 * 同じ署名の連なりを畳む窓。**1つの呼び出し経路につき1つ持つ。**
 *
 * ## 畳み方
 *
 * - **署名が変わったら**、それまでの連なりを要約として吐き出し、新しい観測を
 *   **そのまま書く**（＝1件目は必ず書く）
 * - ⭐ **直前の観測から {@link JOURNAL_FOLD_IDLE_GAP_MS} 以上空いていたら**、
 *   署名が同じでも**連なりが途切れた**とみなし、同じく吐き出して**書く**。
 *   ⟹ **間の空いた本物の再発は、必ず1行になる**
 * - **署名が同じで、空きも短いあいだ**は書かずに数える。ただし
 *   **総経過**（{@link JOURNAL_FOLD_MAX_SPAN_MS}）か**件数**
 *   （{@link JOURNAL_FOLD_MAX_SUPPRESSED}）の上限に達したら、そこで
 *   いったん要約を吐き出して数え直す（連なりは切らない）
 *
 * ⟹ **`UPDATE` を使わない。**吐き出しは常に「新しい1行の追記」である。
 *
 * ## ⚠️ 状態を持つので、経路ごとに分ける
 *
 * 署名が違えば連なりは切れるので、**別の意味の合図が同じ窓を共有しても
 * 畳み間違えることは無い。**ただし連なりは1本しか開かないので、2つの合図が
 * 交互に来ると毎回「署名が変わった」となり**どちらも畳まれない**（＝
 * 安全側に倒れる。書く側へ倒れる）。
 */
export class JournalFoldWindow {
  readonly #idleGapMs: number;
  readonly #maxSpanMs: number;
  readonly #maxSuppressed: number;
  #run: OpenRun | undefined;

  constructor(options: { idleGapMs?: number; maxSpanMs?: number; maxSuppressed?: number } = {}) {
    this.#idleGapMs = options.idleGapMs ?? JOURNAL_FOLD_IDLE_GAP_MS;
    this.#maxSpanMs = options.maxSpanMs ?? JOURNAL_FOLD_MAX_SPAN_MS;
    this.#maxSuppressed = options.maxSuppressed ?? JOURNAL_FOLD_MAX_SUPPRESSED;
  }

  /**
   * 1件の観測を通す。**呼び出し側は返り値のとおりに日誌へ書く。**
   *
   * @param signature 同一性の判定に使う鍵。**1バイトでも違えば別の連なり**に
   *   なる（`synthesizedNoticeSignature` と同じ作法 —— 正規化も切り詰めもしない）
   * @param text 畳んだときに要約へ載せる本文
   * @param atMs 観測の時刻（`Date.now()` 相当。テストでは注入する）
   */
  observe(signature: string, text: string, atMs: number): JournalFoldVerdict {
    const run = this.#run;

    // ⭐ **連なりが切れる条件は2つある** —— 署名が変わったときと、直前の観測から
    // 十分に空いたとき。**後者が無いと、間の空いた本物の再発を畳んでしまう**
    // （{@link JOURNAL_FOLD_IDLE_GAP_MS} の doc の 🔴）。
    const wentIdle = run !== undefined && atMs - run.seenAtMs >= this.#idleGapMs;
    if (run === undefined || run.signature !== signature || wentIdle) {
      const flush = run !== undefined ? snapshot(run) : undefined;
      this.#run = {
        signature,
        text,
        suppressed: 0,
        seenAtMs: atMs,
        spanFromMs: atMs,
      };
      return flush !== undefined ? { write: true, flush } : { write: true };
    }

    // 同じ署名が続いている ⟹ 書かずに数える。
    // **本文は毎回いちばん新しいものを持つ。** 署名が同じでも本文が違いうる
    // 呼び出し方をされたとき、要約に載るのが古いほうだと読み手が混乱する。
    run.text = text;
    run.suppressed += 1;
    run.seenAtMs = atMs;
    run.lastAtMs = atMs;
    if (run.suppressed === 1) run.firstAtMs = atMs;

    const spanned = atMs - run.spanFromMs >= this.#maxSpanMs;
    if (run.suppressed >= this.#maxSuppressed || spanned) {
      const flush = snapshot(run);
      run.suppressed = 0;
      run.firstAtMs = undefined;
      run.lastAtMs = undefined;
      // **数え直しの起点も進める。** ここを戻し忘れると、総経過の上限が
      // 一度効いた後は毎回効きっぱなしになり、畳みが実質止まる。
      run.spanFromMs = atMs;
      return flush !== undefined ? { write: false, flush } : { write: false };
    }

    return { write: false };
  }

  /**
   * 開いている連なりを吐き出して閉じる。**止まるときに呼ぶ。**
   *
   * 呼ばなくても失うのは窓1つぶんだが、**呼べるなら呼ぶ**（`observe` を
   * 通らずに終わる経路で、畳んだ件数が丸ごと消えるのを防ぐ）。
   */
  flush(): JournalFoldRun | undefined {
    const run = this.#run;
    if (run === undefined) return undefined;
    const flushed = snapshot(run);
    run.suppressed = 0;
    run.firstAtMs = undefined;
    run.lastAtMs = undefined;
    return flushed;
  }
}

function snapshot(run: OpenRun): JournalFoldRun | undefined {
  if (run.suppressed <= 0) return undefined;
  if (run.firstAtMs === undefined || run.lastAtMs === undefined) return undefined;
  return {
    signature: run.signature,
    text: run.text,
    suppressed: run.suppressed,
    firstAt: new Date(run.firstAtMs).toISOString(),
    lastAt: new Date(run.lastAtMs).toISOString(),
  };
}

/**
 * 要約の1行の本文を組み立てる。
 *
 * ⭐ **畳んだ本文そのものを必ず載せる。**「同じ合図が N 回」だけでは、後から
 * 読む人間が**何が N 回起きたのか**を別の場所から探すことになる —— 日誌を
 * 読んで過去を辿る手が、その1回の寄り道で切れる。
 *
 * ⚠️ **「1回目は直前に書いてある」と明記する。** これが無いと、読み手は
 * `suppressed` を「起きた回数」と読む。実際には**起きた回数は N + 1** である。
 */
export function foldedRunText(run: JournalFoldRun): string {
  return [
    `同じ合図が続いたので畳んだ（2回目以降を ${run.suppressed} 回ぶん。${run.firstAt} 〜 ${run.lastAt}）。`,
    '⚠ 1回目はこの直前に書いてあるので、起きた回数は 1 + ' + String(run.suppressed) + ' である。',
    '畳んだ本文:',
    run.text,
  ].join('\n');
}
