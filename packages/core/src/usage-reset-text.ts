// 検知のほうへ手を伸ばさない: 接頭辞の判定は USAGE_LIMIT_ERROR_PREFIXES のまま。ここが答えるのは文言に時刻が書いてあるかだけで、外れても設定の既定に落ちるだけで静かに悪化しない
// この文言の時刻は SDK の設定（timeFormat / timeZone）で作られていない（CLI の実装を測った結果。契約ではないので、設定側の記述が変わったら CI を赤くして測り直しを促す）:
// [sdk-verbatim Settings.timeFormat]
// > Clock format for times shown in the UI: "auto" (default, follows the locale), "12-hour", "24-hour", "24-hour-utc" ("18:05Z"), or a strftime pattern such as "%H:%M" (any value containing "%"; other values read as "auto"). A pattern replaces the time everywhere; message timestamps show only the pattern, so include %Y-%m-%d for the date. /config offers the presets; a pattern is set here.
// [sdk-verbatim Settings.timeZone]
// > IANA time zone for times shown in the UI, e.g. "UTC" or "Europe/Dublin". Default: the system time zone. An unknown name falls back to the system time zone.

// 帯が無い形（`resets at 5pm`）を受けない: どの帯か決められないため
const RESETS_AT_PATTERN = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z0-9_+\-/]+)\)/i;

const MINUTES_PER_DAY = 24 * 60;

// `hourCycle: 'h23'` を明示する: 既定だとロケールによって深夜0時が 24 で返るため
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

function to24Hour(hour12: number, meridiem: 'am' | 'pm'): number {
  if (meridiem === 'am') return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

/**
 * 文言に書かれたリセット時刻の言い回し（`resets 12:20am (Asia/Tokyo)`）をそのまま返す。時刻へは直さない。
 * 読む形は {@link parseNoticeResetAt} と同じ正規表現1本を共有する（2つ目を作ると片方だけ直る）。
 */
export function noticeResetText(text: string): string | undefined {
  return RESETS_AT_PATTERN.exec(text)?.[0];
}

export interface ParseNoticeResetOptions {
  at: number;
  withinMs: number;
}

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
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = to24Hour(hour12, rawMeridiem.toLowerCase() === 'am' ? 'am' : 'pm');

  const nowInZone = zonedHourMinute(zone, options.at);
  if (nowInZone === undefined) return undefined;

  const target = hour * 60 + minute;
  const current = nowInZone.hour * 60 + nowInZone.minute;
  const delta = ((target - current + MINUTES_PER_DAY - 1) % MINUTES_PER_DAY) + 1;

  const candidate = options.at - (options.at % 60_000) + delta * 60_000;

  // 描き直して突き合わせる: 夏時間の切り替わりで外れた回を黙って通さず捨てるため
  const rendered = zonedHourMinute(zone, candidate);
  if (rendered === undefined || rendered.hour !== hour || rendered.minute !== minute) {
    return undefined;
  }

  // 窓の外は使わない: 返る値を必ず設定の既定より早くし、長く寝る形を作らないため
  if (candidate <= options.at || candidate > options.at + options.withinMs) return undefined;
  return candidate;
}
