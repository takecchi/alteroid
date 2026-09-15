import { Page } from '~/components/page';
import { Badge, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useAccess } from '~/hooks/queries';
import { formatDateTime } from '~/lib/format';
import type { AccessAccount } from '~/lib/types';

/**
 * `/access` — ログインしたアカウントと許可の一覧（`GET /access` / CLI の
 * `alteroid access list` と同じもの）。
 *
 * **読み取り専用。`grant` / `revoke` はこの画面からは呼ばない**（Issue #213）。
 *
 * ## なぜ読み取りだけなのか
 *
 * `docs/PRD.md`「要件: インターフェース」の入口の等価性は、見えるもの・起こせる
 * ことの列挙に「許可の付与」を含んでいない（`grep -Fn -- '入口の等価性' docs/PRD.md`）。
 * ⟹ 一覧を出さないことをそのまま**欠落**と読める根拠は列挙からは出ない。それでも
 * 一覧だけをここに足すのは、`AGENTS.md`「実装の前提」が列挙を持たずに定めている
 * 「片方でしかできないことを作らない」を、**取り返しのつく側**（表示を足すだけ）
 * から最小に埋めるためである。
 *
 * **`grant` / `revoke`（書き込み）は出さない。** 取り消し（`revoke`）は、押した
 * 後にその場で元に戻せる操作ではない——許可を戻すには、まだ許可を持つ別の
 * アカウントか実行環境の持ち主が、もう一度 `grant` を実行する必要がある。表示を
 * 足すだけの変更とは取り返しのつき方が違うので、この画面の範囲には含めない。
 *
 * ## この変更のあとも CLI / HTTP にしかできないこと
 *
 * - **許可の付与**（`alteroid access grant <id>` / `POST /access/:id/grant`）
 * - **許可の取り消し**（`alteroid access revoke <id>` / `POST /access/:id/revoke`）
 *
 * これらは `apps/cli/src/access.ts` と `apps/daemon/src/app.ts` に在るが、Web UI
 * には無い。**このことを「解消した」と読まないこと**——一覧を出したのはこの2つの
 * うち先に埋まる側であって、書き込みは未決のまま残っている。
 */
export default function Access() {
  const { data, error, isLoading } = useAccess();

  return (
    <Page
      title="アクセス許可"
      description="alteroid を使う許可の一覧。読み取り専用 — 許可の付与・取り消しは alteroid access grant/revoke、または POST /access/:id/grant|revoke で行う"
    >
      <Card>
        <CardHeader
          title="アカウント"
          subtitle="alteroid access list / GET /access と同じもの"
          action={data === undefined ? undefined : <Badge>{data.accounts.length}</Badge>}
        />
        <ErrorNote error={error} className="m-4" />
        {isLoading ? (
          <Spinner />
        ) : data === undefined ? null : (
          <AccessBody accounts={data.accounts} />
        )}
      </Card>
    </Page>
  );
}

function AccessBody({ accounts }: { accounts: readonly AccessAccount[] }) {
  if (accounts.length === 0) {
    // CLI（`accessListCommand`）と同じ文言。まだ誰もログインしていない既定の
    // 構成でもありうる——「まだ取れていない」との混同を避けるため断る。
    return <Empty>まだ誰もログインしていません。</Empty>;
  }
  return (
    <ul>
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} />
      ))}
    </ul>
  );
}

function AccountRow({ account }: { account: AccessAccount }) {
  const name = account.email ?? account.displayName ?? '(名前なし)';
  const via = account.identities
    .map((identity) =>
      identity.email === null ? identity.provider : `${identity.provider} (${identity.email})`,
    )
    .join(', ');

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{name}</span>
        <Badge tone={account.granted ? 'ok' : 'neutral'}>
          {account.granted ? '許可' : '未許可'}
        </Badge>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">id</dt>
        <dd className="font-mono break-all">{account.id}</dd>

        <dt className="mt-2 text-muted sm:mt-0">作成</dt>
        <dd>{formatDateTime(account.createdAt)}</dd>

        {via.length > 0 && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">ログイン手段</dt>
            <dd className="break-all">{via}</dd>
          </>
        )}

        <dt className="mt-2 text-muted sm:mt-0">最終ログイン</dt>
        <dd>
          {account.lastLoginAt === null ? '（まだ無い）' : formatDateTime(account.lastLoginAt)}
        </dd>

        <dt className="mt-2 text-muted sm:mt-0">許可した日時</dt>
        <dd>
          {account.grantedAt === null
            ? '（未許可）'
            : `${formatDateTime(account.grantedAt)}（${describeGrantedBy(account.grantedBy)}）`}
        </dd>
      </dl>
    </li>
  );
}

/**
 * `grantedBy` を人間が読む形にする。
 *
 * **`'operator'` は固定の特別な値**（実行環境の持ち主。`apps/daemon/src/app.ts`
 * の `actorOf` の doc）。それ以外は許可を与えたアカウントの id そのもの
 * （2026-09-06 の同格化以降、許可を持つアカウントも `grant` を叩けるので、id が
 * 入りうる——`.claude/skills/auth-and-access/SKILL.md`「許可が伝播するように
 * なった」）。**id をここで名前へ解決しない**——このアカウントが一覧から既に
 * 消えている（該当する行が無い）ことがありうるため、常に安全に出せる id のまま
 * 見せる。
 */
function describeGrantedBy(grantedBy: string | null): string {
  if (grantedBy === null) return '不明';
  if (grantedBy === 'operator') return '実行環境の持ち主';
  return grantedBy;
}
