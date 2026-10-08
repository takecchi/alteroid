import {
  credentialOf,
  markTokenUnusable,
  markTokenUsable,
  tokenAvailabilityAt,
  type TokenCredential,
  type ActiveAgentToken,
  type AgentToken,
  type CooldownSource,
  type TokenFailureObservation,
  type TokenRotationSettings,
} from './token-pool.js';
import {
  cooldownDeadlineFrom,
  cooldownUntilFrom,
  decideTokenRotation,
  earliestRememberedCooldown,
  observationFreshness,
  selectNextToken,
  type ObservationFreshness,
  type TokenRotationSignal,
  type TokenSelection,
} from './token-rotation.js';
import { parseNoticeResetAt } from './usage-reset-text.js';
import type { JournalEntryInput } from './schema.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { TokenCandidateVerdict } from './token-candidate.js';
import {
  UnreadableActiveTokenError,
  UnreadableTokenSettingsError,
  type Stores,
  type TokenPoolStore,
} from './store.js';
import { createTokenPoolWriteLock, type TokenPoolWriteLock } from './token-pool-write-lock.js';

export interface TokenSpreadResult {
  target: string;
  ok: boolean;
  error?: string;
  selfHealing?: boolean;
}

export interface TokenSpreadPort {
  spread(token: { id: string; generation: number } & TokenCredential): Promise<TokenSpreadResult[]>;
}

export interface TokenProbePort {
  probe(
    token: { id: string } & TokenCredential,
  ): Promise<
    | { verdict: 'usable' }
    | { verdict: 'unusable'; reason: string; retryAt?: number }
    | { verdict: 'undecidable'; reason: string }
  >;
}

export type TokenReconsiderReason =
  | 'pool_changed'
  | 'settings_changed'
  | 'tick'
  | 'runner_connected'
  | 'account_probe'
  | 'startup'
  | 'turn_succeeded'
  | 'trial_succeeded';

export type TokenVerdictOrigin =
  | {
      source: 'account_probe';
      observedBy?: { tokenId: string; generation: number };
    }
  | { source: 'turn_success'; observedBy: { tokenId: string; generation: number } };

export type TokenRotationOutcome =
  | {
      kind: 'ignored';
      signal: TokenRotationSignal;
      freshness?: ObservationFreshness;
      reason?: TokenReconsiderReason;
      recovered?: { tokenId: string; label: string; source: TokenVerdictOrigin['source'] };
      reopened?: { tokenId: string; label: string; cooldownUntil: string };
      staleRun?: number;
      why: string;
    }
  | {
      kind: 'rotated';
      fromTokenId?: string;
      toTokenId: string;
      toLabel: string;
      generation: number;
      signal: TokenRotationSignal;
      freshness?: ObservationFreshness;
      reason?: TokenReconsiderReason;
      spread: TokenSpreadResult[];
      why: string;
    }
  | {
      kind: 'parked';
      fromTokenId?: string;
      tokenId: string;
      label: string;
      generation: number;
      cooldownUntil: number;
      cooldownSource?: CooldownSource;
      signal: TokenRotationSignal;
      freshness?: ObservationFreshness;
      reason?: TokenReconsiderReason;
      spread: TokenSpreadResult[];
      why: string;
    }
  | {
      kind: 'exhausted';
      earliest?: {
        tokenId: string;
        label: string;
        cooldownUntil: number;
        cooldownSource?: CooldownSource;
      };
      current?: {
        tokenId: string;
        label: string;
        cooldownUntil: number;
        cooldownSource?: CooldownSource;
      };
      stoppedBy?: 'budget';
      signal: TokenRotationSignal;
      freshness?: ObservationFreshness;
      reason?: TokenReconsiderReason;
      why: string;
    };

export interface TokenRotatorObservation {
  notice?: UsageLimitNotice;
  facts?: RateLimitFacts;
  transition?: 'entered_overage' | 'rejected';
  statusNow?: RateLimitFacts['status'];
  observedBy?: { tokenId?: string; generation?: number };
  succeeded?: true;
}

export interface TokenRotatorOptions {
  stores: Stores;
  probe: TokenProbePort;
  spread: TokenSpreadPort;
  now?: () => Date;
  writeLock?: TokenPoolWriteLock;
}

export type TokenRestoreOutcome =
  | { kind: 'none'; why: string }
  | {
      kind: 'restored';
      tokenId: string;
      label: string;
      generation: number;
      cooling: boolean;
      spread: TokenSpreadResult[];
      why: string;
    }
  | { kind: 'dangling'; tokenId: string; why: string }
  | { kind: 'withheld'; tokenId: string; label: string; why: string }
  | {
      kind: 'unreadable';
      reason: string;
      why: string;
    };

export interface TokenRotator {
  observe(observation: TokenRotatorObservation): Promise<TokenRotationOutcome>;
  reconsider(input: {
    reason: TokenReconsiderReason;
    current?: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin };
  }): Promise<TokenRotationOutcome>;
  recordTrialVerdict(input: {
    tokenId: string;
    verdict: TokenCandidateVerdict;
  }): Promise<'written' | 'unchanged' | 'missing'>;
  // dangling / withheld では値を戻さない: 人間の判断を実装が黙って覆すことになるため
  restore(): Promise<TokenRestoreOutcome>;
}

// 件数ではなく時間で切る: probe は1本あたり最大20秒待つので、件数の上限では占有時間を縛れないため
export const CANDIDATE_SWEEP_BUDGET_MS = 60_000;

interface CandidateSweep {
  chosen?: { token: AgentToken; verdict: TokenCandidateVerdict };
  fellBackToUndecided: boolean;
  unusableLabels: string[];
  // 行そのもの（AgentToken）ではなく観測を持つ: 保存時に読み直した最新の行へ適用しないと、probe の間に人間が変えた欄が古い値へ巻き戻るため
  unusablePatches: { id: string; observation: TokenFailureObservation }[];
  tokens: AgentToken[];
  ranOut?: Extract<TokenSelection, { kind: 'none' }>;
  stoppedByBudget: boolean;
}

// 遅い鍵へ park し直さない: 増えた世代が走行中の観測を全部 stale にするため
function parkImprovesOn(
  candidateCooldownUntil: number,
  activeRow: AgentToken | undefined,
): boolean {
  const current = activeRow?.cooldownUntil;
  if (current === undefined) return true;
  return candidateCooldownUntil < current;
}

