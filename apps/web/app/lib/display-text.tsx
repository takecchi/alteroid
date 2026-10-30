import type { ReactNode } from 'react';

import { DisplayTextProvider } from '@alteroid/ui';
import { redactBody, redactError } from '@alteroid/logic';

const VALUE = { body: redactBody, error: redactError };

export function WebDisplayTextProvider({ children }: { children: ReactNode }) {
  return <DisplayTextProvider value={VALUE}>{children}</DisplayTextProvider>;
}
