import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import { useConversationApprovals, useMarkConversationRead } from '@alteroid/swr';
import {
  chatDraftEpoch,
  describeApprovalLeftover,
  loadPendingAttachmentsNote,
  saveChatDraft,
  savePendingAttachmentsNote,
} from '@alteroid/logic';
import type { ConversationDetail, PendingAttachmentsNote } from '@alteroid/logic';

import { useIsMounted, useReportDirty, type LeaveNotice } from '~/lib/leave-guard';
import {
  usePersistApprovalDrafts,
  usePersistApprovalLeftoverSources,
  type useApprovalDraftState,
} from '~/lib/use-approval-draft-state';
import { usePageVisible } from '~/lib/use-page-visible';

import {
  sizedOf,
  applyFocusIntent,
  isSettledApproval,
  type PendingAttachment,
  type FocusIntent,
} from './chat-lines';

// chat.tsx の編集下書きの遅延保存も同じ間隔を使う
export const DRAFT_SAVE_DELAY_MS = 400;

const PENDING_ATTACHMENTS_LEAVE_NOTICE: LeaveNotice = {
  title: '添えかけのファイルがあります',
  description:
    'このまま離れると、入力欄に添えたファイルは失われます（本文の書きかけと違い、ファイルは戻せません）。',
  confirmLabel: '破棄して離れる',
};

