import { definedProps } from './defined-props.js';

/**
 * `status` では表さない: 分類器か deny 規則がその場で拒否した仕事は `running` のまま手が止まり、
 * デーモンから見えるのは「拒否があった」事実だけで、それで止まったのかは観測していない。
 * だから状態の値は増やさず、状態に添える（`manager_list`）。
 */
export interface ManagerDenial {
  tool: string;
  count: number;
  /**
   * `undefined` は「マネージャーだった」ではなく「層が取れなかった」という第3の状態。
   * `'manager'` 側へ寄せない: `via: 'result'`（`agent_id` を持たないため層を判定できない）で
   * 拾った作業者の拒否が、黙ってマネージャーの拒否として数えられる。
   * 材料は SDK の `agent_id` で `via: 'live'` のときにしか載らない。`actor` を送らない旧い runner も
   * 同じ「取れていない」に落ちる。
   */
  actor?: 'manager' | 'worker';
  /**
   * 「止められた後に委譲が進んだか」を読む材料（`denial-format.ts` の `describeDenialFollowUp`）。
   * 無いことは「取れていない」であって「古い」ではない。
   */
  lastAt?: string;
  /**
   * 最新1件だけ。journal に既に残っている値を別の口からも届けるだけ（`deniedLastReason` の doc）。
   * 取れていない欄はキーごと省く（`denialSuffix` と同じ規則）。分類器・deny 規則の判定根拠ではなく
   * SDK が返した prose なので、`reason` の文字列を解釈して分類し直さない。
   * `/managers` へは流さない（`managerDenialSchema` が宣言していないので `.parse()` が落とす）。
   */
  reasonType?: string;
  reason?: string;
  message?: string;
  /**
   * 出所が `reasonType` とは違う: runner の `#onPreToolUse` が拒否より前に見た入力を伏せて切ったもの
   * （伏せ字済み・最大160字）。取れていない欄はキーごと省き、欠けた理由は読み分けられない。
   * `/managers` へは流さない（`reasonType` と同じ判断）。
   */
  inputHead?: string;
}

/** どちらの接頭辞にも一致しない文字列は推測でどちらかへ倒さず「取れていない」とする（`ManagerDenial.actor` の doc）。 */
export function denialActorLayerOf(actor: string | undefined): 'manager' | 'worker' | undefined {
  if (actor === undefined) return undefined;
  if (actor.startsWith('worker:')) return 'worker';
  if (actor.startsWith('manager:')) return 'manager';
  return undefined;
}

/**
 * 区切りに `'::'` を使う: 道具名（MCP は `mcp__<server>__<tool>`）にこの並びは現れない。
 * 層が取れていない回は空文字ではなく `'unresolved'`: 空文字だと将来 `actor` の型が増えたとき
 * 「取れていない」と「その名前の層」が衝突しうる。上限は道具×層の組の種類数に効く。
 */
const DENIAL_KEY_SEPARATOR = '::';
const DENIAL_ACTOR_UNRESOLVED = 'unresolved';

export function denialKey(tool: string, actor: 'manager' | 'worker' | undefined): string {
  return `${actor ?? DENIAL_ACTOR_UNRESOLVED}${DENIAL_KEY_SEPARATOR}${tool}`;
}

export function decodeDenialKey(key: string): {
  tool: string;
  actor: 'manager' | 'worker' | undefined;
} {
  const separatorIndex = key.indexOf(DENIAL_KEY_SEPARATOR);
  if (separatorIndex === -1) return { tool: key, actor: undefined };
  const rawActor = key.slice(0, separatorIndex);
  const tool = key.slice(separatorIndex + DENIAL_KEY_SEPARATOR.length);
  return { tool, actor: rawActor === 'manager' || rawActor === 'worker' ? rawActor : undefined };
}

/**
 * `inputHead` は journal へは書かない（`case 'permission_denied':` の doc）。
 * 取れていない欄はキーごと持たない: 作り物を出さない。
 */
export interface DenialReasonSnapshot {
  reasonType?: string;
  reason?: string;
  message?: string;
  inputHead?: string;
}

/**
 * `deniedAt` を持つ理由: `denialKey` は道具×層の組でしかなく、新しい拒否で上書きされても
 * 鍵は変わらない。照合用に古い `deniedAt` を残し、一致しなければ新しいエピソードとして
 * `stage` を 0 から数え直す（同じ鍵が再び長く止まったら新しい注意に値する）。
 */
export interface DenialRenotifyState {
  readonly deniedAt: string;
  /** `DENIAL_RENOTIFY_DELAYS_MS.length` に達したらそれ以上は出さない（出し切りは日誌に1行残す）。 */
  stage: number;
}

/**
 * 1件も欄が無ければ `undefined`: 空オブジェクトだと「観測したが空だった」と
 * 「観測していない」が区別できなくなる。
 */
export function denialReasonSnapshotOf(event: {
  reasonType?: string;
  reason?: string;
  message?: string;
  inputHead?: string;
}): DenialReasonSnapshot | undefined {
  const snapshot: DenialReasonSnapshot = {
    ...(event.reasonType === undefined ? {} : { reasonType: event.reasonType }),
    ...definedProps({ reason: event.reason, message: event.message, inputHead: event.inputHead }),
  };
  return Object.keys(snapshot).length === 0 ? undefined : snapshot;
}
