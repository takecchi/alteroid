/**
 * `manager_transcript`（`tools.ts`）の生ログ（JSONL、1行1イベント）を、
 * 時刻の窓・行の種別（`type` 欄）・部分文字列で絞る、道具に依存しない純粋な
 * 関数（issue #2188）。
 *
 * **なぜ道具（`tools.ts`）から切り出すか** — issue 本文が「絞りの処理は core の
 * 純粋な関数に置く（HTTP・CLI から後で同じものを使えるように。今回はクローンの
 * 道具だけ）」と明記している。`manager_transcript` は `filterTranscriptLines` を
 * 呼ぶだけにし、ISO 8601 の読み書き（`since`/`until` が読めないときの断り文）は
 * `tools.ts` 側（`isReadableJournalTimeBoundary` / `describeUnreadableJournalTimeBoundary`。
 * `journal-time.ts`）に残す——検証と計算を分けるのは、この repo の既存の作法
 * （`describeIntRangeViolation` と実際の範囲判定を分けているのと同じ形）。
 *
 * ## 窓の両端の含み方
 *
 * **`since` は含む（`>=`）、`until` は含まない（`<`）。** `journal_read` の
 * `since`/`until`（`entry.at >= since` かつ `entry.at <= until`——両端とも含む）
 * とは**わざと**揃えていない。生ログを窓で連続して読み進める使い方
 * （`since=T1&until=T2` の次に `since=T2&until=T3` を呼ぶ）を半開区間にしておくと、
 * 境界の1行が2つの窓の両方に出たり、どちらの窓にも出なかったりしない。
 *
 * ## 「判定できない」行の2つの数え方
 *
 * 窓（`since`/`until` のどちらか）を渡したとき、各行は次の3つに分かれる——
 * 「窓に入る」「窓に入らない」「窓の判定ができない」。**3つ目を黙って
 * 2つ目へ倒さない**（`AGENTS.md` の「取れない軸に0の行を作る」と同じ形）。
 * 判定できない行は2種類あり、別々に数える——
 *
 * - `unparsableLines` — 行が JSON として読めない（`JSON.parse` が例外を投げる）
 * - `noTimestampLines` — JSON としては読めるが、`timestamp` 欄が無い・
 *   文字列でも数値でもない・`Date.parse` で日時として読めない、のいずれか。
 *   **「欄が無い」と「欄はあるが読めない値」をここでは1つに畳んでいる**——
 *   どちらも「この行の時刻が確定できない」という同じ帰結だから。畳んだ結果は
 *   `noTimestampLines` という名前のまま出力に出るので、名前と中身がずれない
 *   よう呼び出し側（`tools.ts`）の文言も「時刻の無い行」で統一する。
 *
 * `type` だけを渡した（窓を渡さなかった）ときも、JSON として読めない行は
 * `type` 欄を読めないので `unparsableLines` に数える（窓判定とは独立に、
 * 同じカウンタを共有する——2つの絞りが両方欲しがるのは「JSON として読めたか」
 * という同じ事実なので、行1本につき最大1回しか数えない）。`contains` は
 * 生の行の文字列に対して見るので、JSON として読めるかに関係なく判定できる
 * ——`contains` だけを渡したときは `unparsableLines`/`noTimestampLines` は
 * 一切増えない（JSON を1行も parse しない。700万字級の本文を毎回全部
 * parse する費用を避ける）。
 */

/** `filterTranscriptLines` への絞りの指定。どれも省略できる。 */
export interface TranscriptFilterInput {
  /**
   * ISO 8601（`Date.parse` が読める形）。この時刻以降（含む）の行だけ残す。
   * **呼び出し側で読める形であることを検証済みにしておくこと**——ここでは
   * 検証しない（読めない文字列を渡すと `RangeError` を投げる）。
   */
  since?: string;
  /** ISO 8601。この時刻より前（含まない）の行だけ残す。`since` と同じ注意。 */
  until?: string;
  /**
   * 行の `type` 欄で絞る（複数は OR）。**空配列・未指定はどちらも
   * 「絞らない」と同じ扱い**——空配列を「何にも一致しない」の意味には
   * 使わない（呼び出し側でカンマ区切りを split・trim したときに空文字列
   * だけが残るケースを、そのまま「絞りなし」へ寄せられるようにするため）。
   */
  types?: readonly string[];
  /**
   * 行の生の文字列（JSON にする前の1行そのもの）にこの部分文字列を含む
   * 行だけ残す。空文字列は「絞らない」と同じ（どの行も含む）。
   */
  contains?: string;
}

