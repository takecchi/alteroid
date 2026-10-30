// 定期の依頼の説明文はサーバが書く。そこに混じる内部の語を、待ち行列の画面（task-parts の状態の言い換え）と
// 会話・管理の画面の言葉に直して出す。サーバの文が変わって当たらなくなったら、そのまま出る（黙って消さない）。
// 英語の語の前後の半角の空白も一緒に取る: 日本語の中へ置き換えると、空白だけが残って読みにくいため。
const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/ ?queued \/ needs_decision ?/g, '順番待ち・判断待ち'],
  [/ ?発意 tick ?/g, '発意のターン'],
];

export function describeScheduleText(text: string): string {
  return REPLACEMENTS.reduce((current, [from, to]) => current.replace(from, to), text);
}
