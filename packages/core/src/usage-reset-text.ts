/**
 * 上限の文言に書かれている**リセット時刻**を読む（#682）。
 *
 * ## 何のためにあるか
 *
 * `resetsAt`（構造化された枠の事実）が届かなかった回の冷却は、設定の既定
 * （5時間）へ倒れる。**そしてその回の文言には、答えが書いてあることがある:**
 *
 * ```
 * "reason":"You've hit your session limit · resets 10:10pm (Asia/Tokyo)"   ← ここ
 * "cooldown_until":"2026-09-07T16:52:56.162Z"                              ← 実際に入った値（+5h）
 * ```
 *
 * 実測（2026-09-07、Railway の本番）で `10:10pm (Asia/Tokyo)` = `13:10Z` は、
 * **同じ鍵に前の回で入っていた `resetsAt`（`2026-09-07T13:10:00.000Z`）と逐語で
 * 一致していた** ⟹ この文言は正しい。
 *
 * ## ⚠️ `usage-limits.ts` の「文言のパターンを自前で書かない」に反しないか
 *
 * **反しない。ただしこれは判定であって、あの doc が明示していることではない**
 * （#682 の本文が同じ判断を書いている）。あの禁止の理由は逐語で「手で書いた
 * 正規表現は必ず腐る — しかも腐り方が**『検知しなくなる』**なので、静かに効かなく
 * なる」である ⟹ **禁じているのは検知**（その文言が上限の文言かどうか）である。
 *
 * **期限の抽出は腐り方が違う。** 外れたら**いまの振る舞い（設定の既定）に落ちる
 * だけ**で、静かに悪化しない。⟹ 同じ理由では禁じられない。
 *
 * **⚠️ 検知のほうへ手を伸ばさないこと。** 接頭辞の判定は
 * `USAGE_LIMIT_ERROR_PREFIXES` のままにする（`usage-limits.ts` の禁止はそこに
 * 効いている）。ここが答えるのは「**その文言に時刻が書いてあるか**」だけである。
 *
 * ## 先に測ったこと（#682「先に測ること」）
 *
 * #682 は「時刻の書式が設定で変わるかもしれない。**先に測ること**」と書いていた。
 * 測った（2026-09-07、この器の `claude` CLI `2.1.263` の中の文字列）。
 *
 * - 文言を組んでいるのは `` ` \xB7 resets ${_}` `` の形で、`_` は
 *   `Au(e.resetsAt, !0)` の出力である
 * - その `Au` は **`toLocaleTimeString("en-US", { hour: "numeric", minute: …,
 *   hour12: !0 })` を直に呼んでいる** ⟹ ロケールと 12/24 時間は**引数に焼いて
 *   ある。設定を読んでいない**
 * - 末尾の帯の名前は `Intl.DateTimeFormat().resolvedOptions().timeZone`
 *   （＝**器の帯**）である
 *
 * **⟹ この器で測ったかぎり、下の SDK の設定はこの文言の時刻を作っていない。**
 *
 * [sdk-verbatim Settings.timeFormat]
 * > Clock format for times shown in the UI: "auto" (default, follows the locale), "12-hour", "24-hour", "24-hour-utc" ("18:05Z"), or a strftime pattern such as "%H:%M" (any value containing "%"; other values read as "auto"). A pattern replaces the time everywhere; message timestamps show only the pattern, so include %Y-%m-%d for the date. /config offers the presets; a pattern is set here.
 *
 * [sdk-verbatim Settings.timeZone]
 * > IANA time zone for times shown in the UI, e.g. "UTC" or "Europe/Dublin". Default: the system time zone. An unknown name falls back to the system time zone.
 *
 * **⚠️ そして「測った」の範囲を広げて読まないこと。** 見たのは
 * **CLI のバイナリの中の実装**であって、契約ではない —— **版が上がれば変わりうるし、
 * 変わっても赤くならない**（当たらなくなるだけである）。上の2つに印を付けてあるのは、
 * *設定の側の記述*が変わったときに CI を赤くして、**この測り直しを促すため**である。
 *
 * ## だから2つの条件で自分を守る
 *
 * 1. **帯の名前が明示されている形だけを受ける。** `resets at 5pm`（帯が無い。
 *    この repo の既存の歯に fixture が在る）は**受けない** ——どの帯なのか
 *    決められない。**そして帯が要る理由はもう1つある** —— 時刻を描いた側と
 *    ラベルは同じ器の帯を使っているので、**「どの帯か」を当てに行かずに、
 *    書いてある帯でそのまま解釈できる**
 * 2. **描き直して突き合わせる**（{@link parseNoticeResetAt} の実装）。作った時刻を
 *    その帯で描き直して、読んだ `hh:mm` と一致しなければ**使わない。** ⟹ 夏時間の
 *    切り替わりや器の癖で外れた回は、**黙って既定へ落ちる**（今日の振る舞いに戻る）
 *
 * ## 誤りは必ず「今日より短い」側にしか出ない
 *
 * 呼ぶ側が窓（`withinMs`）を渡し、ここは `(at, at + withinMs]` の外を捨てる。
 * ⟹ **返る値は必ず設定の既定より早い。** 日付が書かれていないこと（`10:10pm` は
 * 今日か明日か）から来る `+24h` の事故も、この挟みだけで消える（24h > 5h なので
 * 落ちる）。#678 と同じ単調性である —— **この変更のせいで長く寝る形は作れない。**
 */

