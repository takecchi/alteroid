import {
  eachLine,
  LOOP_YIELD_CHARS,
  runSteps,
  runStepsYielding,
  type YieldingSteps,
} from './loop-yield.js';

export interface TranscriptFilterInput {
  since?: string;
  until?: string;
  types?: readonly string[];
  contains?: string;
}

export interface TranscriptFilterCounts {
  totalLines: number;
  matchedLines: number;
  noTimestampLines: number;
  unparsableLines: number;
}

export interface TranscriptFilterResult {
  body: string;
  counts: TranscriptFilterCounts;
}

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
    // 窓なしへ黙って倒さない: 読めない境界は呼び出し側の検証漏れなので、例外にする
    throw new RangeError(`filterTranscriptLines: ${field} が日時として読めない（"${value}"）`);
  }
  return ms;
}

function* filterSteps(
  body: string,
  filter: TranscriptFilterInput,
  yieldChars: number,
): YieldingSteps<TranscriptFilterResult> {
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

  let totalLines = 0;
  const visit = (line: string): void => {
    totalLines++;
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
        return;
      }
      const ms = timestampMs(record.timestamp);
      if (ms === null) {
        noTimestampLines++;
        return;
      }
      // until は含まない: 窓を連続して読み進めたとき境界の1行が重複も欠落もしないため
      if (sinceMs !== undefined && ms < sinceMs) return;
      if (untilMs !== undefined && ms >= untilMs) return;
    }

    if (types !== undefined) {
      if (!parseOk) {
        unparsableLines++;
        return;
      }
      const t = record.type;
      if (typeof t !== 'string' || !types.has(t)) return;
    }

    if (contains !== undefined && !line.includes(contains)) return;

    matchedLines++;
    kept.push(line);
  };

  // 全体を `split` で割らない: 数百 MB の生ログでは、割るだけでループを塞ぐため（#4659）
  // `split` と同じ行を数える: 空の本文は0行、末尾の改行の後ろの空行は数えない
  if (body !== '') {
    yield* eachLine(body, yieldChars, (line, _start, end) => {
      if (line === '' && end === body.length) return;
      visit(line);
    });
  }

  return {
    body: kept.join('\n'),
    counts: {
      totalLines,
      matchedLines,
      noTimestampLines,
      unparsableLines,
    },
  };
}

export function filterTranscriptLines(
  body: string,
  filter: TranscriptFilterInput,
): TranscriptFilterResult {
  return runSteps(filterSteps(body, filter, LOOP_YIELD_CHARS));
}

/** {@link filterTranscriptLines} と同じ結果を、約 `yieldChars` 字ごとにループへ順番を返しながら作る（#4659）。 */
export function filterTranscriptLinesYielding(
  body: string,
  filter: TranscriptFilterInput,
  yieldChars: number = LOOP_YIELD_CHARS,
): Promise<TranscriptFilterResult> {
  return runStepsYielding(filterSteps(body, filter, yieldChars));
}
