// finishSweep（`token-rotator.ts`）が返す結果の「組み立て」だけを切り出した、状態にも時計にも触れない同期の純関数。
// 保存・await・staleRun の読み書き・どの枝へ行くかの判断は finishSweep に残す: 回った後の処理の順序と microtask の周回数を、ここへ持ち込まないため
import type { ActiveAgentToken, AgentToken } from './token-pool.js';
import type { ObservationFreshness, TokenRotationSignal } from './token-rotation.js';
import type { TokenCandidateVerdict } from './token-candidate.js';
import type {
  CandidateSweep,
  TokenReconsiderReason,
  TokenRotationOutcome,
  TokenSpreadResult,
} from './token-rotator.js';

// 件数ではなく時間で切る: probe は1本あたり最大20秒待つので、件数の上限では占有時間を縛れないため
export const CANDIDATE_SWEEP_BUDGET_MS = 60_000;

type Earliest = NonNullable<NonNullable<CandidateSweep['ranOut']>['earliest']>;

export interface FinishCommon {
  signal: TokenRotationSignal;
  freshness?: ObservationFreshness;
  reason?: TokenReconsiderReason;
}

export interface EndedStaleRun {
  count: number;
  identity: ActiveAgentToken | null;
}

export type DescribeStaleRunEnd = (ended: {
  count: number;
  identity: ActiveAgentToken | null;
  tokens: readonly AgentToken[];
}) => string;

export function unreadableTailOf(
  activeUnreadableReason: string | undefined,
  generation: number,
): string {
  return activeUnreadableReason === undefined
    ? ''
    : `\n**現役の指名が読めなかったので、世代 ${String(generation)} で撒き直した**（${activeUnreadableReason}）`;
}

export function rotatedWhy(input: {
  whyHead: string;
  token: AgentToken;
  verdict: TokenCandidateVerdict;
  generation: number;
  sweep: Pick<CandidateSweep, 'stoppedByBudget' | 'fellBackToUndecided'>;
  endedStaleRun: EndedStaleRun | null;
  pool: readonly AgentToken[];
  activeUnreadableReason: string | undefined;
  describeStaleRunEnd: DescribeStaleRunEnd;
}): string {
  const {
    whyHead,
    token,
    verdict,
    generation,
    sweep,
    endedStaleRun,
    pool,
    activeUnreadableReason,
    describeStaleRunEnd,
  } = input;
  const head = `${whyHead}。`;
  const tail =
    endedStaleRun === null ? '' : describeStaleRunEnd({ ...endedStaleRun, tokens: pool });
  if (verdict.verdict === 'usable') {
    return `${head}候補「${token.label}」は観測できた${tail}${unreadableTailOf(activeUnreadableReason, generation)}`;
  }
  const stopped = sweep.stoppedByBudget
    ? `（候補を試す持ち時間（${String(CANDIDATE_SWEEP_BUDGET_MS)}ms）を使い切ったところで倒した）`
    : '';
  if (sweep.fellBackToUndecided) {
    return (
      `${head}**\`usable\` と確かめられた候補は見つからなかった**ので、` +
      `判定できなかった候補「${token.label}」へ倒した${stopped}` +
      `——撒いて本番で確かめる（${verdict.reason}）${tail}${unreadableTailOf(activeUnreadableReason, generation)}`
    );
  }
  return `${head}候補「${token.label}」は判定できなかったので撒いて本番で確かめる（${verdict.reason}）${tail}${unreadableTailOf(activeUnreadableReason, generation)}`;
}

export function parkedOutcome(input: {
  outgoingId: string | undefined;
  row: AgentToken;
  generation: number;
  spread: TokenSpreadResult[];
  earliest: Earliest;
  common: FinishCommon;
  whyHead: string;
  skipped: string;
  endedStaleRun: EndedStaleRun | null;
  pool: readonly AgentToken[];
  activeUnreadableReason: string | undefined;
  describeStaleRunEnd: DescribeStaleRunEnd;
}): Extract<TokenRotationOutcome, { kind: 'parked' }> {
  const {
    outgoingId,
    row,
    generation,
    spread,
    earliest,
    common,
    whyHead,
    skipped,
    endedStaleRun,
    pool,
    activeUnreadableReason,
    describeStaleRunEnd,
  } = input;
  return {
    kind: 'parked' as const,
    ...(outgoingId === undefined ? {} : { fromTokenId: outgoingId }),
    tokenId: row.id,
    label: row.label,
    generation,
    cooldownUntil: earliest.cooldownUntil,
    ...(earliest.cooldownSource === undefined ? {} : { cooldownSource: earliest.cooldownSource }),
    ...common,
    spread,
    why:
      `${whyHead}。**いま通る候補は1本も無い**${skipped}。` +
      `いちばん早く戻る「${row.label}」を撒いて待つ` +
      `（${new Date(earliest.cooldownUntil).toISOString()} まで通らない）` +
      (endedStaleRun === null ? '' : describeStaleRunEnd({ ...endedStaleRun, tokens: pool })) +
      unreadableTailOf(activeUnreadableReason, generation),
  };
}

export function exhaustedOutcome(input: {
  sweep: Pick<CandidateSweep, 'stoppedByBudget' | 'ranOut' | 'unusableLabels'>;
  earliest: Earliest | undefined;
  activeTokenId: string | undefined;
  activeRow: AgentToken | undefined;
  common: FinishCommon;
  skipped: string;
}): Extract<TokenRotationOutcome, { kind: 'exhausted' }> {
  const { sweep, earliest, activeTokenId, activeRow, common, skipped } = input;
  // 器の環境変数の値を代わりに撒かない: トークンプールは DB 駆動で、環境変数へのフォールバックは残さないため
  const current =
    earliest !== undefined &&
    earliest.tokenId !== activeTokenId &&
    activeRow?.cooldownUntil !== undefined
      ? {
          tokenId: activeRow.id,
          label: activeRow.label,
          cooldownUntil: activeRow.cooldownUntil,
          ...(activeRow.cooldownSource === undefined
            ? {}
            : { cooldownSource: activeRow.cooldownSource }),
        }
      : undefined;

  return {
    kind: 'exhausted' as const,
    ...(current === undefined ? {} : { current }),
    // 打ち切ったときは earliest を出さない: 試していない候補が残っていて見立てが取れていないため
    ...(sweep.stoppedByBudget || sweep.ranOut?.earliest === undefined
      ? {}
      : { earliest: sweep.ranOut.earliest }),
    ...(sweep.stoppedByBudget ? { stoppedBy: 'budget' as const } : {}),
    ...common,
    why: sweep.stoppedByBudget
      ? `候補を試す持ち時間（${String(CANDIDATE_SWEEP_BUDGET_MS)}ms）を使い切った${skipped}`
      : earliest !== undefined
        ? // 同じ鍵と遅い鍵を言い分ける: 読む側が次に確かめるものが違うため
          earliest.tokenId === activeTokenId
          ? `いちばん早く戻る候補が現役自身だった（撒き直しても同じ鍵なので、世代だけ増やすことはしない）${skipped}`
          : `いま撒いてある${current === undefined ? '鍵' : `「${current.label}」`}のほうが早く戻る（現役を除いた候補の中でいちばん早い「${earliest.label}」は ${new Date(earliest.cooldownUntil).toISOString()}）。遅い鍵へ移すのは改善ではないので撒き直さない${skipped}`
        : sweep.unusableLabels.length > 0
          ? `試せる候補を使い切った${skipped}`
          : (sweep.ranOut?.why ?? '候補が無い'),
  };
}
