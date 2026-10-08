// import しない・型を手で複製する: ブラウザのバンドルへ入る軽い口で、schema.ts から型を取ると zod ごと入るため
// unreadableDirSample を持たせない: 絶対パスを含みうるため
export interface UnpushedWorkObservationIncompletenessLike {
  readonly truncatedAtCount?: number;
  readonly stoppedEarly?: true;
  readonly scratchRootsUnknown?: string;
  readonly unreadableDirCount?: number;
}

// null を「探しきった」と名乗らない: 4欄を持たない旧い台帳の行も null になり、判定できないだけのため
export function describeUnpushedWorkObservationIncompleteness(
  fields: UnpushedWorkObservationIncompletenessLike,
): string | null {
  const reasons: string[] = [];
  if (fields.truncatedAtCount !== undefined) {
    reasons.push(`件数の上限（${fields.truncatedAtCount}）で打ち切った`);
  }
  if (fields.stoppedEarly === true) {
    reasons.push('期限切れで一部を調べる前に打ち切った');
  }
  if (fields.scratchRootsUnknown !== undefined) {
    reasons.push(`/tmp スクラッチの起点を確かめられなかった: ${fields.scratchRootsUnknown}`);
  }
  if (fields.unreadableDirCount !== undefined) {
    reasons.push(
      `子ディレクトリの読み失敗が${fields.unreadableDirCount}件あった（/tmp スクラッチの起点そのものの読み失敗を含む）`,
    );
  }
  if (reasons.length === 0) return null;
  return `この観測は探しきっていない（${reasons.join('・')}）——ここに無い作業ツリーが在りうる。`;
}

export type UnpushedWorkObservationSourceLike =
  'stop-refusal' | 'report' | 'tool_use' | 'auto-fold' | 'vacate' | 'stop' | 'closed' | 'shutdown';

export function describeUnpushedWorkObservationSource(
  source: UnpushedWorkObservationSourceLike | undefined,
): string {
  if (source === undefined) {
    return '経路不明（この欄を書かない版が残した行、または経路を渡さなかった呼び出し）';
  }
  switch (source) {
    case 'stop-refusal':
      return 'manager_stop（running・非force）の断り';
    case 'report':
      return 'ターンが report で終わったとき';
    case 'tool_use':
      return 'Bash で git push か新しい枝を作る操作を検出したとき';
    case 'auto-fold':
      return 'done を自動で畳む前の安全弁（auto-fold）';
    case 'vacate':
      return 'runner を意図して空ける直前（vacate）';
    case 'stop':
      return 'manager_stop（force・done/waiting_human の非force）・人間の停止・自動畳みが止める直前';
    case 'closed':
      return 'runner が closed を出す直前に先取り';
    case 'shutdown':
      return '日常の redeploy で runner が stop する直前に先取り（best-effort）';
    // 知らない値でも投げない: Web UI が描画中に落ちるより、知らないと名乗るほうを取るため
    default:
      return `知らない経路 "${String(source)}"（デーモンの版が新しい可能性）`;
  }
}

export function describeUnpushedWorkObservationProvenance(
  source: UnpushedWorkObservationSourceLike | undefined,
  refresher?: string,
): string {
  const caveat =
    refresher === undefined
      ? 'いまの状態そのものではない'
      : `${refresher} 自身では更新されない。いまの状態ではない`;
  return `最後の1回の経路: ${describeUnpushedWorkObservationSource(source)}。${caveat}`;
}

// 「未pushが無かったことを意味しない」を外さない: 届いていないのは「無かった」ではなく「分からない」ため
export const UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE =
  '⚠ 未push観測: 器が止まる直前の観測は届いていない' +
  '（best-effort の送信のため。未pushが無かったことを意味しない）。';

export function isEmptyCompleteUnpushedWorkObservation(observation: {
  readonly kind: string;
  readonly worktrees?: readonly unknown[];
  readonly truncatedAtCount?: number;
  readonly stoppedEarly?: true;
  readonly scratchRootsUnknown?: string;
  readonly unreadableDirCount?: number;
}): boolean {
  return (
    observation.kind === 'observed' &&
    observation.worktrees !== undefined &&
    observation.worktrees.length === 0 &&
    describeUnpushedWorkObservationIncompleteness(observation) === null
  );
}
