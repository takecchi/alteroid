import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useBlocker } from 'react-router';

import { ConfirmDialog } from '@alteroid/ui';

/** `useBlocker` を使わない: ルーターが同時に扱えるブロッカーは1つで、子の経路が持つ親の画面（`memory.tsx`・`practices.tsx`）が衝突するため。 */
export function useBeforeUnloadGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // returnValue を入れる: 古いブラウザは入れないと確認を出さないため
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

export interface LeaveNotice {
  title: string;
  description: string;
  confirmLabel: string;
}

export const DRAFT_NOTICE: LeaveNotice = {
  title: '保存していない変更があります',
  description: 'このまま離れると、書きかけの内容は失われます。',
  confirmLabel: '破棄して離れる',
};

type ReportDirty = (id: string, dirty: boolean, notice?: LeaveNotice) => void;

interface LeaveGuardApi {
  report: ReportDirty;
  release: () => void;
}

const LeaveGuardContext = createContext<LeaveGuardApi | undefined>(undefined);

type ReportScopeDirty = (scopeId: string, dirty: boolean) => void;

/** 認証の門へ書きかけを知らせる: `useBlocker` は移動しか止められず、門が画面ごと差し替える unmount には効かないため。 */
const ScopeDirtyContext = createContext<ReportScopeDirty | undefined>(undefined);
export const ScopeDirtyProvider = ScopeDirtyContext.Provider;

export function useScopeDirtyRegistry(): { hasDirty: boolean; report: ReportScopeDirty } {
  const [dirtyScopes, setDirtyScopes] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback<ReportScopeDirty>((scopeId, dirty) => {
    setDirtyScopes((current) => {
      if (current.has(scopeId) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(scopeId);
      else next.delete(scopeId);
      return next;
    });
  }, []);
  return { hasDirty: dirtyScopes.size > 0, report };
}

/** `staysOn` は `beforeunload` には効かない: ページごと消えるため。 */
export function LeaveGuardScope({
  children,
  staysOn,
}: {
  children: ReactNode;
  staysOn?: (nextPathname: string) => boolean;
}) {
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
  const released = useRef(false);
  const release = useCallback(() => {
    released.current = true;
  }, []);
  const api = useMemo<LeaveGuardApi>(() => ({ report, release }), [report, release]);
  const anyDirty = dirtyIds.size > 0;
  const notice = [...dirtyIds.values()].find((n) => n !== undefined) ?? DRAFT_NOTICE;
  const blocker = useBlocker(
    ({ nextLocation }) =>
      anyDirty && !released.current && !(staysOn?.(nextLocation.pathname) ?? false),
  );
  useBeforeUnloadGuard(anyDirty);

  const scopeId = useId();
  const reportScope = useContext(ScopeDirtyContext);
  useEffect(() => {
    reportScope?.(scopeId, anyDirty);
  }, [reportScope, scopeId, anyDirty]);
  useEffect(() => () => reportScope?.(scopeId, false), [reportScope, scopeId]);

  return (
    <LeaveGuardContext.Provider value={api}>
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

export function useReportDirty(id: string, dirty: boolean, notice?: LeaveNotice) {
  const report = useContext(LeaveGuardContext)?.report;
  useEffect(() => {
    report?.(id, dirty, notice);
  }, [id, dirty, notice, report]);
  useEffect(() => () => report?.(id, false), [id, report]);
}

/** 報告の解除を待たず確認をやめる: 書きかけの報告は次の描画まで消えず、待つと自分の移動を自分で止めるため。 */
export function useReleaseLeaveGuard(): () => void {
  const release = useContext(LeaveGuardContext)?.release;
  return release ?? noop;
}

function noop() {}

/**
 * 古い詳細の `.then` は残るため、成功時はこれを読み、mount されているときだけ `navigate` する（いま見ている別の項目を閉じない）。
 * ここに置く: 3画面が既に読み込む塊に同居させ、共有の塊を増やさないため。
 */
export function useIsMounted(): RefObject<boolean> {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}
