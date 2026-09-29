/**
 * `/tokens` への導線を組み立てる（issue #2109。#2100 の段2）。
 *
 * 使用量の画面（`usage.tsx`）の「認証トークン別」は #2100 の段1（PR #2103）で
 * `/tokens` へのリンクになったが、飛び先は画面の頭で、その id の行ではな
 * かった。ここでは「その id の行へ飛ぶ」href を1本化する——`usage-links.ts`
 * （#2077 / #2078）・`managers-links.ts`（#2090）と同じ判断・同じ理由:
 * **URL の欄名を呼び出し側（`usage.tsx`）と行き先（`tokens.tsx`）の両方で
 * 書き写すと、直すときに片方だけ変わる。**
 *
 * **hash（`/tokens#token-<id>`）ではなく、クエリパラメタにした。** 理由は
 * 2つ:
 *
 * 1. **react-router の hash スクロールは「効くが、非同期データと相性が
 *    悪い」。** `root.tsx` の `<ScrollRestoration>` は内部で
 *    `useScrollRestoration` を呼んでおり（`react-router` の配布物——
 *    `node_modules/.pnpm/react-router@7.18.4.../node_modules/react-router/
 *    dist/development/chunk-OB3PAWPO.mjs` の `useScrollRestoration` 本体で
 *    確認した）、
 *    `location.hash` があれば `document.getElementById(...)` → 見つかれば
 *    `el.scrollIntoView()` を**遷移直後の1回の `useLayoutEffect`** で行う。
 *    `/tokens` のプール一覧は `useTokens`（SWR）で非同期に取得するため、
 *    冷えたキャッシュで遷移した瞬間には対象の `<li id="token-...">` が
 *    まだ DOM に無く、その1回の効果を素通りしてしまう——re-run のきっかけ
 *    (`location` の変化) がその後は来ないので、データが届いてからでは
 *    スクロールしない。
 * 2. **強調（controlled highlight）はブラウザ側の機構が最初から持たない**
 *    ので、どのみち `tokens.tsx` 側に自前の effect が要る。それなら
 *    `location.hash` に頼らず、`tokens.tsx` がデータ読み込み後の render で
 *    スクロールと強調の両方を行う——読む側の入力はクエリパラメタのほうが
 *    素直（`usage-links.ts` / `managers-links.ts` と同じ「1つの値は1つの
 *    クエリパラメタ」という語彙、`useSearchParams` でそのまま読める）。
 *
 * **DOM の `id="token-<id>"` 自体は `tokens.tsx` の `TokenRow` に残す**
 * （行を指す安定した目印として、テスト・将来の直接リンクの両方に効く）。
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
