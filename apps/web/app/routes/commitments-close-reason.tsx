import { useIsMounted, useReportDirty } from '~/lib/leave-guard';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button, ErrorNote, FieldHint, Input } from '@alteroid/ui';
import { useCloseCommitment } from '@alteroid/swr';
import type { Commitment } from '@alteroid/logic';

import type { RowNotePatch } from './commitments-row-note';

export function CloseReasonForm({
  commitment,
  label,
  onTrack,
  onSettling,
  planFocus,
}: {
  commitment: Commitment;
  label: string;
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
  planFocus: () => () => void;
}) {
  const closeCommitment = useCloseCommitment();
  // 外れたあとの後始末は片付けの途中だったときだけ動かす。応答が外れより先なら応答のほうで動かす。
  const closing = useRef<(() => void) | null>(null);
  // 下の後始末より前に呼ぶ: unmount では宣言順に片付くので、`mounted` を偽にしてから後始末を呼ぶ順が保たれる。
  const mounted = useIsMounted();
  useEffect(() => {
    return () => closing.current?.();
  }, []);
  const reasonId = useId();
  const reasonHintId = useId();
  const [reason, setReason] = useState('');
  const track = useCallback(
    (patch: RowNotePatch) => onTrack(commitment, patch),
    [onTrack, commitment],
  );
  // unmount では消さない: 行が外れたらページが断りとして残す。
  useEffect(() => {
    track({ reason: reason.trim() !== '' ? reason : undefined });
  }, [reason, track]);
  useReportDirty(`close-reason:${commitment.id}`, reason.trim() !== '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function submit() {
    // Enter はボタン（loading で塞がる）を通らないので、送信中の門はここで持つ。
    if (busy || reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    track({ closeFailure: undefined });
    // 応答を待つ間は、行が一覧から消えても断りにしない（一覧は応答より先に取り直される）。
    onSettling(commitment.id, true);
    const restoreFocus = planFocus();
    closing.current = restoreFocus;
    try {
      await closeCommitment(commitment.id, reason.trim());
      track({ reason: undefined, closeFailure: undefined, closedHere: true });
      // 取り直しが応答より先に行を外していたら、後始末は走り終えている。ここで送る。
      if (!mounted.current) restoreFocus();
    } catch (caught) {
      closing.current = null;
      setFailure(caught);
      // 一覧の取り直しが先に行を消すことがある（409）。ページにも渡し、行が消えても失敗の本文を見せる。
      track({ closeFailure: caught });
    } finally {
      setBusy(false);
      onSettling(commitment.id, false);
    }
  }

  return (
    <>
      <label htmlFor={reasonId} className="mt-2 block text-xs font-medium text-muted-foreground">
        片付けた理由
      </label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id={reasonId}
          aria-describedby={reasonHintId}
          value={reason}
          aria-label={`「${label}」を片付けた理由`}
          placeholder="例: 修正を入れて確認した"
          onChange={(event) => setReason(event.target.value)}
          onSubmitShortcut={() => void submit()}
        />
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          loading={busy}
          aria-label={`「${label}」が片付いた`}
          // 理由なしでは閉じられない: 「閉じた」だけが残ると、人間が後から否定できない。
          disabled={reason.trim() === ''}
          onClick={() => void submit()}
        >
          片付いた
        </Button>
      </div>
      <FieldHint id={reasonHintId} className="mt-1.5">
        何をもって片付いたかを書く。後から否定できるように残る。
      </FieldHint>

      <ErrorNote error={failure} className="mt-2" />
    </>
  );
}

// 返した関数は、フォーカスがまだ文書の先頭へ落ちたままのときだけ送る（使い手がほかへ移していたら動かさない）。
export function planFocusAfterRemoval(row: HTMLElement | null, targetSelector: string): () => void {
  const neighbor = row?.nextElementSibling ?? row?.previousElementSibling ?? null;
  return () => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target = neighbor?.isConnected
      ? neighbor.querySelector<HTMLElement>(targetSelector)
      : null;
    if (target !== null && target !== undefined) {
      target.focus();
      return;
    }
    const header = document.querySelector<HTMLElement>('[data-open-list-header]');
    if (header !== null) {
      header.setAttribute('tabindex', '-1');
      header.focus();
    }
  };
}
