import { ConnectionCard } from '~/components/connection';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useRunners } from '~/hooks/queries';
import { useAuth } from '~/hooks/use-auth';

export default function Settings() {
  return (
    <Page title="設定" description="この画面がどのデーモンを見ているか">
      <div className="flex flex-col gap-4">
        <ConnectionCard />
        <Account />
        <Runners />
      </div>
    </Page>
  );
}

function Account() {
  const auth = useAuth();

  return (
    <Card>
      <CardHeader
        title="ログイン"
        subtitle="この画面がデーモンに対して何者か"
        action={
          auth.status === 'open' ? (
            <Badge>認証なし</Badge>
          ) : auth.operator ? (
            <Badge tone="accent">実行環境の持ち主</Badge>
          ) : (
            <Badge tone="ok">ログイン済み</Badge>
          )
        }
      />
      <div className="px-4 py-3 text-sm">
        {auth.status === 'open' ? (
          <p className="text-xs leading-relaxed text-muted">
            このデーモンは認証を要求していない（
            <code className="font-mono">ALTEROID_GOOGLE_CLIENT_ID</code> が未設定か{' '}
            <code className="font-mono">ALTEROID_AUTH=off</code>）。守りは待ち受け先（既定は
            127.0.0.1）と、手前に置いた境界の側にある。
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
              <dt className="text-muted">アカウント</dt>
              <dd className="font-mono text-xs break-all">{auth.account?.id ?? '—'}</dd>
              {auth.account?.email !== null && auth.account?.email !== undefined && (
                <>
                  <dt className="text-muted">メール</dt>
                  <dd className="text-xs break-all">{auth.account.email}</dd>
                </>
              )}
            </dl>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" onClick={auth.logout}>
                ログアウト
              </Button>
              <span className="text-[11px] text-muted">
                この画面から鍵を捨てるだけ。デーモン側で失効させるなら{' '}
                <code className="font-mono">alteroid access revoke</code>
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function Runners() {
  const { data, error, isLoading } = useRunners();
  const runners = data?.runners ?? [];

  return (
    <Card>
      <CardHeader
        title="runner"
        subtitle="マネージャーが実際に走る器。鍵は指紋だけが見える（値は返らない）"
      />
      <ErrorNote error={error} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : runners.length === 0 ? (
        <Empty>登録された runner が無い。ローカルでは同一プロセスの runner に落ちている。</Empty>
      ) : (
        <ul>
          {runners.map((runner) => (
            <li key={runner.runnerId} className="border-b border-border px-4 py-3 last:border-b-0">
              <p className="font-mono text-sm">{runner.runnerId}</p>
              <p className="mt-0.5 font-mono text-[11px] text-muted">{runner.workspacePath}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {runner.credentials.length === 0 ? (
                  <span className="text-[11px] text-muted">渡している鍵は無い</span>
                ) : (
                  runner.credentials.map((credential) => (
                    <Badge key={credential.name}>{credential.name}</Badge>
                  ))
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
