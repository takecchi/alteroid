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
  ConfirmDialog,
  Empty,
  ErrorNote,
  Spinner,
} from '@alteroid/ui';
import {
  useCancelCodexLogin,
  useCodexAuth,
  useCodexLogin,
  useCodexLogout,
  useRunners,
  useStartCodexLogin,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { CodexAuthStatusView, CodexLoginView, RunnerSummary } from '@alteroid/logic';

export default function Codex() {
  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/codex')}
      title="Codex"
      description="マネージャーが作業を頼む Codex を、ChatGPT のサブスクリプション（ChatGPT ログイン）で動かす。ログインか CODEX_API_KEY が実行環境に届くと、そこのマネージャーに Codex へ頼む口が開く（再起動は要らない）。CODEX_API_KEY が在れば、そちらが先に使われる"
    >
      <div className="flex flex-col gap-4">
        <CodexAuthCard />
        <PeerReachCard />
      </div>
    </Page>
  );
}

type CodexReach =
  | { kind: 'open'; models: readonly string[] }
  | { kind: 'closed'; reason: string }
  | { kind: 'unknown' }
  | { kind: 'silent' };

// unknown を「閉じている」と描かない: 名乗らない旧い runner は頼めるかどうか判定できないため
function codexReachOf(view: RunnerSummary['managerPeers']): CodexReach {
  if (view === undefined || view.status === 'unknown') return { kind: 'unknown' };
  const open = view.peers.find((peer) => peer.provider === 'codex');
  if (open !== undefined) return { kind: 'open', models: open.models ?? [] };
  const closed = view.closed?.find((entry) => entry.provider === 'codex');
  if (closed !== undefined) return { kind: 'closed', reason: closed.reason };
  return { kind: 'silent' };
}

