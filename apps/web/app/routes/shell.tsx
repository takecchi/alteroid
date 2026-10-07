import {
  Activity,
  BellRing,
  BookText,
  Brain,
  CalendarClock,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';

import { ConnectionCard } from '~/components/connection';
import { LoadError } from '~/components/load-error';
import { DRAFT_NOTICE, ScopeDirtyProvider, useScopeDirtyRegistry } from '~/lib/leave-guard';
import { LogoutGuardContext, useLogout, type LogoutGuard } from '~/lib/use-logout';
import { useSignIn } from '~/lib/use-sign-in';
import { isNavItemActive, NAV_ITEMS, type NavItemDef } from '~/lib/nav';
import {
  AppSidebar,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  ErrorNote,
  MAIN_CONTENT_ID,
  MobileTopBar,
  ScreenLoading,
  ScreenState,
  SkipLink,
  useIsMobile,
  cn,
  type AppSidebarItem,
} from '@alteroid/ui';
import {
  JournalFeedProvider,
  useApprovals,
  useHealth,
  useUnreadConversationCount,
  useAuth,
  useJournalLive,
} from '@alteroid/swr';

// 記号だけをここに置く: lib/nav.ts を描画の部品（lucide）から切り離しておくため
const ICONS: Record<string, LucideIcon> = {
  '/': LayoutDashboard,
  '/chat': MessageSquare,
  '/approvals': BellRing,
  '/commitments': ListChecks,
  '/managers': Users,
  '/reports': BookText,
  '/journal': Activity,
  '/memory': Brain,
  '/schedule': CalendarClock,
  '/settings': Settings,
};

// 「いま居る画面」を NavLink の前方一致で決めない: 1行がまとまりを代表し、まとまりのどのページに居ても選択中でなければならないため
function NavItemLink({
  def,
  className,
  onClick,
  children,
}: {
  def: NavItemDef;
  className: (isActive: boolean) => string;
  onClick: (() => void) | undefined;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const active = isNavItemActive(def, pathname);
  return (
    <Link
      to={def.to}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={className(active)}
    >
      {children}
    </Link>
  );
}

const RECHECK_RETRY_DELAYS_MS = [5_000, 10_000, 15_000, 30_000];

// 書きかけの有無は門より上で持つ: 門は早期 return で枝ごと差し替わり、門の中の state では差し替えのたびに消えるため
export default function Shell() {
  const { hasDirty, report } = useScopeDirtyRegistry();
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [leaving, setLeaving] = useState(false);
  const guard: LogoutGuard = {
    confirm: (run) => (hasDirty ? setPending(() => run) : run()),
    end: () => setLeaving(false),
  };
  return (
    <ScopeDirtyProvider value={report}>
      <LogoutGuardContext.Provider value={guard}>
        <AuthGate hasDraft={hasDirty} leaving={leaving} />
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          {...DRAFT_NOTICE}
          destructive
          onConfirm={() => {
            // 帯を出さずに /login へ移る: 押した本人が確認して進んだもので、「ログインが切れた」とは違うため
            setLeaving(true);
            pending?.();
          }}
        />
      </LogoutGuardContext.Provider>
    </ScopeDirtyProvider>
  );
}

// 中身を別の部品に分ける: 取得も SSE の購読もその中に置き、混ぜると未ログインのまま全経路が 401 を叩き、日誌のストリームが再接続を繰り返すため
function AuthGate({ hasDraft, leaving }: { hasDraft: boolean; leaving: boolean }) {
  const auth = useAuth();
  const location = useLocation();
  const { error, status, isValidating, revalidate } = auth;

  // 判断と再試行は Shell 1か所に置く: SWR のコールバックは要求を始めたインスタンスでしか呼ばれず、インスタンスごとの state に置くと結果が変わるため
  const recheckFailing = error !== undefined && status !== 'checking';
  const [gaveUp, setGaveUp] = useState(false);
  if (!recheckFailing && gaveUp) setGaveUp(false);
  const attempts = useRef(0);
  useEffect(() => {
    if (!recheckFailing) {
      attempts.current = 0;
      return;
    }
    if (isValidating || gaveUp) return;
    const delay = RECHECK_RETRY_DELAYS_MS[attempts.current];
    if (delay === undefined) {
      setGaveUp(true);
      return;
    }
    const timer = setTimeout(() => {
      attempts.current += 1;
      void revalidate();
    }, delay);
    return () => clearTimeout(timer);
  }, [recheckFailing, isValidating, gaveUp, revalidate]);

  // ログインが切れても書きかけがあるあいだは画面を外さない: useBlocker は移動しか止められず、ここの差し替え（unmount）は止められないため
  // checking も含め、「繋がらない」より先に見る: 鍵が消えると useAuth のキーが変わって一度 checking に戻り、その手前の差し替えで書きかけが消えるため
  // ログアウトは確認のあと leaving で外す: 押した本人の操作に「ログインが切れた」の帯を出さないため
  const signedIn = auth.status === 'ready';
  const [wasSignedIn, setWasSignedIn] = useState(false);
  if (signedIn && !wasSignedIn) setWasSignedIn(true);
  const [discarded, setDiscarded] = useState(false);
  if (signedIn && discarded) setDiscarded(false);
  const sessionLost =
    wasSignedIn &&
    hasDraft &&
    !discarded &&
    !leaving &&
    (auth.status === 'checking' || auth.status === 'anonymous' || auth.status === 'ungranted');
  if (sessionLost) {
    return (
      <AuthedShell
        sessionLost={auth.status === 'ungranted' ? 'ungranted' : 'expired'}
        onDiscard={() => setDiscarded(true)}
        recheckFailing={false}
        onRecheck={() => revalidate()}
      />
    );
  }

  // 繋がらないを「未ログイン」にしない: ログイン画面へ飛ばすと直しようのない画面をぐるぐる回すため
  // 「確認中」より先に見る: 失敗したときは応答が無く status は checking のままで、順番を逆にすると回り続ける輪を出したまま永久にここへ来ないため
  // 直す手段をこの画面に置く: 設定画面は門の内側にいて、接続先が間違っているとそこへは永久に到達できないため
  if (
    auth.error !== undefined &&
    (auth.status === 'checking' || gaveUp) &&
    auth.status !== 'anonymous' &&
    auth.status !== 'ungranted'
  ) {
    return (
      <ScreenState title="接続先のサーバに繋がらない">
        <LoadError
          what="接続先のサーバの状態"
          error={auth.error}
          onRetry={() => auth.revalidate()}
          retrying={auth.isValidating}
          className="mb-4"
        />
        <ConnectionCard />
        <p className="mt-3 text-xs text-muted-foreground">
          接続先を直すとこの画面は自動で進む。サーバが起きていないだけなら
          <code className="mx-1 font-mono">alteroid daemon start</code>。
        </p>
      </ScreenState>
    );
  }

  if (auth.status === 'checking') {
    return <ScreenLoading label="接続を確認中" />;
  }

  if (auth.status === 'anonymous' || auth.status === 'ungranted') {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search + location.hash }}
      />
    );
  }

  return <AuthedShell recheckFailing={recheckFailing && !gaveUp} onRecheck={() => revalidate()} />;
}

