import {
  Activity,
  BellRing,
  BookText,
  Brain,
  CalendarClock,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Users,
} from 'lucide-react';
import { Navigate, NavLink, Outlet } from 'react-router';

import { Badge, ErrorNote, Spinner } from '~/components/ui';
import { useApprovals, useHealth } from '~/hooks/queries';
import { useAuth } from '~/hooks/use-auth';
import { useJournalLive, type LiveStatus } from '~/hooks/use-journal-live';
import { cn } from '~/lib/cn';

const NAV = [
  { to: '/', label: 'ダッシュボード', icon: LayoutDashboard, end: true },
  { to: '/chat', label: '会話', icon: MessageSquare, end: false },
  { to: '/approvals', label: '承認待ち', icon: BellRing, end: false },
  { to: '/managers', label: 'マネージャー', icon: Users, end: false },
  { to: '/journal', label: '日誌', icon: Activity, end: false },
  { to: '/reports', label: '日報', icon: BookText, end: false },
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

  if (auth.status === 'checking') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="接続を確認中" />
      </div>
    );
  }

  // 繋がらない・認証の確認自体が失敗した、は「未ログイン」ではない。
  // ログイン画面へ飛ばすと、直しようのない画面をぐるぐる回すことになる。
  if (auth.error !== undefined && auth.status !== 'anonymous' && auth.status !== 'ungranted') {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md">
          <ErrorNote error={auth.error} />
          <p className="mt-3 text-xs text-muted">
            接続先が違うか、デーモンが起きていない。設定は{' '}
            <a href="/settings" className="text-accent hover:underline">
              /settings
            </a>{' '}
            で変えられる。
          </p>
        </div>
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

  return (
    <div className="flex min-h-dvh">
      <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-surface">
        <div className="px-4 py-4">
          <p className="font-mono text-sm font-semibold tracking-tight">alteroid</p>
          <LiveIndicator status={live.status} />
        </div>

        <ul className="flex-1 px-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-surface-2 text-fg'
                      : 'text-muted hover:bg-surface-2 hover:text-fg',
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

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
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
          <span className="block truncate">記憶: {data.storage}</span>
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
