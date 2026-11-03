import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { useNavigate } from 'react-router';

import {
  useConversationApprovals,
  useMarkConversationRead,
  type useDeleteConversation,
  type useEndConversation,
  type useInterruptClone,
} from '@alteroid/swr';
import {
  chatDraftEpoch,
  describeApprovalLeftover,
  loadPendingAttachmentsNote,
  newClientMessageId,
  saveChatDraft,
  savePendingAttachmentsNote,
} from '@alteroid/logic';
import type {
  ConversationDeleteResult,
  ConversationDetail,
  PendingAttachmentsNote,
} from '@alteroid/logic';

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
  describeCloneInterruptOutcome,
  isSettledApproval,
  type EditDraft,
  type Line,
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

export function useConversationActionStates() {
  const [interrupting, setInterrupting] = useState<{ conversationId: string } | undefined>(
    undefined,
  );
  // 押した時点の会話 id を持ち、描画の時点の shownId と突き合わせる: shownIdRef は受動効果の中でしか進まず、切り替え直後の窓で別の会話に前の会話の「止めた」を出していた
  const [interruptNotice, setInterruptNotice] = useState<
    { conversationId: string; text: string } | undefined
  >(undefined);
  // 送信経路の failures へ合流させず、会話 id ごとの Map にもしない: 「呼べた」と「呼べなかった」で切り替え後の扱いが割れるため、interruptNotice と同じ「切り替えたら消える」で揃える
  const [interruptFailure, setInterruptFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  const [endingConversation, setEndingConversation] = useState<
    { conversationId: string } | undefined
  >(undefined);
  const [endNotice, setEndNotice] = useState<{ fromId: string } | undefined>(undefined);
  const [endFailure, setEndFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  // deleteResult は消えたあとの /chat に残す（トーストにしない）: 消せなかったものと後始末の失敗は、読んで判断する材料のため
  const [deletingConversation, setDeletingConversation] = useState<
    { conversationId: string } | undefined
  >(undefined);
  const [deleteResult, setDeleteResult] = useState<
    { fromId: string; result: ConversationDeleteResult } | undefined
  >(undefined);
  const [deleteFailure, setDeleteFailure] = useState<
    { conversationId: string; error: unknown } | undefined
  >(undefined);
  return {
    interrupting,
    setInterrupting,
    interruptNotice,
    setInterruptNotice,
    interruptFailure,
    setInterruptFailure,
    endingConversation,
    setEndingConversation,
    endNotice,
    setEndNotice,
    endFailure,
    setEndFailure,
    deletingConversation,
    setDeletingConversation,
    deleteResult,
    setDeleteResult,
    deleteFailure,
    setDeleteFailure,
  };
}

type ConversationActionStates = ReturnType<typeof useConversationActionStates>;

// chat.tsx の Stream のうち、止める・終える・消すが読む形だけ
interface RunningStream {
  controller: AbortController;
  id: string | undefined;
  turn?: {
    clientMessageId: string;
    text: string;
    lineKey: string;
    supersedes: string | undefined;
    attachments: PendingAttachment[];
  };
  resumeTarget?: string | null;
}

interface ConversationActionHandlersDeps<Retry> {
  setInterrupting: ConversationActionStates['setInterrupting'];
  setInterruptNotice: ConversationActionStates['setInterruptNotice'];
  setInterruptFailure: ConversationActionStates['setInterruptFailure'];
  setEndingConversation: ConversationActionStates['setEndingConversation'];
  setEndNotice: ConversationActionStates['setEndNotice'];
  setEndFailure: ConversationActionStates['setEndFailure'];
  setDeletingConversation: ConversationActionStates['setDeletingConversation'];
  setDeleteResult: ConversationActionStates['setDeleteResult'];
  setDeleteFailure: ConversationActionStates['setDeleteFailure'];
  streamRef: RefObject<RunningStream | undefined>;
  followUpIdsRef: RefObject<Map<string, Set<string>>>;
  replayControllerRef: RefObject<AbortController | undefined>;
  shownIdRef: RefObject<string | undefined>;
  focusIntentRef: RefObject<FocusIntent | undefined>;
  allRef: RefObject<Line[]>;
  editOriginals: RefObject<Map<string, Line>>;
  pendingEditSave: RefObject<{ drafts: ReadonlyMap<string, EditDraft>; epoch: number } | null>;
  pendingDraftSave: ReturnType<typeof useChatDraftAutosave>['pendingDraftSave'];
  deletedConversationIds: ReturnType<typeof useChatDraftAutosave>['deletedConversationIds'];
  giveBack: (
    key: string | undefined,
    text: string,
    lineKey: string,
    supersedes: string | undefined,
    attachments: PendingAttachment[] | undefined,
    clientMessageId: string,
    unconfirmed?: true,
    conversationId?: string,
  ) => void;
  dropEditDraft: (key: string) => void;
  setEditingKey: Dispatch<SetStateAction<string | undefined>>;
  setRetries: Dispatch<SetStateAction<Map<string | undefined, Retry>>>;
  setPending: Dispatch<SetStateAction<PendingAttachment[]>>;
  setAttachmentDrafts: ReturnType<typeof useChatAttachmentHolding>['setAttachmentDrafts'];
  interruptClone: ReturnType<typeof useInterruptClone>;
  endConversation: ReturnType<typeof useEndConversation>;
  deleteConversation: ReturnType<typeof useDeleteConversation>;
  navigate: ReturnType<typeof useNavigate>;
}

export function useConversationActionHandlers<Retry>(deps: ConversationActionHandlersDeps<Retry>) {
  const {
    setInterrupting,
    setInterruptNotice,
    setInterruptFailure,
    setEndingConversation,
    setEndNotice,
    setEndFailure,
    setDeletingConversation,
    setDeleteResult,
    setDeleteFailure,
    streamRef,
    followUpIdsRef,
    replayControllerRef,
    shownIdRef,
    focusIntentRef,
    allRef,
    editOriginals,
    pendingEditSave,
    pendingDraftSave,
    deletedConversationIds,
    giveBack,
    dropEditDraft,
    setEditingKey,
    setRetries,
    setPending,
    setAttachmentDrafts,
    interruptClone,
    endConversation,
    deleteConversation,
    navigate,
  } = deps;
  // 押した会話 id を呼び出し元（その render の shownId）から直接受ける: shownIdRef は受動効果の中でしか進まず、切り替え直後の窓で別の会話に前の会話の「止めた」が出ていた。
  // ここでは出す/出さないを判断せず、描画側が shownId と突き合わせる。リクエスト自体は切り替えても最後まで送る（変えるのは表示だけ）。
  // failures には触れない: 「止める」は送れていない発言を何も変えない
  const handleInterrupt = useCallback(
    async (pressedConversationId: string) => {
      setInterrupting({ conversationId: pressedConversationId });
      setInterruptNotice(undefined);
      setInterruptFailure(undefined);
      // 対象を省かない: 省くと、順番待ちの間に押しても先客のターンを止めてしまう。決められないときは呼ばずに言う
      const running = streamRef.current;
      const here =
        running !== undefined && running.id === pressedConversationId ? running : undefined;
      const turn = here?.turn;
      const resumeTarget = here?.resumeTarget;
      if (resumeTarget === null) {
        setInterruptNotice({
          conversationId: pressedConversationId,
          text: '止める対象が分からないので、何も止めていません（走っているのが、この会話の別の起点のターンかもしれません）。',
        });
        setInterrupting(undefined);
        return;
      }
      const followUpTarget =
        turn === undefined && here === undefined
          ? followUpIdsRef.current.get(pressedConversationId)?.values().next().value
          : undefined;
      const targetId = turn?.clientMessageId ?? resumeTarget ?? followUpTarget;
      try {
        const outcome = await interruptClone(
          targetId === undefined
            ? undefined
            : { conversationId: pressedConversationId, clientMessageId: targetId },
        );
        const withdrawnReplay =
          outcome === 'withdrawn' &&
          turn === undefined &&
          (here !== undefined || followUpTarget !== undefined);
        if (outcome === 'withdrawn' && turn === undefined && targetId !== undefined) {
          const waiting = followUpIdsRef.current.get(pressedConversationId);
          if (waiting?.delete(targetId) === true && waiting.size === 0) {
            replayControllerRef.current?.abort();
          }
        }
        if (outcome === 'withdrawn' && turn !== undefined && running !== undefined) {
          // 取り下げた発言の SSE には終端が流れないので閉じる。文は新しい id で積み直す: 同じ id で送ると重複扱いで配られない
          running.controller.abort();
          giveBack(
            pressedConversationId,
            turn.text,
            turn.lineKey,
            turn.supersedes,
            turn.attachments,
            newClientMessageId(),
          );
        } else if (withdrawnReplay) {
          here?.controller.abort();
        }
        setInterruptNotice({
          conversationId: pressedConversationId,
          text: withdrawnReplay
            ? '順番待ちだった発言を取り下げました（送っていません）。本文は手元に無いので、入力欄へは戻していません。先客のターンには触れていません。'
            : describeCloneInterruptOutcome(outcome),
        });
      } catch (caught) {
        setInterruptFailure({ conversationId: pressedConversationId, error: caught });
      } finally {
        setInterrupting(undefined);
      }
    },
    [
      interruptClone,
      giveBack,
      setInterrupting,
      setInterruptNotice,
      setInterruptFailure,
      streamRef,
      followUpIdsRef,
      replayControllerRef,
    ],
  );

  const handleEndConversation = useCallback(
    async (pressedConversationId: string) => {
      focusIntentRef.current = { kind: 'end' };
      setEndingConversation({ conversationId: pressedConversationId });
      setEndFailure(undefined);
      setEndNotice(undefined);
      try {
        await endConversation(pressedConversationId);
        if (shownIdRef.current === pressedConversationId) {
          setEndNotice({ fromId: pressedConversationId });
          navigate('/chat');
        }
      } catch (caught) {
        setEndFailure({ conversationId: pressedConversationId, error: caught });
      } finally {
        setEndingConversation(undefined);
      }
    },
    [
      endConversation,
      navigate,
      focusIntentRef,
      setEndingConversation,
      setEndFailure,
      setEndNotice,
      shownIdRef,
    ],
  );

  const handleDeleteConversation = useCallback(
    async (pressedConversationId: string) => {
      setDeletingConversation({ conversationId: pressedConversationId });
      setDeleteFailure(undefined);
      setDeleteResult(undefined);
      setEndNotice(undefined);
      try {
        const result = await deleteConversation(pressedConversationId);
        deletedConversationIds.current.add(pressedConversationId);
        if (pendingDraftSave.current?.id === pressedConversationId) {
          pendingDraftSave.current = null;
        }
        // 添えかけ・送れなかった発言の控えも捨てる: 残すと、消した会話のための確認が出続け、控えが書き戻される
        setAttachmentDrafts((previous) => {
          if (!previous.has(pressedConversationId)) return previous;
          const next = new Map(previous);
          next.delete(pressedConversationId);
          return next;
        });
        setRetries((previous) => {
          if (!previous.has(pressedConversationId)) return previous;
          const next = new Map(previous);
          next.delete(pressedConversationId);
          return next;
        });
        savePendingAttachmentsNote(pressedConversationId, undefined);
        // その会話の発言を編集していた書きかけも捨てる: 鍵は発言 id で会話 id を持たないので、その会話の行（表示中の行と、編集を開いた時点の写し）から集める。
        // 残すと、消した会話の本文がどこからも開けないまま端末に平文で残る（送信前の下書きを消す理由と同じ）
        const editKeys = new Set<string>();
        for (const line of allRef.current)
          if (line.of === pressedConversationId) editKeys.add(line.key);
        for (const [key, line] of editOriginals.current) {
          if (line.of === pressedConversationId) editKeys.add(key);
        }
        if (editKeys.size > 0) {
          const waiting = pendingEditSave.current;
          if (waiting !== null && [...editKeys].some((key) => waiting.drafts.has(key))) {
            const kept = new Map(waiting.drafts);
            for (const key of editKeys) kept.delete(key);
            pendingEditSave.current = { ...waiting, drafts: kept };
          }
          for (const key of editKeys) {
            dropEditDraft(key);
            editOriginals.current.delete(key);
          }
          setEditingKey((current) =>
            current !== undefined && editKeys.has(current) ? undefined : current,
          );
        }
        if (shownIdRef.current === pressedConversationId) {
          setPending([]);
          setDeleteResult({ fromId: pressedConversationId, result });
          navigate('/chat');
        }
      } catch (caught) {
        setDeleteFailure({ conversationId: pressedConversationId, error: caught });
      } finally {
        setDeletingConversation(undefined);
      }
    },
    [
      deleteConversation,
      navigate,
      dropEditDraft,
      allRef,
      deletedConversationIds,
      pendingDraftSave,
      setAttachmentDrafts,
      setDeletingConversation,
      setDeleteFailure,
      setDeleteResult,
      setEndNotice,
      setRetries,
      editOriginals,
      pendingEditSave,
      setEditingKey,
      shownIdRef,
      setPending,
    ],
  );
  return { handleInterrupt, handleEndConversation, handleDeleteConversation };
}
