// id を名前へ解決しない: そのアカウントが一覧から既に消えていることがありうるため
export function describeGrantedBy(grantedBy: string | null): string {
  if (grantedBy === null) return '不明';
  if (grantedBy === 'operator') return '実行環境の持ち主';
  return grantedBy;
}

/** カンマ区切りの入力を、前後の空白を落とし空を除いた配列にする。 */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
