import {
  Activity,
  BellRing,
  BookText,
  Brain,
  CalendarClock,
  DollarSign,
  Footprints,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Menu,
  MessageSquare,
  Settings,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';

import { ConnectionCard } from '~/components/connection';
import { Drawer } from '~/components/drawer';
import { Badge, ErrorNote, Spinner } from '~/components/ui';
import { JournalFeedProvider } from '~/hooks/journal-feed';
import { useApprovals, useHealth } from '~/hooks/queries';
import { useAuth } from '~/hooks/use-auth';
import { useIsMobile } from '~/hooks/use-is-mobile';
import { useJournalLive, type LiveStatus } from '~/hooks/use-journal-live';
import { cn } from '~/lib/cn';

const NAV = [
  { to: '/', label: 'ダッシュボード', icon: LayoutDashboard, end: true },
  { to: '/chat', label: '会話', icon: MessageSquare, end: false },
  { to: '/approvals', label: '承認待ち', icon: BellRing, end: false },
  // 承認待ちの隣に置く。**両方とも「人間が片付けるまで残るもの」**だが、承認待ちは
  // 「クローンが止まっている」で、こちらは「まだ片付いていない」である（止まって
  // いなくても片付いていない仕事はある）。
  { to: '/commitments', label: '未了の仕事', icon: ListChecks, end: false },
  { to: '/managers', label: 'マネージャー', icon: Users, end: false },
  { to: '/journal', label: '日誌', icon: Activity, end: false },
  { to: '/reports', label: '日報', icon: BookText, end: false },
  { to: '/usage', label: '利用状況', icon: DollarSign, end: false },
  { to: '/tokens', label: '認証トークン', icon: KeyRound, end: false },
  { to: '/dropped', label: '握り潰しの跡', icon: Footprints, end: false },
  { to: '/memory', label: '記憶', icon: Brain, end: false },
  { to: '/schedule', label: 'スケジュール', icon: CalendarClock, end: false },
  { to: '/settings', label: '設定', icon: Settings, end: false },
] as const;

/**
 * 通ってから中身を出す。
 *
 * **中身を別の部品に分けてあるのは意図的である。** 取得も SSE の購読もその中に
 * 置いてあるので、通っていない間は1本も飛ばない。同じ部品に混ぜると、未ログインの
 * まま全経路が 401 を叩き、日誌のストリームが再接続を延々と繰り返す。
 */
export default function Shell() {
  const auth = useAuth();

  /**
   * 繋がらない・認証の確認自体が失敗した、は「未ログイン」ではない。
   * ログイン画面へ飛ばすと、直しようのない画面をぐるぐる回すことになる。
   *
   * **「確認中」より先に見る。** 失敗したときは応答が無いので `status` は
   * `checking` のままであり、順番を逆にすると回り続ける輪を出したまま
   * ここへ永久に来ない。
   *
   * **直す手段をこの画面に置く。** 設定画面は門の内側にいるので、接続先が
   * 間違っているとそこへは永久に到達できない（配る成果物の既定は同一オリジンの
   * `/api` なので、別のホストのデーモンを指したい初回の人は必ずここで詰まる）。
   */
  if (auth.error !== undefined && auth.status !== 'anonymous' && auth.status !== 'ungranted') {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <h1 className="mb-3 text-sm font-semibold">デーモンに繋がらない</h1>
          <ErrorNote error={auth.error} className="mb-4" />
          <ConnectionCard />
          <p className="mt-3 text-xs text-muted">
            接続先を直すとこの画面は自動で進む。デーモンが起きていないだけなら
            <code className="mx-1 font-mono">alteroid daemon start</code>。
          </p>
        </div>
      </div>
    );
  }

  if (auth.status === 'checking') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="接続を確認中" />
      </div>
    );
  }

  if (auth.status === 'anonymous' || auth.status === 'ungranted') {
    return <Navigate to="/login" replace />;
  }

  return <AuthedShell />;
}

