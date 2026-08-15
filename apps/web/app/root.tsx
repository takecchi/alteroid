import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import type { ReactNode } from 'react';

import { ApiProvider } from '~/lib/api';

import './app.css';

export function meta() {
  return [
    { title: 'alteroid' },
    { name: 'description', content: 'クローンの様子を見て、指示を出し、記憶を直す画面' },
    // 単一ユーザーの道具であって公開物ではない。検索に載せない。
    { name: 'robots', content: 'noindex, nofollow' },
  ];
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        {/*
          `viewport-fit=cover` は `env(safe-area-inset-*)`（app.css の `--safe-*`）と
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
      <Outlet />
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
      <h1 className="text-lg font-semibold text-danger">{title}</h1>
      {/*
        スタックまで出すのは、これが作者ひとりの道具だからである。隠すと
        「動かない」以上のことが分からなくなり、掘る先が無くなる。
      */}
      <pre className="mt-4 overflow-auto rounded-md border border-border bg-surface p-3 text-xs text-muted">
        {String(detail)}
      </pre>
    </main>
  );
}
