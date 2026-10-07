import type { ReactNode } from 'react';

export const APP_TITLE = 'alteroid';

export function formatDocumentTitle(screen: string): string {
  return `${screen} - ${APP_TITLE}`;
}

// root の meta に固定の題名を置かない: React 19 が引き上げる `<title>` と重なるため
export function DocumentTitle({ children }: { children: string }): ReactNode {
  return <title>{formatDocumentTitle(children)}</title>;
}