// SDK の文言を作らない: ここが書くのは構造化された事実の写しだけで、当たった文言は言い換えずに残すため
function describeCooldownFacts(facts: RateLimitFacts | undefined): string {
  const head = '枠から追い返された（文言は届いていない）';
  if (facts === undefined) return `${head}。枠の事実も届いていない`;
  const parts: string[] = [];
  // 取れなかった欄は書かない: 「不明」で埋めると、取れなかったことと「そういう値だった」が同じ顔になるため
  if (facts.kind !== undefined) parts.push(`枠: ${facts.kind}`);
  if (facts.status !== undefined) parts.push(`status: ${facts.status}`);
  // 判定を2回書かない: ずれると記録が実際と違う出所を主張するため
  const deadline = cooldownDeadlineFrom(facts);
  if (deadline === undefined) {
    parts.push('冷却の期限は設定の既定から（resetsAt も overageResetsAt も届いていない）');
  } else if (deadline.source === 'quota_reset') {
    parts.push(`冷却の期限は枠の resetsAt から: ${new Date(deadline.at).toISOString()}`);
  } else {
    parts.push(`冷却の期限は課金枠の overageResetsAt から: ${new Date(deadline.at).toISOString()}`);
  }
  return `${head}。${parts.join(' / ')}`;
}

// null（指名なし）へ畳まない: 読めない指名を上書きして直す口が無くなるため。他のエラーは飲み込まない
type ActiveTokenRead =
  { readable: true; active: ActiveAgentToken | null } | { readable: false; reason: string };

async function readActiveOrUnreadable(store: TokenPoolStore): Promise<ActiveTokenRead> {
  try {
    return { readable: true, active: await store.readActive() };
  } catch (error) {
    if (error instanceof UnreadableActiveTokenError) {
      return { readable: false, reason: error.message };
    }
    throw error;
  }
}

// 既定値へ畳まない: rotateOn: 'off' にしてあった回転を実装が黙って戻すことになるため。他のエラーは飲み込まない
type SettingsRead =
  { readable: true; settings: TokenRotationSettings } | { readable: false; reason: string };

async function readSettingsOrUnreadable(store: TokenPoolStore): Promise<SettingsRead> {
  try {
    return { readable: true, settings: await store.readSettings() };
  } catch (error) {
    if (error instanceof UnreadableTokenSettingsError) {
      return { readable: false, reason: error.message };
    }
    throw error;
  }
}

