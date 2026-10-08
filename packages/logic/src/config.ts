/// <reference types="vite/client" />
// ↑ `import.meta.env` の型。`apps/cli`（DOM も vite の型も持たない NodeNext）が型検査に載せても通すため、参照を自分で持つ。

// 接続先を外から渡せる経路（クエリ・ハッシュ・`document.referrer`・`postMessage`）から受け取らない:
// 攻撃者の URL を仕込んだリンクが、次のログインの資格情報の送り先になる。

const SELECTED_KEY = 'alteroid.apiBaseUrl';

// `SELECTED_KEY` とは別の鍵にする: 混ぜると「選んでいる」と「持っている」が区別できず、選び直した瞬間に前の接続先が消える。
const ENDPOINTS_KEY = 'alteroid.endpoints';

export const SAME_ORIGIN_BASE_URL = '/api';

export interface StoredEndpoint {
  url: string;
  label?: string;
}

export type EndpointOrigin = 'buildTime' | 'sameOrigin' | 'stored';

export interface Endpoint extends StoredEndpoint {
  origin: EndpointOrigin;
}

export function resolveApiBaseUrl(
  stored: string | null = readSelected(),
  buildTime: string | undefined = readBuildTime(),
): string {
  return normalize(stored) ?? parseBuildTimeEndpoints(buildTime)[0]?.url ?? SAME_ORIGIN_BASE_URL;
}

// `selected` はどこにも載っていなくても必ず一覧に入れる: 入れないと `select` の値がどの `option` とも一致せず、
// ブラウザが黙って先頭を表示して実際の接続先と表示が食い違う。
export function listEndpoints(
  stored: StoredEndpoint[] = readStoredEndpoints(),
  buildTime: string | undefined = readBuildTime(),
  selected: string | null = readSelected(),
): Endpoint[] {
  const entries: Endpoint[] = [];
  const seen = new Set<string>();
  const push = (entry: StoredEndpoint, origin: EndpointOrigin): void => {
    if (seen.has(entry.url)) return;
    seen.add(entry.url);
    entries.push({ ...entry, origin });
  };

  for (const entry of parseBuildTimeEndpoints(buildTime)) push(entry, 'buildTime');
  push({ url: SAME_ORIGIN_BASE_URL }, 'sameOrigin');
  for (const entry of stored) push(entry, 'stored');

  const selectedUrl = normalize(selected);
  if (selectedUrl !== undefined) push({ url: selectedUrl }, 'stored');

  return entries;
}

