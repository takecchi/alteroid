/**
 * `/tokens` への導線を組み立てる。
 *
 * 使用量の画面（`usage.tsx`）の「認証トークン別」から、その id の行へ飛ぶ href を
 * 1本化する——`usage-links.ts`・`managers-links.ts` と同じ理由:
 * **URL の欄名を呼び出し側（`usage.tsx`）と行き先（`tokens.tsx`）の両方で
 * 書き写すと、直すときに片方だけ変わる。**
 *
 * **hash（`/tokens#token-<id>`）ではなく、クエリパラメタにした。** 理由は
 * 2つ:
 *
 * 1. **react-router の hash スクロールは非同期データと相性が悪い。**
 *    `<ScrollRestoration>`（`root.tsx`）は `location.hash` があれば
 *    `document.getElementById(...)` → `el.scrollIntoView()` を**遷移直後の
 *    1回の `useLayoutEffect`** で行う。`/tokens` のプール一覧は `useTokens`（SWR）で
 *    非同期に取得するため、冷えたキャッシュで遷移した瞬間には対象の
 *    `<li id="token-...">` がまだ DOM に無く、その1回を素通りする——
 *    再実行のきっかけ（`location` の変化）はその後来ないので、データが届いても
 *    スクロールしない。
 * 2. **強調はブラウザ側の機構が持たない**ので、どのみち `tokens.tsx` 側に自前の
 *    effect が要る。それなら `tokens.tsx` がデータ読み込み後の render で
 *    スクロールと強調の両方を行い、入力は `useSearchParams` でそのまま読める
 *    クエリパラメタにするほうが素直。
 *
 * **DOM の `id="token-<id>"` 自体は `tokens.tsx` の `TokenRow` に残す**
 * （行を指す安定した目印として、テスト・直接リンクに効く）。
 * 使わないのは「hash をナビゲーションの入力として使う」ことだけである。
 */
export const TOKEN_ID_PARAM = 'tokenId';

/** `tokensHref` が受け取る絞り込み。空文字・`undefined` は「その欄は載せない」。 */
export interface TokensHrefFilter {
  tokenId?: string;
}

/**
 * `/tokens` への href を組み立てる。`tokenId` を渡すと、その id の行へ
 * スクロール・強調するための問い合わせパラメタを載せる。空文字・
 * `undefined` なら欄を載せない（`usage.tsx` が無い欄を「絞り込みなし」
 * として読むのと同じ規約）。
 */
export function tokensHref(filter: TokensHrefFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.tokenId !== undefined && filter.tokenId !== '') {
    params.set(TOKEN_ID_PARAM, filter.tokenId);
  }
  const query = params.toString();
  return query === '' ? '/tokens' : `/tokens?${query}`;
}
