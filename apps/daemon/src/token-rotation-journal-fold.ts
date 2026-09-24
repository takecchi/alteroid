/**
 * `token_rotation` の日誌行を、書く時点で畳む（issue #1311 段B）。
 *
 * ## 背景 — 何が問題だったか
 *
 * 書き込み口は `apps/daemon/src/index.ts` の `settleTokenOutcome` の末尾の
 * `stores.journal.append(entry)` 1箇所だけで、`entry` は
 * `packages/core/src/token-rotator.ts` の `tokenRotationEntry` →
 * `describeTokenRotation` が作る。間引き（`describeTokenRotation` の中の
 * `isThinnedMilestone`）は `ignored` ＋ `freshness === 'stale'` にしか掛からず、
 * `exhausted` / `sweep_stopped` / `ignored`（signal ≠ none）等は毎回そのまま
 * 書く。**`token-watch.ts` の60秒 tick が `reconsider({reason:'tick'})` を
 * 呼ぶたびに、現役が冷却中で他の候補も駄目な間は毎分ほぼ同じ本文
 * （`exhausted`、いちばん早く戻る時刻も同じ）が日誌へ積まれる**——冷却5時間
 * なら約300行の同一本文になる（本番実測、2026-09-22時点で `token_rotation`
 * 型が約38万行）。
 *
 * ## なぜここに切り出したか
 *
 * `settleTokenOutcome` は `main()` の中の閉包で、`main()` 自体は測れない
 * （`tokenRotationStream` の doc「これは `main()` の中の3行だったが、測れな
 * かった」と同じ事情）。**畳むかどうかの判定は状態を持つが、副作用（stdout・
 * `recycleSessionForToken`・`cloneWakeGate`・`wake()`）を1つも持たない**——
 * だからここへ切り出しても、それらの出力・挙動は1文字も変わらない
 * （`AGENTS.md`「テストが書けない構造は、テストが無いのと同じ」の条件どおり）。
 * `settleTokenOutcome` 側の配線は `index.test.ts` の構造検査で固定する。
 *
 * ## 窓は1つ、署名は「event と text の完全一致」
 *
 * デーモン全体で1つの {@link TokenRotationJournalFold} を持つ（`manager.ts` の
 * rate_limit 用 —— マネージャーごとに窓を分ける —— とは違い、`token_rotation`
 * を書く経路はデーモンに1本しか無い）。署名は `event` と `text` を両方含める
 * ——**本文が1文字でも違えば別の連なりにする**（迷ったら畳まない側へ倒す。
 * `JournalFoldWindow` 自身の契約と同じ）。
 *
 * ## 窓の長さは既定のままでは効かない
 *
 * `JOURNAL_FOLD_IDLE_GAP_MS`（既定 60,000ms）は `token-watch.ts` の
 * `TOKEN_WATCH_TICK_MS`（60,000ms）とちょうど同じ長さである。
 * `JournalFoldWindow.observe` は `atMs - run.seenAtMs >= idleGap` で「連なりが
 * 途切れた」と判定するので、**tick がちょうど60秒間隔で来ると、次の観測は
 * 必ず「idleGap 以上空いた」側に落ちる**——＝ 毎回「途切れた」と判定され、
 * 1行も畳めない。**60秒ちょうどの tick では既定の空きが毎回切れる。**
 *
 * ⟹ tick 由来の反復を畳むには、idleGap を tick 周期より十分長く取る必要が
 * ある。**2.5倍（＝150秒）を選んだ理由**: tick は `setInterval` 相当で厳密に
 * 60.000秒間隔とは限らない（イベントループの混雑で数百ms〜数秒のジッタが
 * 乗りうる）。2倍だとジッタ次第でまだ際どく境界に近い。3倍だと「本物の
 * 再発」を見分ける感度が鈍る（tick2回ぶん＝2分以内の再発まで同じ連なりへ
 * 畳まれてしまう）。2.5倍は、tick1回ぶんのジッタを吸収しつつ、tick2回超
 * （＝120秒超の空き）を確実に「途切れた」として拾う値として選んだ。
 *
 * **定数は tick の定数から導く**（値を二重に持たない）——`TOKEN_WATCH_TICK_MS`
 * が変われば、ここも自動で追随する。
 *
 * `maxSpanMs` は60分——`JOURNAL_FOLD_MAX_SPAN_MS`（既定5分）のままだと、
 * 背景にある5時間の冷却（本番実測）でも5分ごとに要約行が出て、約60本に
 * なる。60分にすると同じ冷却で最大5本——「行を減らす」という目的
 * （`journal-fold.ts` の doc の梃子）に対して、なお「器が落ちたときに失う
 * 量」に上限を付けられている値として選んだ。
 *
 * `maxSuppressed` は既定（100）のまま——tick は60秒に1回なので、100件は
 * 約100分ぶん。60分の `maxSpanMs` のほうが先に効くので、実質的に効くのは
 * 時間の上限のほうである。
 */
