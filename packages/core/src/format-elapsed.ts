/**
 * 受け取ってから（あるいは、その時刻になってから）の経過（＝齢）を「N分 / N時間 / N日」で。
 *
 * 元は `apps/cli/src/format.ts` にあった実装。進捗の文（`describeProgress`）を
 * core へ寄せたとき、CLI と道具の両方が同じ丸めを使えるようここへ引き上げた
 * （字面・分岐は逐語のまま。CLI の `format.ts` はここからの再輸出）。
 *
 * 未来の時刻（時計のずれ）は 0 に丸める。読めない ISO（パース不能）は「不明」——
 * 0分前のように読める値を作らない。Node 専用のものは持ち込まない（web 向けバンドルに載りうる）。
 */
export function formatElapsed(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 3600) return `${Math.round(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}時間`;
  return `${Math.round(seconds / 86_400)}日`;
}
