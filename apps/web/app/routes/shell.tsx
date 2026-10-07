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
import { ScopeDirtyProvider, useScopeDirtyRegistry } from '~/lib/leave-guard';
import { useLogout } from '~/lib/use-logout';
import { useSignIn } from '~/lib/use-sign-in';
import { isNavItemActive, NAV_ITEMS, type NavItemDef } from '~/lib/nav';
import {
  AppSidebar,
  Badge,
  Button,
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

/**
 * 行き先の記号。並びと名前・まとまり・「いま居る画面」の経路は `~/lib/nav`（各ページ先頭の
 * タブの帯と同じ配列）が持つ。**記号だけがここに在る**のは、`lib/nav.ts` を描画の部品
 * （lucide）から切り離しておくため。
 */
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

/**
 * サイドバーの1行。**「いま居る画面」は `NavLink` の前方一致では決めない**——1行がまとまり
 * （仕事なら未了の仕事・作業の進捗）を代表するので、まとまりのどのページに居ても
 * 選択中でなければならない。判定は `~/lib/nav` の `isNavItemActive`（詳細の経路も含む）。
 * `aria-current` は自分で付ける（`NavLink` の自動の判定を使わないため）。
 */
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

/** 確認済みの後の再検証が失敗したときの、自動の再試行の間隔（ms）。使い切ると全体表示（合計 60 秒）。 */
const RECHECK_RETRY_DELAYS_MS = [5_000, 10_000, 15_000, 30_000];

/**
 * 書きかけの有無は門より上で持つ: 門は早期 return で枝ごと差し替わるので、門の中の state では
 * 差し替えのたびに消える。
 */
export default function Shell() {
  const { hasDirty, report } = useScopeDirtyRegistry();
  return (
    <ScopeDirtyProvider value={report}>
      <AuthGate hasDraft={hasDirty} />
    </ScopeDirtyProvider>
  );
}

/**
 * 通ってから中身を出す。
 *
 * **中身を別の部品に分けてあるのは意図的である。** 取得も SSE の購読もその中に
 * 置いてあるので、通っていない間は1本も飛ばない。同じ部品に混ぜると、未ログインの
 * まま全経路が 401 を叩き、日誌のストリームが再接続を延々と繰り返す。
 */
function AuthGate({ hasDraft }: { hasDraft: boolean }) {
  const auth = useAuth();
  const location = useLocation();
  const { error, status, isValidating, revalidate } = auth;

  /**
   * 確認済み（`status` が `checking` でない＝`data` がある）の後の再検証の失敗（issue #3063）。
   * 画面を置き換えると配下の書きかけが消えるので、帯で知らせて間隔を空けて自動で再試行し、
   * 約 60 秒続いたときだけ `gaveUp` にして全体表示へ切り替える。
   *
   * **判断と再試行はここ（Shell）1か所に置く。** `useAuth` は Shell・配下の画面・設定・ログインで
   * 同時に使われ、SWR の成功・失敗のコールバックは要求を始めたインスタンスでしか呼ばれない。
   * インスタンスごとの state に置くと、どれが取得を始めたかで結果が変わる。ここは共有される
   * `error` / `status`（キャッシュ）だけを見る。
   */
  const recheckFailing = error !== undefined && status !== 'checking';
  const [gaveUp, setGaveUp] = useState(false);
  // 直った（失敗でなくなった）ら諦めを解く。描画中の state 調整（effect で立て直さない）。
  if (!recheckFailing && gaveUp) setGaveUp(false);
  const attempts = useRef(0);
  useEffect(() => {
    if (!recheckFailing) {
      attempts.current = 0;
      return;
    }
    // 取り直しの最中は待つ（終わるとここへ戻る）。諦めた後は自動では打たない。
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

  /**
   * ログインが切れても、書きかけがあるあいだは画面を外さない（issue #3912）。`useBlocker` は
   * 移動しか止められず、ここの差し替え（unmount）は止められないので、差し替えそのものを控える。
   * 書きかけが無ければ従来どおり `/login` へ移す。
   *
   * **`checking` も含める。** 鍵が消えると `useAuth` のキーが変わって一度 `checking` に戻るので、
   * `anonymous` だけを見ると、その手前の「確認中」への差し替えで書きかけが消える。
   * 「繋がらない」の全体表示より先に見るのも同じ理由。
   * ログアウトの区別はしない: 押した操作の確認は別の穴（#3919）で扱う。
   */
  const signedIn = auth.status === 'ready';
  const [wasSignedIn, setWasSignedIn] = useState(false);
  if (signedIn && !wasSignedIn) setWasSignedIn(true);
  const [discarded, setDiscarded] = useState(false);
  if (signedIn && discarded) setDiscarded(false);
  const sessionLost =
    wasSignedIn &&
    hasDraft &&
    !discarded &&
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
  if (
    auth.error !== undefined &&
    (auth.status === 'checking' || gaveUp) &&
    auth.status !== 'anonymous' &&
    auth.status !== 'ungranted'
  ) {
    return (
      <ScreenState title="接続先のサーバに繋がらない">
        {/* 各画面の読み込み失敗の帯と同じ部品・同じ形（issue #2799）。 */}
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
  // 鍵が無い間は常駐の取得を止める: 止めないと全経路が 401 を叩き、SSE が再接続を繰り返す。
  const polling = sessionLost === undefined;
  // SSE はここで1本だけ張る。下の画面はこれが回した無効化に相乗りする。
  const live = useJournalLive(polling);
  const { data: approvals, error: approvalsError } = useApprovals(true, polling);
  /**
   * **形の違う応答（`approvals` が配列でない）は「0件」ではなく「読めていない」へ倒す。**
   * デーモンと画面は別デプロイで版がずれうる。`approvals?.approvals.length` のままだと
   * `TypeError` で外枠ごと落ち、`?.length ?? 0` で黙らせると読めていないのに0件（札無し）に
   * 見える。`null` も読み込み中（`undefined`）とは別で、「読めていない」側へ倒す。
   */
  const approvalsList = Array.isArray(approvals?.approvals) ? approvals.approvals : undefined;
  const approvalsMalformed = approvals !== undefined && approvalsList === undefined;
  const pending = approvalsList?.length ?? 0;
  /**
   * 読めない行（`unreadable`）の数（issue #3062）。`pending` は読める行だけなので、読めない行だけの
   * ときに札が無い＝「承認待ちはない」に見えた。**0件の顔にしない**——警告の札を出す（語は
   * `/approvals` の「読めない承認待ちが N 件ある」）。
   */
  const unreadableApprovals = Array.isArray(approvals?.unreadable)
    ? approvals.unreadable.length
    : 0;
  /**
   * 「読めていない」を「0件」と区別する（issue #2105）。`GET /approvals` が
   * 失敗しても、`useApprovals` を呼んでいるのがこの1箇所だけなのでナビの
   * バッジも一緒に沈黙していた——0件（バッジ無し）と見分けが付かない。
   *
   * **エラーを最優先する。** SWR は再取得が失敗しても直前の `data` を残す
   * ので、一度取れた後に再取得が失敗すると `approvals` は古い値のまま・
   * `approvalsError` だけが立つ。ここで古い `pending` を出し続けると
   * 「読めていない」ことが画面から消える——`HealthFooter`（同じファイル）と
   * `dashboard.tsx` の承認待ちカードが、どちらも `error !== undefined` を
   * `data` より先に見て古い値を捨てているのと同じ判断をここでも採る。
   *
   * **読み込み中（まだ一度も取れていない。`error` も `data` も無い）は
   * 従来どおりバッジ無し。** ここは「取れなかった」ではなく「まだ結果が
   * 無い」で、開いた直後の一瞬だけの状態である（`LiveIndicator` の
   * `connecting` のような専用の見た目は用意しない——数百 ms で `pending` か
   * 「読めていない」のどちらかへ必ず変わるので、その一瞬のためだけの見た目を
   * 足すと変化が多すぎて逆に読みにくくなる）。
   */
  const approvalsUnavailable = approvalsError !== undefined || approvalsMalformed;

  /*
   * 狭い画面では脇の面を畳む。**畳まないと本文が読めない** — 会話の画面は
   * これに加えてもう1枚（会話一覧）を脇に置くので、幅 375px では本文の取り分が
   * 100px あまりしか残らない。
   */
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  const approvalsBadge: ReactNode = approvalsUnavailable ? (
    // 0件（バッジ無し）と見分けが付く印（issue #2105）。`warn` では
    // 「少数の承認待ちがある」と紛れるので `danger` を使う
    // （`LiveIndicator` の `offline` / `HealthFooter` の
    // 「デーモンに繋がらない」と同じ、取れないことを言うときの色）。
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

  /**
   * 左ナビ「会話」の札: 未読のある会話の数。**承認待ちの札と同じ作法**——読めていないときは
   * 0 件（札無し）と区別できる danger の「?」にする（エラーを最優先。形の違う応答・既読の
   * 記録が読めない旨の応答も読めていない側）。会話の一覧は取らず、軽い口（件数だけ）を使う。
   * 数え切れていない（`capped`）ときは「N+」。
   */
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

  // `NAV_ITEMS`（`~/lib/nav`）から `AppSidebarItem` へ写す。札は承認待ちにだけ付く。
  const items: AppSidebarItem[] = NAV_ITEMS.map((def) => ({
    to: def.to,
    label: def.label,
    icon: ICONS[def.to] ?? Activity,
    ...(def.section === undefined ? {} : { section: def.section }),
    ...(def.to === '/approvals' ? { badge: approvalsBadge } : {}),
    ...(def.to === '/chat' ? { badge: chatBadge } : {}),
  }));
  const defByTo = new Map(NAV_ITEMS.map((def) => [def.to, def]));

  /**
   * 行き先の一覧。**広い画面では脇に、狭い画面ではドロワーの中に、同じものを置く。**
   * 別々に書くと、行き先を1つ足したときに片方だけ増える。
   *
   * ドロワーの中では、行き先を押したら閉じる。**`useLocation` の変化で閉じる形に
   * していない** — いま居る画面をもう一度押したときに URL が変わらず、覆ったまま残る。
   */
  const sidebar = (inDrawer: boolean) => (
    <AppSidebar
      status={live.status}
      items={items}
      inDrawer={inDrawer}
      footer={<HealthFooter />}
      renderLink={(item, slot) => {
        const def = defByTo.get(item.to);
        // `items` は `NAV_ITEMS` から作っているので必ず在る（型のための確認）。
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
    // 下の画面へ `live`（`recent` を含む）を配る。SSE の購読はここ1本のまま
    // （`useJournalLive` を呼んでいるのはこの関数だけ）。
    <JournalFeedProvider value={live}>
      {/*
        **`min-h-dvh` ではなく `h-dvh`。** 下の画面（`components/page.tsx` と
        会話の画面）は自分の中で縦に分けて内側だけを流す作りなので、外側の高さが
        決まっていないと「画面の高さ」を持てない。合わせて `main` を潰れる側
        （`min-h-0`）にしておく。
        **`overflow-hidden` も外さない。** この枠がちょうど viewport の高さなので、はみ出した
        ものは body をスクロールさせるだけで、見えるものは何も無い（サイドバーの下に空白が
        出る。`page.tsx` の本文の `relative` が一次の原因）。はみ出しの再発の保険として、
        body がスクロールしない形を枠そのものに持たせる。
      */}
      <div className={cn('flex h-dvh overflow-hidden', isMobile ? 'flex-col' : 'flex-row')}>
        <SkipLink />
        {isMobile ? (
          <>
            <MobileTopBar
              status={live.status}
              onOpenNav={() => setNavOpen(true)}
              trailing={
                (pending > 0 || unreadableApprovals > 0 || approvalsUnavailable) && (
                  // **リンクのままにする**（issue #2105）。開けば `/approvals` の
                  // `ErrorNote` で読めなかった理由まで読める——ここでは「読めていない」
                  // ことだけを言う。
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
            // 確認済みの後の再検証の失敗（issue #3063）。画面を置き換えると配下の書きかけが
            // 消えるので、上に知らせるだけにする（自動で再試行し、続いたときだけ全体表示）。
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
  expired: 'ログインが切れた。書きかけは画面に残っている。ログインし直すと続きを保存できる。',
  ungranted:
    'このアカウントの許可が取り消された。書きかけは画面に残っているが、保存はできない。必要なら控えてから離れてほしい。',
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

      {/* 認証を要求していないデーモンでは、居ない人を出さない。 */}
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
