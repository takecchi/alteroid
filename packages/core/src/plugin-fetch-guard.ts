import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';

/**
 * 判定後に git へ名前解決をやり直させない: DNS が差し替わると内部のアドレスへ届くので、通ったアドレスを固定する。
 * git にリダイレクトを辿らせない: 途中のホップが判定を通らないので、自分で辿って各ホップを判定する。
 * 判定できない形（読めない IP・変則表記）は通さない: 解釈の差が穴になるから。
 * 拒否の文言に解決したアドレスを載せない: 内部の構成を呼び手へ漏らさないため。
 */

export type SourceGuardErrorKind = 'blocked' | 'invalid' | 'unavailable';

export class SourceGuardError extends Error {
  readonly kind: SourceGuardErrorKind;
  constructor(kind: SourceGuardErrorKind, message: string) {
    super(message);
    this.name = 'SourceGuardError';
    this.kind = kind;
  }
}

const BLOCKED_MESSAGE = '器の内側を指す取り元は取りに行かない';
const MAX_REDIRECTS = 5;
const INFO_REFS = '/info/refs';
const INFO_REFS_QUERY = '?service=git-upload-pack';

function blocked(): SourceGuardError {
  return new SourceGuardError('blocked', BLOCKED_MESSAGE);
}

function bad(message: string): SourceGuardError {
  return new SourceGuardError('invalid', message);
}

