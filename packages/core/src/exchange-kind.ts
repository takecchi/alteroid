export const EXCHANGE_KIND_REPLY_PREFIX = '[応答] ';
export const EXCHANGE_KIND_DECISION_PREFIX = '[判断] ';
export const EXCHANGE_KIND_THINNING_PREFIX = '[間引き] ';
export const EXCHANGE_KIND_FAILURE_PREFIX = '[障害] ';
export const EXCHANGE_KIND_RECOVERY_PREFIX = '[復旧] ';
export const EXCHANGE_KIND_GAUGE_PREFIX = '[計器] ';

export type ExchangeKind = 'reply' | 'decision' | 'thinning' | 'failure' | 'recovery' | 'gauge';

export const EXCHANGE_KIND_PREFIXES: ReadonlyArray<{
  readonly kind: ExchangeKind;
  readonly prefix: string;
}> = [
  { kind: 'reply', prefix: EXCHANGE_KIND_REPLY_PREFIX },
  { kind: 'decision', prefix: EXCHANGE_KIND_DECISION_PREFIX },
  { kind: 'thinning', prefix: EXCHANGE_KIND_THINNING_PREFIX },
  { kind: 'failure', prefix: EXCHANGE_KIND_FAILURE_PREFIX },
  { kind: 'recovery', prefix: EXCHANGE_KIND_RECOVERY_PREFIX },
  { kind: 'gauge', prefix: EXCHANGE_KIND_GAUGE_PREFIX },
];

export function inferExchangeKindFromText(text: string): ExchangeKind | undefined {
  for (const { kind, prefix } of EXCHANGE_KIND_PREFIXES) {
    if (text.startsWith(prefix)) return kind;
  }
  return undefined;
}
