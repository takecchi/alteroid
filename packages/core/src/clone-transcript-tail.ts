import { open } from 'node:fs/promises';

import { distillTailOf } from './distill-transcript-tail.js';

// 単位は文字（UTF-16 の code unit）でバイトではない: 切っているのが `String.prototype.slice` のため
export const DISTILL_TRANSCRIPT_TAIL_CHARS = 60_000;

/**
 * UTF-8 で 1 つのコードポイントを表すのに要るバイト数の上限（補助面の文字は常に 4 バイト）。
 * export して唯一の出所にする: `storage-fs` の `FsTranscriptArchive.readTail` が同じ形を使い、根拠を複製すると片方だけ直る事故になる。
 */
export const MAX_UTF8_BYTES_PER_CODE_POINT = 4;

/**
 * 生ログの末尾だけを読む。
 * 全文を 1 本の文字列にしない: 生ログは伸び続け、JS の文字列上限を超えると `ERR_STRING_TOO_LONG` で蒸留がまるごと止まる。
 * `(DISTILL_TRANSCRIPT_TAIL_CHARS + 1) * MAX_UTF8_BYTES_PER_CODE_POINT` バイト読む: {@link tailOf} はコードポイントで切るので、
 * バイトで読むと文字数が減り、`+ 1` が無いと切り詰め済みの窓を「もとから短い」と誤読する。
 * 窓の先頭の壊れた文字は {@link tailOf} が最初の改行より前を捨てるときに落ちる。
 */
export async function readTranscriptTail(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const window = (DISTILL_TRANSCRIPT_TAIL_CHARS + 1) * MAX_UTF8_BYTES_PER_CODE_POINT;
    const length = Math.min(size, window);
    const buffer = Buffer.alloc(length);
    // `bytesRead` で切る: `buffer` をそのまま文字列にすると末尾に NUL が並び、pg 側は NUL を落とすので器によって中身が変わる。
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * 蒸留に渡す末尾。全文はアーカイブに残っているので、ここでは直近だけでよい。
 * 生の JSONL を「発言者: テキスト」へ整形してから `DISTILL_TRANSCRIPT_TAIL_CHARS` で切る（#5306。整形が落ちたら生の末尾）。
 * 切り方（コードポイントで数える理由・行の途中と壊れた文字で始めない整え方）は {@link distillTailOf}。
 */
export function tailOf(transcript: string): string {
  return distillTailOf(transcript, DISTILL_TRANSCRIPT_TAIL_CHARS);
}
