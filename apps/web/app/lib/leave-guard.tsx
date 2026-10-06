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

/** 確認の文言。`useReportDirty` に渡すと、書きかけの既定の文言の代わりにこれを出す。 */
export interface LeaveNotice {
  title: string;
  description: string;
  confirmLabel: string;
}

const DRAFT_NOTICE: LeaveNotice = {
  title: '保存していない変更があります',
  description: 'このまま離れると、書きかけの内容は失われます。',
  confirmLabel: '破棄して離れる',
};

type ReportDirty = (id: string, dirty: boolean, notice?: LeaveNotice) => void;

const LeaveGuardContext = createContext<ReportDirty | undefined>(undefined);

/**
 * 画面ごとに1つだけ置く。中の欄が `useReportDirty` で知らせた書きかけのどれか1つでもあれば、
 * アプリ内の移動（`useBlocker`）と `beforeunload` の前に確認を挟む（`schedule.tsx` の形を共通にしたもの）。
 * 確認の文言は既定では既存の画面（`schedule.tsx` など）と同じ。欄が `LeaveNotice` を渡せば、それで差し替える。
 */
export function LeaveGuardScope({ children }: { children: ReactNode }) {
  // id -> 文言（既定なら undefined）。
  const [dirtyIds, setDirtyIds] = useState<ReadonlyMap<string, LeaveNotice | undefined>>(new Map());
  const report = useCallback<ReportDirty>((id, dirty, notice) => {
    setDirtyIds((current) => {
      if (current.has(id) === dirty && (!dirty || current.get(id) === notice)) return current;
      const next = new Map(current);
      if (dirty) next.set(id, notice);
      else next.delete(id);
      return next;
    });
  }, []);
  const anyDirty = dirtyIds.size > 0;
  // 文言を持つ欄（取り直せない値など）があれば、書きかけの既定よりそちらを先に言う。
  const notice = [...dirtyIds.values()].find((n) => n !== undefined) ?? DRAFT_NOTICE;
  const blocker = useBlocker(anyDirty);
  useBeforeUnloadGuard(anyDirty);

  return (
    <LeaveGuardContext.Provider value={report}>
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.state === 'blocked') blocker.reset();
        }}
        title={notice.title}
        description={notice.description}
        confirmLabel={notice.confirmLabel}
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
export function useReportDirty(id: string, dirty: boolean, notice?: LeaveNotice) {
  const report = useContext(LeaveGuardContext);
  useEffect(() => {
    report?.(id, dirty, notice);
  }, [id, dirty, notice, report]);
  useEffect(() => () => report?.(id, false), [id, report]);
}
