import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

/**
 * 画面の割り当ては CLI でできることに揃えてある。
 *
 * `alteroid chat` のスラッシュコマンド（`/managers` `/approvals` `/report`
 * `/run` `/event` `/memory`）に対応する場所が全部あること。**片方でしかできない
 * ことを作らない** — 入口が増えただけで能力が変わるのはおかしい。
 */
export default [
  // ログインだけは shell の外（ナビも SSE も、通ってからでないと意味が無い）。
  route('login', 'routes/login.tsx'),
  layout('routes/shell.tsx', [
    index('routes/dashboard.tsx'),
    // 省略可能な引数。`/chat` は新しい会話、`/chat/:id` は続き。
    route('chat/:conversationId?', 'routes/chat.tsx'),
    route('journal', 'routes/journal.tsx'),
    route('managers', 'routes/managers.tsx'),
    route('managers/:id', 'routes/manager-detail.tsx'),
    route('memory', 'routes/memory.tsx'),
    route('memory/:slug', 'routes/memory-detail.tsx'),
    route('approvals', 'routes/approvals.tsx'),
    route('reports/:date?', 'routes/reports.tsx'),
    route('usage', 'routes/usage.tsx'),
    route('schedule', 'routes/schedule.tsx'),
    route('settings', 'routes/settings.tsx'),
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
