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
 * 読む形は {@link parseNoticeResetAt}（`RESETS_AT_PATTERN`）を先に、当たらなければ {@link parseNoticeResetDatedAt}（`RESETS_DATED_PATTERN`）を見る。
 * 2本を順に見る: 1本へ広げると、日付を受けない既存の読み手が日付を無視して次の同じ時刻と読む。
 */
export function noticeResetText(text: string): string | undefined {
  return RESETS_AT_PATTERN.exec(text)?.[0] ?? RESETS_DATED_PATTERN.exec(text)?.[0];
}

/** 日付付きの形を読む窓。週の枠（7日）に1日の余裕を足した先まで。 */
export const DATED_RESET_LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;

// 日付付きの形（週の枠: `resets Oct 22, 4pm (Asia/Tokyo)`）。上の `RESETS_AT_PATTERN` は日付を受けないので、別の1本で持つ（広げると既存の読み手が日付を無視して次の同じ時刻と読む）。
// 年は文言に無い: 呼び出し時刻の年（と翌年）から、`at` に近い側を採る
const RESETS_DATED_PATTERN =
  /\bresets\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z0-9_+\-/]+)\)/i;

const MONTH_PREFIXES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(zone: string, at: number): ZonedParts | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const num = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const result = {
      year: num('year'),
      month: num('month'),
      day: num('day'),
      hour: num('hour'),
      minute: num('minute'),
    };
    return Object.values(result).every(Number.isInteger) ? result : undefined;
  } catch {
    return undefined;
  }
}

// その時間帯の壁時計（年月日時分）が指す瞬間を返す。夏時間の切り替わりなどで描き直しが合わない回は捨てる
function instantOfZonedWallClock(zone: string, wanted: ZonedParts): number | undefined {
  const asUtc = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const first = zonedParts(zone, asUtc);
  if (first === undefined) return undefined;
  const shown = Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute);
  const candidate = asUtc - (shown - asUtc);
  const rendered = zonedParts(zone, candidate);
  if (
    rendered === undefined ||
    rendered.year !== wanted.year ||
    rendered.month !== wanted.month ||
    rendered.day !== wanted.day ||
    rendered.hour !== wanted.hour ||
    rendered.minute !== wanted.minute
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * 日付付きの言い回し（`resets Oct 22, 4pm (Asia/Tokyo)`）を瞬間へ直す。読めない・日付が存在しない・窓の外なら `undefined`。
 * 窓は「`at` の1日前から `withinMs` 先まで」: 文言が届いた時点でリセット直後に当たった回を落とさないための1日ぶんの余裕。
 */
export function parseNoticeResetDatedAt(
  text: string,
  options: ParseNoticeResetOptions,
): number | undefined {
  const matched = RESETS_DATED_PATTERN.exec(text);
  if (matched === null) return undefined;
  const [, rawMonth, rawDay, rawHour, rawMinute, rawMeridiem, zone] = matched;
  if (
    rawMonth === undefined ||
    rawDay === undefined ||
    rawHour === undefined ||
    rawMeridiem === undefined ||
    zone === undefined
  ) {
    return undefined;
  }
  const monthIndex = MONTH_PREFIXES.indexOf(rawMonth.slice(0, 3).toLowerCase());
  const day = Number(rawDay);
  const hour12 = Number(rawHour);
  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  if (monthIndex < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) {
    return undefined;
  }
  const hour = to24Hour(hour12, rawMeridiem.toLowerCase() === 'am' ? 'am' : 'pm');
  const now = zonedParts(zone, options.at);
  if (now === undefined) return undefined;

  for (const year of [now.year, now.year + 1]) {
    const candidate = instantOfZonedWallClock(zone, {
      year,
      month: monthIndex + 1,
      day,
      hour,
      minute,
    });
    if (candidate === undefined) continue;
    if (candidate >= options.at - 24 * 60 * 60_000 && candidate <= options.at + options.withinMs) {
      return candidate;
    }
  }
  return undefined;
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
