import { ExternalLink, LogIn } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { ConnectionCard } from '~/components/connection';
import { LoadError } from '~/components/load-error';
import { useLatest } from '~/lib/use-latest';
import { useLogout } from '~/lib/use-logout';
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
import {
  useAuth,
  useApiContext,
  claimUntilReady,
  openAuthorization,
  startLogin,
  type ClaimOutcome,
} from '@alteroid/swr';
import {
  formatTime,
  readPendingLogin,
  storePendingLogin,
  type PendingLogin,
} from '@alteroid/logic';

/** 小さい補足の文字（この画面で繰り返す class）。 */
const NOTE = 'text-xs text-muted-foreground';

/** 画面の見出し（タブの題と同じ文言）。 */
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

  /**
   * 繋がらない（確認が失敗した）。**結果が1度も無い（`checking`）ときだけ**、画面をエラーに差し替える
   * （ログイン手段の一覧すら引けていない。応答が無いあいだ `status` は checking のままなので、
   * **「確認中」より先に見る**。逆にすると輪が回り続ける）。直す口をここにも置く — この画面へ
   * 直接来た人は設定画面へ行けない。
   *
   * **結果が既に在る（`checking` でない）ときは差し替えない**（#3379）。`useAuth` は SWR なので、
   * 窓へ戻るたびの再検証が失敗しても前回の `status` を持ったまま `error` が立つ。ここで画面を
   * 差し替えると、待機中の `SignIn` が unmount されて待っていた取り込みが止まり、「許可されたか
   * 確認する」の失敗ではアカウント id と実行するコマンドが消える。前回の画面を残し、再試行つきの
   * 失敗の帯を上に足す（`shell.tsx` の `recheckFailing` と同じ考え方）。
   */
  const recheckError = auth.status === 'checking' ? undefined : auth.error;
  const notice = (
    <LoadError
      what="接続先のサーバの状態"
      error={recheckError}
      onRetry={() => auth.revalidate()}
      retrying={auth.isValidating}
      className="mb-4"
    />
  );

  if (auth.error !== undefined && auth.status === 'checking') {
    return (
      <Shell>
        <Heading>接続先のサーバに繋がらない</Heading>
        <LoadError
          what="接続先のサーバの状態"
          error={auth.error}
          onRetry={() => auth.revalidate()}
          retrying={auth.isValidating}
          className="mt-3"
        />
      </Shell>
    );
  }

  // 認証を要求していないデーモン、あるいは既に通っているなら、ここは用が無い。
  if (auth.status === 'checking') {
    return (
      <Shell>
        <Spinner label="接続先のサーバを確認中" />
      </Shell>
    );
  }
  if (auth.status === 'open' || auth.status === 'ready') {
    return <Navigate to="/" replace />;
  }
  if (auth.status === 'ungranted') {
    return <Ungranted notice={notice} />;
  }
  return <SignIn notice={notice} />;
}

