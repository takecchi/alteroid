// import を1つも持たない: ブラウザのバンドルへ入る軽い口のため。
// system-error.ts の型を使わず手で複製する: zod ごとブラウザバンドルへ入るため
export interface SystemErrorFactsLike {
  readonly code: string;
  readonly errno?: number;
  readonly syscall?: string;
}

export function formatSystemErrorFacts(systemError: SystemErrorFactsLike): string {
  const facts = [`code=${systemError.code}`];
  if (systemError.errno !== undefined) facts.push(`errno=${systemError.errno}`);
  if (systemError.syscall !== undefined) facts.push(`syscall=${systemError.syscall}`);
  return facts.join(' ');
}

// 指し先だけ pointer にする: クローン向けと Web UI 向けで次に見る場所が違うため
export function formatSystemErrorUnknownNote(pointer: string): string {
  return (
    '器の資源による落ち方かどうかは、この欄では判定できなかった。' +
    '枠に当たった場合・セッションが切れた場合もこの欄には出ない —— ' +
    `本文と${pointer}`
  );
}
