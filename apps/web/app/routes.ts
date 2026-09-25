import { index, layout, route, type RouteConfig } from '@react-router/dev/routes';

/**
 * 画面の割り当ては CLI でできることに揃えてある。
 *
 * `alteroid chat` のスラッシュコマンド（`/managers` `/approvals` `/report`
 * `/run` `/event` `/memory` `/commitments`）に対応する場所が全部あること。
 * **片方でしかできないことを作らない** — 入口が増えただけで能力が変わるのはおかしい。
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
    route('practices', 'routes/practices.tsx'),
    route('practices/:slug', 'routes/practice-detail.tsx'),
    route('approvals', 'routes/approvals.tsx'),
    route('commitments', 'routes/commitments.tsx'),
    // 同じ日に複数あるので、日付だけでは1件に定まらない（`reports.tsx` の選択の doc）。
    route('reports/:date?/:reportId?', 'routes/reports.tsx'),
    route('usage', 'routes/usage.tsx'),
    route('tokens', 'routes/tokens.tsx'),
    route('access', 'routes/access.tsx'),
    // 人間が承認した Bash 許可の一覧・取り消し（Issue #863）。CLI の
    // `alteroid permission list/revoke` と同じ口。
    route('permissions', 'routes/permissions.tsx'),
    route('env-vars', 'routes/env-vars.tsx'),
    // 実行環境プロファイル（issue #1122）。CLI の `alteroid profile` と同じ口。
    route('profile', 'routes/profile.tsx'),
    // 人間の MCP 連携の登録（#325 段4）。CLI の `alteroid mcp` と同じ口。
    route('mcp-servers', 'routes/mcp-servers.tsx'),
    route('dropped', 'routes/dropped.tsx'),
    route('archive', 'routes/archive.tsx'),
    // CLI の `alteroid inbox remove` と同じ口（issue #972 / #1042）。
    route('inbox', 'routes/inbox.tsx'),
    route('schedule', 'routes/schedule.tsx'),
    route('settings', 'routes/settings.tsx'),
    route('*', 'routes/not-found.tsx'),
  ]),
] satisfies RouteConfig;
