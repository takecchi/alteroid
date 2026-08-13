import { ExternalLink, LogIn } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { ConnectionCard } from '~/components/connection';
import { Badge, Button, Card, ErrorNote, Input, Spinner } from '~/components/ui';
import { useAuth } from '~/hooks/use-auth';
import { useApiContext } from '~/lib/api';
import { readPendingLogin, storePendingLogin } from '~/lib/auth';
import { claimUntilReady, openAuthorization, startLogin, type ClaimOutcome } from '~/lib/login';

export default function Login() {
  const auth = useAuth();

  // 繋がらないなら、ログイン手段の一覧すら引けていない。**「確認中」より先に見る**
  // （応答が無いあいだ `status` は checking のままなので、逆にすると輪が回り続ける）。
  // 直す口をここにも置く — この画面へ直接来た人は設定画面へ行けない。
  if (auth.error !== undefined) {
    return (
      <Shell>
        <h1 className="text-sm font-semibold">デーモンに繋がらない</h1>
        <ErrorNote error={auth.error} className="mt-3" />
        <div className="mt-4">
          <ConnectionCard compact />
        </div>
      </Shell>
    );
  }

  // 認証を要求していないデーモン、あるいは既に通っているなら、ここは用が無い。
  if (auth.status === 'checking') {
    return (
      <Shell>
        <Spinner label="デーモンを確認中" />
      </Shell>
    );
  }
  if (auth.status === 'open' || auth.status === 'ready') {
    return <Navigate to="/" replace />;
  }
  if (auth.status === 'ungranted') {
    return <Ungranted />;
  }
  return <SignIn />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="font-mono text-lg font-semibold tracking-tight">alteroid</p>
          <p className="mt-1 text-xs text-muted">クローンの様子を見て、指示を出し、記憶を直す</p>
        </div>
        <Card className="p-5">{children}</Card>
      </div>
    </div>
  );
}

