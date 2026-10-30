import type { ReactNode } from 'react';

import { DisplayTextProvider } from '@alteroid/ui';
import { redactBody, redactError } from '@alteroid/logic';

/** プラグインのプレビュー・導入の失敗文の頭に付く、サーバ内部のクラス名（`PluginFetchError: `）を落とす */
export function stripErrorClassName(text: string): string {
  return text.replace(/^PluginFetchError:\s*/, '');
}

const VALUE = {
  body: redactBody,
  error: (text: string) => stripErrorClassName(redactError(text)),
};

export function WebDisplayTextProvider({ children }: { children: ReactNode }) {
  return <DisplayTextProvider value={VALUE}>{children}</DisplayTextProvider>;
}
