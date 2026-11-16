export const EXCHANGE_KIND_REPLY_PREFIX = '[応答] ';
export const EXCHANGE_KIND_DECISION_PREFIX = '[判断] ';
export const EXCHANGE_KIND_THINNING_PREFIX = '[間引き] ';
export const EXCHANGE_KIND_FAILURE_PREFIX = '[障害] ';
export const EXCHANGE_KIND_RECOVERY_PREFIX = '[復旧] ';
export const EXCHANGE_KIND_GAUGE_PREFIX = '[計器] ';
/**
 * 担当の runner が出した `note`（`tool_use_failure:` など）を日誌へ残す行の頭。
 * `[応答]` を使わない: 担当の返事（報告・配達行）に見え、診断の分類でも Pool の全文行として報告と対にされていたため。
 * `[計器]` を使わない: あちらはクローン自身の観測の行で、承認の追跡が行動に数えない印として読まれる。
 */
export const EXCHANGE_KIND_RECORD_PREFIX = '[記録] ';

/**
 * 過去の日誌に残っている、固定文を全文へ戻した回の観測の1行の頭（`理由=<label>` が続く）。書き手はもう無い。
 * 保存済みの行が `[判断]` の頭で残っており、承認の追跡が行動に数えないために消せない。
 */
export const DIGEST_RESET_JOURNAL_HEAD = `${EXCHANGE_KIND_DECISION_PREFIX}固定文を全文へ戻す: 理由=`;

// 日誌の検索 q で引く固定の語。変えると過去の行と引けなくなる（`describeMemoryIndexRefresh` が本文の頭に置く）。
export const MEMORY_INDEX_REINJECTED_PHRASE = '記憶の索引を載せ直した';

/** 要約後に記憶の索引を載せ直した回に clone が残す観測の1行の頭。行動ではないので承認の追跡は数えない。 */
export const MEMORY_INDEX_REINJECTED_JOURNAL_HEAD = `${EXCHANGE_KIND_GAUGE_PREFIX}${MEMORY_INDEX_REINJECTED_PHRASE}`;

export type ExchangeKind =
  | 'reply'
  | 'decision'
  | 'thinning'
  | 'failure'
  | 'recovery'
  | 'gauge'
  | 'record';

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
  { kind: 'record', prefix: EXCHANGE_KIND_RECORD_PREFIX },
];

/** 本文の頭の接頭辞から記録の種類を導く。どの接頭辞でもなければ null（種類を言わない）。 */
export function exchangeKindOf(text: string): ExchangeKind | null {
  return EXCHANGE_KIND_PREFIXES.find(({ prefix }) => text.startsWith(prefix))?.kind ?? null;
}

export type ExchangeSender = 'system' | 'clone' | 'manager';

const SYSTEM_TEXT_HEAD = '[system] ';
// managerId の欄が無い行でも `[<id>] [system] ` の形は見分ける（id は `]` を含まない）。
const BRACKETED_SYSTEM_HEAD = /^\[[^\]]*\] \[system\] /;

/**
 * 日誌の `with: manager` の行の書き手。`role` は向き（outbound = 担い手へ向かう）で、書き手ではない。
 * outbound は `#recordDelivery` が `[応答] [managerId] <送った文面>` で書く。クローンの `manager_send` と、
 * システムが同じ経路で送る `[system] …`（rescue_restore の応答など）を、本文の頭でしか分けられない。
 * 判定できない outbound は clone に倒す（システムだと言い切る根拠が無い）。
 */
export function exchangeSenderOf(row: {
  readonly role: 'outbound' | 'inbound';
  readonly managerId?: string | undefined;
  readonly text: string;
}): ExchangeSender {
  if (row.role === 'inbound') return 'manager';
  const body = row.text.startsWith(EXCHANGE_KIND_REPLY_PREFIX)
    ? row.text.slice(EXCHANGE_KIND_REPLY_PREFIX.length)
    : row.text;
  if (row.managerId !== undefined) {
    return body.startsWith(`[${row.managerId}] ${SYSTEM_TEXT_HEAD}`) ? 'system' : 'clone';
  }
  return BRACKETED_SYSTEM_HEAD.test(body) ? 'system' : 'clone';
}