function AuthedShell() {
  // SSE はここで1本だけ張る。下の画面はこれが回した無効化に相乗りする。
  const live = useJournalLive();
  const { data: approvals } = useApprovals(true);
  const pending = approvals?.approvals.length ?? 0;

  /*
   * 狭い画面では脇の面を畳む。**畳まないと本文が読めない** — 会話の画面は
   * これに加えてもう1枚（会話一覧）を脇に置くので、幅 375px では本文の取り分が
   * 100px あまりしか残らない。
   */
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  const nav = (
    <Nav status={live.status} pending={pending} onNavigate={isMobile ? closeNav : undefined} />
  );

  return (
    // 下の画面へ `live`（`recent` を含む）を配る。SSE の購読はここ1本のまま
    // （`useJournalLive` を呼んでいるのはこの関数だけ）。
    <JournalFeedProvider value={live}>
      {/*
        **`min-h-dvh` ではなく `h-dvh`。** 下の画面（`components/page.tsx` と
        会話の画面）は自分の中で縦に分けて内側だけを流す作りなので、外側の高さが
        決まっていないと「画面の高さ」を持てない。合わせて `main` を潰れる側
        （`min-h-0`）にしておく。
      */}
      <div className={cn('flex h-dvh', isMobile ? 'flex-col' : 'flex-row')}>
        {isMobile ? (
          <>
            <MobileTopBar
              status={live.status}
              pending={pending}
              onOpenNav={() => setNavOpen(true)}
            />
            <Drawer open={navOpen} onClose={closeNav} label="メニュー">
              {nav}
            </Drawer>
          </>
        ) : (
          nav
        )}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </JournalFeedProvider>
  );
}

/**
 * 行き先の一覧。
 *
 * **広い画面では脇に、狭い画面ではドロワーの中に、同じものを置く。** 別々に
 * 書くと、行き先を1つ足したときに片方だけ増える。
 */
function Nav({
  status,
  pending,
  onNavigate,
}: {
  status: LiveStatus;
  pending: number;
  /**
   * 行き先を押したとき。ドロワーの中では閉じる。
   *
   * **`useLocation` の変化で閉じる形にしていない。** いま居る画面をもう一度
   * 押したときに URL が変わらず、覆ったまま残る。
   */
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <nav
      className={cn(
        'flex flex-col bg-surface',
        /*
         * ドロワーの中では枠と幅は Drawer 側が持っている（`pl-[var(--safe-left)]` も
         * 含めて — `drawer.tsx` の `SheetContent` に既にある）。**ここで同じものを
         * 足すと二重に効く**（余白が倍になる）ので、`onNavigate` が無い側
         * （広い画面でこの `nav` が単独でページの左端に立つとき）にだけ足す。
         *
         * 横向きで画面幅が 768px（`useIsMobile` の境目）を超える端末では
         * `MobileTopBar` ではなくこちら（`AuthedShell` の `nav`）が画面の左端に
         * 出る（`shell.tsx` の `AuthedShell` 参照）。**現行の多くの機種は横向きで
         * この幅を超える**ので、横向きの左端の safe-area はむしろこちらが主な
         * 当たり先になる。右は当てていない — 広い画面では `nav` の右に `main`
         * （`page.tsx` / `chat.tsx`）が続き、画面の右端は既にそちら側の
         * pr-safe-right の calc() 版が持っている（⚠️ ここで実際の角括弧つきの
         * クラス名を書くと、Tailwind のスキャナがコメントか本物のコードかを
         * 区別せず拾って壊れた CSS を生成する。実測: 一度 `pr-[calc(...+var(
         * --safe-right))]` と書いたところ、コンパイル後の CSS に
         * `padding-right:calc(...+var(--safe-right))` という不正な calc() が
         * そのまま出た。使われない・壊れてもいないので実害は無いが、次に
         * ここへ角括弧つきの例を書くときは注意すること）。
         */
        onNavigate === undefined
          ? 'w-52 shrink-0 border-r border-border pl-[var(--safe-left)]'
          : 'min-h-0 flex-1',
      )}
    >
      <div className="px-4 py-4">
        <p className="font-mono text-sm font-semibold tracking-tight">alteroid</p>
        <LiveIndicator status={status} />
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'mb-0.5 flex items-center gap-2 rounded-md px-2 text-sm transition-colors',
                  // 指で押す先は 44px 以上（WCAG 2.5.5 / Apple HIG の下限）。
                  onNavigate === undefined ? 'py-1.5' : 'min-h-11',
                  isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="flex-1 truncate">{label}</span>
              {to === '/approvals' && pending > 0 && <Badge tone="warn">{pending}</Badge>}
            </NavLink>
          </li>
        ))}
      </ul>

      <HealthFooter />
    </nav>
  );
}

