import { hasAuthoritativeCooldown, roundDownToMinute } from './token-reset-match.js';
import type { AgentToken } from './token-pool.js';
import { parseNoticeResetAt, parseNoticeResetDatedAt } from './usage-reset-text.js';

/**
 * 作業者の落ちの原文の `resets …` を、鍵のプールの各鍵の枠の resetsAt と突き合わせ、落ちた枠がどの鍵のものかを1行で名乗る（#5021）。
 * 決め打ちしない: 読めない・一致なし・複数一致・プールが読めない、はそれぞれそう書く。**鍵の値は受け取らない**（名前・order・id の先頭だけを出す）。
 */

// 週の枠は日付付きで来るので、1年先までを窓にする（超えたら読めない扱い）
const DATED_HORIZON_MS = 366 * 24 * 60 * 60_000;
// 日付なしの形は24時間以内のどこかを指す（`token-reset-match.ts` と同じ）
const TIME_ONLY_HORIZON_MS = 24 * 60 * 60_000;

const ID_HEAD_CHARS = 8;
const LABEL_MAX_CHARS = 40;

export interface RememberedWindow {
  tokenId: string;
  kind: string;
  resetsAt: number;
}

export interface WorkerLimitKeyMatchInput {
  raw: string;
  at: number;
  /** `undefined` はプールを読めなかったこと（空配列は「読めたが鍵が無い」）。 */
  pool: readonly AgentToken[] | undefined;
  /** `undefined` は現役の指名を読めなかったこと。`null` は一度も指名が無いこと。 */
  activeTokenId: string | null | undefined;
  /** デーモンが覚えている、鍵ごとの枠の最後の観測（`rate_limit` の事実）。 */
  windows: readonly RememberedWindow[];
}

const PREFIX = '鍵の突き合わせ: ';

function describeToken(token: Pick<AgentToken, 'id' | 'label' | 'order'>): string {
  const label =
    token.label.length > LABEL_MAX_CHARS
      ? `${token.label.slice(0, LABEL_MAX_CHARS)}…`
      : token.label;
  return `鍵「${label}」（order ${String(token.order)}・id ${token.id.slice(0, ID_HEAD_CHARS)}）`;
}

interface TokenHit {
  token: AgentToken;
  windowKinds: string[];
  viaCooldown: boolean;
}

function findHits(
  pool: readonly AgentToken[],
  windows: readonly RememberedWindow[],
  target: number,
): TokenHit[] {
  const hits: TokenHit[] = [];
  for (const token of pool) {
    const windowKinds = windows
      .filter((one) => one.tokenId === token.id && roundDownToMinute(one.resetsAt) === target)
      .map((one) => one.kind);
    const viaCooldown =
      hasAuthoritativeCooldown(token) && roundDownToMinute(token.cooldownUntil) === target;
    if (windowKinds.length > 0 || viaCooldown) {
      hits.push({ token, windowKinds: [...new Set(windowKinds)], viaCooldown });
    }
  }
  return hits;
}

function describeWindow(hit: TokenHit): string {
  if (hit.windowKinds.length > 0) {
    return `${hit.windowKinds.map((kind) => (kind === '' ? '（種類の記録が無い枠）' : kind)).join('・')} の枠`;
  }
  return `枠（どの枠かは記録に無い。冷却明けと一致。出所: ${hit.token.cooldownSource ?? '記録が無い'}）`;
}

function describeActive(
  input: WorkerLimitKeyMatchInput,
  pool: readonly AgentToken[],
  hit: TokenHit,
): string {
  const { activeTokenId } = input;
  if (activeTokenId === undefined) return '現役かどうかは分からない（現役の指名を読めなかった）。';
  if (activeTokenId === null) return '現役の指名はまだ一度も無い。';
  if (activeTokenId === hit.token.id) return '現役と同じ鍵である。';
  const active = pool.find((token) => token.id === activeTokenId);
  const who =
    active === undefined ? `id ${activeTokenId.slice(0, ID_HEAD_CHARS)}` : describeToken(active);
  return `現役ではない（現役は ${who}）。`;
}

export function describeWorkerLimitKeyMatch(input: WorkerLimitKeyMatchInput): string {
  if (input.pool === undefined) {
    return `${PREFIX}鍵のプールを読めなかったので、落ちた枠がどの鍵のものかは言えない。`;
  }
  const resetAt =
    parseNoticeResetDatedAt(input.raw, { at: input.at, withinMs: DATED_HORIZON_MS }) ??
    parseNoticeResetAt(input.raw, { at: input.at, withinMs: TIME_ONLY_HORIZON_MS });
  if (resetAt === undefined) {
    return `${PREFIX}原文の resets を時刻に直せなかったので、落ちた枠がどの鍵のものかは言えない。`;
  }
  const target = roundDownToMinute(resetAt);
  const when = new Date(target).toISOString();
  const hits = findHits(input.pool, input.windows, target);
  if (hits.length === 0) {
    return `${PREFIX}原文の resets（${when}）に一致する鍵の枠は、プールの記録に無い。どの鍵のものかは言えない。`;
  }
  if (hits.length > 1) {
    return (
      `${PREFIX}原文の resets（${when}）は複数の鍵に一致する（${hits.map((hit) => describeToken(hit.token)).join('、')}）。` +
      'どの鍵のものかは決められない。'
    );
  }
  const [hit] = hits;
  if (hit === undefined) return `${PREFIX}一致を読めなかった。`;
  return (
    `${PREFIX}原文の resets（${when}、分単位の一致）は ${describeToken(hit.token)} の ${describeWindow(hit)}に一致する。` +
    describeActive(input, input.pool, hit)
  );
}