export function useChatDraftAutosave(shownId: string | undefined, draft: string) {
  const pendingDraftSave = useRef<{ id: string | undefined; text: string; epoch: number } | null>(
    null,
  );
  const deletedConversationIds = useRef<Set<string | undefined>>(new Set());
  const flushDraftSave = useCallback(() => {
    const waiting = pendingDraftSave.current;
    if (waiting === null) return;
    pendingDraftSave.current = null;
    if (waiting.epoch !== chatDraftEpoch()) return;
    // 削除した会話の書きかけは書き戻さない: 会話を離れる effect が、消したはずの本文を書き直してしまう
    if (deletedConversationIds.current.has(waiting.id)) return;
    saveChatDraft(waiting.id, waiting.text);
  }, []);
  useEffect(() => {
    if (pendingDraftSave.current !== null && pendingDraftSave.current.id !== shownId)
      flushDraftSave();
    // 空にしたときは待たずに消す: 送った文が復元されない。
    if (draft === '') {
      pendingDraftSave.current = null;
      saveChatDraft(shownId, '');
      return;
    }
    pendingDraftSave.current = { id: shownId, text: draft, epoch: chatDraftEpoch() };
    const timer = setTimeout(flushDraftSave, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [shownId, draft, flushDraftSave]);
  useEffect(() => {
    window.addEventListener('pagehide', flushDraftSave);
    return () => {
      window.removeEventListener('pagehide', flushDraftSave);
      flushDraftSave();
    };
  }, [flushDraftSave]);
  return { pendingDraftSave, deletedConversationIds };
}

export function useChatAttachmentHolding(
  shownId: string | undefined,
  pending: PendingAttachment[],
) {
  // 会話 id を持つ: 持たないと、別の会話へ移っても入力欄を塞ぐ
  const [uploading, setUploading] = useState<ReadonlyMap<string | undefined, number>>(new Map());
  const adjustUploading = useCallback((id: string | undefined, delta: 1 | -1) => {
    setUploading((previous) => {
      const next = new Map(previous);
      const count = (next.get(id) ?? 0) + delta;
      if (count > 0) next.set(id, count);
      else next.delete(id);
      return next;
    });
  }, []);
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Map<string | undefined, PendingAttachment[]>
  >(new Map());
  const heldAttachments = useMemo(() => {
    const held = new Map<string | undefined, PendingAttachment[]>();
    for (const [key, items] of attachmentDrafts) if (items.length > 0) held.set(key, items);
    if (pending.length > 0) held.set(shownId, pending);
    else held.delete(shownId);
    return held;
  }, [attachmentDrafts, pending, shownId]);
  useReportDirty(
    'chat-pending-attachments',
    heldAttachments.size > 0,
    PENDING_ATTACHMENTS_LEAVE_NOTICE,
  );
  // 控えは、この画面が書いた鍵のうち空になったものだけ消す: 読む前に空の状態で消すと案内が出せない
  const writtenNoteKeys = useRef(new Set<string | undefined>());
  useEffect(() => {
    for (const [key, items] of heldAttachments) {
      writtenNoteKeys.current.add(key);
      savePendingAttachmentsNote(key, {
        count: items.length,
        names: items.map((item) => sizedOf(item).name),
      });
    }
    for (const key of writtenNoteKeys.current) {
      if (heldAttachments.has(key)) continue;
      writtenNoteKeys.current.delete(key);
      savePendingAttachmentsNote(key, undefined);
    }
  }, [heldAttachments]);
  const [lostPending, setLostPending] = useState<
    ReadonlyMap<string | undefined, PendingAttachmentsNote>
  >(new Map());
  const lostPendingChecked = useRef(new Set<string | undefined>());
  useEffect(() => {
    if (lostPendingChecked.current.has(shownId)) return;
    lostPendingChecked.current.add(shownId);
    const note = loadPendingAttachmentsNote(shownId);
    if (note === undefined || writtenNoteKeys.current.has(shownId)) return;
    setLostPending((previous) => new Map(previous).set(shownId, note));
  }, [shownId]);
  const shownLostPending = pending.length === 0 ? lostPending.get(shownId) : undefined;
  const dismissLostPending = () => {
    savePendingAttachmentsNote(shownId, undefined);
    setLostPending((previous) => {
      const next = new Map(previous);
      next.delete(shownId);
      return next;
    });
  };
  return {
    uploading,
    adjustUploading,
    attachmentDrafts,
    setAttachmentDrafts,
    shownLostPending,
    dismissLostPending,
  };
}

export function useChatConversationApprovals(
  shownId: string | undefined,
  approvalDraftState: ReturnType<typeof useApprovalDraftState>,
) {
  const { drafts: approvalDrafts, leftoverSources } = approvalDraftState;
  // exchange だけでは復元できない: ask_human の日誌エントリは conversationId を持たず窓にも入らず、質問・回答は承認の台帳にしか無い
  const conversationApprovals = useConversationApprovals(shownId ?? null);
  // 消すのは、この会話の承認の一覧を読めていて決着済みと分かった id だけ: 読めていないときやほかの会話の書きかけは残す
  const settledApprovalIds = useMemo(
    () =>
      new Set(
        (conversationApprovals.data?.approvals ?? [])
          .filter(isSettledApproval)
          .map((approval) => approval.id),
      ),
    [conversationApprovals.data],
  );
  const keepApprovalDraft = useCallback(
    (id: string) => !settledApprovalIds.has(id) || id in leftoverSources,
    [settledApprovalIds, leftoverSources],
  );
  usePersistApprovalDrafts(approvalDraftState, keepApprovalDraft);
  usePersistApprovalLeftoverSources(leftoverSources, approvalDrafts);
  const leftovers = useMemo(
    () =>
      Object.entries(leftoverSources)
        .filter(([id]) => settledApprovalIds.has(id))
        .map(([id, source]) => ({
          id,
          source,
          text: describeApprovalLeftover(source, approvalDrafts, id),
        }))
        .filter((entry) => entry.text !== ''),
    [leftoverSources, settledApprovalIds, approvalDrafts],
  );
  const discardLeftover = approvalDraftState.discard;
  const refetchApprovalsRef = useRef<() => void>(() => {});
  const mountedRef = useIsMounted();
  // commit の直後に毎回差し替える（render 中には書かない）: 読むのは受信のハンドラだけで、どれも render の外で非同期に呼ばれる。
  // 同期の render では render と layout effect の間に非同期の処理は割り込めないので、ハンドラから見える値は render 中に書くのと同じ。
  // 途中で譲る render（遷移）では、まだ commit していない render の関数ではなく、画面に出ている render の関数を指す
  useLayoutEffect(() => {
    refetchApprovalsRef.current = () => {
      if (!mountedRef.current) return;
      try {
        // 失敗は conversationApprovals.error に出る（下の ErrorNote）ので、ここでは未処理にしないだけ。
        void Promise.resolve(conversationApprovals.mutate()).catch(() => undefined);
      } catch {
        // 同上。
      }
    };
  });
  return { conversationApprovals, leftovers, discardLeftover, refetchApprovalsRef };
}

export function useMarkShownConversationRead(
  shownId: string | undefined,
  historyData: ConversationDetail | undefined,
) {
  // history だけを見る（手元の lines や transient は見ない）: 日誌の発言ではないので、返答が日誌に載る前に離れたときも既読になってしまう
  const pageVisible = usePageVisible();
  const markRead = useMarkConversationRead();
  useEffect(() => {
    if (!pageVisible || shownId === undefined || historyData === undefined) return;
    markRead(shownId, historyData);
  }, [pageVisible, shownId, historyData, markRead]);
}

export function useFocusIntentReturn(
  focusIntentRef: RefObject<FocusIntent | undefined>,
  editingKey: string | undefined,
  visibleEnding: boolean,
) {
  // 使い手が自分でフォーカスを動かしたら戻す約束は取り下げる（pointerdown / keydown を capture で先に見る）
  useEffect(() => {
    const clear = () => {
      focusIntentRef.current = undefined;
    };
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('keydown', clear, true);
    return () => {
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('keydown', clear, true);
    };
  }, [focusIntentRef]);
  useEffect(() => {
    const intent = focusIntentRef.current;
    if (intent === undefined) return;
    if (intent.kind === 'edit' && editingKey !== undefined) {
      focusIntentRef.current = undefined;
      return;
    }
    if (intent.kind === 'end' && visibleEnding) return;
    const done = applyFocusIntent(intent);
    if (done) focusIntentRef.current = undefined;
  });
}
