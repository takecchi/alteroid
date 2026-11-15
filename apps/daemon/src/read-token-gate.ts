// `read` のアクセストークンが通れる経路の許可表（既定拒否）。経路（メソッド＋パスのパターン）の明示の一覧で、新しい口を足しても自動では入らない。
// 「GET だけ」を条件にしない: GET にも値を返す口（`GET /credentials`・`/mcp-servers`・`/profile` など）が在る。
// 一覧の根拠: `alteroid diagnostics pull`（`apps/cli/src/diagnostics-pull.ts`）が叩く GET（`/usage`・`/journal`・`/self/prompt`・`/memory`・`/memory/:slug`）が全部通る最小の集合、MCP の読み取りの道具（`POST /mcp`）、本人確認（`GET /auth/me`）、自分1本の失効（`POST /auth/logout`）。
// `read` は連携の鍵と同じ型の固定の境界（配布範囲）であって、行為ごとのスコープではない（2026-11-15 のオーナー決定）。許可表に足すときは、値を返す口でないことを人間が確かめる。
export const READ_TOKEN_ALLOWED_ROUTES = [
  { method: 'GET', path: '/auth/me' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'POST', path: '/mcp' },
  { method: 'GET', path: '/memory' },
  { method: 'GET', path: '/memory/:slug' },
  { method: 'GET', path: '/journal' },
  { method: 'GET', path: '/usage' },
  { method: 'GET', path: '/self/prompt' },
] as const;

type ReadTokenRouteVerdict = { allowed: true; route: string } | { allowed: false };

// `:name` は空でない1区間にだけ一致する（`/` をまたがない）。メソッドは大文字へ揃えて比べ、`HEAD` や `OPTIONS` は通さない。
function matchesPattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) => {
    const actual = pathSegments[index] ?? '';
    return segment.startsWith(':') ? actual.length > 0 : segment === actual;
  });
}

export function judgeReadTokenRoute(method: string, path: string): ReadTokenRouteVerdict {
  const upper = method.toUpperCase();
  for (const route of READ_TOKEN_ALLOWED_ROUTES) {
    if (route.method === upper && matchesPattern(route.path, path)) {
      return { allowed: true, route: `${route.method} ${route.path}` };
    }
  }
  return { allowed: false };
}
