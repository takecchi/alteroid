export function exampleBaseUrl(baseUrl: string, origin: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return baseUrl.startsWith('/') ? `${origin}${trimmed}` : trimmed;
}
