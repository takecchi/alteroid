// 文字列の `localeCompare` や `<` で比べない: オフセット付きの表記は同じ瞬間でも一意でなく、文字列順と実時刻順が食い違うため
// 同着の2次キーを決めない: pg の側が2次キーを持たず、足しても3実装は揃わないため
export function compareIsoInstant(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

export function earliestIsoInstant(values: Iterable<string>): string | undefined {
  let earliest: string | undefined;
  for (const value of values) {
    if (earliest === undefined || compareIsoInstant(value, earliest) < 0) earliest = value;
  }
  return earliest;
}
