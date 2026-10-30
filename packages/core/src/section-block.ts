// ターンへ渡す文の節の末尾に区切りを足す形。何も import しない。
// 末尾の区切り（---）まで含めて返す: 呼び出し側で足すと、節を足すたびに #runTurn の連結にも手が要るため。
// 1本に置く: 節ごとに写すと、区切りの形が片方だけ変わり、読み手（クローン）が節の境を読み違えるため
export function sectionBlock(lines: readonly string[]): string {
  return [...lines, '', '---', ''].join('\n');
}
