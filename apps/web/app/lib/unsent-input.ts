/**
 * 送ったあとの入力欄に残す文字列。応答を待つ間に打ち足した分を、成功のあとに消さない（issue #3515）。
 *
 * - いまの値が送った値と同じなら、空にする（これまでどおり）。
 * - 送った値の続きに打ち足していれば、送った分を除いた打ち足しだけを残す（送り済みの文を
 *   欄に残すと、そのまま押して二重に送ってしまう）。
 * - それ以外（途中を書き換えた）は、どこまでが送った分か決められないので、そのまま残す。
 */
export function unsentInput(current: string, sent: string): string {
  if (current === sent) return '';
  if (current.startsWith(sent)) return current.slice(sent.length).replace(/^\s+/, '');
  return current;
}
