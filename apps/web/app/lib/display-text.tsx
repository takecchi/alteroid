/**
 * `@alteroid/ui` の部品へ、伏せ字の関数を渡す provider（issue #2600）。
 *
 * ui は伏せ字を知らない（`packages/ui/src/lib/display-text.tsx`）。本番は `root.tsx` の `App` が、
 * テストは `~/test-support` の `Providers` が、この同じ部品で包む。
 */
import type { ReactNode } from 'react';

import { DisplayTextProvider } from '@alteroid/ui';
import { redactBody, redactError } from '@alteroid/logic';

const VALUE = { body: redactBody, error: redactError };

export function WebDisplayTextProvider({ children }: { children: ReactNode }) {
  return <DisplayTextProvider value={VALUE}>{children}</DisplayTextProvider>;
}
