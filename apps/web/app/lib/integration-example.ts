/**
 * 連携の鍵の「送り方の例」に出す接続先（Issue #3210）。
 *
 * 同一オリジンの既定（`SAME_ORIGIN_BASE_URL` = `/api`）は `/` で始まる相対で、そのまま
 * `curl -X POST /api/events/<source>` と書くとホスト名が無く、外のサービスの設定に写しても
 * 動かない。**`/` で始まるときは `origin` を前に付けて絶対 URL にする。** 絶対ならそのまま。
 * 末尾のスラッシュは落とす。
 *
 * 画面から `window.location.origin` を渡す（切り出したのは、jsdom の `fetch` が相対の接続先を
 * 扱えず、画面ごとのテストでは相対のまま通せないため。出力は変えていない）。
 */
export function exampleBaseUrl(baseUrl: string, origin: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return baseUrl.startsWith('/') ? `${origin}${trimmed}` : trimmed;
}
