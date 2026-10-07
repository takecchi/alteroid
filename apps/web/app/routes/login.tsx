import { ExternalLink, LogIn } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { ConnectionCard } from '~/components/connection';
import { LoadError } from '~/components/load-error';
import { returnPathFrom } from '~/lib/return-to';
import { useLatest } from '~/lib/use-latest';
import { useLogout } from '~/lib/use-logout';
import { useSignIn } from '~/lib/use-sign-in';
import {
  Badge,
  Button,
  Card,
  DocumentTitle,
  ErrorNote,
  Input,
  KeyValueList,
  Spinner,
} from '@alteroid/ui';
import { useAuth, useApiContext } from '@alteroid/swr';
import { formatTime } from '@alteroid/logic';

const NOTE = 'text-xs text-muted-foreground';

function Heading({ children }: { children: string }) {
  return (
    <>
      <DocumentTitle>{children}</DocumentTitle>
      <h1 className="text-sm font-semibold">{children}</h1>
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono">{children}</code>;
}

export default function Login() {
  const auth = useAuth();

  // 結果が既に在るときは画面を差し替えない: 再検証の失敗で差し替えると、待機中の SignIn が unmount されて待っていた取り込みが止まるため
  const recheckError = auth.status === 'checking' ? undefined : auth.error;
  const loadError = (error: unknown, className: string) => (
    <LoadError
      what="接続先のサーバの状態"
      error={error}
      onRetry={() => auth.revalidate()}
      retrying={auth.isValidating}
      className={className}
    />
  );
  const notice = loadError(recheckError, 'mb-4');

  if (auth.error !== undefined && auth.status === 'checking') {
    return (
      <Shell>
        <Heading>接続先のサーバに繋がらない</Heading>
        {loadError(auth.error, 'mt-3')}
      </Shell>
    );
  }

  if (auth.status === 'checking') {
    return (
      <Shell>
        <Spinner label="接続先のサーバを確認中" />
      </Shell>
    );
  }
  if (auth.status === 'open' || auth.status === 'ready') {
    return <BackToWhereYouWere />;
  }
  if (auth.status === 'ungranted') {
    return <Ungranted notice={notice} />;
  }
  return <SignIn notice={notice} />;
}

// `useLocation` を `Login` 本体で呼ばない: `Router` 無しで `Login` を描くテストがあるため。
function BackToWhereYouWere() {
  return <Navigate to={returnPathFrom(useLocation().state)} replace />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 pt-[calc(1.5rem+var(--safe-top))] pb-[calc(1.5rem+var(--safe-bottom))]">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="font-mono text-lg font-semibold tracking-tight">alteroid</p>
          <p className={`mt-1 ${NOTE}`}>クローンの様子を見て、指示を出し、記憶を直す</p>
        </div>
        <Card className="p-5">{children}</Card>
        <div className="mt-4">
          <ConnectionCard compact />
        </div>
      </div>
    </div>
  );
}

