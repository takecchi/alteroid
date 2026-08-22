import { ConnectionCard } from '~/components/connection';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useRunners } from '~/hooks/queries';
import { formatDateTime } from '~/lib/format';
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

/**
 * 名簿に載っている状態の見え方。
 *
 * **繋がっていないことを隠さない。** 上がってこない runner が一覧から消えるだけだと、
 * 人間には「設定し忘れた」のか「上がってこない」のかが区別できない。
 */
const RUNNER_STATES = {
  connecting: { label: '接続中', tone: 'neutral' },
  connected: { label: '接続済み', tone: 'ok' },
  unreachable: { label: '繋がらない（挑み直し中）', tone: 'warn' },
  unusable: { label: '使えない（挑み直さない）', tone: 'danger' },
  // 一度は繋がったのに名乗らなくなった器。**「まだ繋がらない」とは別に見せる** —
  // こちらは走っていた仕事ごと黙った可能性がある。
  lost: { label: '名乗らない（落ちた可能性）', tone: 'danger' },
} as const;

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
            <li key={runner.label} className="border-b border-border px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                {/* 繋がるまで runner_id は分からない。宛先（label）が名簿の鍵である */}
                <p className="font-mono text-sm">{runner.runnerId ?? runner.label}</p>
                <Badge tone={RUNNER_STATES[runner.state].tone}>
                  {RUNNER_STATES[runner.state].label}
                </Badge>
              </div>
              {runner.runnerId === undefined ? null : (
                <p className="mt-0.5 font-mono text-[11px] text-muted">{runner.label}</p>
              )}
              <p className="mt-0.5 font-mono text-[11px] text-muted">{runner.workspacePath}</p>
              {/*
                いまその宛先に応えているプロセス。**`runnerId` は器を作り直しても同じ**
                なので、名前だけでは「さっき仕事を渡した相手と同じか」が分からない。
                入れ替わっていれば、そこで走っていた委譲は失われている可能性がある。

                **名乗らないことを黙らせない。** 出さないと、人間からは
                「入れ替わっていない」と「判定できない」が同じに見える（クローンは
                `runner_list` で同じものを見ている。片方だけが見える形を作らない）。
              */}
              <p className="mt-0.5 font-mono text-[11px] text-muted">
                {runner.instanceId === undefined
                  ? 'プロセス: 名乗っていない（入れ替わりを判定できない）'
                  : `プロセス: ${runner.instanceId}${
                      runner.instanceSince === undefined
                        ? ''
                        : `（${formatDateTime(runner.instanceSince)} から）`
                    }`}
              </p>
              {runner.error === undefined ? null : (
                <p className="mt-1 text-[11px] text-danger">{runner.error}</p>
              )}
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
