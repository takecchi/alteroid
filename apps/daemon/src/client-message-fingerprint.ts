import { createHash } from 'node:crypto';

import { stripNulWellFormed } from '@alteroid/core';

export interface ClientMessageContent {
  readonly text: string;
  readonly attachmentIds?: readonly string[] | undefined;
  readonly supersedes?: string | undefined;
}

// 本文を `stripNulWellFormed` に通してから比べる: 日誌に残る本文と受け取ったままの本文が食い違い、再送が「中身が違う」と読まれるため。
// 添付の中身（バイト列）は比べない: id が同じなら同じ上げたものであるため。メモリには本文でなく指紋だけを持つ: 本文は長くなりうるため。
export function clientMessageFingerprint(content: ClientMessageContent): string {
  const ids = [...new Set((content.attachmentIds ?? []).map(stripNulWellFormed))].sort();
  const supersedes =
    content.supersedes === undefined ? null : stripNulWellFormed(content.supersedes);
  // JSON の配列で畳む: 区切り文字の取り違えで別の中身が同じ指紋になるのを避けるため。
  const canonical = JSON.stringify([stripNulWellFormed(content.text), ids, supersedes]);
  return createHash('sha256').update(canonical).digest('hex');
}