export function createTokenRotator(options: TokenRotatorOptions): TokenRotator {
  const { stores, probe, spread } = options;
  const now = options.now ?? (() => new Date());
  const writeLock = options.writeLock ?? createTokenPoolWriteLock();

  // 鍵は id と世代の両方: 世代だけだと、同じ世代のまま指名が変わったときに数え続けるため
  let staleRun: { key: string; identity: ActiveAgentToken | null; count: number } | null = null;

  // 記憶ストアへは書かない: これはこのプロセスが既に起こしたかの計器であって、鍵の状態ではないため
  const announcedReopen = new Map<string, number>();

  // 回し手の側で覚える・判定へ混ぜない・鍵に世代を入れない:
  // 層の側だと文言とは別の層から事実が届く組で片方の記憶しか使えず、判定へ混ぜると古い記憶が回す/回さないを動かすため
  const rememberedRejections = new Map<string, { tokenId: string; facts: RateLimitFacts }>();

  function identityOf(active: ActiveAgentToken | null): string {
    return active === null ? 'none' : `${active.tokenId}#${String(active.generation)}`;
  }

  function describeStaleRunEnd(ended: {
    count: number;
    identity: ActiveAgentToken | null;
    tokens: readonly AgentToken[];
  }): string {
    const { count, identity, tokens } = ended;
    const who =
      identity === null
        ? '(現役が未指名のあいだ)'
        : (() => {
            const label = tokens.find((token) => token.id === identity.tokenId)?.label;
            const labelPart = label === undefined ? '' : `「${label}」`;
            return `前の現役${labelPart}（id ${identity.tokenId}）`;
          })();
    return (
      `\n${who}に対して、もう回した後の通知を計${String(count)}件捨てて、この連なりは終わった` +
      '（**間引きで出していない件も含めた総数**。' +
      '**プロセスが落ちた（デーモンが入れ替わった）ときは、この連なりの総数は出ない**——' +
      'この計器はプロセスの寿命でしか持たないためである）'
    );
  }

  // statusNow を見る: facts.status は重ねた形で、枠が開いた後の観測まで拒否されたとして覚えるため
  function rememberRejection(
    active: ActiveAgentToken | null,
    observation: TokenRotatorObservation,
  ): void {
    if (active === null) return;
    const facts = observation.facts;
    if (facts === undefined) return;
    const key = `${active.tokenId}#${facts.kind ?? ''}`;
    if (observation.statusNow === 'allowed' || observation.statusNow === 'allowed_warning') {
      rememberedRejections.delete(key);
      return;
    }
    if (observation.statusNow !== 'rejected') return;
    if (cooldownUntilFrom(facts) === undefined) return;
    rememberedRejections.set(key, { tokenId: active.tokenId, facts });
  }

  function forgetRejections(tokenId: string): void {
    for (const [key, entry] of rememberedRejections) {
      if (entry.tokenId === tokenId) rememberedRejections.delete(key);
    }
  }

  function rememberedFactsFor(tokenId: string): RateLimitFacts[] {
    return [...rememberedRejections.values()]
      .filter((entry) => entry.tokenId === tokenId)
      .map((entry) => entry.facts);
  }

  let tail: Promise<unknown> = Promise.resolve();
  // 並列に回さない: 同じ文言が2本同時に届くとプールを一気に食うため
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // 呼び出し元から一覧を受け取らない: 周の先頭で読んだ一覧を書き戻すと、直前に完了した PUT /tokens を踏み消すため
  async function coolDown(
    outgoingId: string,
    settings: TokenRotationSettings,
    observation: TokenRotatorObservation,
  ): Promise<AgentToken[]> {
    const at = now().toISOString();
    const resets =
      cooldownDeadlineFrom(observation.facts) ??
      earliestRememberedCooldown(rememberedFactsFor(outgoingId), Date.parse(at));
    const noticeResetsAt =
      resets !== undefined || observation.notice === undefined
        ? undefined
        : parseNoticeResetAt(observation.notice.text, {
            at: Date.parse(at),
            withinMs: settings.cooldownMs,
          });
    const mutate = (token: AgentToken): AgentToken =>
      markTokenUnusable(token, {
        at,
        message: observation.notice?.text ?? describeCooldownFacts(observation.facts),
        ...(resets === undefined ? {} : { resets }),
        ...(noticeResetsAt === undefined ? {} : { noticeResetsAt }),
        fallbackCooldownMs: settings.cooldownMs,
      });
    return writeLock.run(async () => {
      const latest = await stores.tokens.list();
      if (!latest.some((token) => token.id === outgoingId)) return latest;
      return stores.tokens.replace(
        latest.map((token) => (token.id === outgoingId ? mutate(token) : token)),
      );
    });
  }

  async function sweepCandidates(
    startTokens: readonly AgentToken[],
    exclude: readonly string[],
    settings: TokenRotationSettings,
  ): Promise<CandidateSweep> {
    const tried = new Set<string>(exclude);
    const sweepStartedAt = now().getTime();

    let sweptTokens = [...startTokens];
    const unusableLabels: string[] = [];
    const unusablePatches: { id: string; observation: TokenFailureObservation }[] = [];
    let chosen: { token: AgentToken; verdict: TokenCandidateVerdict } | undefined;
    // undecidable は順位を下げるだけで捨てない: usable が1本も無ければここへ倒すため
    let undecided: { token: AgentToken; verdict: TokenCandidateVerdict } | undefined;
    let ranOut: Extract<TokenSelection, { kind: 'none' }> | undefined;
    let stoppedByBudget = false;

    for (;;) {
      const selection = selectNextToken(sweptTokens, {
        at: now().getTime(),
        exclude: [...tried],
      });
      if (selection.kind === 'none') {
        ranOut = selection;
        break;
      }
      // 持ち時間は選んでから probe を始める前に見る: 初回は経過が 0 なので必ず1本は試すため
      if (now().getTime() - sweepStartedAt >= CANDIDATE_SWEEP_BUDGET_MS) {
        stoppedByBudget = true;
        break;
      }
      tried.add(selection.token.id);

      // 候補を本番の仕事で試さない: 推論が走らない probe で確かめるため
      const verdict = await probe.probe({
        id: selection.token.id,
        ...credentialOf(selection.token),
      });
      // undecidable で止めない: usable が後ろに居ても届かなくなるため
      if (verdict.verdict === 'usable') {
        chosen = { token: selection.token, verdict };
        break;
      }
      if (verdict.verdict === 'undecidable') {
        undecided ??= { token: selection.token, verdict };
        continue;
      }

      // ローカルの sweptTokens は次の候補選びのためだけ: 保存には observation を使う（finishSweep が最新の行へ当てる）
      const at = now().toISOString();
      const observation: TokenFailureObservation = {
        at,
        message: verdict.reason,
        // source は default ではなく quota_reset: probe の retryAt は claude.ai が言っている値で、こちらが足した推測ではないため
        ...(verdict.retryAt === undefined
          ? {}
          : { resets: { at: verdict.retryAt, source: 'quota_reset' as const } }),
        fallbackCooldownMs: settings.cooldownMs,
      };
      sweptTokens = sweptTokens.map((token) =>
        token.id === selection.token.id ? markTokenUnusable(token, observation) : token,
      );
      unusableLabels.push(selection.token.label);
      unusablePatches.push({ id: selection.token.id, observation });
    }

    // 打ち切りでも undecided へ倒す: 省くと持ち時間切れで見つけてあった undecidable を捨てることになるため
    const fellBackToUndecided = chosen === undefined && undecided !== undefined;
    if (fellBackToUndecided) chosen = undecided;

    return {
      ...(chosen === undefined ? {} : { chosen }),
      fellBackToUndecided,
      unusableLabels,
      unusablePatches,
      tokens: sweptTokens,
      ...(ranOut === undefined ? {} : { ranOut }),
      stoppedByBudget,
    };
  }

  // observe と reconsider が同じここを通る: 回った後の処理を2本にすると、片方だけが parked や保存の順序を持つ形が静かに生まれるため
  async function finishSweep(input: {
    sweep: CandidateSweep;
    active: ActiveAgentToken | null;
    activeUnreadableReason?: string;
    outgoingId?: string;
    signal: TokenRotationSignal;
    freshness?: ObservationFreshness;
    reason?: TokenReconsiderReason;
    whyHead: string;
  }): Promise<TokenRotationOutcome> {
    const {
      sweep,
      active,
      activeUnreadableReason,
      outgoingId,
      signal,
      freshness,
      reason,
      whyHead,
    } = input;
    const common = {
      signal,
      ...(freshness === undefined ? {} : { freshness }),
      ...(reason === undefined ? {} : { reason }),
    };

    const endedStaleRun =
      staleRun !== null && staleRun.key === identityOf(active)
        ? { count: staleRun.count, identity: active }
        : null;

    // 周ごとに保存しない・sweep.tokens をそのまま書き戻さない:
    // 途中で落ちると一部の候補にだけ冷却が付いた版が残り、probe 前に読んだ一覧は完了済みの PUT /tokens を踏み消すため
    const pool =
      sweep.unusablePatches.length === 0
        ? sweep.tokens
        : await writeLock.run(async () => {
            const latest = await stores.tokens.list();
            const observationById = new Map(
              sweep.unusablePatches.map((patch) => [patch.id, patch.observation] as const),
            );
            return stores.tokens.replace(
              latest.map((token) => {
                const observation = observationById.get(token.id);
                return observation === undefined ? token : markTokenUnusable(token, observation);
              }),
            );
          });

    // pool から引く: sweep.tokens から引くと、いま冷やしたばかりの現役を冷却中ではないと読むため
    const activeRow =
      active === null ? undefined : pool.find((token) => token.id === active.tokenId);

    const skipped =
      sweep.unusableLabels.length === 0
        ? ''
        : `。試した候補「${sweep.unusableLabels.join('」「')}」はどれも使えなかった`;

    const unreadableTail = (generation: number): string =>
      activeUnreadableReason === undefined
        ? ''
        : `\n**現役の指名が読めなかったので、世代 ${String(generation)} で撒き直した**（${activeUnreadableReason}）`;

    // 撒いてから保存しない: 保存が落ちたときに誰も成功と言っていない版を1層だけが使うことになるため
    const nominate = async (
      token: AgentToken,
    ): Promise<{ generation: number; spread: TokenSpreadResult[] }> => {
      // 読めない指名を上書きするときだけ世代を時刻から作る: 前の世代が読めない以上 +1 は過去の世代と重なりうるため
      const generation =
        activeUnreadableReason === undefined ? (active?.generation ?? 0) + 1 : now().getTime();
      const nextActive: ActiveAgentToken = {
        tokenId: token.id,
        generation,
        rotatedAt: now().toISOString(),
      };
      await stores.tokens.writeActive(nextActive);
      const results = await spread.spread({
        id: token.id,
        generation,
        ...credentialOf(token),
      });
      return { generation, spread: results };
    };

    if (sweep.chosen !== undefined) {
      const { token, verdict } = sweep.chosen;
      const placed = await nominate(token);
      if (endedStaleRun !== null) staleRun = null;
      return {
        kind: 'rotated' as const,
        ...(outgoingId === undefined ? {} : { fromTokenId: outgoingId }),
        toTokenId: token.id,
        toLabel: token.label,
        generation: placed.generation,
        ...common,
        spread: placed.spread,
        why: (() => {
          const head = `${whyHead}。`;
          const tail =
            endedStaleRun === null ? '' : describeStaleRunEnd({ ...endedStaleRun, tokens: pool });
          if (verdict.verdict === 'usable') {
            return `${head}候補「${token.label}」は観測できた${tail}${unreadableTail(placed.generation)}`;
          }
          const stopped = sweep.stoppedByBudget
            ? `（候補を試す持ち時間（${String(CANDIDATE_SWEEP_BUDGET_MS)}ms）を使い切ったところで倒した）`
            : '';
          if (sweep.fellBackToUndecided) {
            return (
              `${head}**\`usable\` と確かめられた候補は見つからなかった**ので、` +
              `判定できなかった候補「${token.label}」へ倒した${stopped}` +
              `——撒いて本番で確かめる（${verdict.reason}）${tail}${unreadableTail(placed.generation)}`
            );
          }
          return `${head}候補「${token.label}」は判定できなかったので撒いて本番で確かめる（${verdict.reason}）${tail}${unreadableTail(placed.generation)}`;
        })(),
      };
    }

    // 現役自身へは park し直さない: 同じ鍵を撒き直すと世代だけが増え、走行中の観測を stale として捨てさせるため
    const earliest = sweep.stoppedByBudget ? undefined : sweep.ranOut?.earliest;
    if (
      earliest !== undefined &&
      earliest.tokenId !== active?.tokenId &&
      parkImprovesOn(earliest.cooldownUntil, activeRow)
    ) {
      const row = pool.find((token) => token.id === earliest.tokenId);
      if (row !== undefined) {
        const placed = await nominate(row);
        if (endedStaleRun !== null) staleRun = null;
        return {
          kind: 'parked' as const,
          ...(outgoingId === undefined ? {} : { fromTokenId: outgoingId }),
          tokenId: row.id,
          label: row.label,
          generation: placed.generation,
          cooldownUntil: earliest.cooldownUntil,
          ...(earliest.cooldownSource === undefined
            ? {}
            : { cooldownSource: earliest.cooldownSource }),
          ...common,
          spread: placed.spread,
          why:
            `${whyHead}。**いま通る候補は1本も無い**${skipped}。` +
            `いちばん早く戻る「${row.label}」を撒いて待つ` +
            `（${new Date(earliest.cooldownUntil).toISOString()} まで通らない）` +
            (endedStaleRun === null
              ? ''
              : describeStaleRunEnd({ ...endedStaleRun, tokens: pool })) +
            unreadableTail(placed.generation),
        };
      }
    }

    // 器の環境変数の値を代わりに撒かない: トークンプールは DB 駆動で、環境変数へのフォールバックは残さないため
    const current =
      earliest !== undefined &&
      earliest.tokenId !== active?.tokenId &&
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
            earliest.tokenId === active?.tokenId
            ? `いちばん早く戻る候補が現役自身だった（撒き直しても同じ鍵なので、世代だけ増やすことはしない）${skipped}`
            : `いま撒いてある${current === undefined ? '鍵' : `「${current.label}」`}のほうが早く戻る（現役を除いた候補の中でいちばん早い「${earliest.label}」は ${new Date(earliest.cooldownUntil).toISOString()}）。遅い鍵へ移すのは改善ではないので撒き直さない${skipped}`
          : sweep.unusableLabels.length > 0
            ? `試せる候補を使い切った${skipped}`
            : (sweep.ranOut?.why ?? '候補が無い'),
    };
  }

  return {
    // 同じ列を通す: 引き取りと観測が並ぶと、撒き直しの途中に回転が割り込んで古い方を後から撒くため
    restore: () =>
      serial(async () => {
        const [tokens, activeRead] = await Promise.all([
          stores.tokens.list(),
          readActiveOrUnreadable(stores.tokens),
        ]);

        if (!activeRead.readable) {
          return {
            kind: 'unreadable' as const,
            reason: activeRead.reason,
            why: `現役の指名が読めなかった（${activeRead.reason}）。指名なしと同じ扱いで、何も撒かない`,
          };
        }
        const active = activeRead.active;

        if (active === null) {
          return {
            kind: 'none' as const,
            why: 'まだ一度も回していない（プールにまだ何も登録されていない、または一度も候補へ回っていない）',
          };
        }

        const row = tokens.find((token) => token.id === active.tokenId);
        if (row === undefined) {
          // 記憶ストアへ書いて直さない: 次の当たりで回し手が正しい候補へ移り、ここで消すのは見えなくするだけになるため
          return {
            kind: 'dangling' as const,
            tokenId: active.tokenId,
            why: '現役として記録された行がプールに無い（人間が消した）',
          };
        }

        const availability = tokenAvailabilityAt(row, now().getTime());
        if (availability === 'disabled' || availability === 'invalidated') {
          // 人間が外したものを起動時に戻さない: 人間の判断を黙って覆すことになるため
          return {
            kind: 'withheld' as const,
            tokenId: row.id,
            label: row.label,
            why:
              availability === 'disabled'
                ? `現役として記録された「${row.label}」は人間が外している。撒き直さない`
                : `現役として記録された「${row.label}」は失効している。撒き直さない`,
          };
        }

        const cooling = availability === 'cooling';
        const spreadResults = await spread.spread({
          id: row.id,
          // 世代を増やさない: まだ有効な観測が stale として捨てられるため
          generation: active.generation,
          ...credentialOf(row),
        });
        return {
          kind: 'restored' as const,
          tokenId: row.id,
          label: row.label,
          generation: active.generation,
          cooling,
          spread: spreadResults,
          why: cooling
            ? `現役の「${row.label}」を撒き直した。**ただし冷却中である**（次に枠へ当たれば回し手が次の候補へ移す）`
            : `現役の「${row.label}」を撒き直した`,
        };
      }),

    observe: (observation: TokenRotatorObservation) =>
      serial(async () => {
        const [tokens, settingsRead, activeRead] = await Promise.all([
          stores.tokens.list(),
          readSettingsOrUnreadable(stores.tokens),
          readActiveOrUnreadable(stores.tokens),
        ]);
        const active = activeRead.readable ? activeRead.active : null;
        const activeUnreadableReason = activeRead.readable ? undefined : activeRead.reason;

        const freshness = observationFreshness(active, observation.observedBy ?? {});

        // 既定値へすり替えない: rotateOn: 'off' の回転を黙って戻すことになるため。signal は none を借りない: 日誌に出ず設定が壊れている事実が消えるため
        if (!settingsRead.readable) {
          if (freshness !== 'stale') rememberRejection(active, observation);
          return {
            kind: 'ignored' as const,
            signal: 'settings_unreadable' as const,
            freshness,
            why: `回転の設定が読めなかった（${settingsRead.reason}）。回すかどうかを判定できないので、この回は回さない`,
          };
        }
        const settings = settingsRead.settings;

        const decision = decideTokenRotation(settings.rotateOn, observation, freshness);

        // stale でも冷却は書かない: 遅れて届いた観測が本物の期限が未来に在る鍵を早く ready に見せ、冷却を縮めるため
        if (freshness === 'stale') {
          const key = identityOf(active);
          const previousRun = staleRun;
          const isNewRun = previousRun === null || previousRun.key !== key;
          staleRun = isNewRun
            ? { key, identity: active, count: 1 }
            : { key, identity: active, count: previousRun.count + 1 };
          const endedSuffix =
            isNewRun && previousRun !== null
              ? describeStaleRunEnd({
                  count: previousRun.count,
                  identity: previousRun.identity,
                  tokens,
                })
              : '';
          return {
            kind: 'ignored' as const,
            signal: decision.signal,
            freshness,
            staleRun: staleRun.count,
            why: `もう回した後の通知（世代が合わない）${endedSuffix}`,
          };
        }

        // stale の後・判定の前に置く: 後ろだと回らなかった回の事実が落ち、前だと前の世代の鍵の期限を今の鍵として覚えるため
        rememberRejection(active, observation);

        if (!decision.rotate) {
          return {
            kind: 'ignored' as const,
            signal: decision.signal,
            freshness,
            why: decision.why,
          };
        }

        if (tokens.length === 0) {
          return {
            kind: 'exhausted' as const,
            signal: decision.signal,
            freshness,
            why: 'プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）',
          };
        }

        const outgoingId = active?.tokenId;
        const afterCoolDown =
          outgoingId === undefined ? tokens : await coolDown(outgoingId, settings, observation);

        const sweep = await sweepCandidates(
          afterCoolDown,
          outgoingId === undefined ? [] : [outgoingId],
          settings,
        );
        return finishSweep({
          sweep,
          active,
          ...(activeUnreadableReason === undefined ? {} : { activeUnreadableReason }),
          ...(outgoingId === undefined ? {} : { outgoingId }),
          signal: decision.signal,
          freshness,
          whyHead: decision.why,
        });
      }),

    recordTrialVerdict: (input: { tokenId: string; verdict: TokenCandidateVerdict }) =>
      serial(async () => {
        const tokens = await stores.tokens.list();
        const row = tokens.find((token) => token.id === input.tokenId);
        if (row === undefined) return 'missing' as const;
        const at = now().toISOString();
        const { verdict } = input;
        let mutate: (token: AgentToken) => AgentToken;
        if (verdict.verdict === 'usable') {
          if (row.cooldownUntil === undefined && row.lastRejectedAt === undefined) {
            return 'unchanged' as const;
          }
          mutate = (token) => markTokenUsable(token, at);
        } else if (verdict.verdict === 'unusable' && verdict.retryAt !== undefined) {
          if (row.cooldownUntil === verdict.retryAt) return 'unchanged' as const;
          // 設定が読めなくても書く: この分岐は resets を必ず運ぶので、冷却の期限は設定に依存しないため
          const settingsRead = await readSettingsOrUnreadable(stores.tokens);
          const retryAt = verdict.retryAt;
          const reason = verdict.reason;
          mutate = (token) =>
            markTokenUnusable(token, {
              at,
              message: reason,
              resets: { at: retryAt, source: 'quota_reset' },
              ...(settingsRead.readable
                ? { fallbackCooldownMs: settingsRead.settings.cooldownMs }
                : {}),
            });
        } else {
          return 'unchanged' as const;
        }
        const wrote = await writeLock.run(async () => {
          const latest = await stores.tokens.list();
          if (!latest.some((token) => token.id === input.tokenId)) return false;
          await stores.tokens.replace(
            latest.map((token) => (token.id === input.tokenId ? mutate(token) : token)),
          );
          return true;
        });
        return wrote ? ('written' as const) : ('unchanged' as const);
      }),

    reconsider: (input: {
      reason: TokenReconsiderReason;
      current?: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin };
    }) =>
      serial(async () => {
        const { reason, current } = input;
        const currentVerdict = current?.verdict;
        const [tokens, settingsRead, activeRead] = await Promise.all([
          stores.tokens.list(),
          readSettingsOrUnreadable(stores.tokens),
          readActiveOrUnreadable(stores.tokens),
        ]);
        const active = activeRead.readable ? activeRead.active : null;
        const activeUnreadableReason = activeRead.readable ? undefined : activeRead.reason;

        // exhausted にしない: あちらは全層が止まる顔で、ここは何も起きていないため
        if (tokens.length === 0) {
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: 'プールにトークンが1本も無い（器の環境変数だけの構成。回す先が無い）',
          };
        }

        const currentId = active?.tokenId;
        const currentRow =
          currentId === undefined ? undefined : tokens.find((token) => token.id === currentId);

        if (currentId === undefined) {
          // 成功は回す契機にしない: turn_succeeded はターンが成功した証拠であって、選び直す判定ではないため
          if (reason === 'turn_succeeded') {
            return {
              kind: 'ignored' as const,
              signal: 'none' as const,
              reason,
              why: 'ターンの成功を観測したが、まだ一度も指名していない（成功は回す契機にしない）',
            };
          }

          // signal は stranded を借りない: あちらは記録の上で現役が通らないという別の事実の印のため
          if (!settingsRead.readable) {
            return {
              kind: 'ignored' as const,
              signal: 'settings_unreadable' as const,
              reason,
              why: `まだ一度も指名していない。回転の設定が読めなかった（${settingsRead.reason}）ので、この回は回さない`,
            };
          }
          if (settingsRead.settings.rotateOn === 'off') {
            return {
              kind: 'ignored' as const,
              signal: 'stranded' as const,
              reason,
              why: 'まだ一度も指名していない。回す契機の設定が off なので回さない（記録だけする）',
            };
          }
          const sweep = await sweepCandidates(tokens, [], settingsRead.settings);
          return finishSweep({
            sweep,
            active: null,
            ...(activeUnreadableReason === undefined ? {} : { activeUnreadableReason }),
            signal: 'stranded' as const,
            reason,
            whyHead: 'まだ一度も指名していない',
          });
        }

        // 世代の門は turn_success だけ: 回った後に届いた前の世代の成功が、未試行の新しい現役の記録を usable にしうるため
        if (current !== undefined && current.origin.source === 'turn_success') {
          const freshness = observationFreshness(active, current.origin.observedBy);
          if (freshness !== 'current') {
            return {
              kind: 'ignored' as const,
              signal: 'none' as const,
              reason,
              why:
                'ターンの成功を観測したが、世代が合わない（もう回した後、' +
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

        if (
          current !== undefined &&
          current.verdict.verdict === 'usable' &&
          currentRow !== undefined
        ) {
          // hasRejection とは別に無条件で忘れる: 行に止まった記録が無い回でも記憶のほうは残っているため
          forgetRejections(currentRow.id);
          const availability = tokenAvailabilityAt(currentRow, now().getTime());
          const hasRejection =
            currentRow.lastRejectedAt !== undefined || currentRow.cooldownUntil !== undefined;
          const observedHow =
            current.origin.source === 'turn_success'
              ? 'ターンが実際に成功した'
              : 'probe で通ることを観測した';
          // disabled / invalidated には触らない: 人間の判断を通ったことを理由に覆すことになるため
          if (hasRejection && availability !== 'disabled' && availability !== 'invalidated') {
            // tokens をそのまま書き戻さない: 周の先頭で読んだ版は完了済みの PUT /tokens を踏み消すため
            const recoveredAt = now().toISOString();
            const currentRowId = currentRow.id;
            await writeLock.run(async () => {
              const latest = await stores.tokens.list();
              if (!latest.some((token) => token.id === currentRowId)) return;
              await stores.tokens.replace(
                latest.map((token) =>
                  token.id === currentRowId ? markTokenUsable(token, recoveredAt) : token,
                ),
              );
            });
            return {
              kind: 'ignored' as const,
              signal: 'none' as const,
              reason,
              // source はリテラルで書かない: 生産者を足したときにこの分岐だけ追随し忘れるため
              recovered: {
                tokenId: currentRow.id,
                label: currentRow.label,
                source: current.origin.source,
              },
              why: `現役「${currentRow.label}」は${observedHow}（止まった記録を消した。冷却の見込みが実際より長かった分がここで戻る）`,
            };
          }
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: `現役「${currentRow.label}」は${observedHow}（回す契機が無い）`,
          };
        }

        // current ではなく reason を見る: current を条件にすると、判定を落とした状態で契機だけが届いた場合に素通りするため
        if (reason === 'turn_succeeded') {
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: 'ターンの成功を観測したが、現役の記録に反映できなかった（行がプールに見つからない等）。成功は回す契機にしない',
          };
        }

        let pool = tokens;
        let blockedByProbe = false;
        let probeUnusableUnrecorded: string | undefined;
        if (currentVerdict?.verdict === 'unusable' && currentRow !== undefined) {
          const resets =
            currentVerdict.retryAt === undefined
              ? undefined
              : { at: currentVerdict.retryAt, source: 'quota_reset' as const };
          // 既定値へすり替えない: 設定が読めず resets も無ければ書かない
          if (resets !== undefined || settingsRead.readable) {
            const at = now().toISOString();
            const currentRowId = currentRow.id;
            const reason = currentVerdict.reason;
            const fallbackCooldownMs = settingsRead.readable
              ? settingsRead.settings.cooldownMs
              : undefined;
            // tokens をそのまま書き戻さない: 周の先頭で読んだ版は完了済みの PUT /tokens を踏み消すため
            pool = await writeLock.run(async () => {
              const latest = await stores.tokens.list();
              if (!latest.some((token) => token.id === currentRowId)) return latest;
              return stores.tokens.replace(
                latest.map((token) =>
                  token.id === currentRowId
                    ? markTokenUnusable(token, {
                        at,
                        message: reason,
                        ...(resets === undefined ? {} : { resets }),
                        ...(fallbackCooldownMs === undefined ? {} : { fallbackCooldownMs }),
                      })
                    : token,
                ),
              );
            });
            blockedByProbe = true;
          } else {
            probeUnusableUnrecorded = currentVerdict.reason;
          }
        }

        const row = pool.find((token) => token.id === currentId);
        const availability =
          row === undefined ? 'dangling' : tokenAvailabilityAt(row, now().getTime());

        if (availability === 'ready') {
          // reopened の判定より前に置く: 後ろだと明けた合図を出して返り、probe で通らないと観測した事実が消えるため
          if (probeUnusableUnrecorded !== undefined && !settingsRead.readable) {
            return {
              kind: 'ignored' as const,
              signal: 'settings_unreadable' as const,
              reason,
              why: `現役「${row?.label ?? currentId}」は probe で通らないことを観測した（${probeUnusableUnrecorded}）。回転の設定が読めなかったので冷却を書けず、この回は回さない（${settingsRead.reason}）`,
            };
          }
          // rotateOn: 'off' でも出す: あれは勝手に鍵を移すなであって、止まったままにしておけではないため
          if (
            row?.cooldownUntil !== undefined &&
            announcedReopen.get(row.id) !== row.cooldownUntil
          ) {
            announcedReopen.set(row.id, row.cooldownUntil);
            const elapsedAt = new Date(row.cooldownUntil).toISOString();
            return {
              kind: 'ignored' as const,
              signal: 'none' as const,
              reason,
              reopened: { tokenId: row.id, label: row.label, cooldownUntil: elapsedAt },
              why: `現役「${row.label}」の冷却が明けた（${elapsedAt}）。**時計で明けたのであって、通ることを観測したわけではない**`,
            };
          }
          return {
            kind: 'ignored' as const,
            signal: 'none' as const,
            reason,
            why: `記録の上ではいまの現役「${row?.label ?? currentId}」が通る（回す契機が無い。健全な鍵から勝手に移らない）`,
          };
        }

        const stranded =
          availability === 'dangling'
            ? `現役として記録された id（${currentId}）の行がプールに無い`
            : blockedByProbe
              ? `現役「${row?.label ?? currentId}」は probe で通らないことを観測した（${currentVerdict?.verdict === 'unusable' ? currentVerdict.reason : ''}）`
              : `記録の上でいまの現役「${row?.label ?? currentId}」は通らない（${availability}）`;

        // signal は stranded を借りない: 設定が読めないことと記録の上で現役が通らないことは別の事実のため
        if (!settingsRead.readable) {
          return {
            kind: 'ignored' as const,
            signal: 'settings_unreadable' as const,
            reason,
            why: `${stranded}。回転の設定が読めなかった（${settingsRead.reason}）ので、この回は回さない`,
          };
        }

        if (settingsRead.settings.rotateOn === 'off') {
          return {
            kind: 'ignored' as const,
            signal: 'stranded' as const,
            reason,
            why: `${stranded}。回す契機の設定が off なので回さない（記録だけする）`,
          };
        }

        const sweep = await sweepCandidates(pool, [currentId], settingsRead.settings);
        return finishSweep({
          sweep,
          active,
          // 指名が無いときに fromTokenId を名乗らない: 回したことのない鍵から回ったことになるため
          ...(active === null ? {} : { outgoingId: active.tokenId }),
          signal: 'stranded' as const,
          reason,
          whyHead: stranded,
        });
      }),
  };
}