function SignIn() {
  const auth = useAuth();
  const { client, baseUrl, setCredential } = useApiContext();
  const navigate = useNavigate();

  /**
   * 同じタブごと遷移させられていた場合の引き換え券。
   *
   * **初期値として読む**（effect の中で state に写さない）。写すと「effect の中で
   * 同期的に setState する」形になり、描き直しが1往復無駄に増えるうえ、
   * 進行中かどうかの真偽が2か所に分かれる。
   */
  const [resumed] = useState(() => readPendingLogin());
  const [busy, setBusy] = useState(() => resumed !== null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [manualUrl, setManualUrl] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** 引き取りの結末を画面に反映する。**待ち合わせの後**に呼ばれる。 */
  const applyOutcome = useCallback(
    async (outcome: ClaimOutcome) => {
      if (outcome.status === 'ready') {
        storePendingLogin(null);
        setCredential(outcome.credential);
        await auth.revalidate();
        // 許可が無ければ、この後 `ungranted` の画面に落ちる（ここでは分岐しない）。
        void navigate('/', { replace: true });
      } else if (outcome.status === 'failed') {
        storePendingLogin(null);
        setFailure(new Error(outcome.message));
      }
      setBusy(false);
      setManualUrl(undefined);
      abortRef.current = undefined;
    },
    [auth, navigate, setCredential],
  );

  const fail = useCallback((error: unknown) => {
    setFailure(error);
    setBusy(false);
    abortRef.current = undefined;
  }, []);

  /**
   * 戻ってきたら引き取りを続ける。
   *
   * これは**外部（OAuth の往復）の購読**であって、画面の状態を写す処理ではない。
   * だから state を触るのは待ち合わせが解けた後のコールバックの中だけにする。
   * `busy` は初期値で立ててあるので、ここでは何も同期的に触らない。
   */
  useEffect(() => {
    if (resumed === null) return;
    const controller = new AbortController();
    abortRef.current = controller;
    claimUntilReady(client, resumed, { signal: controller.signal }).then(applyOutcome).catch(fail);
    return () => controller.abort();
  }, [resumed, client, applyOutcome, fail]);

  async function begin(provider: string) {
    setBusy(true);
    setFailure(undefined);
    setManualUrl(undefined);
    try {
      const started = await startLogin(client, provider);
      const popup = openAuthorization(started.authorizationUrl);
      // 塞がれたら黙って失敗させない。人間が自分で開けるようにする。
      if (popup === null) setManualUrl(started.authorizationUrl);

      const controller = new AbortController();
      abortRef.current = controller;
      const outcome = await claimUntilReady(
        client,
        {
          requestId: started.requestId,
          claimSecret: started.claimSecret,
          expiresAt: started.expiresAt,
          provider,
        },
        { signal: controller.signal },
      );
      await applyOutcome(outcome);
    } catch (error) {
      fail(error);
    }
  }

  return (
    <Shell>
      <h1 className="text-sm font-semibold">ログイン</h1>
      <p className="mt-1 text-xs text-muted">
        接続先: <span className="font-mono">{baseUrl}</span>
      </p>

      <ErrorNote error={failure} className="mt-3" />

      {auth.providers.length === 0 ? (
        <div className="mt-4 rounded-md border border-border bg-bg p-3 text-xs leading-relaxed text-muted">
          <p className="mb-1.5 font-medium text-fg">ログイン手段が設定されていない</p>
          <p>
            このデーモンは認証を要求しているが、ログインできるプロバイダが1つも登録されていない。
            デーモン側に <code className="font-mono">ALTEROID_GOOGLE_CLIENT_ID</code> と{' '}
            <code className="font-mono">ALTEROID_GOOGLE_CLIENT_SECRET</code>{' '}
            を設定するか、認証を切る（<code className="font-mono">ALTEROID_AUTH=off</code>）。
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
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Badge tone="accent">待機中</Badge>
          別ウィンドウで認証を終えると、この画面が自動で進む
        </p>
      )}

      {manualUrl !== undefined && (
        <a
          href={manualUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          ポップアップが塞がれた。ここを開いて認証する
        </a>
      )}

      <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted">
        ログインしただけでは使えない。
        <strong className="text-fg">使う許可は人間が CLI から与える</strong>（
        <code className="font-mono">alteroid access grant &lt;id&gt;</code>）。 端末から使うだけなら{' '}
        <code className="font-mono">alteroid login</code> でも同じ。
      </p>
    </Shell>
  );
}

/**
 * ログインは通ったが、使う許可が無い。
 *
 * **ここでログインし直させない。** 何度やっても同じ結果になる。必要なのは人間が
 * CLI で許可を与えることなので、貼り付けられる形でコマンドを出す。
 */
function Ungranted() {
  const auth = useAuth();
  const { logout } = auth;
  const command = `alteroid access grant ${auth.account?.id ?? '<アカウント id>'}`;

  return (
    <Shell>
      <h1 className="text-sm font-semibold">まだ使う許可が無い</h1>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        ログインは通っている。alteroid
        は単一の持ち主のものなので、使えるようにするのは人間の明示的な操作である。
      </p>

      <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-y-1 text-xs">
        <dt className="text-muted">アカウント</dt>
        <dd className="font-mono break-all">{auth.account?.id ?? '—'}</dd>
        {auth.account?.email !== null && auth.account?.email !== undefined && (
          <>
            <dt className="text-muted">メール</dt>
            <dd className="break-all">{auth.account.email}</dd>
          </>
        )}
      </dl>

      <p className="mt-3 text-xs text-muted">デーモンと同じ環境で次を実行する:</p>
      <Input readOnly value={command} className="mt-1.5 font-mono text-xs" />

      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" onClick={() => void auth.revalidate()}>
          許可されたか確認する
        </Button>
        <Button onClick={logout}>別のアカウントでログイン</Button>
      </div>
    </Shell>
  );
}
