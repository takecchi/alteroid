import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
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

interface LeaveGuardApi {
  report: ReportDirty;
  /** 以降の移動を止めない（削除が通った後の移動など）。戻せない。 */
  release: () => void;
}

const LeaveGuardContext = createContext<LeaveGuardApi | undefined>(undefined);

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
  // 削除が通った後の移動のように、確認を挟まず離れたいとき（`useReleaseLeaveGuard`）。
  const released = useRef(false);
  const release = useCallback(() => {
    released.current = true;
  }, []);
  const api = useMemo<LeaveGuardApi>(() => ({ report, release }), [report, release]);
  const anyDirty = dirtyIds.size > 0;
  // 文言を持つ欄（取り直せない値など）があれば、書きかけの既定よりそちらを先に言う。
  const notice = [...dirtyIds.values()].find((n) => n !== undefined) ?? DRAFT_NOTICE;
  const blocker = useBlocker(() => anyDirty && !released.current);
  useBeforeUnloadGuard(anyDirty);

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

/**
 * 書きかけかどうかを、外側の `LeaveGuardScope` へ知らせる。欄が消えたら（保存・やめる）書きかけでなくなる。
 * `id` は同じ画面の中で欄ごとに別にする。
 */
export function useReportDirty(id: string, dirty: boolean, notice?: LeaveNotice) {
  const report = useContext(LeaveGuardContext)?.report;
  useEffect(() => {
    report?.(id, dirty, notice);
  }, [id, dirty, notice, report]);
  useEffect(() => () => report?.(id, false), [id, report]);
}

/**
 * 外側の `LeaveGuardScope` の確認を、これ以降やめる関数を返す。削除が通った直後の `navigate` の前に呼ぶ
 * （書きかけの報告は次の描画まで消えないので、報告を待つと自分の移動を自分で止めてしまう）。
 */
export function useReleaseLeaveGuard(): () => void {
  const release = useContext(LeaveGuardContext)?.release;
  return release ?? noop;
}

function noop() {}

/**
 * この詳細がいまも mount されているか（issue #3802）。詳細は項目ごとに作り直される（`key`）ので、
 * 削除・停止の応答待ちに別の項目へ移ると古い詳細は消える。それでも古い詳細が起こした Promise の
 * `.then` は残るため、成功の `.then` ではこれを読み、mount されているときだけ `navigate` する
 * （いま見ている別の項目を閉じない）。StrictMode の二重実行でも、setup で true・cleanup で false。
 * `LeaveGuardScope` と同じ「項目ごとの作り直し」の部品なので、ここに置く（3画面が既に読み込む塊に
 * 同居させ、共有の塊を増やさない）。
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
