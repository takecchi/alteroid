// 「ファイル」画面（#4126 P7）の純ロジック: 出所のラベル・寿命の言い方。
// 出所の分類は core の `classifyAttachmentFrom` の写し（core の値の import は禁止なので複製する。ずれは attachment-files.test.ts が core と突き合わせて落とす）。
import { formatDateTime } from './format.js';
import type { AttachmentFrom, AttachmentItem } from './types.js';

export const ATTACHMENT_FROM_LABELS: Record<AttachmentFrom, string> = {
  human: '人間',
  clone: 'クローン',
  manager: 'マネージャー',
  integration: '連携',
  unknown: '不明',
};

export const ATTACHMENT_FROM_ORDER: readonly AttachmentFrom[] = [
  'human',
  'clone',
  'manager',
  'integration',
  'unknown',
];

export function attachmentFromOf(uploadedBy: string | undefined): AttachmentFrom {
  if (uploadedBy === undefined) return 'unknown';
  if (uploadedBy === 'operator' || uploadedBy.startsWith('account:')) return 'human';
  if (uploadedBy === 'clone') return 'clone';
  if (uploadedBy.startsWith('manager:')) return 'manager';
  if (uploadedBy.startsWith('integration:')) return 'integration';
  return 'unknown';
}

export function isAttachmentFrom(value: string | null | undefined): value is AttachmentFrom {
  return ATTACHMENT_FROM_ORDER.some((from) => from === value);
}

export interface AttachmentLifetime {
  kept: boolean;
  text: string;
}

/** 保存中なら「保存中」、そうでなければ期限（`expiresAt`）を「〇〇に消える」と言う。期限が無い未保存は「期限は不明」。 */
export function describeAttachmentLifetime(
  item: Pick<AttachmentItem, 'keptAt' | 'expiresAt'>,
  now: number = Date.now(),
): AttachmentLifetime {
  if (item.keptAt !== undefined) return { kept: true, text: '保存中' };
  if (item.expiresAt === undefined) return { kept: false, text: '期限は不明' };
  return { kept: false, text: `${formatDateTime(item.expiresAt, now)} に消える` };
}
