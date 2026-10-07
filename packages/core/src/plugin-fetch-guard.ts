import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';

/**
 * plugin の取り元が「器の内側」を指していないかの判定と、リダイレクトの手動追跡。
 *
 * - **名前を判定してから、git に名前解決をやり直させない。** 判定した後で DNS が差し替わると、
 *   git が別のアドレス（内部）へ届く。判定を通ったアドレスを `http.curloptResolve` で固定して渡す。
 * - **git にリダイレクトを辿らせない。** 辿らせると、途中のホップが判定を通らない。
 *   事前の GET で自分が辿り、各ホップで同じ判定を掛ける。
 * - 判定できない形（読めない IP・変則表記）は通さない。通すと、解釈の差が穴になる。
 * - 拒否の文言に、解決したアドレスを載せない（内部の構成を呼び手へ漏らさない）。
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

/** ホスト名で拒むもの。大文字小文字と末尾のドットは区別しない。 */
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
    // 先頭 0 は 8 進と読む実装がある。解釈が割れる形は通さない。
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

  // :: と ::1 を含む、上位 96 bit が 0 のもの（IPv4 互換）。
  if (zeroTo(6)) return embedded(g6, g7) || (g6 === 0 && g7 <= 1);
  // IPv4 射影 ::ffff:a.b.c.d と、SIIT の ::ffff:0:a.b.c.d。
  if (zeroTo(5) && g5 === 0xffff) return embedded(g6, g7);
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return embedded(g6, g7);
  // NAT64。64:ff9b::/96 は中の IPv4 で見る。ローカル用の 64:ff9b:1::/48 は丸ごと拒む。
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
    if (g2 === 1) return true;
  }
  // 6to4。中の IPv4 で見る。
  if (g0 === 0x2002) return embedded(g1, g2);
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10（廃止された site-local）
  if (g0 >> 8 === 0xff) return true; // ff00::/8
  return false;
}

/** 解決したアドレス（IPv4・IPv6 の文字列）が、器の内側・予約の帯に入るか。読めなければ拒む。 */
export function isBlockedAddress(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, '');
  if (text.includes(':')) return blockedIPv6(text);
  const v4 = parseIPv4(text);
  return v4 === null ? true : blockedIPv4(v4);
}

/** curl の `--resolve` と同じ形（`host:port:addr[,addr]`、IPv6 は角括弧）。 */
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

/** 名前解決をせず、判定済みのアドレスだけを返す `lookup`（Node の `https.request` 用）。 */
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
  /** 判定を通ったアドレス。ここへだけ接続する。 */
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

/**
 * 応答の本文は読まない。リダイレクトを自動で辿らせない。プロキシも使わない
 * （`agent: false` で、環境変数のプロキシを拾う共有エージェントを避ける）。
 */
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
  /** 残りの時間（ミリ秒）を返す。 */
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
  /** git に渡す、リダイレクトを辿り終えた後のリポジトリの URL。 */
  repoUrl: string;
}

/**
 * 取り元の URL を判定し、`info/refs` への GET でリダイレクトを手動で辿って、最後のホストの
 * アドレスを確定させる。どのホップも、ホスト名と解決したすべてのアドレスを判定する。
 */
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
