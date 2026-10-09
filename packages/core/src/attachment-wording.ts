/**
 * 添付の大きさ・個数・合計の断りの文。サーバ（`validateAttachmentInput` / `validateAttachmentBatch`）・
 * Web の送る前の検査（`@alteroid/logic` の `checkAttachments`）・CLI と TUI の送る前の検査
 * （`AttachmentDraft.add`）の唯一の正本: 片方だけ直すと、同じ理由の断りが入口ごとに違う文で見える。
 * ファイル名は文に含めない。名前を前に付けるかは呼ぶ側が決める。
 *
 * import を1つも持たない: Web のバンドルへ入るので、core 本体（Node の組み込みと SDK）を引き込まないため。
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

export function formatAttachmentLimit(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : humanOneDecimal(bytes);
}

/** 丸めた表示が上限と同じになるときだけ、見分けがつくようバイトを添える。 */
export function describeAttachmentActual(bytes: number, limitBytes: number): string {
  const rounded = humanOneDecimal(bytes);
  if (rounded !== humanOneDecimal(limitBytes)) return `${rounded} ある`;
  return `${bytes.toLocaleString('en-US')} バイトある`;
}

export function attachmentTooLargeMessage(
  kind: 'image' | 'file',
  bytes: number,
  limitBytes: number,
): string {
  return `${kind === 'image' ? '画像' : 'ファイル'}は 1 つ ${formatAttachmentLimit(limitBytes)} まで（${describeAttachmentActual(bytes, limitBytes)}）`;
}

/** サーバ・Web・CLI の検査が全部これに揃う。`maxLargeFileBytes` を名乗らない旧いサーバの応答は 0（枠なし）として読む。 */
export function attachmentMaxBytes(
  limits: {
    readonly maxImageBytes: number;
    readonly maxFileBytes: number;
    readonly maxLargeFileBytes?: number;
  },
  image: boolean,
): number {
  if (image) return limits.maxImageBytes;
  const large = limits.maxLargeFileBytes ?? 0;
  return large > 0 ? Math.max(limits.maxFileBytes, large) : limits.maxFileBytes;
}

/** 大きいファイルは1発言の合計に数えない。 */
export function isLargeAttachmentSize(
  limits: { readonly maxFileBytes: number },
  size: number,
  image: boolean,
): boolean {
  return !image && size > limits.maxFileBytes;
}

export function attachmentTooManyMessage(maxPerMessage: number, count: number): string {
  return `1 発言に添えられるのは ${maxPerMessage} 個まで（${count} 個）`;
}

export function attachmentTotalTooLargeMessage(maxTotalBytes: number, totalBytes: number): string {
  return `1 発言の合計は ${formatAttachmentLimit(maxTotalBytes)} まで（${describeAttachmentActual(totalBytes, maxTotalBytes)}）`;
}
