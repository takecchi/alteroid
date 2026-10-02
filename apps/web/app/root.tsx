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

import { WebDisplayTextProvider } from '~/lib/display-text';

import './app.css';

export function meta() {
  return [
    { title: 'alteroid' },
    { name: 'description', content: 'クローンの様子を見て、指示を出し、記憶を直す画面' },
    // 単一ユーザーの道具であって公開物ではない。検索に載せない。
    { name: 'robots', content: 'noindex, nofollow' },
  ];
}

export function links() {
  return [
    // サイドバー左上の印（`BrandMark`）と同じ形。中身と色の決め方は `public/favicon.svg` の注釈に在る。
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  ];
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    /*
      既定は暗い側（`@alteroid/ui` の `styles.css` の `.dark`）。クローンは常駐して動き続ける
      もので、画面は長時間開けたままになる。
    */
    <html lang="ja" className="dark">
      <head>
        <meta charSet="utf-8" />
        {/*
          `viewport-fit=cover` は `env(safe-area-inset-*)`（`@alteroid/ui` の `styles.css` の `--safe-*`）と
          対である。これが無いと inset は常に 0 のままで、切り欠きを避ける指定が
          まるごと効かない。
        */}
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
  return (
    <ApiProvider>
      {/* ui の部品へ伏せ字を渡す。全 route を包む（既定は恒等で、外すと伏せずに出る。root.redact.test.tsx が固定） */}
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
      <h1 className="text-lg font-semibold text-destructive">{title}</h1>
      {/*
        スタックまで出すのは、これが作者ひとりの道具だからである。隠すと
        「動かない」以上のことが分からなくなり、掘る先が無くなる。
      */}
      <pre className="mt-4 overflow-auto rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
        {redactError(String(detail))}
      </pre>
    </main>
  );
}
