export const EXCHANGE_KIND_REPLY_PREFIX = '[応答] ';
export const EXCHANGE_KIND_DECISION_PREFIX = '[判断] ';
export const EXCHANGE_KIND_THINNING_PREFIX = '[間引き] ';
export const EXCHANGE_KIND_FAILURE_PREFIX = '[障害] ';
export const EXCHANGE_KIND_RECOVERY_PREFIX = '[復旧] ';
export const EXCHANGE_KIND_GAUGE_PREFIX = '[計器] ';

/** 固定文を全文へ戻した回に clone が残す観測の1行の頭（`理由=<label>` が続く）。行動ではないので承認の追跡は数えない。 */
export const DIGEST_RESET_JOURNAL_HEAD = `${EXCHANGE_KIND_DECISION_PREFIX}固定文を全文へ戻す: 理由=`;

/** 預けた控えを読み戻さなかった回に clone が残す観測の1行の頭（`理由=<label>` が続く）。行動ではないので承認の追跡は数えない。 */
export const FOLD_READBACK_SKIPPED_JOURNAL_HEAD = `${EXCHANGE_KIND_GAUGE_PREFIX}畳みの控えを読み戻さなかった: 理由=`;

// 日誌の検索 q で引く固定の語。変えると過去の行と引けなくなる（`describeMemoryIndexRefresh` が本文の頭に置く）。
export const MEMORY_INDEX_REINJECTED_PHRASE = '記憶の索引を載せ直した';
export const MEMORY_INDEX_NOT_REINJECTED_PHRASE = '記憶の索引は載せ直さなかった';

/** 要約後に記憶の索引を載せ直した回に clone が残す観測の1行の頭。行動ではないので承認の追跡は数えない。 */
export const MEMORY_INDEX_REINJECTED_JOURNAL_HEAD = `${EXCHANGE_KIND_GAUGE_PREFIX}${MEMORY_INDEX_REINJECTED_PHRASE}`;

/** 要約後に記憶の索引を載せ直さなかった回に clone が残す観測の1行の頭。行動ではないので承認の追跡は数えない。 */
export const MEMORY_INDEX_NOT_REINJECTED_JOURNAL_HEAD = `${EXCHANGE_KIND_GAUGE_PREFIX}${MEMORY_INDEX_NOT_REINJECTED_PHRASE}`;

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
