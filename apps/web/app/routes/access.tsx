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
        <LoadError
          what="アクセス許可の一覧"
          error={error}
          onRetry={() => mutate()}
          retrying={isValidating}
          className="m-4"
        />
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
  hasUnreadable: boolean;
}) {
  if (accounts.length === 0) {
    if (hasUnreadable) {
      return <Empty>読めたアカウントは無い（誰もログインしていない、とは言えない）。</Empty>;
    }
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

// 取り消しは最初の押下で叩かない: 取り消された本人は自分では許可を戻せないため、誤クリック1回で起きないようにする
// 押せるかを先回りして隠さない: 誰が押せるかの判定はサーバに任せるため
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

// id を名前へ解決しない: そのアカウントが一覧から既に消えていることがありうるため
function describeGrantedBy(grantedBy: string | null): string {
  if (grantedBy === null) return '不明';
  if (grantedBy === 'operator') return '実行環境の持ち主';
  return grantedBy;
}
