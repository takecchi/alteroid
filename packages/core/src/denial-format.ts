// 何も import しない: Web（`@alteroid/core/denial-format`）と CLI が core 本体を評価せずに読むため。
// 書式を1か所に置く: 写すと片方だけ直り、クローンと人間が同じ拒否を見て違う判断をするため

/** 拒否した層の印。3値を3値のまま出す: 層が取れていない `undefined` をマネージャー側へ混ぜない */
export function denialActorTag(actor: 'manager' | 'worker' | undefined): string {
  return actor === 'manager' ? ' [マネージャー]' : actor === 'worker' ? ' [作業者]' : ' [層不明]';
}

/**
 * 時刻の取れていない拒否が1件でも在れば判定できない: どちらへも畳まない（判定できないという
 * 3つ目の状態を持つ）。報告が届いたことは止められた道具を別の手で越えたことを意味しないので、
 * 文面もそこで止める。`status` の値は増やさない。
 */
export function describeDenialFollowUp(
  denials: readonly { readonly lastAt?: string }[],
  lastReportAt: string | undefined,
): string | null {
  if (denials.length === 0) return null;
  const times = denials.map((denial) => denial.lastAt);
  if (times.some((time) => time === undefined)) {
    return '最後に止められた時刻が取れていない拒否が在るので、止められた後に報告が届いたかは判定できない';
  }
  const latest = (times as string[]).reduce((a, b) => (a > b ? a : b));
  if (lastReportAt !== undefined && lastReportAt > latest) {
    return (
      `最後に止められた（${latest}）後にも報告が届いている（${lastReportAt}）。` +
      '止められた道具を別の手で越えたかまでは見ていない'
    );
  }
  return `最後に止められた（${latest}）後の報告はまだ届いていない`;
}
