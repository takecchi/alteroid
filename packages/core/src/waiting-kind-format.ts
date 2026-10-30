// 何も import しない: core（manager_list）と CLI が同じ1本を読むため。写すと片方だけ直り、クローンと人間が同じ待ちを違う言葉で読む

/**
 * 二択へ畳まない: 旧 runner の応答には `kind` が乗らず、「実行許可」と嘘をつくとクローンが質問に許可／拒否で答え、
 * 人間（CLI）は実際は質問だった確認に `/allow` を打ってしまうため
 */
export function describeWaitingKind(kind: 'question' | 'permission' | undefined): string {
  if (kind === 'question') return '質問';
  if (kind === 'permission') return '実行許可';
  return '種別不明';
}