/**
 * 狭い画面の上端。
 *
 * **承認待ちの件数をここにも出す。** 脇の面を畳んだ結果、人間を待っている仕事が
 * どこにも見えなくなるのが一番まずい（自律して動き続ける前提の系なので、待ちが
 * 溜まっていることに気づけないと止まる）。
 */
function MobileTopBar({
  status,
  pending,
  onOpenNav,
}: {
  status: LiveStatus;
  pending: number;
  onOpenNav: () => void;
}) {
  return (
    <header className="shrink-0 border-b border-border bg-surface pt-[var(--safe-top)] pl-[var(--safe-left)] pr-[var(--safe-right)]">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="メニューを開く"
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Menu className="size-5" aria-hidden />
        </button>

        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold tracking-tight">alteroid</p>
          <LiveIndicator status={status} />
        </div>

        {pending > 0 && (
          <NavLink
            to="/approvals"
            className="flex min-h-11 shrink-0 items-center px-2"
            aria-label={`承認待ち ${pending} 件`}
          >
            <Badge tone="warn">承認待ち {pending}</Badge>
          </NavLink>
        )}
      </div>
    </header>
  );
}

/**
 * 日誌 SSE が生きているか。
 *
 * **これを出さないと「静かなこと」と「切れていること」が区別できない。** 常駐して
 * 動き続ける前提の系なので、無音は正常でもありうるし異常でもありうる。
 */
function LiveIndicator({ status }: { status: LiveStatus }) {
  const view = {
    live: { tone: 'ok', text: '受信中', pulse: true },
    connecting: { tone: 'warn', text: '接続中', pulse: true },
    offline: { tone: 'danger', text: '切断', pulse: false },
  }[status] as { tone: 'ok' | 'warn' | 'danger'; text: string; pulse: boolean };

  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
      <span
        className={cn(
          'size-1.5 rounded-full',
          view.tone === 'ok' && 'bg-ok',
          view.tone === 'warn' && 'bg-warn',
          view.tone === 'danger' && 'bg-danger',
          view.pulse && 'animate-pulse',
        )}
        aria-hidden
      />
      {view.text}
    </div>
  );
}

function HealthFooter() {
  const { data, error } = useHealth();
  const auth = useAuth();

  const who = auth.account?.email ?? auth.account?.displayName ?? (auth.operator ? '持ち主' : null);

  return (
    <div className="border-t border-border px-4 py-3 text-[11px] text-muted">
      {error !== undefined ? (
        <span className="text-danger">デーモンに繋がらない</span>
      ) : data === undefined ? (
        <span>確認中…</span>
      ) : (
        <>
          <span className="block truncate" title={data.storage}>
            記憶: {data.storage}
          </span>
          <span className="block truncate">pid {data.pid}</span>
        </>
      )}

      {/* 認証を要求していないデーモンでは、居ない人を出さない。 */}
      {auth.status !== 'open' && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="min-w-0 truncate" title={auth.account?.id}>
            {who ?? '—'}
          </span>
          <button
            type="button"
            onClick={auth.logout}
            className="shrink-0 underline hover:text-fg"
            title="この画面から鍵を捨てる（デーモン側の失効は alteroid access revoke）"
          >
            ログアウト
          </button>
        </div>
      )}
    </div>
  );
}
