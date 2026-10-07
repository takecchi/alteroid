// hash（`#token-<id>`）ではなくクエリパラメタにする: 遷移直後の1回しか hash スクロールせず、非同期取得の行がまだ DOM に無いと素通りするため。
export const TOKEN_ID_PARAM = 'tokenId';

export interface TokensHrefFilter {
  tokenId?: string;
}

export function tokensHref(filter: TokensHrefFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.tokenId !== undefined && filter.tokenId !== '') {
    params.set(TOKEN_ID_PARAM, filter.tokenId);
  }
  const query = params.toString();
  return query === '' ? '/tokens' : `/tokens?${query}`;
}
