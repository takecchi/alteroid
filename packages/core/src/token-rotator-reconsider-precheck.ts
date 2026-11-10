// reconsiderLocked（`token-rotator.ts`）が sweepCandidates / finishSweep に入る前に返す結果と、撒き直しの条件式の前半だけを切り出した、
// 状態にも時計にも触れない同期の純関数。
// await・状態に触れる呼び出し（forgetRejections・announcedReopen・nominateRow・patchToken）・now() の読み・どの枝へ行くかの骨格は reconsiderLocked に残す:
// 時計は呼び出しごとに違う値を返しうるので読む回数と位置を動かさないため、周回数（microtask）を変えないため
import type { ActiveAgentToken, AgentToken, tokenAvailabilityAt } from './token-pool.js';
import type { TokenCandidateVerdict } from './token-candidate.js';
import { observationFreshness } from './token-rotation.js';
import { fingerprintOf } from './credentials.js';
import type {
  TokenReconsiderReason,
  TokenRotationOutcome,
  TokenVerdictOrigin,
} from './token-rotator.js';

type IgnoredOutcome = Extract<TokenRotationOutcome, { kind: 'ignored' }>;

// 設定の読み: token-rotator.ts の SettingsRead と同じ形（あちらは export していないので、使う欄だけ構造で受ける）
type SettingsReadLike<Settings> =
  { readable: true; settings: Settings } | { readable: false; reason: string };

// exhausted にしない: あちらは全層が止まる顔で、ここは何も起きていないため
export function emptyPoolOutcome(reason: TokenReconsiderReason): IgnoredOutcome {
  return {
    kind: 'ignored' as const,
    signal: 'none' as const,
    reason,
    why: 'プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）',
  };
}

// 回す判定へ進めるときは、読めた設定をそのまま運ぶ（呼び元が readable を二度確かめずに済むように）
export type PrecheckDecision<Settings> =
  { kind: 'ignored'; outcome: IgnoredOutcome } | { kind: 'continue'; settings: Settings };

// 現役の指名が無い回に、回さずに返す3つの判定（成功は契機にしない・設定が読めない・rotateOn が off）
export function unnominatedDecision<Settings extends { rotateOn: string }>(input: {
  reason: TokenReconsiderReason;
  settingsRead: SettingsReadLike<Settings>;
}): PrecheckDecision<Settings> {
  const { reason, settingsRead } = input;
  // 成功は回す契機にしない: turn_succeeded はターンが成功した証拠であって、選び直す判定ではないため
  if (reason === 'turn_succeeded') {
    return {
      kind: 'ignored',
      outcome: {
        kind: 'ignored' as const,
        signal: 'none' as const,
        reason,
        why: 'ターンの成功を観測したが、まだ一度も指名していない（成功は回す契機にしない）',
      },
    };
  }

  // signal は stranded を借りない: あちらは記録の上で現役が通らないという別の事実の印のため
  if (!settingsRead.readable) {
    return {
      kind: 'ignored',
      outcome: {
        kind: 'ignored' as const,
        signal: 'settings_unreadable' as const,
        reason,
        why: `まだ一度も指名していない。回転の設定が読めなかった（${settingsRead.reason}）ので、この回は回さない`,
      },
    };
  }
  if (settingsRead.settings.rotateOn === 'off') {
    return {
      kind: 'ignored',
      outcome: {
        kind: 'ignored' as const,
        signal: 'stranded' as const,
        reason,
        why: 'まだ一度も指名していない。回す契機の設定が off なので回さない（記録だけする）',
      },
    };
  }
  return { kind: 'continue', settings: settingsRead.settings };
}

// 撒き直しの条件式のうち、時計を読まない前半の項。当てはまれば撒き直す行と現役を返す（tokenAvailabilityAt の項は読み元が最後に評価する）
export function respreadTargetOf(input: {
  reason: TokenReconsiderReason;
  currentRow: AgentToken | undefined;
  spreadMark: { tokenId: string; generation: number; fingerprint: string } | null;
  active: ActiveAgentToken | null;
}): { currentRow: AgentToken; active: ActiveAgentToken } | undefined {
  const { reason, currentRow, spreadMark, active } = input;
  if (
    reason === 'pool_changed' &&
    currentRow !== undefined &&
    currentRow.value !== undefined &&
    currentRow.value !== '' &&
    spreadMark !== null &&
    active !== null &&
    spreadMark.tokenId === active.tokenId &&
    spreadMark.generation === active.generation &&
    spreadMark.fingerprint !== fingerprintOf(currentRow.value)
  ) {
    return { currentRow, active };
  }
  return undefined;
}

