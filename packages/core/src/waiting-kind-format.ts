// 何も import しない: core（manager_list）と CLI が同じ1本を読むため。写すと片方だけ直り、クローンと人間が同じ待ちを違う言葉で読む

export function describeWaitingKind(kind: 'question' | 'permission'): string {
  return kind === 'question' ? '質問' : '実行許可';
}