function SignIn({ notice }: { notice: React.ReactNode }) {
  const auth = useAuth();
  const { baseUrl } = useApiContext();
  const navigate = useNavigate();
  const returnTo = returnPathFrom(useLocation().state);

  // 許可の有無でここでは分岐しない: 許可が無ければ、この後 `ungranted` の画面に落ちるため
  const { busy, failure, manualUrl, begin, cancel } = useSignIn(
    useCallback(() => void navigate(returnTo, { replace: true }), [navigate, returnTo]),
  );

  return (
    <Shell>
      {notice}
      <Heading>ログイン</Heading>
      <p className={`mt-1 ${NOTE}`}>
        接続先: <span className="font-mono">{baseUrl}</span>
      </p>

      <ErrorNote error={failure} className="mt-3" />

      {auth.providers.length === 0 ? (
        <div
          className={`mt-4 rounded-md border border-border bg-background p-3 leading-relaxed ${NOTE}`}
        >
          <p className="mb-1.5 font-medium text-foreground">ログイン手段が設定されていない</p>
          <p>
            接続先のサーバは認証を要求しているが、ログインできるプロバイダが1つも登録されていない。
            サーバ側に <Code>ALTEROID_GOOGLE_CLIENT_ID</Code> と{' '}
            <Code>ALTEROID_GOOGLE_CLIENT_SECRET</Code> を設定するか、認証を切る（
            <Code>ALTEROID_AUTH=off</Code>）。
          </p>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {auth.providers.map((provider) => (
            <Button
              key={provider.id}
              variant="primary"
              loading={busy}
              onClick={() => void begin(provider.id)}
            >
              <LogIn className="size-3.5" aria-hidden />
              {provider.label} で続ける
            </Button>
          ))}
        </div>
      )}

      {busy && (
        <div className={`mt-3 flex items-center gap-2 ${NOTE}`}>
          <Badge tone="accent">待機中</Badge>
          <span className="min-w-0 flex-1">別ウィンドウで認証を終えると、この画面が自動で進む</span>
          <Button size="sm" onClick={cancel}>
            やめる
          </Button>
        </div>
      )}

      {manualUrl !== undefined && (
        <a
          href={manualUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          ポップアップが塞がれた。ここを開いて認証する
        </a>
      )}

      <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
        ログインしただけでは使えない。
        <strong className="text-foreground">使う許可は人間が CLI から与える</strong>（
        <Code>alteroid access grant &lt;id&gt;</Code>）。 端末から使うだけなら{' '}
        <Code>alteroid login</Code> でも同じ。
      </p>
    </Shell>
  );
}

// ここでログインし直させない: 何度やっても同じ結果になるため
function Ungranted({ notice }: { notice: React.ReactNode }) {
  const auth = useAuth();
  // 鍵だけ捨てて離れない（auth.logout() を使う）: サーバ側では生きたまま残り、後から grant された瞬間に使える鍵として生き返るため
  const { busy, error: logoutError, logout, discard } = useLogout();
  // 確認の失敗を「まだ許可されていない」と言わない: 失敗を結果のように見せないため
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  // 失敗の有無を描き直し後の error で見る: revalidate() は失敗しても前回の値で解決するため
  const latestError = useLatest(auth.error);
  const recheck = () => {
    if (checking) return;
    setChecking(true);
    void auth
      .revalidate()
      .then(() => {
        if (latestError.current === undefined) setCheckedAt(new Date().toISOString());
      })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };
  const command = `alteroid access grant ${auth.account?.id ?? '<アカウント id>'}`;

  return (
    <Shell>
      {notice}
      <Heading>まだ使う許可が無い</Heading>
      {/* 「単一の持ち主のもの」と書かない: 許可できるアカウントの数に上限が無くなり、その文言は嘘になるため */}
      <p className={`mt-2 leading-relaxed ${NOTE}`}>
        ログインは通っている。使えるようにするのは人間の明示的な操作なので、下のコマンドを実行してもらう必要がある。
      </p>

      <KeyValueList
        className="mt-3"
        labelWidth="5rem"
        items={[
          { label: 'アカウント', value: auth.account?.id ?? '—', mono: true },
          ...(auth.account?.email !== null && auth.account?.email !== undefined
            ? [{ label: 'メール', value: auth.account.email }]
            : []),
        ]}
      />

      <p className={`mt-3 ${NOTE}`}>接続先のサーバと同じ環境で次を実行する:</p>
      <Input readOnly value={command} className="mt-1.5 font-mono text-xs" />

      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" loading={checking} onClick={recheck}>
          許可されたか確認する
        </Button>
        <Button loading={busy} onClick={logout}>
          別のアカウントでログイン
        </Button>
      </div>
      {checkedAt !== null && !checking && (
        <p role="status" className={`mt-2 ${NOTE}`}>
          まだ許可されていない（{formatTime(checkedAt)} に確認）
        </p>
      )}
      {logoutError !== null && (
        <div role="alert" className="mt-3 break-words text-xs text-destructive">
          サーバ側を失効させられなかった: {logoutError}
          <button type="button" onClick={discard} className="ml-1 underline hover:text-foreground">
            この画面から鍵だけを捨てる
          </button>
        </div>
      )}
    </Shell>
  );
}