/** `filterTranscriptLines` が返す、絞り込みの数え上げ。 */
export interface TranscriptFilterCounts {
  /** 本文を改行で割った行の総数（空行も1行と数える）。 */
  totalLines: number;
  /** 全ての絞りを通過した行数。 */
  matchedLines: number;
  /**
   * 時刻の窓（`since`/`until` のどちらか）を渡したときだけ増える。
   * `timestamp` 欄が無い・読めない値だった行の数（窓の判定ができないので
   * 除いた行）。窓を渡さなかったときは常に0。
   */
  noTimestampLines: number;
  /**
   * JSON として読めなかった行の数。窓を渡したときは窓の判定ができずに
   * 除いた行、`type` だけを渡したときは `type` の判定ができずに除いた行
   * （`contains` だけのときは常に0——`contains` は JSON を parse しない）。
   */
  unparsableLines: number;
}

export interface TranscriptFilterResult {
  /** 絞りを通過した行を `\n` で連結した本文（末尾の改行は付けない）。 */
  body: string;
  counts: TranscriptFilterCounts;
}

/**
 * 本文を行に割る。**末尾の改行1つぶんは行として数えない**——
 * `"a\nb\n"` は2行（`["a", "b"]`）であって3行ではない。一方、中間の空行
 * （`"a\n\nb"` の2行目）はそのまま1行として残す。
 */
function splitTranscriptLines(body: string): string[] {
  if (body === '') return [];
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * `timestamp` 欄の値を epoch ミリ秒へ。文字列なら `Date.parse`、数値なら
 * そのまま epoch ミリ秒として扱う。どちらでも読めなければ `null`。
 */
function timestampMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function parseIsoBoundary(field: 'since' | 'until', value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    // **ここへ来るのは呼び出し側の検証漏れである。** `tools.ts` は
    // `isReadableJournalTimeBoundary` で先に断っているはずなので、通常経路
    // では届かない。歯（unit test）が直接この関数を壊れた値で呼んだときに
    // 黙って窓なしへ倒さないよう、はっきり例外にする。
    throw new RangeError(`filterTranscriptLines: ${field} が日時として読めない（"${value}"）`);
  }
  return ms;
}

/**
 * 生ログ（JSONL）を絞る。`filter` の4つのキーはどれも省略できる——
 * **全部省略したとき、`body` は入力と1文字も変わらない**（`matchedLines`
 * は `totalLines` と一致し、`noTimestampLines`/`unparsableLines` は0のまま）。
 */
export function filterTranscriptLines(
  body: string,
  filter: TranscriptFilterInput,
): TranscriptFilterResult {
  const lines = splitTranscriptLines(body);
  const sinceMs = parseIsoBoundary('since', filter.since);
  const untilMs = parseIsoBoundary('until', filter.until);
  const windowActive = sinceMs !== undefined || untilMs !== undefined;
  const nonEmptyTypes = (filter.types ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  const types = nonEmptyTypes.length > 0 ? new Set(nonEmptyTypes) : undefined;
  const contains =
    filter.contains !== undefined && filter.contains !== '' ? filter.contains : undefined;

  let matchedLines = 0;
  let noTimestampLines = 0;
  let unparsableLines = 0;
  const kept: string[] = [];
  const needsParse = windowActive || types !== undefined;

  for (const line of lines) {
    let parsed: unknown;
    let parseOk = true;
    if (needsParse) {
      try {
        parsed = JSON.parse(line);
      } catch {
        parseOk = false;
      }
    }
    const record: Record<string, unknown> =
      parseOk && parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};

    if (windowActive) {
      if (!parseOk) {
        unparsableLines++;
        continue;
      }
      const ms = timestampMs(record.timestamp);
      if (ms === null) {
        noTimestampLines++;
        continue;
      }
      if (sinceMs !== undefined && ms < sinceMs) continue;
      if (untilMs !== undefined && ms >= untilMs) continue;
    }

    if (types !== undefined) {
      if (!parseOk) {
        unparsableLines++;
        continue;
      }
      const t = record.type;
      if (typeof t !== 'string' || !types.has(t)) continue;
    }

    if (contains !== undefined && !line.includes(contains)) continue;

    matchedLines++;
    kept.push(line);
  }

  return {
    body: kept.join('\n'),
    counts: {
      totalLines: lines.length,
      matchedLines,
      noTimestampLines,
      unparsableLines,
    },
  };
}