// 現役の行の値が差し替わって撒き直した回の結果
export function respreadOutcome(input: {
  reason: TokenReconsiderReason;
  currentRow: AgentToken;
  generation: number;
  spread: Extract<TokenRotationOutcome, { kind: 'rotated' }>['spread'];
}): Extract<TokenRotationOutcome, { kind: 'rotated' }> {
  const { reason, currentRow, generation, spread } = input;
  return {
    kind: 'rotated' as const,
    fromTokenId: currentRow.id,
    toTokenId: currentRow.id,
    toLabel: currentRow.label,
    generation,
    signal: 'none' as const,
    reason,
    spread,
    why: `現役「${currentRow.label}」の値が差し替わった（同じ id のまま）ので、新しい値を撒き直した`,
  };
}

// 世代の門（turn_success / trial）と stale な account_probe の判定。捨てる回の結果を返し、どちらにも当たらなければ undefined
export function staleObservationOutcome(input: {
  reason: TokenReconsiderReason;
  current: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin } | undefined;
  active: ActiveAgentToken | null;
}): IgnoredOutcome | undefined {
  const { reason, current, active } = input;
  // 世代の門は turn_success と trial に掛ける: 回った後に届いた前の世代の成功が、未試行の新しい現役の記録を usable にしうるため
  if (
    current !== undefined &&
    (current.origin.source === 'turn_success' || current.origin.source === 'trial')
  ) {
    const freshness = observationFreshness(active, current.origin.observedBy);
    if (freshness !== 'current') {
      return {
        kind: 'ignored' as const,
        signal: 'none' as const,
        reason,
        why:
          `${current.origin.source === 'trial' ? '試しの成功' : 'ターンの成功'}を観測したが、世代が合わない（もう回した後、` +
          'あるいはまだ一度も試していない現役についての成功なので、捨てる）',
      };
    }
  }

  // 身元が無い probe には掛けない: 照合する相手が無いため
  if (
    current !== undefined &&
    current.origin.source === 'account_probe' &&
    current.origin.observedBy !== undefined &&
    observationFreshness(active, current.origin.observedBy) === 'stale'
  ) {
    return {
      kind: 'ignored' as const,
      signal: 'none' as const,
      reason,
      why:
        '枠の probe を観測したが、測った鍵がもう現役ではない（測っている間に回った）' +
        'ので、その判定は現役へ当てずに捨てる',
    };
  }
  return undefined;
}

function observedHowOf(source: TokenVerdictOrigin['source']): string {
  return {
    turn_success: 'ターンが実際に成功した',
    trial: '試しで通ることを観測した',
    account_probe: 'probe で通ることを観測した',
  }[source];
}

// 止まった記録を消して返す回の結果（消す書き込みは呼び元が済ませてから呼ぶ）
export function recoveredOutcome(input: {
  reason: TokenReconsiderReason;
  currentRow: AgentToken;
  source: TokenVerdictOrigin['source'];
}): IgnoredOutcome {
  const { reason, currentRow, source } = input;
  const observedHow = observedHowOf(source);
  return {
    kind: 'ignored' as const,
    signal: 'none' as const,
    reason,
    // source はリテラルで書かない: 生産者を足したときにこの分岐だけ追随し忘れるため
    recovered: {
      tokenId: currentRow.id,
      label: currentRow.label,
      source,
    },
    why: `現役「${currentRow.label}」は${observedHow}（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）`,
  };
}

// usable だが止まった記録も無い（あっても消せない）回の結果
export function usableNoTriggerOutcome(input: {
  reason: TokenReconsiderReason;
  currentRow: AgentToken;
  source: TokenVerdictOrigin['source'];
}): IgnoredOutcome {
  const { reason, currentRow, source } = input;
  const observedHow = observedHowOf(source);
  return {
    kind: 'ignored' as const,
    signal: 'none' as const,
    reason,
    why: `現役「${currentRow.label}」は${observedHow}（回す契機が無い）`,
  };
}