// URL として妥当かどうかは検査しない: 弾くと書いた値が画面に出ないまま消え、間違った値が出るより直しにくい。
export function parseBuildTimeEndpoints(
  raw: string | undefined = readBuildTime(),
): StoredEndpoint[] {
  if (raw === undefined || raw === null) return [];
  const out: StoredEndpoint[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(/[,\n]/)) {
    const entry = parseBuildTimeItem(item);
    if (entry === undefined || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

function parseBuildTimeItem(item: string): StoredEndpoint | undefined {
  const trimmed = item.trim();
  if (trimmed === '') return undefined;

  const separator = trimmed.indexOf('=');
  if (separator > 0) {
    const label = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 1).trim();
    // 右側が URL に見えるときだけラベル付きとして読む: `https://api.example.com/?x=1` が最初の `=` で切られないように。
    if (label !== '' && looksLikeUrl(rest)) {
      const url = normalize(rest);
      return url === undefined ? undefined : { url, label };
    }
  }

  const url = normalize(trimmed);
  return url === undefined ? undefined : { url };
}

// ホスト名だけの `example.com` を通さない: 相対 URL として解決され、画面と同じオリジンの `./example.com` を叩きに行く。
export function looksLikeUrl(value: string): boolean {
  return value.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

// 空白だけの値は未設定に倒す: `''` を通すと「同一オリジン」と区別が付かないまま設定済み扱いになる。
function normalize(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

export function normalizeEndpointUrl(value: string | null | undefined): string | undefined {
  return normalize(value);
}

function readSelected(): string | null {
  // prerender や typegen で window の無い文脈でも読まれうる。
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SELECTED_KEY);
}

// `import.meta.env` を各所で直に書かない: 既定値を渡す形と渡さない形が混ざり、`vi.stubEnv` で差し替えた経路だけが素通りする。
function readBuildTime(): string | undefined {
  return import.meta.env.VITE_ALTEROID_API_URL;
}

export function storeApiBaseUrl(value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const normalized = normalize(value);
  if (normalized === undefined) localStorage.removeItem(SELECTED_KEY);
  else localStorage.setItem(SELECTED_KEY, normalized);
}

// `Endpoint.origin` とは別の問い: こちらは明示の選択が在るか、`Endpoint.origin` は一覧のどの段に載っているか。
// 一覧からビルド時の既定を選ぶと、こちらは `'stored'`、その行の `origin` は `'buildTime'` になる。統合しない。
export type ApiBaseUrlOrigin = 'stored' | 'buildTime' | 'sameOrigin';

export function resolveApiBaseUrlOrigin(
  stored: string | null = readSelected(),
  buildTime: string | undefined = readBuildTime(),
): ApiBaseUrlOrigin {
  if (normalize(stored) !== undefined) return 'stored';
  if (parseBuildTimeEndpoints(buildTime).length > 0) return 'buildTime';
  return 'sameOrigin';
}

export function hasStoredApiBaseUrl(): boolean {
  return resolveApiBaseUrlOrigin() === 'stored';
}

// 壊れた行だけ落とし、読めた行は残す: 1行壊れただけで人間の一覧が丸ごと消えるほうが害が大きい。
export function readStoredEndpoints(): StoredEndpoint[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(ENDPOINTS_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? sanitizeEndpoints(parsed) : [];
  } catch {
    return [];
  }
}

export function sanitizeEndpoints(value: unknown[]): StoredEndpoint[] {
  const out: StoredEndpoint[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { url, label } = item as { url?: unknown; label?: unknown };
    const normalized = normalize(typeof url === 'string' ? url : null);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    const trimmed = typeof label === 'string' ? label.trim() : '';
    out.push(trimmed === '' ? { url: normalized } : { url: normalized, label: trimmed });
  }
  return out;
}

export function storeEndpoints(list: StoredEndpoint[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(list));
}

export function upsertEndpoint(list: StoredEndpoint[], entry: StoredEndpoint): StoredEndpoint[] {
  const url = normalize(entry.url);
  if (url === undefined) return list;
  const label = entry.label?.trim();
  const next: StoredEndpoint = label === undefined || label === '' ? { url } : { url, label };
  const index = list.findIndex((item) => item.url === url);
  if (index === -1) return [...list, next];
  // 順番は変えない: 名前を直しただけで行が跳ぶと、人間は別のものが増えたと読む。
  return list.map((item, i) => (i === index ? next : item));
}

export function withoutEndpoint(list: StoredEndpoint[], url: string): StoredEndpoint[] {
  const target = normalize(url);
  if (target === undefined) return list;
  return list.filter((item) => item.url !== target);
}

// 選択中を保存済みの一覧へ写す: `listEndpoints` の補完は表示だけで、別の接続先へ切り替えた瞬間に元の接続先が失われるため。
export function migrateSelectionIntoStoredEndpoints(): void {
  const selected = normalize(readSelected());
  if (selected === undefined || selected === SAME_ORIGIN_BASE_URL) return;
  if (parseBuildTimeEndpoints().some((entry) => entry.url === selected)) return;
  const list = readStoredEndpoints();
  if (list.some((entry) => entry.url === selected)) return;
  storeEndpoints([...list, { url: selected }]);
}

export interface ConnectionName {
  name: string;
  title: string;
}

// 名前は一覧（`listEndpoints`）から引く: 別に持つと、名前を直した・切り替えた瞬間に札だけ古い名前を出すため。
// 名前が無ければホスト名に倒す（ポートも含める）: 同じ機械の別のデーモンを `localhost` だけでは見分けられないため。
export function describeConnection(
  endpoints: readonly Endpoint[],
  baseUrl: string,
  pageHref: string | null = readPageHref(),
): ConnectionName {
  const url = normalize(baseUrl) ?? baseUrl;
  const label = endpoints.find((entry) => entry.url === url)?.label;
  if (label !== undefined && label !== '') return { name: label, title: `${label} — ${url}` };
  const resolved = resolveUrl(url, pageHref);
  if (resolved === undefined || resolved.host === '') return { name: url, title: url };
  return { name: resolved.host, title: resolved.href.replace(/\/+$/, '') };
}

function resolveUrl(url: string, base: string | null): URL | undefined {
  try {
    return base === null ? new URL(url) : new URL(url, base);
  } catch {
    return undefined;
  }
}

// `globalThis` から読む: DOM の lib を持たない `apps/cli` もこのソースを型検査するので、`location` を名指しすると型が解けないため
function readPageHref(): string | null {
  const page = (globalThis as { location?: { href?: unknown } }).location;
  return typeof page?.href === 'string' ? page.href : null;
}
