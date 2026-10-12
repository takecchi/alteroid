import type { RunnerEvent } from './runner-protocol.js';

/**
 * 器の作り直し・移送・デーモンの再起動の後に出した resume が、前の会話へ実際に戻れたかの確定（#4501）。
 *
 * runner の受理は「戻れた」ではない: CLI が会話を見つけられなければ、受理の後で `error_during_execution` で終わり、
 * `resume_failed` が追いかけてくる。そこで、新しいセッションから最初の「進んだ印」が届いた時点で「戻れた」と確定し、
 * それまでは「確定待ち」と書く。印は runner が resume の成否に使う `#markProgressed` と同じ事実に揃える
 * （成功したターン・確認の要求・道具の使用）。`session`（init）は印にしない: runner も init を「戻れた」と見ない。
 */

/**
 * 確定待ちのまま印が1つも届かないときに、その旨を知らせるまでの時間。
 * **能力の上限ではない**: 過ぎても委譲は止めず、lost とも決めない（長く考えているだけのこともある）。知らせるだけである。
 * 10 分にしたのは、大きな文脈の resume でも、CLI の起動・会話の読み込み・最初の道具の使用までは数分で済む見込みのため（判定。本番では測っていない）。
 * 失敗する resume は、印より先に `resume_failed` が届いて確定が打ち切られる。
 */
export const RESUME_CONFIRM_TIMEOUT_MS = 10 * 60_000;

export type ResumeConfirmationState = 'pending' | 'confirmed' | 'unconfirmed';

/** 戻れた印として数える出来事なら、その種類（日誌に書く名前）を返す。数えないなら `undefined`。 */
export function resumeEvidenceOf(event: RunnerEvent): string | undefined {
  switch (event.type) {
    case 'tool_use':
    case 'tool_running':
    case 'ask':
      return event.type;
    case 'report':
      // 失敗したターン・結果を受け取らずに畳んだターンは数えない: 戻れなかった resume も、この形の報告を出しうる。
      return event.failure === undefined && event.unreported === undefined ? 'report' : undefined;
    default:
      return undefined;
  }
}

/** 確定を打ち切る出来事（この後は、それぞれの経路が自分で知らせる）。 */
export function endsResumeConfirmation(event: RunnerEvent): boolean {
  return event.type === 'resume_failed' || event.type === 'closed';
}

export function resumeConfirmMinutes(timeoutMs: number): string {
  return String(Math.max(1, Math.round(timeoutMs / 60_000)));
}

/** 印の説明。知らせの文面と日誌で同じものを使う。 */
export const RESUME_EVIDENCE_DESCRIPTION = '道具の使用・確認の要求・失敗の無いターンの報告';
