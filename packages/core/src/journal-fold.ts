// 迷ったら畳まない側へ倒す: 容量は後から減らせるが、書かなかった行は戻らないため
// 「畳み始めてからの経過」で切らない: 10 分後の別の出来事が、直前の連なりと同じ本文というだけで書かれずに抱え込まれるため
export const JOURNAL_FOLD_IDLE_GAP_MS = 60_000;

// 空きだけで切らない: 連なりの長さに上限が無くなり、器が落ちたときに失う量が青天井になるため
export const JOURNAL_FOLD_MAX_SPAN_MS = 5 * 60_000;

// 件数でも切る: 間隔が極端に詰まった暴走で、落ちたときの損失が数千件になるため
export const JOURNAL_FOLD_MAX_SUPPRESSED = 100;

export interface JournalFoldRun {
  readonly signature: string;
  // 畳んだ本文そのものを持たせる: 要約に回数しか無いと、後から何が N 回起きたのかを別の場所から探すことになるため
  readonly text: string;
  readonly suppressed: number;
  readonly firstAt: string;
  readonly lastAt: string;
  // 2本目以降の要約の「直前」は前の要約なので、「1 + N」と書かない: 合計を要約の本数ぶん多く読ませるため
  readonly later?: {
    readonly index: number;
    readonly priorSuppressed: number;
  };
}

export interface JournalFoldVerdict {
  readonly write: boolean;
  // 要約は `write` の行より先に書く: 日誌が時系列で読まれ、次の1件目より後ろに出ると係り先がずれるため
  readonly flush?: JournalFoldRun;
}

interface OpenRun {
  signature: string;
  text: string;
  suppressed: number;
  seenAtMs: number;
  spanFromMs: number;
  firstAtMs?: number;
  lastAtMs?: number;
  summaries: number;
  priorSuppressed: number;
}

// `UPDATE` を使わない: 日誌は追記専用で、畳んだ結果は常に新しい1行の追記として出すため
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

  observe(signature: string, text: string, atMs: number): JournalFoldVerdict {
    const run = this.#run;

    const wentIdle = run !== undefined && atMs - run.seenAtMs >= this.#idleGapMs;
    if (run === undefined || run.signature !== signature || wentIdle) {
      const flush = run !== undefined ? snapshot(run) : undefined;
      this.#run = {
        signature,
        text,
        suppressed: 0,
        seenAtMs: atMs,
        spanFromMs: atMs,
        summaries: 0,
        priorSuppressed: 0,
      };
      return flush !== undefined ? { write: true, flush } : { write: true };
    }

    // 本文は毎回いちばん新しいものを持つ: 署名が同じでも本文が違いうる呼び方をされたとき、古いほうだと読み手が混乱するため
    run.text = text;
    run.suppressed += 1;
    run.seenAtMs = atMs;
    run.lastAtMs = atMs;
    if (run.suppressed === 1) run.firstAtMs = atMs;

    const spanned = atMs - run.spanFromMs >= this.#maxSpanMs;
    if (run.suppressed >= this.#maxSuppressed || spanned) {
      const flush = takeSummary(run);
      // 数え直しの起点も進める: 戻し忘れると総経過の上限が毎回効きっぱなしになり、畳みが実質止まるため
      run.spanFromMs = atMs;
      return flush !== undefined ? { write: false, flush } : { write: false };
    }

    return { write: false };
  }

  flush(): JournalFoldRun | undefined {
    const run = this.#run;
    if (run === undefined) return undefined;
    return takeSummary(run);
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
    ...(run.summaries > 0
      ? { later: { index: run.summaries + 1, priorSuppressed: run.priorSuppressed } }
      : {}),
  };
}

function takeSummary(run: OpenRun): JournalFoldRun | undefined {
  const flushed = snapshot(run);
  if (flushed !== undefined) {
    run.summaries += 1;
    run.priorSuppressed += flushed.suppressed;
  }
  run.suppressed = 0;
  run.firstAtMs = undefined;
  run.lastAtMs = undefined;
  return flushed;
}

// 「1回目は直前に書いてある」と明記する: 無いと、読み手は `suppressed` を「起きた回数」と読むため
export function foldedRunText(run: JournalFoldRun): string {
  if (run.later !== undefined) {
    const total = run.later.priorSuppressed + run.suppressed;
    return [
      `同じ合図が続いたので畳んだ（この連なりの ${run.later.index} 本目の要約。前の要約の後の ${run.suppressed} 回ぶん。${run.firstAt} 〜 ${run.lastAt}）。`,
      '⚠ 1回目はこの連なりの最初の要約より前に書いてある。前の要約の後に、さらに ' +
        String(run.suppressed) +
        ' 回起きた。この要約までの通算は 1 + ' +
        String(total) +
        ' 回である（この要約の件数を、前の要約の件数に足し直さないこと）。',
      '畳んだ本文:',
      run.text,
    ].join('\n');
  }
  return [
    `同じ合図が続いたので畳んだ（2回目以降を ${run.suppressed} 回ぶん。${run.firstAt} 〜 ${run.lastAt}）。`,
    '⚠ 1回目はこの直前に書いてあるので、起きた回数は 1 + ' + String(run.suppressed) + ' である。',
    '畳んだ本文:',
    run.text,
  ].join('\n');
}
