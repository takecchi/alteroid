// `index.ts` から export しない: 下書きの保存の3ファイルが共有する内部の部品で、公開の面には出さない。

// 鍵の文字列は変えない: 変えると、すでに保存されている書きかけが読めなくなる。
// 承認の置き土産の鍵は `approval-leftovers.ts` と `chat-drafts.ts`（`clearChatDrafts`）が共有する。別々に書くと、片方だけ変わったときにログアウトが置き土産を消し損ねる。
export const APPROVAL_LEFTOVERS_KEY = 'alteroid.approvalLeftovers';

// アクセスしただけで投げる環境（クッキー無効など）がある。
export function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 会話の無い入力欄は `new` の鍵に置く。
export function draftKey(prefix: string, conversationId: string | undefined): string {
  return `${prefix}${conversationId ?? 'new'}`;
}
