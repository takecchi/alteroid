import { useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useHealth, useRunners } from '~/hooks/queries';
import { useApiContext } from '~/lib/api';
import { SAME_ORIGIN_BASE_URL } from '~/lib/config';

export default function Settings() {
  return (
    <Page title="設定" description="この画面がどのデーモンを見ているか">
      <div className="flex flex-col gap-4">
        <Connection />
        <Runners />
      </div>
    </Page>
  );
}

function Connection() {
  const { baseUrl, setBaseUrl } = useApiContext();
  const health = useHealth();
  const [draft, setDraft] = useState(baseUrl);

  const dirty = draft.trim().replace(/\/+$/, '') !== baseUrl;

  return (
    <Card>
      <CardHeader
        title="接続先"
        subtitle="ビルドし直さずに向き先を変えられる（同じ成果物をどの配置でも使うため）"
        action={
          health.error !== undefined ? (
            <Badge tone="danger">繋がらない</Badge>
          ) : health.data === undefined ? (
            <Badge tone="warn">確認中</Badge>
          ) : (
            <Badge tone="ok">応答あり</Badge>
          )
        }
      />

      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex gap-2">
          <Input
            value={draft}
            spellCheck={false}
            placeholder={SAME_ORIGIN_BASE_URL}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && dirty) setBaseUrl(draft);
            }}
          />
          <Button variant="primary" disabled={!dirty} onClick={() => setBaseUrl(draft)}>
            適用
          </Button>
          <Button
            onClick={() => {
              setBaseUrl(null);
              setDraft(SAME_ORIGIN_BASE_URL);
            }}
          >
            既定に戻す
          </Button>
        </div>

        <ErrorNote error={health.error} />

        {health.data !== undefined && (
          <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
            <dt className="text-muted">記憶</dt>
            <dd className="font-mono text-xs">{health.data.storage}</dd>
            <dt className="text-muted">pid</dt>
            <dd className="font-mono text-xs">{health.data.pid}</dd>
          </dl>
        )}

        {/*
          ここは「ドメインが違うときどうするか」の答えを画面の中に置いている。
          設定を触るのは大抵それで詰まったときなので、別の文書へ飛ばさない。
        */}
        <div className="rounded-md border border-border bg-bg p-3 text-xs leading-relaxed text-muted">
          <p className="mb-1.5 font-medium text-fg">別のオリジンのデーモンに繋ぐとき</p>
          <p className="mb-1.5">
            既定の <code className="font-mono">{SAME_ORIGIN_BASE_URL}</code>{' '}
            は同一オリジン向け（開発サーバの proxy と、画面の手前に置いたリバースプロキシが
            これで当たる）。<code className="font-mono">https://api.example.com</code>{' '}
            のように別オリジンを指す場合は、デーモン側でそのオリジンを明示的に許可する必要がある。
          </p>
          <pre className="rounded border border-border bg-surface p-2">
            ALTEROID_ALLOWED_ORIGINS=https://www.example.com
          </pre>
          <p className="mt-1.5">
            許可は<strong className="text-fg">列挙したオリジンだけ</strong>で、ワイルドカードは
            受け付けない。資格情報は Cookie ではなくヘッダで運ぶ設計なので、
            別の登録可能ドメイン（例: <code className="font-mono">*.vercel.app</code>）に画面を
            置いても成立する。
          </p>
          <p className="mt-1.5">
            デーモン自体には認証が無い。外から届く場所に置くなら、手前に境界
            （リバースプロキシ・トンネル・認証）を必ず置くこと。
          </p>
        </div>
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
