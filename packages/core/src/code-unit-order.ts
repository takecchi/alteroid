// localeCompare にしない: 照合順がロケールと ICU の版で変わり、器と環境で一覧の並びがずれるため
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
