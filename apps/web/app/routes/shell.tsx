import {
  Activity,
  Archive as ArchiveIcon,
  BellRing,
  BookText,
  Brain,
  CalendarClock,
  DollarSign,
  Footprints,
  Gauge,
  Inbox as InboxIcon,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Lock,
  MessageSquare,
  Plug,
  Route as RouteIcon,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Users,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';

import { ConnectionCard } from '~/components/connection';
import {
  AppSidebar,
  Badge,
  Drawer,
  ErrorNote,
  MobileTopBar,
  ScreenLoading,
  ScreenState,
  useIsMobile,
  cn,
  type AppSidebarItem,
} from '@alteroid/ui';
import {
  JournalFeedProvider,
  useApprovals,
  useHealth,
  useAuth,
  useJournalLive,
} from '@alteroid/swr';

/**
 * `end` は `AppSidebarItem` に無い（`@alteroid/ui` はルーターを知らない）ので、`NAV`
 * が自前で持ち、`renderLink` の中で `NavLink` へ渡す。元の `NAV` が持つ値を落とさないため
 * である（将来 `end` が要る行き先が足されたときに、黙って効かなくならない）。
 * なお react-router の `NavLink` は `to="/"` を特別に扱うので、いまの `/` は `end` が
 * 無くても `/chat` などで選択中にならない（`shell.nav-current.test.tsx` の冒頭に実測）。
 */
const NAV = [
  { to: '/', label: 'ダッシュボード', icon: LayoutDashboard, end: true },
  { to: '/chat', label: '会話', icon: MessageSquare, end: false },
  { to: '/approvals', label: '承認待ち', icon: BellRing, end: false },
  // 承認待ちの隣に置く。**両方とも「人間が片付けるまで残るもの」**だが、承認待ちは
  // 「クローンが止まっている」で、こちらは「まだ片付いていない」である（止まって
  // いなくても片付いていない仕事はある）。
  { to: '/commitments', label: '未了の仕事', icon: ListChecks, end: false },
  { to: '/managers', label: 'マネージャー', icon: Users, end: false },
  // マネージャーの隣。評定（good/bad/unclear）は台帳（未了の仕事）と委譲
  // （マネージャー）の両方の軸を跨いで集計するので、どちらか一方の詳細画面では
  // なくここに置く（issue #1278 / #1620。PRD「入口の等価性」）。
  { to: '/appraisal-stats', label: '評定の内訳', icon: Gauge, end: false },
  { to: '/journal', label: '日誌', icon: Activity, end: false },
  { to: '/reports', label: '日報', icon: BookText, end: false },
  { to: '/usage', label: '利用状況', icon: DollarSign, end: false },
  { to: '/tokens', label: '認証トークン', icon: KeyRound, end: false },
  { to: '/access', label: 'アクセス許可', icon: ShieldCheck, end: false },
  // アクセス許可の隣。あちらは「誰が alteroid を使えるか」、こちらは
  // 「その人が Bash で何を通せるか」（issue #863）——別の許可の軸である。
  { to: '/permissions', label: '許可（Bash）', icon: Lock, end: false },
  { to: '/env-vars', label: '環境変数', icon: SlidersHorizontal, end: false },
  // 環境変数の隣。どちらも「器を焼き直さずに実行環境を直す」口で、こちらは
  // シェルスクリプト1本を丸ごと置く太い口である（issue #1122）。
  { to: '/profile', label: '実行環境プロファイル', icon: SquareTerminal, end: false },
  // プロファイルの隣。同じく「器を焼き直さずに実行環境を直す」口で、こちらは
  // `.mcp.json` に当たる連携の登録である（#325 段4）。
  { to: '/mcp-servers', label: 'MCP 連携', icon: Plug, end: false },
  { to: '/dropped', label: '握り潰しの跡', icon: Footprints, end: false },
  // 可観測性の最下段——`/dropped` の隣（#776）。
  { to: '/archive', label: 'アーカイブ', icon: ArchiveIcon, end: false },
  // アーカイブの隣。**どちらも人間の入口から一括削除する掃除の道具**
  // （issue #972 / #1042）。CLI の `alteroid inbox remove` と同じ口。
  { to: '/inbox', label: '受信箱', icon: InboxIcon, end: false },
  { to: '/memory', label: '記憶', icon: Brain, end: false },
  // 記憶の隣。どちらも「クローンの判断の材料」で、こちらは仕事の型ごとの
  // やり方（#1055 段3③）——器はこれを実行しない（読む素材でしかない）。
  { to: '/practices', label: 'やり方', icon: RouteIcon, end: false },
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
      <ScreenState title="デーモンに繋がらない">
        <ErrorNote error={auth.error} className="mb-4" />
        <ConnectionCard />
        <p className="mt-3 text-xs text-muted-foreground">
          接続先を直すとこの画面は自動で進む。デーモンが起きていないだけなら
          <code className="mx-1 font-mono">alteroid daemon start</code>。
        </p>
      </ScreenState>
    );
  }

  if (auth.status === 'checking') {
    return <ScreenLoading label="接続を確認中" />;
  }

  if (auth.status === 'anonymous' || auth.status === 'ungranted') {
    return <Navigate to="/login" replace />;
  }

  return <AuthedShell />;
}

