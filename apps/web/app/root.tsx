import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import type { ReactNode } from 'react';

import { redactError } from '@alteroid/logic';
import { ApiProvider } from '@alteroid/swr';
import { DocumentTitle } from '@alteroid/ui';

import { WebDisplayTextProvider } from '~/lib/display-text';
import { usePreventWindowFileDrop } from '~/lib/use-prevent-file-drop';

import './app.css';

export function meta() {
  return [
    // 題名（`<title>`）を置かない: 固定の題名を置くと全画面が同じ題名になり、画面の側のものと重なるため
    { name: 'description', content: 'クローンの様子を見て、指示を出し、記憶を直す画面' },
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'apple-mobile-web-app-title', content: 'alteroid' },
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    // default / black にしない: 本文が状態バーの下から始まる不透明な帯になり、全画面にならないため
    { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
    { name: 'theme-color', content: '#0b0e18' },
  ];
}

export function links() {
  return [
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
    { rel: 'manifest', href: '/manifest.webmanifest' },
  ];
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className="dark">
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover を外さない: safe-area の inset が常に 0 のままになり、切り欠きを避ける指定が効かなくなるため */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  usePreventWindowFileDrop();
  return (
    <ApiProvider>
      {/* WebDisplayTextProvider を外さない: ui の部品の既定は恒等で、外すと伏せずに出るため */}
      <WebDisplayTextProvider>
        <Outlet />
      </WebDisplayTextProvider>
    </ApiProvider>
  );
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : '画面が落ちた';
  const detail = isRouteErrorResponse(error)
    ? error.data
    : error instanceof Error
      ? error.stack
      : String(error);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <DocumentTitle>{title}</DocumentTitle>
      <h1 className="text-lg font-semibold text-destructive">{title}</h1>
      {/* スタックを隠さない: 作者ひとりの道具で、隠すと「動かない」以上のことが分からなくなるため */}
      <pre className="mt-4 overflow-auto rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        {redactError(String(detail))}
      </pre>
    </main>
  );
}
