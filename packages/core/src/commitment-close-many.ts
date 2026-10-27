import { chunkIdsByChars } from './chunk-ids.js';
import {
  describeOffsetRequiredTimeBoundary,
  isOffsetQualifiedTimeBoundary,
} from './journal-time.js';
import { commitmentOriginSchema } from './schema.js';
import type { Commitment, CommitmentClosedBy, CommitmentOrigin } from './schema.js';
import type { CommitmentStore } from './store.js';
import {
  describeArrayLengthViolation,
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringArrayElementLengthViolation,
  describeStringLengthViolation,
} from './tool-arg-checks.js';

// 道具 `commitment_close_many`（クローン）と `POST /commitments/close-many`（人間）が共有する。絞り込みの検証・当て方・塊ごとの閉じ方を2箇所に書くと、「下見した結果と閉じる集合が食い違わない」ことの保証が2つの実装の一致に落ちるため、1つの実装に置く。
// 日誌を書く順序は共有しない: 道具は「閉じてから書く」、HTTP は「先に書き、書けなければ閉じない」（`POST /commitments/:id/close`）で、呼び手の流儀が違うため。差し込み口（`CloseManyChunkHooks`）で呼び手に渡す。

export const CLOSE_MANY_LIMIT_DEFAULT = 500;
// store 側に同じ上限を置いて二重にしない: どちらが効いたのか呼び出し側から読めなくなるため
export const CLOSE_MANY_LIMIT_MAX = 2_000;
// id 列は件数ではなく文字数の予算で塊に割り、塊ごとに1件の日誌を書く: 全件を1行へ詰めると予算が文字数という面の規約に反するため
export const CLOSE_MANY_JOURNAL_ID_CHARS = 3_600;
export const CLOSE_MANY_IDS_SHOWN = 20;
export const CLOSE_MANY_SOURCES_SHOWN = 8;

export interface CloseManyFilterInput {
  origin: readonly CommitmentOrigin[];
  source?: readonly string[] | undefined;
  q?: string | undefined;
  until?: string | undefined;
}

export interface CloseManyInput extends CloseManyFilterInput {
  reason: string;
  dryRun?: boolean | undefined;
  limit?: number | undefined;
}

/**
 * 入力の検証。断るなら人間（と AI）が読む断り文を返し、通すなら `null`。
 * 検査の順序と文言は道具が持っていたものそのまま: 先に当たった違反だけを返す。
 */
export function describeCloseManyViolation(input: CloseManyInput): string | null {
  const { origin, source, q, until, reason, limit } = input;
  const limitError = describeIntRangeViolation('limit', limit, {
    min: 1,
    max: CLOSE_MANY_LIMIT_MAX,
  });
  if (limitError !== null) return limitError;
  const originError = describeArrayLengthViolation('origin', origin, { min: 1 });
  if (originError !== null) return originError;
  const sourceLengthError = describeArrayLengthViolation('source', source, { min: 1 });
  if (sourceLengthError !== null) return sourceLengthError;
  const sourceElementError = describeStringArrayElementLengthViolation('source', source);
  if (sourceElementError !== null) return sourceElementError;
  const qError = describeStringLengthViolation('q', q, { min: 1 });
  if (qError !== null) return qError;
  const untilLengthError = describeStringLengthViolation('until', until, { min: 1 });
  if (untilLengthError !== null) return untilLengthError;
  const reasonError =
    describeStringLengthViolation('reason', reason, { min: 1 }) ??
    describeBlankViolation('reason', reason);
  if (reasonError !== null) return reasonError;
  // 絞り込みの無い呼びを断る: 「全部閉じる」が事故で撃てる形を作らないため。確認用の追加の引数は作らない: `dryRun` の既定と2重に問うことになり、どちらが効いたのか読めなくなるため
  if (commitmentOriginSchema.options.every((known) => origin.includes(known))) {
    return (
      'origin に在る起点を全部（human / manager / external / self）並べた呼びは断る——' +
      'それは絞り込みが無いのと同じで、1回で台帳を空にできてしまう。' +
      '閉じたい起点だけを名指しすること（例 origin: ["external"]）。**1件も閉じていない。**'
    );
  }
  // 読めない `until` を「絞り込みが当たらなかった」に混ぜない: 打ち間違いが「0件だった」に化けて静かに通るため
  // 時差（`Z` / `±hh:mm`）を必須にする: 元に戻せない一括操作で、時差の無い形は `Date.parse` が地方時刻として読み境界が黙ってずれるため
  if (until !== undefined && !isOffsetQualifiedTimeBoundary(until)) {
    return (
      describeOffsetRequiredTimeBoundary('until', until, '2026-09-11T19:00:00.000Z') +
      '**1件も閉じていない。**'
    );
  }
  return null;
}

export function describeCloseManyFilter(filter: CloseManyFilterInput): string {
  const { origin, source, q, until } = filter;
  return [
    `origin=[${origin.join(', ')}]`,
    ...(source === undefined ? [] : [`source=[${source.join(', ')}]（完全一致）`]),
    ...(q === undefined ? [] : [`q="${q}"`]),
    ...(until === undefined ? [] : [`until=${until}`]),
  ].join(' / ');
}

