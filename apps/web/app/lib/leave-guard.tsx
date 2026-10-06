import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router';

import { ConfirmDialog } from '@alteroid/ui';

/**
 * タブを閉じる・再読み込みの前の確認（`beforeunload`）。`dirty` の間だけ挟む。
 * アプリ内の移動（リンク）は止めない——そちらは `LeaveGuardScope` の `useBlocker` が受け持つ。
 * ルーターが同時に扱えるブロッカーは1つなので、子の経路が自分でブロッカーを持つ
 * 親の画面（`memory.tsx`・`practices.tsx`）はこちらだけを使う。
 */
export function useBeforeUnloadGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 古いブラウザは returnValue を入れないと出さない。
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

type ReportDirty = (id: string, dirty: boolean) => void;

const LeaveGuardContext = createContext<ReportDirty | undefined>(undefined);

/**
 * 画面ごとに1つだけ置く。中の欄が `useReportDirty` で知らせた書きかけのどれか1つでもあれば、
 * アプリ内の移動（`useBlocker`）と `beforeunload` の前に確認を挟む（`schedule.tsx` の形を共通にしたもの）。
 * 確認の文言は既存の画面（`schedule.tsx` など）と同じ。
 */
export function LeaveGuardScope({ children }: { children: ReactNode }) {
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback<ReportDirty>((id, dirty) => {
    setDirtyIds((current) => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const anyDirty = dirtyIds.size > 0;
  const blocker = useBlocker(anyDirty);
  useBeforeUnloadGuard(anyDirty);

  return (
    <LeaveGuardContext.Provider value={report}>
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.state === 'blocked') blocker.reset();
        }}
        title="保存していない変更があります"
        description="このまま離れると、書きかけの内容は失われます。"
        confirmLabel="破棄して離れる"
        destructive
        onConfirm={() => {
          if (blocker.state === 'blocked') blocker.proceed();
        }}
      />
      {children}
    </LeaveGuardContext.Provider>
  );
}

/**
 * 書きかけかどうかを、外側の `LeaveGuardScope` へ知らせる。欄が消えたら（保存・やめる）書きかけでなくなる。
 * `id` は同じ画面の中で欄ごとに別にする。
 */
export function useReportDirty(id: string, dirty: boolean) {
  const report = useContext(LeaveGuardContext);
  useEffect(() => {
    report?.(id, dirty);
  }, [id, dirty, report]);
  useEffect(() => () => report?.(id, false), [id, report]);
}