export function isBlockedHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  if (name === '') return true;
  for (const suffix of ['localhost', 'internal', 'local']) {
    if (name === suffix || name.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // 先頭 0 は通さない: 8 進と読む実装があり、解釈が割れるから。
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

function blockedIPv4([a, b, c]: readonly number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function parseIPv6(text: string): number[] | null {
  let rest = text;
  if (rest.includes('%')) return null;
  const tailIndex = rest.lastIndexOf(':');
  const tail = rest.slice(tailIndex + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    rest = `${rest.slice(0, tailIndex + 1)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    return groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? groups : null;
  };
  const head = toGroups(halves[0] ?? '');
  const back = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (head === null || back === null) return null;
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function blockedIPv6(text: string): boolean {
  const g = parseIPv6(text);
  if (g === null) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = (hi: number, lo: number) =>
    blockedIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (zeroTo(6)) return embedded(g6, g7) || (g6 === 0 && g7 <= 1);
  if (zeroTo(5) && g5 === 0xffff) return embedded(g6, g7);
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return embedded(g6, g7);
  // 64:ff9b:1::/48 は丸ごと拒む: ローカル用で中の IPv4 では判定できないから。
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
    if (g2 === 1) return true;
  }
  if (g0 === 0x2002) return embedded(g1, g2);
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if (g0 >> 8 === 0xff) return true;
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, '');
  if (text.includes(':')) return blockedIPv6(text);
  const v4 = parseIPv4(text);
  return v4 === null ? true : blockedIPv4(v4);
}

export function curlResolveValue(host: string, port: number, addresses: string[]): string {
  const list = addresses.map((a) => (a.includes(':') ? `[${a}]` : a)).join(',');
  return `${host}:${port}:${list}`;
}

type LookupResult = { address: string; family: number };
type LookupCallback = (
  error: Error | null,
  address: string | LookupResult[],
  family?: number,
) => void;

export function pinnedLookup(addresses: string[]) {
  const results: LookupResult[] = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
  return (_host: string, options: { all?: boolean }, callback: LookupCallback): void => {
    const first = results[0];
    if (options.all === true) callback(null, results);
    else if (first === undefined) callback(new Error('no address'), '', 0);
    else callback(null, first.address, first.family);
  };
}

export type Resolver = (host: string) => Promise<string[]>;

export interface ProbeTarget {
  url: URL;
  addresses: string[];
  timeoutMs: number;
}

export interface ProbeReply {
  status: number;
  location?: string;
}

export type Probe = (target: ProbeTarget) => Promise<ProbeReply>;

export const defaultResolver: Resolver = async (host) => {
  const found = await dnsLookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
};

const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');

// agent: false にする: 環境変数のプロキシを拾う共有エージェントを避けるため。
export const defaultProbe: Probe = ({ url, addresses, timeoutMs }) =>
  new Promise<ProbeReply>((resolve, reject) => {
    const host = bareHost(url);
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: host,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        lookup: pinnedLookup(addresses),
        ...(isIPv4(host) || host.includes(':') ? {} : { servername: host }),
        headers: { host: url.host, 'user-agent': 'alteroid-plugin-fetch', accept: '*/*' },
      },
      (res) => {
        clearTimeout(timer);
        const location = res.headers.location;
        res.destroy();
        resolve({
          status: res.statusCode ?? 0,
          ...(typeof location === 'string' ? { location } : {}),
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('timeout')), Math.max(1, timeoutMs));
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });

export interface Vetted {
  host: string;
  port: number;
  addresses: string[];
  literal: boolean;
}

export interface GuardDeps {
  resolver?: Resolver;
  probe?: Probe;
  remainingMs?: () => number;
}

function checkShape(url: URL): void {
  if (url.protocol !== 'https:') throw bad('取り元は https の URL だけ');
  if (url.username !== '' || url.password !== '') throw bad('URL に資格を含められない');
}

async function vet(url: URL, resolver: Resolver): Promise<Vetted> {
  const port = url.port === '' ? 443 : Number(url.port);
  const host = bareHost(url);
  if (url.hostname.startsWith('[') || isIPv4(host)) {
    if (isBlockedAddress(host)) throw blocked();
    return { host, port, addresses: [host], literal: true };
  }
  if (isBlockedHostname(host)) throw blocked();
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new SourceGuardError('unavailable', '取り元のホスト名を解決できない');
  }
  if (addresses.length === 0) {
    throw new SourceGuardError('unavailable', '取り元のホスト名を解決できない');
  }
  // 1つでも内部なら拒む。残りだけを使うと、接続先の選び方しだいで内部へ届く。
  if (addresses.some((address) => isBlockedAddress(address))) throw blocked();
  return { host, port, addresses, literal: false };
}

function repoUrlFrom(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export interface GuardedSource extends Vetted {
  repoUrl: string;
}

export async function resolveRepoSource(
  rawUrl: string,
  deps: GuardDeps = {},
): Promise<GuardedSource> {
  const resolver = deps.resolver ?? defaultResolver;
  const probe = deps.probe ?? defaultProbe;
  const remainingMs = deps.remainingMs ?? (() => 60_000);

  // 資格はクエリ・フラグメントにも載りうる。元の文字列で見る（URL は空の `?` `#` を消す）。
  if (/[?#]/.test(rawUrl)) throw bad('URL にクエリ・フラグメントを含められない');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw bad('取り元の URL として読めない');
  }
  checkShape(url);

  let repoUrl = repoUrlFrom(url);
  let current = new URL(`${repoUrl}${INFO_REFS}${INFO_REFS_QUERY}`);
  for (let hop = 0; ; hop += 1) {
    const vetted = await vet(current, resolver);
    let reply: ProbeReply;
    try {
      reply = await probe({ url: current, addresses: vetted.addresses, timeoutMs: remainingMs() });
    } catch {
      throw new SourceGuardError('unavailable', '取り元に接続できない');
    }
    if (reply.status < 300 || reply.status >= 400) {
      return { ...vetted, repoUrl };
    }
    if (hop >= MAX_REDIRECTS) throw bad('リダイレクトが多すぎる');
    if (reply.location === undefined || reply.location === '') {
      throw bad('リダイレクト先が読めない');
    }
    let next: URL;
    try {
      next = new URL(reply.location, current);
    } catch {
      throw bad('リダイレクト先が読めない');
    }
    checkShape(next);
    if (/#/.test(reply.location) || next.hash !== '') {
      throw bad('URL にクエリ・フラグメントを含められない');
    }
    if (next.search !== '' && next.search !== INFO_REFS_QUERY) {
      throw bad('URL にクエリ・フラグメントを含められない');
    }
    if (!next.pathname.endsWith(INFO_REFS)) throw bad('リダイレクト先から取り元を導けない');
    const base = new URL(next.href);
    base.pathname = next.pathname.slice(0, -INFO_REFS.length);
    base.search = '';
    repoUrl = repoUrlFrom(base);
    current = new URL(`${repoUrl}${INFO_REFS}${INFO_REFS_QUERY}`);
  }
}