// 成功だけを数えて 2/3 と書かない: どれが落ちたのかが読めなくなるため
function describeSpread(results: readonly TokenSpreadResult[]): string {
  if (results.length === 0) return '撒いた先: 無し';
  const failed = results.filter((result) => !result.ok);
  const ok = results.filter((result) => result.ok).map((result) => result.target);
  const parts: string[] = [];
  if (ok.length > 0) parts.push(`置けた: ${ok.join(', ')}`);
  for (const result of failed) {
    if (result.selfHealing === true) {
      parts.push(
        `**相手が居ないだけ: ${result.target}**（${result.error ?? '理由不明'}。自己修復する）`,
      );
      continue;
    }
    parts.push(`**置けなかった: ${result.target}**（${result.error ?? '理由不明'}）`);
  }
  return parts.join(' / ');
}

// 件数で上限を切らない: 越えた先が丸ごと見えなくなるため
function isThinnedMilestone(count: number): boolean {
  if (count === 1) return true;
  if (count < 10) return false;
  // 浮動小数の対数を使わない: Math.log10(1000) が 2.9999… になる器が在り、桁が上がった回だけ静かに出なくなるため
  for (let milestone = 10; milestone <= count; milestone *= 10) {
    if (milestone === count) return true;
  }
  return false;
}