export interface CloseManySelection {
  /** 未了の全行（読めた分）。0件の理由を段で言うために段ごとの行を持つ */
  openEntries: readonly Commitment[];
  afterOrigin: readonly Commitment[];
  afterSource: readonly Commitment[];
  afterQ: readonly Commitment[];
  /** 絞り込みの全段を通った行（古い側から） */
  matched: readonly Commitment[];
  /** この呼びで閉じる行（`matched` の古い側から `limit` 件） */
  targets: readonly Commitment[];
  /** `limit` に収まらず対象にしなかった件数 */
  rest: number;
  effectiveLimit: number;
  unreadableCount: number;
  trimmedClosed: number;
}

/**
 * 台帳の未了を絞り込んで、閉じる対象を決める（閉じない）。
 * 絞りは `commitment_list` と同じ側・同じ当て方で当てる: 下見した結果と閉じる集合が食い違わないことが、一括で閉じてよいと判断できる唯一の根拠のため。
 * 入力は `describeCloseManyViolation` を通った後のものを渡すこと（ここでは検証しない）。
 */
export async function selectCloseManyTargets(
  commitments: Pick<CommitmentStore, 'list'>,
  input: CloseManyInput,
): Promise<CloseManySelection> {
  const { origin, source, q, until, limit } = input;
  const { entries: openEntries, unreadable, trimmedClosed } = await commitments.list();
  const afterOrigin = openEntries.filter((entry) => origin.includes(entry.origin));
  const afterSource =
    source === undefined
      ? afterOrigin
      : afterOrigin.filter((entry) => entry.source !== undefined && source.includes(entry.source));
  const needle = q?.toLowerCase();
  const afterQ =
    needle === undefined
      ? afterSource
      : afterSource.filter(
          (entry) =>
            entry.body.toLowerCase().includes(needle) ||
            (entry.source !== undefined && entry.source.toLowerCase().includes(needle)),
        );
  const untilMs = until === undefined ? undefined : Date.parse(until);
  const matched =
    untilMs === undefined ? afterQ : afterQ.filter((entry) => Date.parse(entry.at) <= untilMs);
  const effectiveLimit = limit ?? CLOSE_MANY_LIMIT_DEFAULT;
  const targets = matched.slice(0, effectiveLimit);
  return {
    openEntries,
    afterOrigin,
    afterSource,
    afterQ,
    matched,
    targets,
    rest: matched.length - targets.length,
    effectiveLimit,
    unreadableCount: unreadable.length,
    trimmedClosed,
  };
}

/**
 * 閉じた直後に、片付き履歴の保持上限で刈られた行を数える（fs の置き場。1回で上限を超えて閉じると、閉じたばかりの行も刈る）。
 * 言わないと、閉じたと言った行が `commitment_list id=` で「台帳に無い」になる。刈った件数が増えた回だけ読み直す（保持上限の無い置き場では読まない）。
 */
export async function countTrimmedJustClosed(
  commitments: Pick<CommitmentStore, 'list'>,
  closedIds: readonly string[],
  trimmedBefore: number,
): Promise<number> {
  const trimmedAfter =
    closedIds.length === 0 ? trimmedBefore : (await commitments.list()).trimmedClosed;
  if (trimmedAfter <= trimmedBefore) return 0;
  const remaining = new Set(
    (await commitments.list({ includeClosed: true })).entries.map((entry) => entry.id),
  );
  return closedIds.filter((id) => !remaining.has(id)).length;
}

export interface CloseManyChunk {
  /** 1 起点 */
  number: number;
  total: number;
  ids: readonly string[];
}

export interface CloseManyChunkHooks {
  /** 塊を閉じる前。投げれば、その塊を閉じずに全体を止める（投げた例外はそのまま呼び手へ出る） */
  before?: (chunk: CloseManyChunk) => Promise<void>;
  /** `closeMany` が投げたとき。ここで打ち消しなどを書いてよい。例外はそのまま呼び手へ出る */
  closeFailed?: (chunk: CloseManyChunk, error: unknown) => Promise<void>;
  /** 塊を閉じた後。`closed` はこの呼びが実際に閉じた id（他経路が先に閉じていた分は含まない。0件のこともある） */
  after: (chunk: CloseManyChunk, closed: readonly string[]) => Promise<void>;
}

/**
 * 対象の id を文字数の予算で塊に割り、塊ごとに「前 → 閉じる → 後」を交互に回す: まとめて閉じてから日誌を書くと、器が落ちたとき閉じたのに記録が無い行が最大 `CLOSE_MANY_LIMIT_MAX` 件できるため。
 * 閉じた id を全部返す。
 */
export async function closeManyInChunks(
  commitments: Pick<CommitmentStore, 'closeMany'>,
  ids: readonly string[],
  options: { reason: string; by: CommitmentClosedBy; at: string },
  hooks: CloseManyChunkHooks,
): Promise<string[]> {
  const chunks = chunkIdsByChars(ids, CLOSE_MANY_JOURNAL_ID_CHARS);
  const closedIds: string[] = [];
  for (const [index, chunkIds] of chunks.entries()) {
    const chunk: CloseManyChunk = { number: index + 1, total: chunks.length, ids: chunkIds };
    await hooks.before?.(chunk);
    let closed: string[];
    try {
      closed = await commitments.closeMany(chunkIds, options.at, options.reason, options.by);
    } catch (error) {
      await hooks.closeFailed?.(chunk, error);
      throw error;
    }
    closedIds.push(...closed);
    await hooks.after(chunk, closed);
  }
  return closedIds;
}
