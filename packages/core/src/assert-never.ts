/**
 * 網羅検査の行き止まり。`value` が `never` でなくなる（分岐が足りなくなる）と型検査が落ち、
 * 実行時に未知の値が来たら `${label}: ${JSON.stringify(value)}` を投げる。
 */
export function assertNever(label: string, value: never): never {
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
