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

/**
 * 割って計算するときの1かけらの長さ（UTF-16 コード単位）。手元の測定で 1MB の md5 は数 ms。
 * 数十 MB の生ログを一度に計算すると、デーモンのループを 150ms 前後ずつ塞ぐ（#4485。本番の CPU ではその数倍の見込み）。
 */
const MD5_CHUNK_CHARS = 1024 * 1024;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * `md5Hex(text.slice(0, end))` と同じ値を、かけらごとにループへ返しながら計算する。
 * かけらの境目でサロゲートペアを割らない: 割ると、それぞれが不正な片割れとして U+FFFD に置き換わって UTF-8 にされ、値が変わるため。
 * 終わり（`end`）はそのまま使う: `slice` と同じく、そこで割れたペアは片割れとして数える。
 */
async function md5HexYielding(text: string, end: number = text.length): Promise<string> {
  const hash = createHash('md5');
  let at = 0;
  while (at < end) {
    let next = Math.min(end, at + MD5_CHUNK_CHARS);
    if (
      next < end &&
      isHighSurrogate(text.charCodeAt(next - 1)) &&
      isLowSurrogate(text.charCodeAt(next))
    ) {
      next -= 1;
    }
    hash.update(text.slice(at, next), 'utf8');
    at = next;
    if (at < end) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return hash.digest('hex');
}

/** {@link fingerprintArchiveBody} と同じ値を、ループを長く塞がずに計算する（#4485。デーモンの中で数十 MB を扱う置き場向け）。 */
export async function fingerprintArchiveBodyYielding(
  body: string,
): Promise<ArchiveBodyFingerprint> {
  return { bodyChars: body.length, bodyMd5: await md5HexYielding(body) };
}

/** {@link classifyArchiveContinuity} と同じ答えを、ループを長く塞がずに出す（#4485）。 */
export async function classifyArchiveContinuityYielding(
  previous: Parameters<typeof classifyArchiveContinuity>[0],
  body: string,
): Promise<ReturnType<typeof classifyArchiveContinuity>> {
  if (
    previous === null ||
    previous === undefined ||
    previous.bodyChars === null ||
    previous.bodyChars === undefined ||
    previous.bodyMd5 === null ||
    previous.bodyMd5 === undefined
  ) {
    return classifyArchiveContinuity(previous, body);
  }
  const prefixMd5 = await md5HexYielding(body, Math.min(previous.bodyChars, body.length));
  return prefixMd5 === previous.bodyMd5
    ? { continuity: 'continues', comparedTo: previous.id }
    : { continuity: 'diverged', comparedTo: previous.id };
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
