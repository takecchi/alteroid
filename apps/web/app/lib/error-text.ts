import { AttachmentGoneError } from '@alteroid/swr';
import { redactError } from '@alteroid/logic';

/** catch した値を、秘密を伏せた1行の文にする。Error 以外の値は String() で文字にする */
export function errorText(caught: unknown): string {
  return redactError(caught instanceof Error ? caught.message : String(caught));
}

/**
 * 添付の取り出し・上げの失敗の文。期限切れ（AttachmentGoneError）は接頭辞を付けない固定文で、
 * `otherPrefix` は期限切れ以外のときだけ頭に付く（期限切れにまで付けると、画面の文言が変わるため）
 */
export function describeAttachmentFailure(caught: unknown, otherPrefix = ''): string {
  return caught instanceof AttachmentGoneError
    ? '取り出せない（期限切れの可能性）'
    : `${otherPrefix}${errorText(caught)}`;
}
