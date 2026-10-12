import { useSyncExternalStore } from 'react';

/**
 * 回答を送っている途中の承認 id。画面（承認の画面・会話の画面）より長生きさせる。
 * カードの中の送信中の印（busy・sendingRef）と画面の state は、画面を離れるとアンマウントで消える。
 * 応答を待つ間に別のページへ移って戻ると、同じ承認へもう一度「回答する」が押せてしまうため、
 * モジュールの寿命で持つ（ページを読み直せば消える。送信の途中で読み直したら、その POST の行方は誰も持たない）。
 */
const sending = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isApprovalSending(approvalId: string): boolean {
  return sending.has(approvalId);
}

export function markApprovalSending(approvalId: string, value: boolean): void {
  if (sending.has(approvalId) === value) return;
  if (value) sending.add(approvalId);
  else sending.delete(approvalId);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useApprovalSending(approvalId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => sending.has(approvalId),
    () => false,
  );
}
