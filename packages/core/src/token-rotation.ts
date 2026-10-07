import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import {
  tokenAvailabilityAt,
  type ActiveAgentToken,
  type AgentToken,
  type AuthoritativeCooldownSource,
  type CooldownSource,
  type TokenRotationPolicy,
} from './token-pool.js';

// stranded は none・reached を借りない: 回した回の日誌に「回す材料が無い」と書くか、当たっていない文言が当たったことになるため。
// settings_unreadable は none も stranded も借りない: none は日誌に出さない判定に飲まれて消え、stranded は別の事実の印で発生源を誤読させるため
export type TokenRotationSignal =
  | 'reached'
  | 'quota_rejected'
  | 'overage_closed'
  | 'entered_overage'
  | 'org_policy'
  | 'warning'
  | 'none'
  | 'stranded'
  | 'settings_unreadable';

export interface TokenRotationDecision {
  rotate: boolean;
  signal: TokenRotationSignal;
  why: string;
}

export interface TokenRotationObservation {
  // 生の文言を直接渡さない: classifyUsageNotice は部分一致で、クローンが日報に「上限に当たった」と書いた瞬間に誤判定するため
  notice?: UsageLimitNotice;
  facts?: RateLimitFacts;
  // 遷移だけでなく statusNow も運ぶ: 遷移の判定材料はインスタンスの寿命ぶん残り、別のトークンで再発した rejected が届かないため
  transition?: 'entered_overage' | 'rejected';
  // facts の status を見ない: 重ねた形は rejected が残り続けアカウントを跨ぐので、回した直後の健全な鍵でもう一度回るため
  statusNow?: RateLimitFacts['status'];
}

function overageClosed(facts: RateLimitFacts | undefined): boolean {
  if (facts === undefined) return false;
  if (facts.overageStatus === 'rejected') return true;
  if (facts.overageDisabledReason !== undefined) return true;
  // usingOverage === false を「閉じている」と読まない: いま引いていないだけで、引けないではないため
  return false;
}

// reached は free_exhausted でも回す: 弱い契機で回す設定が強い観測で回らないのは矛盾するため。
// 状態で回すのは freshness が current のときだけにする: unknown まで広げると世代を照合できず、rejected が続くあいだ毎ターン回してプールを食い潰すため。
// entered_overage は状態で回さない: usingOverage は重ねた形に残りやすく、回した直後の健全な鍵でもう一度回るため
export function decideTokenRotation(
  policy: TokenRotationPolicy,
  observation: TokenRotationObservation,
  freshness?: ObservationFreshness,
): TokenRotationDecision {
  const { notice, facts, transition, statusNow } = observation;
  const rejected =
    transition === 'rejected' || (statusNow === 'rejected' && freshness === 'current');

  // org_policy を最初に見て必ず回さない: 回してもプールを1周ぶん食って同じところで止まるため
  if (notice?.kind === 'org_policy') {
    return {
      rotate: false,
      signal: 'org_policy',
      why: '組織の方針で止められている（枠ではない）。別のトークンでも同じ組織なら同じ結果になるので回さない',
    };
  }

  if (policy === 'off') {
    return {
      rotate: false,
      signal: signalOf(notice, facts, transition),
      why: '回す契機の設定が off（記録だけする）',
    };
  }

  if (notice?.kind === 'reached') {
    return {
      rotate: true,
      signal: 'reached',
      why: '仕事が止まった文言が出た（設定に関わらず回す）',
    };
  }

  if (policy === 'overage_exhausted') {
    if (rejected && overageClosed(facts)) {
      return {
        rotate: true,
        signal: 'overage_closed',
        why:
          transition === 'rejected'
            ? '枠が尽きたうえに課金枠も閉じている（overage_exhausted）'
            : '枠が尽きたうえに課金枠も閉じている状態がいまの現役について届いた（overage_exhausted。遷移は取れていないが、観測がいまの世代を名乗っている）',
      };
    }
    return {
      rotate: false,
      signal: signalOf(notice, facts, transition),
      why: '設定が overage_exhausted なので、課金枠が生きている限り回さない',
    };
  }

  if (rejected) {
    return {
      rotate: true,
      signal: overageClosed(facts) ? 'overage_closed' : 'quota_rejected',
      why:
        transition === 'rejected'
          ? '無料枠が尽きた（free_exhausted。課金枠を焼く前に回す）'
          : // 遷移ではなく状態で回した回は同じ文言にしない: 日誌から「遷移の門を通れなかった観測が効いた」が消えるため
            '無料枠が尽きた状態がいまの現役について届いた（free_exhausted。遷移は取れていないが、観測がいまの世代を名乗っている）',
    };
  }
  if (transition === 'entered_overage') {
    return {
      rotate: true,
      signal: 'entered_overage',
      why: '課金枠から引き始めた（free_exhausted。課金枠を焼く前に回す）',
    };
  }

  return {
    rotate: false,
    signal: signalOf(notice, facts, transition),
    why: '回す契機に当たる観測が無い',
  };
}

// none へ潰さない: warning は「そろそろ止まる」の唯一の予告で、日誌から区別が消えるため
function signalOf(
  notice: UsageLimitNotice | undefined,
  facts: RateLimitFacts | undefined,
  transition: 'entered_overage' | 'rejected' | undefined,
): TokenRotationSignal {
  // reached を最初に見る: 設定が off の経路でもここへ来て、落とすと自動を切っていたあいだに何回止まったかが取れなくなるため
  if (notice?.kind === 'reached') return 'reached';
  if (notice?.kind === 'org_policy') return 'org_policy';
  if (notice?.kind === 'warning') return 'warning';
  if (transition === 'rejected') return overageClosed(facts) ? 'overage_closed' : 'quota_rejected';
  if (transition === 'entered_overage') return 'entered_overage';
  if (notice?.kind === 'transition') return 'entered_overage';
  return 'none';
}

