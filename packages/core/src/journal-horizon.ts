/**
 * 日誌の窓（`since`）が地平（`JournalStore.oldestAt()`）より前にかかるかの
 * 判定（issue #1510 の積み残し）。
 *
 * **なぜ切り出したか。** この条件はもともと `tools.ts` の
 * `describeJournalHorizonNote`（`journal_read` に添える注記の可否）の中に
 * 埋め込まれていたが、`GET /journal`（`apps/daemon/src/app.ts`）にも同じ
 * 情報を構造化された欄として返す必要が出た（issue #1510 のクローズ時点の
 * 積み残し「`GET /journal`（HTTP）と Web の画面には、同じ注記がまだ無い」）。
 * **同じ条件を2箇所に書くと、片方だけ直された回に気づけなくなる**
 * （`journal-time.ts` の doc「ストア側にも同じ判定を足すと…」と同じ理由）
 * ので、判定そのものをここへ1本にまとめ、`journal_read` と `GET /journal`
 * の両方から呼ぶ。
 *
 * **判定条件。** 窓の始点 `start` は `since`（無指定なら過去へ無限に開いて
 * いる＝ `-∞`）——`until` は関与しない。
 *
 * - **窓がまるごと地平より後ろ（`start >= oldestAt`）**: 偽。その窓は
 *   日誌が持っている範囲に収まっているので、0件なら「本当に無かった」と
 *   言い切れる
 * - **`start < oldestAt`**: 真。`start` から地平までの区間は日誌が持って
 *   いないので、その区間について「無かった」と「そこまで遡れないだけ」を
 *   区別できない
 * - `oldestAt` が `null`（日誌そのものが空）なら、比べる地平が無いので常に偽
 *
 * **`since` は正規化済みであることを前提にしない。** 読めない文字列
 * （`Date.parse` が `NaN`）が来ても、判定できない側（真）へ倒す——
 * `journal_read` の入口（`tools.ts`）も `GET /journal` の入口（`app.ts`）も
 * 今は `since` を正規化してから渡す（issue #1515）ので通常は起こらないが、
 * ここは呼び出し側の正規化に依存しない防御として残す。
 */
export function journalWindowCrossesHorizon(
  oldestAt: string | null,
  since: string | undefined,
): boolean {
  if (oldestAt === null) return false;
  // **時刻として比べる（文字列では比べない）。** `since` は自由な ISO 8601 で、
  // 秒の省略（`…T20:21Z`）やオフセット（`+09:00`）を含みうる。辞書順では
  // `'…T20:21Z' > '…T20:21:05.123Z'` になり、地平より前の since を後ろと
  // 取り違える。読めない since は比べられないので、判定できない側（真）へ倒す。
  const sinceMs = since === undefined ? Number.NaN : Date.parse(since);
  if (since !== undefined && !Number.isNaN(sinceMs) && !(sinceMs < Date.parse(oldestAt))) {
    return false;
  }
  return true;
}
