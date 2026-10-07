/**
 * 戻り先として受け入れるのは、同じオリジンのアプリ内パスだけ。`//` と `/\` は
 * ブラウザがホストとして読むので弾く。`/login` へ戻すと、ログインしたのにログイン画面へ戻る。
 *
 * 元の場所は URL の query ではなく `Navigate` の `state` で渡す: 外から書き換えられる入口を作らず、
 * ログイン画面の URL を変えないため。
 */
export function returnPathFrom(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && /^\/(?![/\\]|login([/?#]|$))/.test(from) ? from : '/';
}
