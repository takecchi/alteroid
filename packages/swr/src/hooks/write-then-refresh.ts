// 失敗しても取り直す（409 に限らない）: 台帳の行は裏で先に閉じられていることがあり、
// 例外で抜けると取り直しに届かず、未了の見た目のまま同じ 409 が繰り返される。
// 取り直しの失敗で元の失敗を上書きしない: 呼び出し側へ伝えるのは「なぜ書けなかったか」
export async function writeThenRefresh(
  write: () => Promise<void>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  let writeError: unknown;
  let failed = false;
  try {
    await write();
  } catch (caught) {
    writeError = caught;
    failed = true;
  }
  try {
    await refresh();
  } catch (refreshError) {
    if (!failed) throw refreshError;
  }
  if (failed) throw writeError;
}
