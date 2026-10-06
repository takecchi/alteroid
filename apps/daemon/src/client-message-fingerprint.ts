import { createHash } from 'node:crypto';

import { stripNul } from '@alteroid/core';

/**
 * **`POST /chat` の `clientMessageId` の重複を判定するときに比べる「発言の中身」の指紋**（Issue #3243）。
 *
 * 同じ id が再び届いたとき、1回目と今回の中身が同じなら再送（200 の `duplicate: true`）、違えば
 * 呼び手の取り違え（409 `client_message_id_mismatch`）。比べる中身は本文・添付の id・`supersedes` の3つ。
 *
 * - **本文は `stripNul` を通す。** 日誌（fs・pg・インメモリ）は本文から NUL を落として残すので、日誌から
 *   取り出した本文と、受け取ったままの本文を、同じ規則に揃えてから比べる（揃えないと、NUL を含む本文の
 *   再送が「中身が違う」と読まれる）。
 * - **添付は id の集合として比べる**（重複を除いて並べ替える）。サーバは添付の id を重複除去してから
 *   結び付けるので、同じ id を2度書いても中身は変わらない。順序は、再送する側が一覧を作り直す
 *   （集合から組み直す）ことがあり、順序の違いだけで黙って捨てるより受けるほうが害が小さいので無視する。
 *   **添付の中身（バイト列）は比べない** —— id が同じなら同じ上げたものである（id は上げたときに払い出される）。
 * - **メモリには指紋（sha256）だけを持つ。** 本文は長くなりうる（受信箱の上限まで）。上限 2048 件の
 *   Map に本文を抱えると、記憶の大きさが本文の長さに比例する。指紋なら1件あたり固定長。
 *   日誌のほうは、引いた行（`exchange`）から同じ関数で指紋を作る。
 */
export interface ClientMessageContent {
  readonly text: string;
  readonly attachmentIds?: readonly string[] | undefined;
  readonly supersedes?: string | undefined;
}

export function clientMessageFingerprint(content: ClientMessageContent): string {
  const ids = [...new Set(content.attachmentIds ?? [])].sort();
  // 区切り文字の取り違えで別の中身が同じ指紋にならないよう、JSON の配列で畳む。
  const canonical = JSON.stringify([stripNul(content.text), ids, content.supersedes ?? null]);
  return createHash('sha256').update(canonical).digest('hex');
}
