import type { AgentTurnEnded } from './agent-events.js';
import { reasonOf } from './dropped-record.js';
import { classifyUsageNotice, isRateLimitReason, type UsageLimitNotice } from './usage-limits.js';

/**
 * `Clone#distillFromTranscript` の「観測する枠切れ notice を決める」判断のうち、`succeeded: false` で届いたターンの終わり側。
 * 切り出し前の `#distillFromTranscript` から切り出した。振る舞いは変えていない。同期・状態なし・協力者なし。
 * 候補を先頭から1つずつ分類し、最初に `reached` になった1つで止まる（後ろの候補は分類しない）。無ければ `undefined`。
 */
export function quotaNoticeOfEnded(
  ended: Pick<AgentTurnEnded, 'failure' | 'body' | 'errorLines'>,
): UsageLimitNotice | undefined {
  const candidates = [ended.failure?.text, ended.body, ...ended.errorLines];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const notice = classifyUsageNotice(candidate);
    if (notice?.kind === 'reached') {
      return notice;
    }
  }
  return undefined;
}

/**
 * 同じ判断の、例外で届いた側（`catch` の中）。切り出し前の `#distillFromTranscript` から切り出した。振る舞いは変えていない。同期。
 * 分類は生の文（`String(error)`）に掛け、通知に載せる文だけ `reasonOf` を通す。
 */
export function quotaNoticeOfError(error: unknown): UsageLimitNotice | undefined {
  const raw = String(error);
  const classified = classifyUsageNotice(raw);
  if (classified?.kind === 'reached') {
    return classified;
  } else if (isRateLimitReason(raw)) {
    return { kind: 'reached', text: reasonOf(error) };
  }
  return undefined;
}
