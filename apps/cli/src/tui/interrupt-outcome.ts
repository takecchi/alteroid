import { describeInterruptOutcome, type InterruptOutcome } from '../interrupt.js';

export type { InterruptOutcome, InterruptTarget } from '../interrupt.js';

export const INTERRUPT_TARGET_PENDING_NOTICE =
  '会話がまだ確定していないので、何も止めていない（少し待ってから、もう一度 Ctrl+C）';

// 文は CLI の chat と共有する（../interrupt.ts）。取り下げだけ、TUI が本文を入力欄へ戻すことを足す
export function describeTuiInterruptOutcome(outcome: InterruptOutcome): string {
  const text = describeInterruptOutcome(outcome);
  if (outcome !== 'withdrawn') return text;
  return `${text}本文は入力欄へ戻しました（書きかけがあるときは、上の「送れなかった発言」から取れます）`;
}