/**
 * ログイン画面のどの分岐からでも接続先を変えられるようにする。
 *
 * **かつては `auth.error !== undefined` のときだけ `ConnectionCard` を出していた。**
 * これだと「デーモンが応答しているが認証を要求している」場合（= 大半の詰まり方）に
 * 直す手段が出ない——応答はしているので `auth.error` は undefined のままだが、
 * 繋いでいる先が「入りたいデーモン」ではないことがある（例: 開発用と本番用を
 * 両方動かしていて、既定の `/api` が開発用を向いたまま本番へ繋ぎたい）。
 *
 * ここに1箇所だけ置き、全分岐（`SignIn` / `Ungranted` / `checking` / エラー）が
 * 同じものを得る。**エラー分岐はこれまで直に `ConnectionCard` を出していたが、
 * ここへ一本化したので削除した**（二重に出さないため）。
 */
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

  /** 引き取りを待って結末を反映する。**やめた（中断した）後に届いた結果は反映しない。** */
  const settle = useCallback(
    (pending: PendingLogin, controller: AbortController) =>
      claimUntilReady(client, pending, { signal: controller.signal })
        .then((outcome) => (controller.signal.aborted ? undefined : applyOutcome(outcome)))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) fail(error);
        }),
    [client, applyOutcome, fail],
  );

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
    void settle(resumed, controller);
    return () => controller.abort();
  }, [resumed, settle]);

  /**
   * 待ちをやめる。中断し、待ちの記録も消して、ボタンを押せる状態へ戻す
   * （読み直しで再開した待ちも同じ）。
   */
  function cancel() {
    abortRef.current?.abort();
    abortRef.current = undefined;
    storePendingLogin(null);
    setBusy(false);
    setManualUrl(undefined);
  }

  async function begin(provider: string) {
    setBusy(true);
    setFailure(undefined);
    setManualUrl(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const started = await startLogin(client, provider);
      if (controller.signal.aborted) {
        // 始める要求の最中にやめた。`startLogin` が控えた記録を残さない。
        storePendingLogin(null);
        return;
      }
      const popup = openAuthorization(started.authorizationUrl);
      // 塞がれたら黙って失敗させない。人間が自分で開けるようにする。
      if (popup === null) setManualUrl(started.authorizationUrl);

      await settle({ ...started, provider }, controller);
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    }
  }

  return (
    <Shell>
      {notice}
      <Heading>ログイン</Heading>
      <p className={`mt-1 ${NOTE}`}>
        接続先: <span className="font-mono">{baseUrl}</span>
      </p>

      <ErrorNote error={failure} className="mt-3" />

      {auth.providers.length === 0 ? (
        <div className="mt-4 rounded-md border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
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

/**
 * ログインは通ったが、使う許可が無い。
 *
 * **ここでログインし直させない。** 何度やっても同じ結果になる。必要なのは人間が
 * CLI で許可を与えることなので、貼り付けられる形でコマンドを出す。
 */
function Ungranted({ notice }: { notice: React.ReactNode }) {
  const auth = useAuth();
  /**
   * **ここでも `auth.logout()`（サーバ側の失効）を使う（issue #1757）。**
   * 許可待ちのトークンを鍵だけ捨てて離れると、サーバ側では生きたまま残り、
   * **後から `access grant` された瞬間に使える鍵として生き返る。**
   * `/auth/logout` は許可の無いアカウントも通す（`app.ts` の `authenticate`
   * の該当箇所）。失敗したら、ほかの画面と同じく鍵だけを捨てる操作を残す。
   */
  const { busy, error: logoutError, logout, discard } = useLogout();
  /**
   * 「許可されたか確認する」。**確かめている間は読み込み中にし、確かめた結果まだ許可が無ければ
   * そう言う**（#3738。何も変わらないと、押せたのかどうかが分からない）。許可が下りていれば
   * 画面ごと差し替わる。確認そのものが失敗したときは `notice` が出るので、「まだ許可されていない」
   * とは言わない（失敗を結果のように見せない）。
   */
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  // 失敗しても `revalidate()` は前回の値で解決するので、失敗の有無は描き直し後の `error` で見る。
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
      {/*
          **「単一の持ち主のもの」と書かないこと。** 2026-09-09 のオーナー決定で
          許可できるアカウントの数に上限が無くなったので、その文言は嘘になる。
          変わっていないのは「使えるようにするのは人間の明示的な操作である」の
          ほうで、下のコマンドがその操作そのものである。
        */}
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        ログインは通っている。使えるようにするのは人間の明示的な操作なので、下のコマンドを実行してもらう必要がある。
      </p>

      {/*
          **`sm:`（640px）未満は1列に積む。** 理由と、組の境目（先頭以外の名前に上の
          余白）の意味は `KeyValueList` の doc と、`manager-detail.tsx` の同型の
          一覧に書いたコメントと同じ（ここは5remで4つの中でいちばん狭いので、なおのこと
          余裕がある）。外側の `mt-3` は上の段落からの間隔で、`KeyValueList` が
          名前に足す組の境目とは別の役目である（混同しないこと）。
        */}
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
