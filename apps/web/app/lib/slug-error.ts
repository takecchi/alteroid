// サーバは URL の名前が不正なとき「記憶のスラッグが不正」「やり方のスラッグが不正」と返す。
// 画面は URL の名前を「名前」と呼ぶ（`NewSlugForm` の欄）ので、画面の言葉と使える形で言い直す。
const SLUG_ERROR = /^(記憶|やり方)のスラッグが不正$/;

const USABLE_FORM = '使えるのは半角の英小文字・数字と . _ - で、先頭は英数字。128 文字まで';

/** 名前が不正の 400 の文だけ画面の言葉に差し替える。それ以外の値はそのまま返す */
export function describeSlugError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const match = SLUG_ERROR.exec(error.message.trim());
  if (match === null) return error;
  return new Error(`${match[1]}の名前が使えない形。${USABLE_FORM}`);
}
