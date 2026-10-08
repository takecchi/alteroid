/**
 * 添付の大きさ・個数・合計の断りの文（#3933。`@alteroid/core/attachment-wording`）。
 *
 * **サーバ（`validateAttachmentInput` / `validateAttachmentBatch`）・Web の送る前の検査
 * （`@alteroid/logic` の `checkAttachments`）・CLI と TUI の送る前の検査（`AttachmentDraft.add`）の
 * 唯一の正本である。** 同じ理由の断りは、どこから上げても同じ文で見える（入口の等価性）。
 * ファイル名は文に含めない。名前を前に付けるかは呼ぶ側が決める（`${name}: ${reason}`）。
 *
 * **import を1つも持たない。** Web のバンドルへ入るので、core 本体（Node の組み込みと SDK）を
 * 引き込まないためである（`mask-url.ts` と同じ形）。
 */

const KIB = 1024;
const MIB = KIB * KIB;

// 小数1桁へ丸めた値で単位を上げるか決める: 生の値で切ると 1,048,524 バイト以上が「1024.0 KiB」になる。
function humanOneDecimal(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`;
  const kib = (bytes / KIB).toFixed(1);
  if (Number(kib) < KIB) return `${kib} KiB`;
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** 上限の表記。MiB で割り切れれば `5 MiB`、そうでなければ実際の大きさと同じ丸め方（`1.5 MiB`・`1000 B`）。 */
export function formatAttachmentLimit(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : humanOneDecimal(bytes);
}

/**
 * 実際の大きさの言い方（`5.2 MiB ある`）。**丸めた表示が上限と同じになるときだけ**、
 * 見分けがつくようバイトを添える（`5,242,881 バイト`）。上限は {@link formatAttachmentLimit} と
 * 同じ丸め方で並べて比べる（`5 MiB` は `5.0 MiB` と比べる）。
 */
export function describeAttachmentActual(bytes: number, limitBytes: number): string {
  const rounded = humanOneDecimal(bytes);
  if (rounded !== humanOneDecimal(limitBytes)) return `${rounded} ある`;
  return `${bytes.toLocaleString('en-US')} バイトある`;
}

/** 1つが上限を超えるときの断り。`kind` は画像かそれ以外か。 */
export function attachmentTooLargeMessage(
  kind: 'image' | 'file',
  bytes: number,
  limitBytes: number,
): string {
  return `${kind === 'image' ? '画像' : 'ファイル'}は 1 つ ${formatAttachmentLimit(limitBytes)} まで（${describeAttachmentActual(bytes, limitBytes)}）`;
}

/** 1発言の個数が上限を超えるときの断り。`count` は超えた後の個数。 */
export function attachmentTooManyMessage(maxPerMessage: number, count: number): string {
  return `1 発言に添えられるのは ${maxPerMessage} 個まで（${count} 個）`;
}

/** 1発言の合計が上限を超えるときの断り。`totalBytes` は超えた後の合計。 */
export function attachmentTotalTooLargeMessage(maxTotalBytes: number, totalBytes: number): string {
  return `1 発言の合計は ${formatAttachmentLimit(maxTotalBytes)} まで（${describeAttachmentActual(totalBytes, maxTotalBytes)}）`;
}
