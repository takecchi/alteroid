/**
 * 1 から始める。拒否の重要度は繰り返し回数と相関せず、一度きりで取り返しのつかない行為ほど繰り返されない
 * ので、3 から数えると件数が 1 で止まって永久に上がらない。作業者の上限到達も同じで、上げると1回目自体が届かない。
 * 刻み（3倍ごと）は動かさない: 「N 件で N 通」にすると受信箱が埋まりクローンの判断が雑音で鈍る。
 */
export const DENIED_ESCALATE_AT = 1;

// 上げ続けない: 止められ続けている1本が受信箱を埋めると他の判断材料が押し流される。黙りもしない: 続けば次の桁でもう一度出る。
// 入口（1）と刻み（3倍）は別の判断: 入口を上げると一度きりの拒否が黙り、刻みを詰めると1件ずつ流す形に戻る。
// 担当の道具の拒否（`manager.ts`）と作業者の上限到達（`runner-subagent-stop-state.ts`）で共有する: 片方だけ直すと間引きが黙ってずれる。
export function shouldEscalateDenial(count: number): boolean {
  if (count < DENIED_ESCALATE_AT) return false;
  let step = DENIED_ESCALATE_AT;
  while (step < count) step *= 3;
  return step === count;
}
