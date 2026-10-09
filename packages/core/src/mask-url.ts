/**
 * **import を1つも持たない。** ブラウザのバンドルへ入るので、サーバ専用の
 * ドメイン層を引き込まないためである（`permission-rule.ts` と同じ形）。
 */

export const URL_MASK = '***';

/**
 * **読めない URL は丸ごと伏せる** —— 読めないものの中のどこに鍵があるかは
 * 判別できない。
 *
 * **`password` を必ず見ること。** `username` だけを見ると、password だけの
 * userinfo（`https://:<秘密>@host`）が素通りする（#1622 の穴そのもの）。
 */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return URL_MASK;
  }
  const hidden =
    parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '';
  return hidden ? `${parsed.origin}${parsed.pathname}?${URL_MASK}` : url;
}
