/**
 * CLI と Web UI の唯一の正本: 判定を別々に持つと片方だけ直って、同じ秘密がもう片方から出る。
 *
 * import を1つも持たない: ブラウザのバンドルへ入るので、サーバ専用のドメイン層を引き込まないため。
 */

export const URL_MASK = '***';

/**
 * 読めない URL は丸ごと伏せる: どこに鍵があるか判別できない。
 * `password` を必ず見る: `username` だけだと `https://:<秘密>@host` が素通りする。
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