/**
 * `resets <時刻> (<帯>)` の形。**帯が無い形は当たらない**（上の条件1）。
 *
 * - `10:10pm` / `10pm` の両方を受ける —— 分が 0 の回は分そのものが描かれない
 *   （測った `Au` が `minute: u === 0 ? void 0 : "2-digit"` を渡している）
 * - `resets` の直後は**数字でなければならない。** `resets at 5pm` は当たらず、
 *   1日以上先の形（`resets Sep 8, 10:10pm (…)`）も当たらない ——**後者を
 *   受けないのは正しい**（窓が5時間なら、どうせ挟みで落ちる）
 * - 帯の名前は IANA の字種だけを受ける（`Asia/Tokyo` / `UTC` / `Etc/GMT+9`）。
 *   **形の検査はここでは終わらない** —— 実在するかは `Intl` に聞く（{@link zonedHourMinute}）
 */
const RESETS_AT_PATTERN = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z0-9_+\-/]+)\)/i;

/** 1日ぶんの分数。 */
const MINUTES_PER_DAY = 24 * 60;

/**
 * その瞬間を、その帯の**壁時計の時と分**にする。読めなければ `undefined`。
 *
 * **`hourCycle: 'h23'` を明示する。** 既定（`hour12` 未指定）では器のロケールに
 * よって `24` が返る帯があり、**深夜0時だけ 24 として読む**形が生まれる。
 *
 * **投げない。** 実在しない帯の名前で `Intl` は `RangeError` を投げるので、
 * ここで飲んで `undefined` にする（帯の実在の検査を兼ねている）。
 */
function zonedHourMinute(zone: string, at: number): { hour: number; minute: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
    return { hour, minute };
  } catch {
    return undefined;
  }
}

/** 12 時間表記を 0〜23 へ。`12am` は 0 時、`12pm` は 12 時である。 */
function to24Hour(hour12: number, meridiem: 'am' | 'pm'): number {
  if (meridiem === 'am') return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

export interface ParseNoticeResetOptions {
  /** 判定の基準時刻（epoch ミリ秒）。**観測した時刻を渡す。** */
  at: number;
  /**
   * 受ける窓の幅（ミリ秒）。**設定の既定（`cooldownMs`）を渡す。**
   *
   * `(at, at + withinMs]` の外は捨てる ⟹ **返る値は必ず既定より早い**
   * （この module の doc「誤りは必ず今日より短い側にしか出ない」）。
   */
  withinMs: number;
}

/**
 * 上限の文言から**リセット時刻**（epoch ミリ秒）を読む。読めなければ `undefined`。
 *
 * **決して投げない。** ここは観測の後始末であって仕事ではないので、想定外の形は
 * すべて「読めなかった」へ落とす（呼ぶ側は設定の既定へ倒す）。
 *
 * **抽出した値を「権威ある値」と同じ顔にしないこと**（#682 の地雷）。`resetsAt` は
 * SDK が構造化して渡してきたもので、こちらは**文字列から読んだ推測**である ⟹
 * 呼ぶ側は出所を `notice_text` として記録する（`CooldownSource`）。
 */
export function parseNoticeResetAt(
  text: string,
  options: ParseNoticeResetOptions,
): number | undefined {
  const matched = RESETS_AT_PATTERN.exec(text);
  if (matched === null) return undefined;
  const [, rawHour, rawMinute, rawMeridiem, zone] = matched;
  if (rawHour === undefined || rawMeridiem === undefined || zone === undefined) return undefined;

  const hour12 = Number(rawHour);
  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  // `\d{1,2}` は `0` も `13` も通す。**時計として在りえない値は捨てる。**
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = to24Hour(hour12, rawMeridiem.toLowerCase() === 'am' ? 'am' : 'pm');

  const nowInZone = zonedHourMinute(zone, options.at);
  // 帯が実在しない（または読めない）⟹ どの瞬間なのか決められない。
  if (nowInZone === undefined) return undefined;

  // **次に来る `hh:mm` までの分数。** 同じ分ぴったりのときは「次の日」へ回す
  // ——`at` より後でなければ、いま止まったことの期限にならない（そして窓が
  // 1日より狭ければ、そのまま挟みで落ちる）。
  const target = hour * 60 + minute;
  const current = nowInZone.hour * 60 + nowInZone.minute;
  const delta = ((target - current + MINUTES_PER_DAY - 1) % MINUTES_PER_DAY) + 1;

  // **分の頭へ揃えてから足す。** 帯の差は必ず分単位なので、epoch の分の頭は
  // どの帯でも分の頭である。
  const candidate = options.at - (options.at % 60_000) + delta * 60_000;

  // **描き直して突き合わせる**（この module の doc の条件2）。夏時間の切り替わりが
  // 窓の中に在ると上の足し算は外れるので、**外れたことをここで捕まえて捨てる。**
  const rendered = zonedHourMinute(zone, candidate);
  if (rendered === undefined || rendered.hour !== hour || rendered.minute !== minute) {
    return undefined;
  }

  // **窓の外は使わない。** ここが「今日より長く寝る形は作れない」を支えている。
  if (candidate <= options.at || candidate > options.at + options.withinMs) return undefined;
  return candidate;
}
