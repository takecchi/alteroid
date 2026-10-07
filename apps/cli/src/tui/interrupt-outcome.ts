// 文にしない形で持つ: 呼び手が `withdrawn` で自分の流れを閉じる判断に使うため
export type InterruptOutcome =
  'interrupted' | 'withdrawn' | 'not_target' | 'starting' | 'idle' | 'unsupported';

/** 止める対象の発言（`POST /chat` に付けた `conversationId` と `clientMessageId`）。 */
export interface InterruptTarget {
  readonly conversationId: string;
  readonly clientMessageId: string;
}

export const INTERRUPT_TARGET_PENDING_NOTICE =
  '会話がまだ確定していないので、何も止めていない（少し待ってから、もう一度 Ctrl+C）';

export function describeInterruptOutcome(outcome: InterruptOutcome): string {
  switch (outcome) {
    case 'interrupted':
      return 'いま走っていたクローンのターンを止めた。会話の続きと受信箱はそのまま残る（次の合図で次のターンが始まる）。';
    case 'withdrawn':
      return '順番待ちだった発言を取り下げた（送っていない）。先客のターンには触れていない。本文は入力欄へ戻した（書きかけがあるときは、上の「送れなかった発言」から取れる）';
    case 'not_target':
      return 'いま走っているのは、この発言のターンではない（別の起点の）ターンなので、止めていない。';
    case 'starting':
      return 'この発言のターンが始まる直前だった（まだ止めていない）。もう一度 Ctrl+C を押す。';
    case 'idle':
      return '走っているターンは無かった（止めるものが無い）。';
    case 'unsupported':
      return 'このデーモンのクローンは、ターンを止める口を持っていない。';
  }
}
