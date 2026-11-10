import { excerptLine } from './excerpt.js';
import { describePeerTurnResult, type PeerTurnResult } from './peer-broker.js';
import type { ParkedPeers } from './runner.js';

/** 預かった peer を閉じる（担当が戻らなかった・人が止めた・器を畳む）。預かっていた確認は理由を付けて断り、背景の止まりどころは知らせに残す。 */
export async function closeParkedPeers(
  parked: ParkedPeers,
  reason: string,
  note: (text: string) => void,
  // 伏せ字（env と vault の値を渡したもの。#4923）。抜粋はこれを通してから切る（伏せ字が先、切り詰めが後）
  redact: (text: string) => string,
  // 日誌の主語。預かりではなく、いま生きている担当の peer を閉じるとき（#6123）は呼び手が言い換える
  subject = '預かっていた peer',
): Promise<ClosedParkedPeer[]> {
  const { binding, broker } = parked;
  for (const ask of binding.heldAsks.splice(0)) {
    ask.deny(`peer のマネージャーが戻らないので断った（${reason}）`);
  }
  const closed = new Map<string, ClosedParkedPeer>();
  for (const session of broker.sessionList()) {
    closed.set(session.id, { id: session.id, provider: session.provider });
  }
  const record = (result: PeerTurnResult): void => {
    closed.set(result.sessionId, {
      id: result.sessionId,
      provider: result.provider,
      interrupted: excerptLine(
        redact(
          result.pendingApproval === undefined
            ? result.text
            : `確認待ちで止まっていた: ${result.pendingApproval.toolName} ${result.pendingApproval.summary}`,
        ),
        PARKED_PEER_STOP_EXCERPT_CHARS,
      ),
    });
  };
  for (const result of binding.heldStops.splice(0)) {
    note(
      `背景の peer（${result.provider}）[${result.sessionId}] の止まりどころを届けられないまま閉じた（${reason}）: ${redact(describePeerTurnResult(result))}`,
    );
    record(result);
  }
  // 閉じるとき走っていた背景ターンは、閉じた後に止まりどころが届く（`readEvents` が終わる → ターンが終わる → `onBackgroundStop`）。
  // それを `heldStops` へ積ませず、届くまで待って集める（#4885）
  const awaiting = new Set(broker.backgroundTasks().map((task) => task.id.replace(/^peer:/u, '')));
  // 確認待ちで止まっている peer（背景ではなく、担当が `peer_approve` で答えるのを待っているもの）も、閉じると拒否で終わる。閉じる前に控える（#6123）
  const liveSessions = broker.sessionList();
  for (const pending of broker.pendingApprovals()) {
    if (closed.get(pending.sessionId)?.interrupted !== undefined) continue;
    const session = liveSessions.find((entry) => entry.id === pending.sessionId);
    if (session === undefined) continue;
    closed.set(session.id, {
      id: session.id,
      provider: session.provider,
      interrupted: `確認待ちで止まっていた（approval_id=${pending.approvalId}）`,
    });
  }
  let finish = (): void => undefined;
  const collected = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let done = false;
  binding.collectStop = (result) => {
    if (done) {
      note(
        `背景の peer（${result.provider}）[${result.sessionId}] の止まりどころが、閉じ終えた後に届いた（${reason}）: ${redact(describePeerTurnResult(result))}`,
      );
      return;
    }
    record(result);
    awaiting.delete(result.sessionId);
    if (awaiting.size === 0) finish();
  };
  broker.closeAll();
  if (awaiting.size > 0) {
    // 止まりどころが届かない相手（読み取りが終わらない）で器の畳みを止めない: 上限で切り、集めた分だけ運ぶ
    const timer = setTimeout(finish, PARKED_PEER_STOP_COLLECT_MS);
    timer.unref?.();
    await collected;
    clearTimeout(timer);
  }
  done = true;
  // 上限で切ったとき止まりどころが届かなかった背景ターンも、途中で終わったものとして数える（黙って「走っていなかった」にしない）
  for (const sessionId of awaiting) {
    const entry = closed.get(sessionId);
    if (entry !== undefined && entry.interrupted === undefined) {
      closed.set(sessionId, {
        ...entry,
        interrupted: '背景ターンが走っていた（閉じたが、止まりどころは届かなかった）',
      });
    }
  }
  note(`${subject} のセッションを閉じた（${reason}）`);
  return [...closed.values()];
}

interface ClosedParkedPeer {
  readonly id: string;
  readonly provider: string;
  /** 閉じるとき背景で走っていた（または預かっていた）ターンの止まりどころの抜粋。 */
  readonly interrupted?: string;
}

// 止まりどころの抜粋の長さ。畳んだ背景処理のコマンドの字数（`FOLD_NOTICE_COMMAND_CHARS`）より長く、知らせ1通に peer 数ぶん載っても収まる程度
const PARKED_PEER_STOP_EXCERPT_CHARS = 300;
const PARKED_PEER_STOP_COLLECT_MS = 5_000;