// current ではなく reason を見る側の判定は呼び元に置く。ここは結果だけ
export function successNotReflectedOutcome(input: {
  reason: TokenReconsiderReason;
  current: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin } | undefined;
}): IgnoredOutcome {
  const { reason, current } = input;
  return {
    kind: 'ignored' as const,
    signal: 'none' as const,
    reason,
    why: `${current?.origin.source === 'trial' ? '試しの成功' : 'ターンの成功'}を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない`,
  };
}

export function probeUnusableUnrecordedOutcome(input: {
  reason: TokenReconsiderReason;
  row: AgentToken | undefined;
  currentId: string;
  probeUnusableUnrecorded: string;
  settingsReason: string;
}): IgnoredOutcome {
  const { reason, row, currentId, probeUnusableUnrecorded, settingsReason } = input;
  return {
    kind: 'ignored' as const,
    signal: 'settings_unreadable' as const,
    reason,
    why: `現役「${row?.label ?? currentId}」は probe で通らないことを観測した（${probeUnusableUnrecorded}）。回転の設定が読めなかったので冷却を書けず、この回は回さない（${settingsReason}）`,
  };
}

export function reopenedOutcome(input: {
  reason: TokenReconsiderReason;
  row: AgentToken;
  cooldownUntil: number;
}): IgnoredOutcome {
  const { reason, row, cooldownUntil } = input;
  const elapsedAt = new Date(cooldownUntil).toISOString();
  return {
    kind: 'ignored' as const,
    signal: 'none' as const,
    reason,
    reopened: { tokenId: row.id, label: row.label, cooldownUntil: elapsedAt },
    why: `現役「${row.label}」の冷却が明けた（${elapsedAt}）。**時計で明けたのであって、通ることを観測したわけではない**`,
  };
}

export function readyNoTriggerOutcome(input: {
  reason: TokenReconsiderReason;
  row: AgentToken | undefined;
  currentId: string;
}): IgnoredOutcome {
  const { reason, row, currentId } = input;
  return {
    kind: 'ignored' as const,
    signal: 'none' as const,
    reason,
    why: `記録の上ではいまの現役「${row?.label ?? currentId}」が通る（回す契機が無い。健全な鍵から勝手に移らない）`,
  };
}

// 現役が通らない理由の文面（finishSweep の whyHead になる）
export function strandedWhyOf(input: {
  availability: ReturnType<typeof tokenAvailabilityAt> | 'dangling';
  currentId: string;
  row: AgentToken | undefined;
  blockedByProbe: boolean;
  currentVerdict: TokenCandidateVerdict | undefined;
}): string {
  const { availability, currentId, row, blockedByProbe, currentVerdict } = input;
  return availability === 'dangling'
    ? `現役として記録された id（${currentId}）の行がプールに無い`
    : blockedByProbe
      ? `現役「${row?.label ?? currentId}」は probe で通らないことを観測した（${currentVerdict?.verdict === 'unusable' ? currentVerdict.reason : ''}）`
      : `記録の上でいまの現役「${row?.label ?? currentId}」は通らない（${availability}）`;
}

// 現役が通らないが回さずに返す2つの判定（設定が読めない・rotateOn が off）
export function strandedDecisionOf<Settings extends { rotateOn: string }>(input: {
  reason: TokenReconsiderReason;
  stranded: string;
  settingsRead: SettingsReadLike<Settings>;
}): PrecheckDecision<Settings> {
  const { reason, stranded, settingsRead } = input;
  // signal は stranded を借りない: 設定が読めないことと記録の上で現役が通らないことは別の事実のため
  if (!settingsRead.readable) {
    return {
      kind: 'ignored',
      outcome: {
        kind: 'ignored' as const,
        signal: 'settings_unreadable' as const,
        reason,
        why: `${stranded}。回転の設定が読めなかった（${settingsRead.reason}）ので、この回は回さない`,
      },
    };
  }

  if (settingsRead.settings.rotateOn === 'off') {
    return {
      kind: 'ignored',
      outcome: {
        kind: 'ignored' as const,
        signal: 'stranded' as const,
        reason,
        why: `${stranded}。回す契機の設定が off なので回さない（記録だけする）`,
      },
    };
  }
  return { kind: 'continue', settings: settingsRead.settings };
}
