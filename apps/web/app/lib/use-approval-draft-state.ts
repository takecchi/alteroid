import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

import type { SentApprovalDraft } from '~/components/approval-answer-card';
import type { ApprovalQuestionsDraft } from '@alteroid/ui';
import {
  chatDraftEpoch,
  isEmptyQuestionsDraft,
  loadApprovalDrafts,
  loadApprovalLeftoverSources,
  saveApprovalDrafts,
  saveApprovalLeftoverSources,
  settleApprovalDraft,
  type ApprovalDrafts,
  type ApprovalLeftoverSource,
  type ApprovalLeftoverSources,
} from '@alteroid/logic';

// 承認の画面（approvals.tsx）と会話の画面（chat.tsx）は、承認カードの下書きを同じ形・同じ保存先（sessionStorage）で持つ。
// 持ち方を2か所に書くと、片方だけ epoch の扱いや畳み方がずれる。ここは両方で同じものだけを持つ。
// 送信中の id・残った下書きの導出は画面ごとに違う（送信中は ref と state の二重か state だけか、導出は一覧の読み方）ので持たない。
// 控えの保存は形が同じ（下書きの残っている控えだけを残す）で、違うのは渡す控えだけなので、`usePersistApprovalLeftoverSources` に置く。

/** `Record` から1つの key を落とした新しい `Record` を作る（key が無ければ同じ参照を返す）。 */
export function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/** 答えが通った承認の控えに載せる、本文と設問。 */
type ApprovalLeftoverBase = Pick<ApprovalLeftoverSource, 'question' | 'questions'>;

interface ApprovalDraftState {
  /** 各カードの下書き（自由記述と設問の選択）。 */
  drafts: ApprovalDrafts;
  /**
   * 書きかけを最後に決めた時点の `chatDraftEpoch()`。ログアウトで消したあとに、メモリに残った
   * 書きかけが書き戻らないよう、保存はこの値が今と同じときだけ行う。
   */
  draftsEpoch: { readonly current: number };
  setDrafts: (update: SetStateAction<ApprovalDrafts>) => void;
  /** 答えが通った承認の、本文と設問の控え（残った下書きを見せるため）。 */
  leftoverSources: ApprovalLeftoverSources;
  setLeftoverSources: (update: SetStateAction<ApprovalLeftoverSources>) => void;
  setText: (id: string, text: string) => void;
  setQuestions: (id: string, draft: ApprovalQuestionsDraft) => void;
  /**
   * 答えが通った。**送った時点の下書き（`sent`）と同じ項目だけ**畳み、応答を待つ間に打ち足した
   * 分は残す。残したものは、承認が未回答の一覧から消えたあとも
   * 「送らなかった下書きが残っている」として見せる（`leftovers`）。
   */
  settle: (id: string, source: ApprovalLeftoverBase, sent: SentApprovalDraft) => void;
  /** 409（先に決着していた）。書いた答えを残りの下書きへ移す。取り直しで控えの無い下書きは掃除で落ち、答えが黙って消えるため。 */
  noteConflict: (id: string, source: ApprovalLeftoverBase) => void;
  /** 残った下書きを使い手が閉じる（写し終えた・要らない）。 */
  discard: (id: string) => void;
}

export function useApprovalDraftState(): ApprovalDraftState {
  // `sessionStorage` にも写す（`usePersistApprovalDrafts`）。別の画面へ移るとこの画面は unmount されるので、state だけでは書きかけが黙って消える。初期値は保存したものから読む。
  const [drafts, setDraftsState] = useState<ApprovalDrafts>(loadApprovalDrafts);
  const draftsEpoch = useRef(chatDraftEpoch());
  const setDrafts = useCallback((update: SetStateAction<ApprovalDrafts>) => {
    draftsEpoch.current = chatDraftEpoch();
    setDraftsState(update);
  }, []);
  const [leftoverSources, setLeftoverSources] = useState<ApprovalLeftoverSources>(
    loadApprovalLeftoverSources,
  );

  const setText = useCallback(
    (id: string, text: string) =>
      setDrafts((current) => ({
        ...current,
        texts: text === '' ? omitKey(current.texts, id) : { ...current.texts, [id]: text },
      })),
    [setDrafts],
  );
  const setQuestions = useCallback(
    (id: string, draft: ApprovalQuestionsDraft) =>
      setDrafts((current) => ({
        ...current,
        questions: isEmptyQuestionsDraft(draft)
          ? omitKey(current.questions, id)
          : { ...current.questions, [id]: draft },
      })),
    [setDrafts],
  );
  const settle = useCallback(
    (id: string, source: ApprovalLeftoverBase, sent: SentApprovalDraft) => {
      setDrafts((current) => settleApprovalDraft(current, id, sent));
      setLeftoverSources((current) => ({
        ...current,
        [id]: { question: source.question, questions: source.questions ?? undefined },
      }));
    },
    [setDrafts],
  );
  const noteConflict = useCallback((id: string, source: ApprovalLeftoverBase) => {
    setLeftoverSources((current) => ({
      ...current,
      [id]: {
        origin: 'conflict',
        question: source.question,
        questions: source.questions ?? undefined,
      },
    }));
  }, []);
  const discard = useCallback(
    (id: string) => {
      setDrafts((current) => ({
        texts: omitKey(current.texts, id),
        questions: omitKey(current.questions, id),
      }));
      setLeftoverSources((current) => omitKey(current, id));
    },
    [setDrafts],
  );

  return {
    drafts,
    draftsEpoch,
    setDrafts,
    leftoverSources,
    setLeftoverSources,
    setText,
    setQuestions,
    settle,
    noteConflict,
    discard,
  };
}

/**
 * 下書きを `sessionStorage` へ写す。`keep` が無ければそのまま、あれば `keep(id)` が真の id の下書きだけを書く。
 * `keep` は呼び元で `useCallback` / `useMemo` に載せる: 参照が変わるたびに書き直すため、毎描画作り直すと毎描画書く。
 * 画面ごとに呼ぶ位置が違う（`keep` の材料が後から決まる）ので、state の hook とは分けてある。
 */
export function usePersistApprovalDrafts(
  state: Pick<ApprovalDraftState, 'drafts' | 'draftsEpoch'>,
  keep?: (id: string) => boolean,
): void {
  const { drafts, draftsEpoch } = state;
  useEffect(() => {
    if (keep === undefined) {
      saveApprovalDrafts(drafts, draftsEpoch.current);
      return;
    }
    saveApprovalDrafts(
      {
        texts: Object.fromEntries(Object.entries(drafts.texts).filter(([id]) => keep(id))),
        questions: Object.fromEntries(Object.entries(drafts.questions).filter(([id]) => keep(id))),
      },
      draftsEpoch.current,
    );
  }, [drafts, draftsEpoch, keep]);
}

/**
 * 答えが通った承認の控えを `sessionStorage` へ写す。下書きの残っている承認の控えだけを残す（下書きを閉じた・送り切った控えは要らない）。
 * どの控えを渡すかは画面ごとに違う（承認の画面は一覧から集めた分も含める）ので、呼び元が渡す。
 */
export function usePersistApprovalLeftoverSources(
  sources: ApprovalLeftoverSources,
  drafts: ApprovalDrafts,
): void {
  useEffect(() => {
    saveApprovalLeftoverSources(
      Object.fromEntries(
        Object.entries(sources).filter(([id]) => id in drafts.texts || id in drafts.questions),
      ),
    );
  }, [sources, drafts]);
}
