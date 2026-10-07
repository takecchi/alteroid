import { redactErrorText, redactSecretsInBody } from '@alteroid/core/redact';

// データではなく描画の側で掛ける: 編集の下書きや回答欄に伏せ字が入り、人が再送する本文になるため。
export function redactBody(text: string): string {
  return redactSecretsInBody(text, undefined);
}

export function redactError(text: string): string {
  return redactErrorText(text, undefined);
}
