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
  ErrorNote,
  Spinner,
} from '@alteroid/ui';
import {
  useCancelCodexLogin,
  useCodexAuth,
  useCodexLogin,
  useCodexLogout,
  useStartCodexLogin,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { CodexAuthStatusView, CodexLoginView } from '@alteroid/logic';

/**
 * Codex の ChatGPT ログイン（#3939）。CLI（`alteroid codex`）・HTTP（`/codex/*`）と同じ API の上に
 * 乗る。**値（auth.json の中身）はこの画面に1文字も来ない**——来るのは状態と、ログインの
 * 確認用 URL・コードだけ。
 */
export default function Codex() {
  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/codex')}
      title="Codex"
      description="マネージャーが作業を頼む Codex を、ChatGPT のサブスクリプション（ChatGPT ログイン）で動かす。CODEX_API_KEY が環境変数に在れば、そちらが先に使われる"
    >
      <div className="flex flex-col gap-4">
        <CodexAuthCard />
      </div>
    </Page>
  );
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
        ログインしていない。peer の Codex は、環境変数に CODEX_API_KEY があればそれで走る。
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
