/**
 * `//` と `/\` を弾く: ブラウザがホストとして読むため。`/login` も弾く: 戻すとログインしたのにログイン画面へ戻るため。
 * 元の場所を query でなく `Navigate` の `state` で渡す: 外から書き換えられる入口を作らず、ログイン画面の URL を変えないため。
 */
export function returnPathFrom(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && /^\/(?![/\\]|login([/?#]|$))/.test(from) ? from : '/';
}
