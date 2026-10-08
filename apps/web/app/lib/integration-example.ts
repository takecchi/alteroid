export const ORIGIN_PLACEHOLDER = '<デーモンの origin>';

// 相対（/api）は外から届く先とは限らず、推測した URL を出さないため null
export function daemonOrigin(baseUrl: string): string | null {
  return baseUrl.startsWith('/') ? null : baseUrl.replace(/\/+$/, '');
}
