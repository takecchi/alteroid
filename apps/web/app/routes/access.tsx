import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { useState } from 'react';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  KeyValueList,
  Spinner,
} from '@alteroid/ui';
import {
  useGrantAccess,
  useRevokeAccess,
  useAccess,
  useRemoveUnreadableAccounts,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { AccessAccount } from '@alteroid/logic';

import { UnreadableRowsNote } from '~/components/unreadable-rows-note';

/**
 * `/access` — ログインしたアカウントと許可の一覧（`GET /access` / CLI の
 * `alteroid access list` と同じもの）。
 *
 * **`grant` / `revoke`（許可の付与・取り消し）もこの画面から起こせる**（Issue #213。
 * 2026-09-24 に「欠落」と判定して足した。経緯は下の「grant / revoke を足した経緯」）。
 *
 * **持ち主の宣言のバッジ・ボタンは置かない（#2862 / #2947）。** ログインできる許可済みの
 * アカウントは全員が持ち主として扱われる（デーモンの `requireOwner` は素通し）ので、宣言の
 * 有無は通す・通さないに効かない。宣言の API（`/access/:id/owner*`）はデーモンに残るが、
 * 画面からは呼ばない。
 *
 * ## grant / revoke を足した経緯（Issue #213）
 *
 * **⚠️ 2026-09-24 に判断を反転した。** 以下の2段落は、それまでこの画面が読み取りに
 * とどまっていた理由として書かれていたもので、経緯として残す。反転した理由:
 *
 * - オーナーが「判断待ちの Issue は担い手の層で決めてよい」と委ねた（2026-09-24）
 * - 資格の線は既に決着している —— 2026-09-06 のオーナー決定で、許可を持つ
 *   アカウントは `grant` / `revoke` を叩ける（`authenticate` だけ）。**足りないのは
 *   画面だけ**だった（#213 の 2026-09-16 のコメント）
 * - 下の「列挙に無い」は、この repo の実績（台帳の本文編集・生ログの削除も列挙に
 *   無いが3入口へ揃えた）と整合しない（同コメント）
 * - 残る懸念「取り消しはその場で戻せない」は、**取り消しの前に確認の一手を挟む**
 *   ことで扱う（`AccessGrantControl`）。付与は取り消せる側なので確認を挟まない
 *
 * （以下、反転前の記述）
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
 * - ~~許可の付与・取り消し~~ —— 2026-09-24 に足した（Issue #213）
 *
 * これらは `apps/cli/src/access.ts` と `apps/daemon/src/app.ts` に在るが、Web UI
 * には無い。**このことを「解消した」と読まないこと**。
 */
export default function Access() {
  const { data, error, isLoading, isValidating, mutate } = useAccess();
  const removeUnreadable = useRemoveUnreadableAccounts();

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/access')}
      title="アクセス許可"
      description="alteroid を使える人の許可の一覧。許可を与えたり取り消したりもここでできる。ここで許可したアカウントは、どれも環境変数・実行環境プロファイル・MCP 連携などすべての設定を変えられる"
    >
      <Card>
        <CardHeader
          title="アカウント"
          subtitle="許可されているアカウント"
          action={data === undefined ? undefined : <Badge>{data.accounts.length}</Badge>}
        />
        {/* 一覧が既に読めていれば、取り直しの失敗でも下の一覧は残す（data があるときは中身を消さない）。 */}
        <LoadError
          what="アクセス許可の一覧"
          error={error}
          onRetry={() => mutate()}
          retrying={isValidating}
          className="m-4"
        />
        {/* 読めない行は一覧の前に言う（issue #2536。0件なら鍵ごと無いので何も出ない）。 */}
        {data?.rowsUnreadable !== undefined && (
          <UnreadableRowsNote
            noun="アカウント"
            unreadable={data.rowsUnreadable}
            removeUnreadable={removeUnreadable}
            hand="auth.json"
          />
        )}
        {isLoading ? (
          <Spinner />
        ) : data === undefined ? null : (
          <AccessBody accounts={data.accounts} hasUnreadable={data.rowsUnreadable !== undefined} />
        )}
      </Card>
    </Page>
  );
}

function AccessBody({
  accounts,
  hasUnreadable,
}: {
  accounts: readonly AccessAccount[];
  /** 読めない行が在るか（在れば「誰もログインしていない」とは言えない。issue #2536）。 */
  hasUnreadable: boolean;
}) {
  if (accounts.length === 0) {
    if (hasUnreadable) {
      return <Empty>読めたアカウントは無い（誰もログインしていない、とは言えない）。</Empty>;
    }
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

/** 一覧の行の名前（行ごとの操作ボタンの `aria-label` にも使う）。 */
function accountName(account: AccessAccount): string {
  return account.email ?? account.displayName ?? '(名前なし)';
}

function AccountRow({ account }: { account: AccessAccount }) {
  const name = accountName(account);
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

      <KeyValueList
        className="mt-2"
        labelWidth="9rem"
        items={[
          { label: 'id', value: account.id, mono: true },
          { label: '作成', value: formatDateTime(account.createdAt) },
          ...(via.length > 0 ? [{ label: 'ログイン手段', value: via }] : []),
          {
            label: '最終ログイン',
            value:
              account.lastLoginAt === null ? '（まだ無い）' : formatDateTime(account.lastLoginAt),
          },
          {
            label: '許可した日時',
            value:
              account.grantedAt === null
                ? '（未許可）'
                : `${formatDateTime(account.grantedAt)}（${describeGrantedBy(account.grantedBy)}）`,
          },
        ]}
      />

      <AccessGrantControl account={account} />
    </li>
  );
}

/**
 * 許可の付与・取り消しボタン（Issue #213）。
 *
 * - 未許可のアカウント → 「許可する」。押せばすぐ `POST /access/:id/grant`
 * - 許可済みのアカウント → 「許可を取り消す」。**押しても最初は叩かない。**
 *   確認の一手（「本当に取り消す」）を挟んでから `POST /access/:id/revoke`。
 *   取り消しはすぐ効き、**取り消された本人は自分では許可を戻せない**（許可が無いので `grant` も
 *   通らない）。戻せるのは、許可を持つ別のアカウントか実行環境の持ち主で、押す側は同じ画面の
 *   「許可する」で戻せる（issue #3072）。取り消された側が困るので、誤クリック1回で起きないようにする
 *
 * 誰が押せるかの判定はサーバに任せる（先回りして隠さない）。
 */
function AccessGrantControl({ account }: { account: AccessAccount }) {
  const grantAccess = useGrantAccess();
  const revokeAccess = useRevokeAccess();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(undefined);
    try {
      await action();
      setConfirming(false);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!account.granted ? (
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            aria-label={`${accountName(account)} を許可する`}
            onClick={() => void run(() => grantAccess(account.id))}
          >
            許可する
          </Button>
        ) : !confirming ? (
          <Button
            variant="danger"
            size="sm"
            aria-label={`${accountName(account)} の許可を取り消す`}
            onClick={() => setConfirming(true)}
          >
            許可を取り消す
          </Button>
        ) : (
          <>
            <span className="text-[11px] text-warn">
              取り消すと、このアカウントはすぐ使えなくなる。取り消された本人は、自分では許可を戻せない。戻せるのは許可を持つ別のアカウントか実行環境の持ち主で、この画面の「許可する」で戻せる。
            </span>
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              aria-label={`${accountName(account)} の許可を本当に取り消す`}
              onClick={() => void run(() => revokeAccess(account.id))}
            >
              本当に取り消す
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              やめる
            </Button>
          </>
        )}
      </div>
      <ErrorNote error={failure} />
    </div>
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