export function describeCooldownSource(source: CooldownSource | undefined): string {
  switch (source) {
    case 'quota_reset':
      return '。出所は枠の resetsAt（権威ある値）';
    case 'overage_reset':
      return '。出所は課金枠の overageResetsAt（権威ある値。枠そのものではない）';
    case 'notice_text':
      return '。**出所は上限の文言に書かれていた時刻（推測。ただし既定よりは良い）**';
    case 'default':
      return '。**出所は設定の既定（ただの推測である）**';
    // 無いときは default として書かない: 推測だと観測したという嘘になるため。型の網羅性とは別に、実行時の倒れ先が要る
    default:
      return '';
  }
}

export function describeTokenRotation(
  outcome: TokenRotationOutcome,
  observed?: { noticeText?: string },
): string | null {
  const tail = observed?.noticeText === undefined ? '' : `\n当たった文言: ${observed.noticeText}`;

  if (outcome.kind === 'ignored') {
    if (outcome.freshness === 'stale') {
      const run = outcome.staleRun;
      // 数を 1 で埋めない: 初出が捏造されるため
      if (run === undefined || !isThinnedMilestone(run)) return null;
      return (
        `認証トークン: 回さなかった（${outcome.signal}）。${outcome.why}。` +
        `いまの現役に対して${String(run)}件目である（**捨てた側の計器**。` +
        '初出と10の冪だけ出しているので、これは連番ではない)' +
        tail
      );
    }
    // 回復は signal: 'none' でも出す: 出ないと日誌に止まったしか残らず、いつ開いたかを後から言えないため
    if (outcome.recovered !== undefined) {
      return (
        `認証トークン: **止まっていた現役が、また通ることを観測できた**` +
        `（id ${outcome.recovered.tokenId} / 「${outcome.recovered.label}」）。${outcome.why}\n` +
        '**回してはいない** — 鍵は1文字も変わっていない。消したのは止まった記録だけである' +
        tail
      );
    }
    if (outcome.reopened !== undefined) {
      return (
        `認証トークン: **現役の冷却が明けた**` +
        `（id ${outcome.reopened.tokenId} / 「${outcome.reopened.label}」。期限 ${outcome.reopened.cooldownUntil}）。${outcome.why}\n` +
        '**通ることを観測したわけではない** — 記録した期限を過ぎたので、止まっていた層を起こすだけである' +
        tail
      );
    }
    if (outcome.signal === 'none') return null;
    return `認証トークン: 回さなかった（${outcome.signal}）。${outcome.why}${tail}`;
  }

  if (outcome.kind === 'exhausted') {
    // 打ち切ったときに戻る見込みが1本も無いと言わない: まだ試していない候補が在るのに1本も無いと言うことになるため
    const earliest =
      outcome.stoppedBy === 'budget'
        ? '**まだ試していない候補が残っている**（戻る見込みは測っていない）'
        : outcome.earliest === undefined
          ? '**戻る見込みの立っている候補が1本も無い**'
          : outcome.current !== undefined
            ? // 候補を全体の最速として書かない: 現役のほうが早いのに候補が最速に読めるため
              `いちばん早く戻るのは現役の「${outcome.current.label}」（${new Date(outcome.current.cooldownUntil).toISOString()}${describeCooldownSource(outcome.current.cooldownSource)}）`
            : `いちばん早く戻るのは「${outcome.earliest.label}」（${new Date(outcome.earliest.cooldownUntil).toISOString()}${describeCooldownSource(outcome.earliest.cooldownSource)}）`;
    return `認証トークン: **回せなかった**（${outcome.signal}）。${outcome.why}。${earliest}${tail}`;
  }

  const from = outcome.fromTokenId === undefined ? '（指名なし）' : outcome.fromTokenId;

  if (outcome.kind === 'parked') {
    return (
      `認証トークン: **いま通る鍵は無い。いちばん早く戻る鍵を撒いて待つ**` +
      `（${outcome.signal} / 世代 ${String(outcome.generation)}）。` +
      `${from} → 「${outcome.label}」（id ${outcome.tokenId}）。${outcome.why}\n` +
      `${describeSpread(outcome.spread)}\n` +
      // 出所は時刻の直後ではなく文の後ろへ置く: 時刻と「まで通らない」の間に差し込むと読める文でなくなるため
      `**⚠️ この鍵は ${new Date(outcome.cooldownUntil).toISOString()} まで通らない** — ` +
      'それまでのターンは失敗する。撒いてあるのは「開いた瞬間にそのまま通る」ため' +
      `である（回し手をもう一度通らずに復帰する）` +
      `${describeCooldownSource(outcome.cooldownSource)}${tail}`
    );
  }

  return (
    `認証トークン: **回した**（${outcome.signal} / 世代 ${String(outcome.generation)}）。` +
    `${from} → 「${outcome.toLabel}」（id ${outcome.toTokenId}）。${outcome.why}\n` +
    `${describeSpread(outcome.spread)}\n` +
    '**⚠️ 撒いたのであって、回ったのではない** — 走行中のセッションには届かない。' +
    `回ったことの証拠は次のターンが成功することだけである${tail}`
  );
}

