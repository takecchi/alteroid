import { createHash } from 'node:crypto';

import type { ArchiveContinuityTally } from './store.js';

export type ArchiveContinuity = 'first' | 'continues' | 'diverged' | 'unknown';

export interface ArchiveBodyFingerprint {
  // pg の `length()`（コードポイント数）と混ぜない: ここは UTF-16 コード単位で数えているため
  readonly bodyChars: number;
  readonly bodyMd5: string;
}

export function fingerprintArchiveBody(body: string): ArchiveBodyFingerprint {
  return { bodyChars: body.length, bodyMd5: md5Hex(body) };
}

// 長さの大小で判定しない: 伸びていても前方一致しない行が在るため
// 'unknown' を 'continues' に倒さない: 確かめずに畳んでよいと言うことになるため
export function classifyArchiveContinuity(
  previous:
    | { readonly id: string; readonly bodyChars?: number | null; readonly bodyMd5?: string | null }
    | null
    | undefined,
  body: string,
): { readonly continuity: ArchiveContinuity; readonly comparedTo?: string } {
  if (previous === null || previous === undefined) {
    return { continuity: 'first' };
  }
  if (
    previous.bodyChars === null ||
    previous.bodyChars === undefined ||
    previous.bodyMd5 === null ||
    previous.bodyMd5 === undefined
  ) {
    return { continuity: 'unknown', comparedTo: previous.id };
  }
  const prefixMd5 = md5Hex(body.slice(0, previous.bodyChars));
  return prefixMd5 === previous.bodyMd5
    ? { continuity: 'continues', comparedTo: previous.id }
    : { continuity: 'diverged', comparedTo: previous.id };
}

function md5Hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

// 'first' / 'continues' を記録しない: 毎回1行ずつ日誌へ積むとノイズにしかならないため
export function describeArchiveContinuityForJournal(params: {
  readonly caller: string;
  readonly sessionId: string;
  readonly continuity: ArchiveContinuity;
  readonly comparedTo?: string;
  readonly bodyChars: number;
}): string | null {
  if (params.continuity !== 'diverged' && params.continuity !== 'unknown') return null;
  const comparedToPart = params.comparedTo === undefined ? '' : ` comparedTo=${params.comparedTo}`;
  return (
    `[${params.caller}] continuity=${params.continuity} sessionId=${params.sessionId} ` +
    `bodyChars=${params.bodyChars}${comparedToPart}`
  );
}

// undefined を 'unknown' に混ぜない: 門より前に積まれた行は、門を通って指紋が無かった行とは別の状態のため
export function tallyArchiveContinuity(
  continuities: ReadonlyArray<ArchiveContinuity | undefined>,
): ArchiveContinuityTally {
  const tally = { first: 0, continues: 0, diverged: 0, unknown: 0, absent: 0 };
  for (const continuity of continuities) {
    if (continuity === undefined) {
      tally.absent += 1;
      continue;
    }
    tally[continuity] += 1;
  }
  return tally;
}