type SessionLost = 'expired' | 'ungranted';

function AuthedShell({
  recheckFailing,
  onRecheck,
  sessionLost,
  onDiscard,
}: {
  recheckFailing: boolean;
  onRecheck: () => unknown;
  sessionLost?: SessionLost;
  onDiscard?: () => void;
}) {
  // 鍵が無い間は常駐の取得を止める: 止めないと全経路が 401 を叩き、SSE が再接続を繰り返すため
  const polling = sessionLost === undefined;
  // SSE はここで1本だけ張る: 下の画面はこれが回した無効化に相乗りするため
  const live = useJournalLive(polling);
  const { data: approvals, error: approvalsError } = useApprovals(true, polling);
  // 形の違う応答は「0件」ではなく「読めていない」へ倒す: 版がずれうる上、?.length ?? 0 で黙らせると読めていないのに0件（札無し）に見えるため
  const approvalsList = Array.isArray(approvals?.approvals) ? approvals.approvals : undefined;
  const approvalsMalformed = approvals !== undefined && approvalsList === undefined;
  const pending = approvalsList?.length ?? 0;
  // 読めない行だけのときも札を出す: pending は読める行だけなので、札が無いと「承認待ちはない」に見えるため
  const unreadableApprovals = Array.isArray(approvals?.unreadable)
    ? approvals.unreadable.length
    : 0;
  // エラーを最優先する: SWR は再取得が失敗しても直前の data を残すので、古い pending を出し続けると「読めていない」ことが画面から消えるため
  const approvalsUnavailable = approvalsError !== undefined || approvalsMalformed;

  // 狭い画面では脇の面を畳む: 畳まないと会話の画面では幅 375px で本文の取り分が 100px あまりしか残らないため
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  const approvalsBadge: ReactNode = approvalsUnavailable ? (
    // warn にしない: 「少数の承認待ちがある」と紛れるため
    <Badge tone="danger" aria-label="承認待ちを読めていない" title="承認待ちを読めていない">
      ?
    </Badge>
  ) : (
    <>
      {pending > 0 && <Badge tone="warn">{pending}</Badge>}
      {unreadableApprovals > 0 && (
        <Badge
          tone="warn"
          aria-label={`読めない承認待ちが ${unreadableApprovals} 件ある`}
          title={`読めない承認待ちが ${unreadableApprovals} 件ある`}
        >
          !
        </Badge>
      )}
    </>
  );

  const { data: unread, error: unreadError } = useUnreadConversationCount(polling);
  const unreadMalformed =
    unread !== undefined &&
    (typeof unread.count !== 'number' || unread.readStateUnreadable !== undefined);
  const conversationsUnavailable = unreadError !== undefined || unreadMalformed;
  const unreadCount = typeof unread?.count === 'number' ? unread.count : 0;
  const chatBadge: ReactNode = conversationsUnavailable ? (
    <Badge tone="danger" aria-label="未読の会話を読めていない" title="未読の会話を読めていない">
      ?
    </Badge>
  ) : (
    unreadCount > 0 && (
      <Badge
        tone="accent"
        aria-label={
          unread?.capped === true
            ? `未読のある会話 ${unreadCount} 件以上`
            : `未読のある会話 ${unreadCount} 件`
        }
      >
        {unreadCount}
        {unread?.capped === true ? '+' : ''}
      </Badge>
    )
  );

  const items: AppSidebarItem[] = NAV_ITEMS.map((def) => ({
    to: def.to,
    label: def.label,
    icon: ICONS[def.to] ?? Activity,
    ...(def.section === undefined ? {} : { section: def.section }),
    ...(def.to === '/approvals' ? { badge: approvalsBadge } : {}),
    ...(def.to === '/chat' ? { badge: chatBadge } : {}),
  }));
  const defByTo = new Map(NAV_ITEMS.map((def) => [def.to, def]));

  // 広い画面とドロワーで行き先の一覧を別々に書かない: 1つ足したとき片方だけ増えるため
  // ドロワーを useLocation の変化で閉じない: いま居る画面をもう一度押したときに URL が変わらず、覆ったまま残るため
  const sidebar = (inDrawer: boolean) => (
    <AppSidebar
      status={live.status}
      items={items}
      inDrawer={inDrawer}
      footer={<HealthFooter />}
      renderLink={(item, slot) => {
        const def = defByTo.get(item.to);
        if (def === undefined) return null;
        return (
          <NavItemLink
            def={def}
            className={slot.className}
            onClick={inDrawer ? closeNav : undefined}
          >
            {slot.children}
          </NavItemLink>
        );
      }}
    />
  );

  return (
    <JournalFeedProvider value={live}>
      {/* min-h-dvh ではなく h-dvh: 下の画面は自分の中で縦に分けて内側だけを流す作りで、外側の高さが決まっていないと「画面の高さ」を持てないため */}
      {/* overflow-hidden を外さない: はみ出したものは body をスクロールさせるだけで、サイドバーの下に空白が出るため */}
      <div className={cn('flex h-dvh overflow-hidden', isMobile ? 'flex-col' : 'flex-row')}>
        <SkipLink />
        {isMobile ? (
          <>
            <MobileTopBar
              status={live.status}
              onOpenNav={() => setNavOpen(true)}
              trailing={
                (pending > 0 || unreadableApprovals > 0 || approvalsUnavailable) && (
                  // リンクのままにする: 開けば /approvals の ErrorNote で読めなかった理由まで読めるため
                  <NavLink
                    to="/approvals"
                    className="flex min-h-11 shrink-0 items-center px-2"
                    aria-label={
                      approvalsUnavailable
                        ? '承認待ちを読めていない'
                        : unreadableApprovals > 0
                          ? `承認待ち ${pending} 件・読めない承認待ちが ${unreadableApprovals} 件ある`
                          : `承認待ち ${pending} 件`
                    }
                  >
                    {approvalsUnavailable ? (
                      <Badge tone="danger" title="承認待ちを読めていない">
                        承認待ち ?
                      </Badge>
                    ) : (
                      <>
                        {pending > 0 && <Badge tone="warn">承認待ち {pending}</Badge>}
                        {unreadableApprovals > 0 && (
                          <Badge
                            tone="warn"
                            title={`読めない承認待ちが ${unreadableApprovals} 件ある`}
                          >
                            読めない {unreadableApprovals}
                          </Badge>
                        )}
                      </>
                    )}
                  </NavLink>
                )
              }
            />
            <Drawer open={navOpen} onClose={closeNav} label="メニュー">
              {sidebar(true)}
            </Drawer>
          </>
        ) : (
          sidebar(false)
        )}

        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        >
          {sessionLost !== undefined && onDiscard !== undefined && (
            <SessionLostBanner kind={sessionLost} onDiscard={onDiscard} />
          )}
          {recheckFailing && (
            // 画面を置き換えず上に知らせるだけにする: 置き換えると配下の書きかけが消えるため
            <div
              role="status"
              className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
            >
              <span>接続先のサーバを確認できていない。自動で再試行している。</span>
              <button type="button" onClick={() => void onRecheck()} className="shrink-0 underline">
                今すぐ試す
              </button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </JournalFeedProvider>
  );
}

const SESSION_LOST_TEXT: Record<SessionLost, string> = {
  expired: 'ログインが切れた。書きかけは残してある。ログインし直すと保存できる。',
  ungranted: '許可が取り消された。書きかけは画面に残っているが保存できない。控えてから離れて。',
};

const noop = () => undefined;

function SessionLostBanner({ kind, onDiscard }: { kind: SessionLost; onDiscard: () => void }) {
  const { providers } = useAuth();
  const { busy, failure, manualUrl, begin, cancel } = useSignIn(noop);
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
    >
      <span>{SESSION_LOST_TEXT[kind]}</span>
      <div className="flex flex-wrap items-center gap-2">
        {kind === 'expired' &&
          providers.map((provider) => (
            <Button
              key={provider.id}
              size="sm"
              variant="primary"
              loading={busy}
              onClick={() => void begin(provider.id)}
            >
              {provider.label} でログインし直す
            </Button>
          ))}
        {busy && (
          <Button size="sm" onClick={cancel}>
            やめる
          </Button>
        )}
        <Button size="sm" onClick={onDiscard}>
          破棄してログイン画面へ
        </Button>
      </div>
      {manualUrl !== undefined && (
        <a href={manualUrl} target="_blank" rel="noreferrer" className="underline">
          ポップアップが塞がれた。ここを開いて認証する
        </a>
      )}
      <ErrorNote error={failure} />
    </div>
  );
}

function HealthFooter() {
  const { data, error } = useHealth();
  const auth = useAuth();
  const { busy, error: logoutError, logout, discard } = useLogout();

  const who = auth.account?.email ?? auth.account?.displayName ?? (auth.operator ? '持ち主' : null);

  return (
    <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
      {error !== undefined ? (
        <span className="text-destructive">接続先のサーバに繋がらない</span>
      ) : data === undefined ? (
        <span>確認中…</span>
      ) : (
        <span>接続中</span>
      )}

      {auth.status !== 'open' && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate" title={auth.account?.id}>
              {who ?? '—'}
            </span>
            <button
              type="button"
              onClick={logout}
              disabled={busy}
              className="shrink-0 underline hover:text-foreground disabled:opacity-50"
              title="サーバ側のアクセストークンも失効させる（アカウントごと締め出すなら alteroid access revoke）"
            >
              ログアウト
            </button>
          </div>
          {logoutError !== null && (
            <div className="mt-1.5 break-words text-destructive">
              サーバ側を失効させられなかった: {logoutError}
              <button
                type="button"
                onClick={discard}
                className="ml-1 shrink-0 underline hover:text-foreground"
              >
                この画面から鍵だけを捨てる
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