// none は出さない: 既定の構成では毎回の起動で出て、意味のある行が埋もれるため
export function describeTokenRestore(outcome: TokenRestoreOutcome): string | null {
  if (outcome.kind === 'none') return null;
  if (outcome.kind === 'restored') {
    return (
      `認証トークン: 起動時に現役を撒き直した（世代 ${String(outcome.generation)}、増やしていない）。` +
      `「${outcome.label}」（id ${outcome.tokenId}）${outcome.cooling ? '。**冷却中である**' : ''}\n` +
      describeSpread(outcome.spread)
    );
  }
  return `認証トークン: 起動時に撒き直せなかった。${outcome.why}`;
}

// JournalEntryInput をそのまま返さない: 全種別の union だと呼ぶ側が entry.text を読めず、文言を自分で組み直して日誌と stderr で言い方が分かれるため
export type TokenRotationEntry = Extract<JournalEntryInput, { type: 'token_rotation' }>;

// 出す・出さないの判定を書き直さない: stderr には出るのに日誌には出ない食い違いが静かに生まれるため
export function tokenRotationEntry(
  outcome: TokenRotationOutcome,
  observed?: { noticeText?: string },
): TokenRotationEntry | null {
  const text = describeTokenRotation(outcome, observed);
  if (text === null) return null;
  const common = {
    type: 'token_rotation' as const,
    signal: outcome.signal,
    // freshness を unknown で埋めない: 身元を運べない観測が届いたという別の事実になるため
    ...(outcome.freshness === undefined ? {} : { freshness: outcome.freshness }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(observed?.noticeText === undefined ? {} : { noticeText: observed.noticeText }),
    text,
  };
  if (outcome.kind === 'rotated') {
    return {
      ...common,
      event: 'rotated',
      tokenId: outcome.toTokenId,
      label: outcome.toLabel,
      ...(outcome.fromTokenId === undefined ? {} : { fromTokenId: outcome.fromTokenId }),
      generation: outcome.generation,
    };
  }
  if (outcome.kind === 'parked') {
    return {
      ...common,
      event: 'parked',
      tokenId: outcome.tokenId,
      label: outcome.label,
      ...(outcome.fromTokenId === undefined ? {} : { fromTokenId: outcome.fromTokenId }),
      generation: outcome.generation,
      earliestAt: new Date(outcome.cooldownUntil).toISOString(),
      ...(outcome.cooldownSource === undefined ? {} : { cooldownSource: outcome.cooldownSource }),
    };
  }
  if (outcome.kind === 'exhausted') {
    return {
      ...common,
      // 打ち切りを exhausted と名乗らせない: 打ち切った回は候補がまだ残っているため
      event: outcome.stoppedBy === 'budget' ? 'sweep_stopped' : 'exhausted',
      ...(outcome.earliest === undefined
        ? {}
        : {
            tokenId: outcome.earliest.tokenId,
            label: outcome.earliest.label,
            earliestAt: new Date(outcome.earliest.cooldownUntil).toISOString(),
            ...(outcome.earliest.cooldownSource === undefined
              ? {}
              : { cooldownSource: outcome.earliest.cooldownSource }),
          }),
    };
  }
  if (outcome.kind === 'ignored' && outcome.recovered !== undefined) {
    // not_rotated へ潰さない: 止まった側と対になる唯一の行なので、絞って引ける形で残すため
    return {
      ...common,
      event: 'recovered',
      tokenId: outcome.recovered.tokenId,
      label: outcome.recovered.label,
      recoveredSource: outcome.recovered.source,
    };
  }
  if (outcome.kind === 'ignored' && outcome.reopened !== undefined) {
    // recovered へも not_rotated へも潰さない・recoveredSource は付けない: 観測していない成功が観測として残り、層を起こした回が何もしなかった中へ消えるため
    return {
      ...common,
      event: 'reopened',
      tokenId: outcome.reopened.tokenId,
      label: outcome.reopened.label,
    };
  }
  return { ...common, event: 'not_rotated' };
}

export function tokenRestoreEntry(outcome: TokenRestoreOutcome): TokenRotationEntry | null {
  const text = describeTokenRestore(outcome);
  if (text === null) return null;
  if (outcome.kind === 'restored') {
    return {
      type: 'token_rotation',
      event: 'restored',
      tokenId: outcome.tokenId,
      label: outcome.label,
      generation: outcome.generation,
      text,
    };
  }
  return {
    type: 'token_rotation',
    event: 'restore_failed',
    ...('tokenId' in outcome ? { tokenId: outcome.tokenId } : {}),
    ...('label' in outcome ? { label: outcome.label } : {}),
    text,
  };
}
