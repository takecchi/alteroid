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

function splitTranscriptLines(body: string): string[] {
  if (body === '') return [];
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
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
      // until は含まない: 窓を連続して読み進めたとき境界の1行が重複も欠落もしないため
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