function AuthedShell() {
  // SSE はここで1本だけ張る。下の画面はこれが回した無効化に相乗りする。
  const live = useJournalLive();
  const { data: approvals, error: approvalsError } = useApprovals(true);
  const pending = approvals?.approvals.length ?? 0;
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
  const approvalsUnavailable = approvalsError !== undefined;

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
    pending > 0 && <Badge tone="warn">{pending}</Badge>
  );

  // `NAV`（`end` を持つ自前の型）から `AppSidebarItem` へ写す。札は承認待ちにだけ付く。
  const items: AppSidebarItem[] = NAV.map(({ to, label, icon }) => ({
    to,
    label,
    icon,
    ...(to === '/approvals' ? { badge: approvalsBadge } : {}),
  }));
  const endByTo = new Map<string, boolean>(NAV.map((n) => [n.to, n.end]));

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
      renderLink={(item, slot) => (
        <NavLink
          to={item.to}
          end={endByTo.get(item.to) ?? false}
          onClick={inDrawer ? closeNav : undefined}
          className={({ isActive }) => slot.className(isActive)}
        >
          {slot.children}
        </NavLink>
      )}
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
      */}
      <div className={cn('flex h-dvh', isMobile ? 'flex-col' : 'flex-row')}>
        {isMobile ? (
          <>
            <MobileTopBar
              status={live.status}
              onOpenNav={() => setNavOpen(true)}
              trailing={
                (pending > 0 || approvalsUnavailable) && (
                  // **リンクのままにする**（issue #2105）。開けば `/approvals` の
                  // `ErrorNote` で読めなかった理由まで読める——ここでは「読めていない」
                  // ことだけを言う。
                  <NavLink
                    to="/approvals"
                    className="flex min-h-11 shrink-0 items-center px-2"
                    aria-label={
                      approvalsUnavailable ? '承認待ちを読めていない' : `承認待ち ${pending} 件`
                    }
                  >
                    {approvalsUnavailable ? (
                      <Badge tone="danger" title="承認待ちを読めていない">
                        承認待ち ?
                      </Badge>
                    ) : (
                      <Badge tone="warn">承認待ち {pending}</Badge>
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

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </JournalFeedProvider>
  );
}

function HealthFooter() {
  const { data, error } = useHealth();
  const auth = useAuth();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const who = auth.account?.email ?? auth.account?.displayName ?? (auth.operator ? '持ち主' : null);

  const handleLogout = () => {
    setLogoutError(null);
    void auth.logout().then((result) => {
      if (!result.ok) setLogoutError(result.message);
    });
  };

  return (
    <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
      {error !== undefined ? (
        <span className="text-destructive">デーモンに繋がらない</span>
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
        <div className="mt-2 border-t border-border pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate" title={auth.account?.id}>
              {who ?? '—'}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="shrink-0 underline hover:text-foreground"
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
                onClick={() => {
                  setLogoutError(null);
                  auth.discardCredential();
                }}
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