// この関数の中に既定を持たない: 設定を変えたのに片方の経路だけ古い値で動く形が作れるため。
// resetsAt を overageResetsAt より先に採る: 逆順だと無料枠が先に開くのに課金枠のリセットまで寝るため。
// 過去の値を未来へ丸めない: 既に過ぎていれば「もう戻っている」が正しいため
export function cooldownUntilFrom(facts: RateLimitFacts | undefined): number | undefined {
  return cooldownDeadlineFrom(facts)?.at;
}

// 優先順の判定を3箇所に書かない: ずれたときに記録が実際と違う出所を主張するため
export function cooldownDeadlineFrom(
  facts: RateLimitFacts | undefined,
): { at: number; source: AuthoritativeCooldownSource } | undefined {
  if (facts === undefined) return undefined;
  if (facts.resetsAt !== undefined) return { at: facts.resetsAt, source: 'quota_reset' };
  if (facts.overageResetsAt !== undefined)
    return { at: facts.overageResetsAt, source: 'overage_reset' };
  return undefined;
}

// 渡すのはその枠が実際に拒否した回の事実だけにする: five_hour の拒否に seven_day の resetsAt を当てると1日冷えるため。
// at 以前の期限は使わない: 過去の値を書くと行が ready に見えるため。
// いちばん早いものを採る: 遅いほうだと早く開く枠のリセットを待たずに寝るため。
// resetsAt を直接読まず cooldownUntilFrom に任せる: 優先順の判定が2箇所になるため
export function earliestRememberedCooldown(
  facts: Iterable<RateLimitFacts>,
  at: number,
): { at: number; source: AuthoritativeCooldownSource } | undefined {
  let earliest: { at: number; source: AuthoritativeCooldownSource } | undefined;
  for (const one of facts) {
    const deadline = cooldownDeadlineFrom(one);
    if (deadline === undefined || deadline.at <= at) continue;
    if (earliest === undefined || deadline.at < earliest.at) earliest = deadline;
  }
  return earliest;
}

// 2値にしない: 身元を持たない観測が黙ってどちらかへ倒れ、stale へ倒すと本物の当たりを飲み込んで見えないため。
// 回し手は unknown を current として扱う（飲み込むほうが悪い）が、この関数は倒さず3つ目の値で返す
export type ObservationFreshness = 'current' | 'stale' | 'unknown';

// tokenId だけで照合しない: 同じトークンが冷却明けにもう一度選ばれた後に届いた遅れた通知を現役の通知として受け取るため。
// 現役が無いとき current と答えない: 照合していないのに「照合した」という嘘になるため
export function observationFreshness(
  active: ActiveAgentToken | null,
  observed: { tokenId?: string; generation?: number },
): ObservationFreshness {
  if (active === null) return 'unknown';
  if (observed.generation !== undefined && observed.generation !== active.generation)
    return 'stale';
  if (observed.tokenId !== undefined && observed.tokenId !== active.tokenId) return 'stale';
  if (observed.generation === undefined && observed.tokenId === undefined) return 'unknown';
  return 'current';
}

// 候補が無い回を3つの分岐に分けない: 呼ぶ側が同じ「先頭へ戻らずに待つ」を3回書くことになり、1つ忘れた分岐だけが黙って先頭へ戻るため
export type TokenSelection =
  | { kind: 'candidate'; token: AgentToken }
  | {
      kind: 'none';
      // 無いことを 0 や now で埋めない: 「すぐ戻る」と読めるため
      earliest?: {
        tokenId: string;
        label: string;
        cooldownUntil: number;
        // 行が持っていなければ埋めない: 「推測だと観測した」という嘘になるため
        cooldownSource?: CooldownSource;
      };
      why: string;
    };

export interface SelectNextTokenOptions {
  at: number;
  // 降りたトークンを外す: 外さないと過ぎた resetsAt で ready に見え、自分自身へ回して日誌には「回した」と残るのに撒いた先は変わらないため。
  // 記録ではなくその場の集合で外す: resetsAt が既に過去なら、印を付けた直後でも ready に見えるため
  exclude?: string | readonly string[];
}

export function selectNextToken(
  tokens: readonly AgentToken[],
  options: SelectNextTokenOptions,
): TokenSelection {
  const ordered = [...tokens].sort((a, b) => a.order - b.order);
  const excluded =
    options.exclude === undefined
      ? new Set<string>()
      : new Set(typeof options.exclude === 'string' ? [options.exclude] : options.exclude);
  const eligible = ordered.filter((token) => !excluded.has(token.id));

  const ready = eligible.find((token) => tokenAvailabilityAt(token, options.at) === 'ready');
  if (ready !== undefined) return { kind: 'candidate', token: ready };

  const cooling = eligible
    .filter((token) => tokenAvailabilityAt(token, options.at) === 'cooling')
    .sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));

  const first = cooling[0];
  if (first?.cooldownUntil === undefined) {
    return {
      kind: 'none',
      why:
        eligible.length === 0
          ? '試せる候補が1本も無い（プールが空、または降りた1本しか無い）'
          : '試せる候補が1本も無い（すべて人間が外したか失効している。冷却中のものは無いので、待っても戻らない）',
    };
  }

  return {
    kind: 'none',
    earliest: {
      tokenId: first.id,
      label: first.label,
      cooldownUntil: first.cooldownUntil,
      ...(first.cooldownSource === undefined ? {} : { cooldownSource: first.cooldownSource }),
    },
    why: `候補が全部冷却中である。いちばん早く戻るのは「${first.label}」`,
  };
}