import { JournalFoldWindow, foldedRunText, type TokenRotationEntry } from '@alteroid/core';
import { TOKEN_WATCH_TICK_MS } from './token-watch.js';

/** {@link TokenRotationJournalFold} の既定の idleGap。上の doc の「2.5倍」。 */
export const TOKEN_ROTATION_JOURNAL_FOLD_IDLE_GAP_MS = TOKEN_WATCH_TICK_MS * 2.5;

/** {@link TokenRotationJournalFold} の既定の maxSpan。上の doc の「60分」。 */
export const TOKEN_ROTATION_JOURNAL_FOLD_MAX_SPAN_MS = 60 * 60_000;

/** {@link TokenRotationJournalFold.observe} の判定。 */
export interface TokenRotationJournalFoldVerdict {
  /** この `entry` そのものを日誌へ書くか。 */
  readonly write: boolean;
  /**
   * 直前までの連なりを畳んだ要約。在れば**この行より先に**日誌へ書くこと
   * （`JournalFoldVerdict.flush` の doc と同じ順序の理由——日誌は時系列で
   * 読まれる）。
   */
  readonly summary?: TokenRotationEntry;
}

/**
 * 畳みの同一性を決める署名。**`event` と `text` の両方を含める**——本文が
 * 1文字でも違えば別の連なりとして扱う（迷ったら畳まない側へ倒す）。
 *
 * ⚠️ 区切り（`\u0000`）を挟む理由: `event` と `text` を素朴に連結すると、
 * `event="a", text="bc"` と `event="ab", text="c"` が同じ文字列になりうる
 * ——`event` は現状 固定の enum なのでこの衝突は実際には起きないが、区切りを
 * 挟むコストは無いので安全側へ倒してある。
 */
export function tokenRotationFoldSignature(entry: TokenRotationEntry): string {
  return `${entry.event}\u0000${entry.text}`;
}

/**
 * `token_rotation` の日誌行を畳む窓。**デーモン単位で1つ持つ。**
 *
 * 副作用を持たない——`observe` / `flush` は「日誌へ何を書くべきか」を返す
 * だけで、`stores.journal.append` は呼び出し側（`settleTokenOutcome`）が行う。
 */
export class TokenRotationJournalFold {
  readonly #window: JournalFoldWindow;
  /**
   * **直前に observe した entry。** 畳んだ連なりの構造欄
   * （`event` / `signal` / `tokenId` / `earliestAt` 等）は、要約を組み立てる
   * ときにこれを引き継ぐ——{@link JournalFoldWindow} 自体は `text` しか
   * 覚えていないので、構造欄を持ち回るのはここの役目である。
   */
  #lastEntry: TokenRotationEntry | undefined;

  constructor(options: { idleGapMs?: number; maxSpanMs?: number; maxSuppressed?: number } = {}) {
    this.#window = new JournalFoldWindow({
      idleGapMs: options.idleGapMs ?? TOKEN_ROTATION_JOURNAL_FOLD_IDLE_GAP_MS,
      maxSpanMs: options.maxSpanMs ?? TOKEN_ROTATION_JOURNAL_FOLD_MAX_SPAN_MS,
      ...(options.maxSuppressed === undefined ? {} : { maxSuppressed: options.maxSuppressed }),
    });
  }

  /**
   * 1件の `token_rotation` entry を通す。**呼び出し側は返り値のとおりに
   * 日誌へ書く**（`summary` が在ればそちらを先に、`write` が真なら `entry`
   * 自身も書く）。
   *
   * @param atMs 観測の時刻（`Date.now()` 相当。テストでは注入する）。
   */
  observe(entry: TokenRotationEntry, atMs: number): TokenRotationJournalFoldVerdict {
    const verdict = this.#window.observe(tokenRotationFoldSignature(entry), entry.text, atMs);
    const summary =
      verdict.flush === undefined
        ? undefined
        : { ...(this.#lastEntry ?? entry), text: foldedRunText(verdict.flush) };
    this.#lastEntry = entry;
    return summary === undefined ? { write: verdict.write } : { write: verdict.write, summary };
  }

  /**
   * 開いている連なりを吐き出して閉じる。**デーモンが止まるときに呼ぶ。**
   *
   * 呼ばなくても失うのは窓1つぶんの畳んだ件数だけで、**1件目は
   * {@link observe} の時点で既に書かれている**（`JournalFoldWindow` の契約:
   * 1件目は必ず即座に `write: true` で返る）。
   */
  flush(): TokenRotationEntry | undefined {
    const flushed = this.#window.flush();
    if (flushed === undefined || this.#lastEntry === undefined) return undefined;
    return { ...this.#lastEntry, text: foldedRunText(flushed) };
  }
}