function PeerReachCard() {
  const { data: auth } = useCodexAuth();
  const { data, error, isLoading, isValidating, mutate } = useRunners();
  const runners = data?.runners ?? [];
  const reach = runners.map((runner) => ({ runner, view: codexReachOf(runner.managerPeers) }));
  const noneOpen = reach.every(({ view }) => view.kind !== 'open');

  return (
    <Card>
      <CardHeader
        title="マネージャーから頼めるか（実行環境ごと）"
        subtitle="Codex の資格（このログインか CODEX_API_KEY）が実行環境に届くと、そこのマネージャーに Codex へ作業を頼む口（peer）が開く。頼むかどうかはマネージャーが決める"
      />
      <LoadError
        what="実行環境の一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="m-4"
      />
      {isLoading ? (
        <Spinner />
      ) : data === undefined ? null : runners.length === 0 ? (
        <Empty>
          登録された実行環境が無い。ローカルでは、接続先のサーバと同じプロセスの中で動いている。
        </Empty>
      ) : (
        <div>
          {auth?.loggedIn === true && noneOpen ? (
            <p className="border-b border-border px-4 py-3 text-sm text-destructive">
              ログインは済んでいるが、Codex を頼める実行環境がまだ無い。下の理由を見ること。
            </p>
          ) : null}
          <ul>
            {reach.map(({ runner, view }) => (
              <li key={runner.label} className="border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-sm break-all">{runner.runnerId ?? runner.label}</p>
                  <ReachBadge view={view} />
                </div>
                <ReachDetail view={view} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ReachBadge({ view }: { view: CodexReach }) {
  if (view.kind === 'open') return <Badge tone="ok">頼める</Badge>;
  if (view.kind === 'unknown') return <Badge>不明</Badge>;
  return <Badge tone="warn">閉じている</Badge>;
}

function ReachDetail({ view }: { view: CodexReach }) {
  const note = 'mt-0.5 text-[11px] break-words text-muted-foreground';
  if (view.kind === 'open') {
    return (
      <p className={note}>
        {view.models.length === 0
          ? 'モデルは Codex の既定'
          : `名指しできるモデル: ${view.models.join(', ')}`}
      </p>
    );
  }
  if (view.kind === 'closed') return <p className={note}>{view.reason}</p>;
  if (view.kind === 'unknown') {
    return <p className={note}>名乗らない旧い版か、名乗りをまだ受けていない</p>;
  }
  return <p className={note}>理由を名乗らない旧い版の実行環境（更新すると理由が出る）</p>;
}

function CodexAuthCard() {
  const { data, error, isLoading, isValidating, mutate } = useCodexAuth();
  const startLogin = useStartCodexLogin();
  const logout = useCodexLogout();
  const [loginId, setLoginId] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [starting, setStarting] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);

  async function start() {
    setFailure(undefined);
    setStarting(true);
    try {
      const view = await startLogin();
      setLoginId(view.id);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setStarting(false);
    }
  }

  async function doLogout() {
    setFailure(undefined);
    try {
      await logout();
    } catch (caught) {
      setFailure(caught);
    }
  }

  return (
    <Card>
      <CardHeader
        title="ChatGPT ログイン"
        subtitle="正本はデーモンが持ち、runner だけへ降ろす（値はどの画面にも出ない）"
        action={data === undefined ? undefined : <StatusBadge status={data} />}
      />
      <LoadError
        what="Codex のログインの状態"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="m-4"
      />
      <ErrorNote error={failure} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : data === undefined ? null : (
        <div className="flex flex-col gap-3 p-4">
          <StatusDetail status={data} />
          {loginId !== undefined && (
            <LoginProgress
              id={loginId}
              onSettled={() => void mutate()}
              onClose={() => setLoginId(undefined)}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={starting} onClick={() => void start()}>
              {data.loggedIn ? '再ログイン' : 'ログイン'}
            </Button>
            {data.loggedIn && (
              <Button variant="danger" onClick={() => setConfirmingLogout(true)}>
                ログアウト
              </Button>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmingLogout}
        onOpenChange={setConfirmingLogout}
        title="Codex の ChatGPT ログインを消しますか"
        description="正本から消し、全 runner から外します。戻すにはもう一度ログインが要ります。"
        confirmLabel="ログアウト"
        destructive
        onConfirm={() => void doLogout()}
      />
    </Card>
  );
}

function StatusBadge({ status }: { status: CodexAuthStatusView }) {
  if (!status.loggedIn) return <Badge>なし</Badge>;
  if (status.failure !== null) return <Badge tone="danger">切れている</Badge>;
  return <Badge tone="ok">ログイン済み</Badge>;
}

function StatusDetail({ status }: { status: CodexAuthStatusView }) {
  if (!status.loggedIn) {
    return (
      <p className="text-sm text-muted-foreground">
        ログインしていない。CODEX_API_KEY が実行環境に届いていれば、マネージャーの peer
        はそれで開いて走る。
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        アカウント <span className="font-medium">{status.email ?? '(不明)'}</span> / プラン{' '}
        <span className="font-medium">{status.planType ?? '(不明)'}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        最終更新 {status.updatedAt === null ? '(不明)' : formatDateTime(status.updatedAt)} / 指紋
        sha256={status.fingerprint ?? '(不明)'}
      </p>
      {status.failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          切れている・失効した・更新に失敗した（{formatDateTime(status.failure.at)}）:{' '}
          {status.failure.reason}。再ログインしてください。
        </p>
      )}
    </div>
  );
}

function describeLoginState(view: CodexLoginView): string {
  switch (view.state) {
    case 'pending':
      return '承認を待っている';
    case 'succeeded':
      return 'ログインした（正本に置き、runner へ降ろした）';
    case 'canceled':
      return '取り消した（正本は変わっていない）';
    case 'expired':
      return 'コードの期限が切れた（正本は変わっていない）。もう一度ログインする';
    case 'failed':
      return `失敗した（正本は変わっていない）: ${view.error ?? '理由不明'}`;
    default:
      // 投げずにそのまま出す: web とデーモンは別に配られ、サーバのほうが新しい窓が在るため
      return `未知の状態（${String(view.state)}）`;
  }
}

function LoginProgress({
  id,
  onSettled,
  onClose,
}: {
  id: string;
  onSettled: () => void;
  onClose: () => void;
}) {
  const { data, error } = useCodexLogin(id);
  const cancel = useCancelCodexLogin();
  const [cancelFailure, setCancelFailure] = useState<unknown>(undefined);
  const [notified, setNotified] = useState(false);

  if (data !== undefined && data.state !== 'pending' && !notified) {
    setNotified(true);
    onSettled();
  }

  async function doCancel() {
    setCancelFailure(undefined);
    try {
      await cancel(id);
    } catch (caught) {
      setCancelFailure(caught);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <ErrorNote error={error ?? cancelFailure} />
      {data === undefined ? (
        <Spinner />
      ) : (
        <>
          {data.state === 'pending' && (
            <>
              <p className="text-sm">
                ブラウザで次の URL を開き、コードを入力して ChatGPT のアカウントで承認する:
              </p>
              <a
                href={data.verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-sm text-primary underline"
              >
                {data.verificationUrl}
              </a>
              <p className="text-sm">
                コード: <code className="font-mono text-base font-semibold">{data.userCode}</code>
              </p>
            </>
          )}
          <p role="status" className="text-sm text-muted-foreground">
            {describeLoginState(data)}
          </p>
          <div className="flex gap-2">
            {data.state === 'pending' ? (
              <Button onClick={() => void doCancel()}>取り消す</Button>
            ) : (
              <Button variant="ghost" onClick={onClose}>
                閉じる
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
