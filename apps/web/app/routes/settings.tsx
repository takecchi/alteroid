// **版の言い方は core の1本を通す**（`@alteroid/core/revision`）。ここに文言を
// 書き写すと、状態が増えたときに画面だけが古くなる——とくに `unknown`（器が自分の
// 版を知らない）と `unheard`（名乗りをまだ聞けていない）の区別が画面で消えると、
// 人間は疑う先を取り違える。**ブラウザが読めるのは subpath の側だけである**
// （`revision.ts` は焼き込んだ正典と zod を読むので初期チャンクへ入れられない）。
import { describeRevisionStatus } from '@alteroid/core/revision';

import { ConnectionCard } from '~/components/connection';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useRunners } from '~/hooks/queries';
import { formatDateTime } from '~/lib/format';
import { useAuth } from '~/hooks/use-auth';
import type { RunnerSummary } from '~/lib/types';

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
            {/*
              **`sm:`（640px）未満は1列に積む。** 理由・`dt` の `mt-3 first:mt-0`
              の意味は `manager-detail.tsx` の同型の `dl` に書いたコメントと同じ
              （ここは6remなのでなお余裕がある）。
            */}
            <dl className="grid grid-cols-1 gap-y-1 sm:grid-cols-[6rem_1fr]">
              <dt className="mt-3 text-muted first:mt-0 sm:mt-0">アカウント</dt>
              <dd className="font-mono text-xs break-all">{auth.account?.id ?? '—'}</dd>
              {auth.account?.email !== null && auth.account?.email !== undefined && (
                <>
                  <dt className="mt-3 text-muted first:mt-0 sm:mt-0">メール</dt>
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
  // 意図して空けている最中（drain。#485 PR-1）。**`lost` と違って黙ったのでは
  // ない** — 空けると決めた結果なので `warn` に留める（`danger` にすると
  // 「落ちた」と誤読される）。この値を立てる口はまだ無い（PR-2）ので、いまは
  // 表示だけが先に存在する。
  vacating: { label: '空けている最中', tone: 'warn' },
} as const;

/**
 * 渡している鍵の指紋。
 *
 * **「無い」と言ってよいのは、聞けたときだけである。**
 *
 * ここは `credentials.length === 0` だけを見て「渡している鍵は無い」と断定して
 * いた。だが空になるのは3つの場合がある——**繋がっていないので聞いていない**
 * （`unheard`）／**聞いたが失敗した**（`failed`）／**聞いて0件だった**
 * （`asked`）。前の2つで「無い」と書くと、**確かめられなかったことが、確かめた
 * 結果として人間に届く。**
 *
 * デーモン側（`GET /runners` の `credentialsProbe`）が3状態を返すようにした
 * ので、ここで潰し直さない。**潰す場所が1つ奥へ移るだけになる。**
 */
function Credentials({ runner }: { runner: RunnerSummary }) {
  if (runner.credentialsProbe.status === 'unheard') {
    return (
      <span className="text-[11px] text-muted">
        鍵は確かめていない（繋がっていないので聞いていない）
      </span>
    );
  }
  if (runner.credentialsProbe.status === 'failed') {
    return (
      <span className="text-[11px] break-words text-danger">
        鍵を確かめられなかった: {runner.credentialsProbe.error}
      </span>
    );
  }
  if (runner.credentials.length === 0) {
    return <span className="text-[11px] text-muted">渡している鍵は無い</span>;
  }
  return (
    <>
      {runner.credentials.map((credential) => (
        // `credential.name` は `CREDENTIAL_NAME`（packages/core/src/credentials.ts）
        // ＝ `/^[A-Z][A-Z0-9_]*$/` で長さの上限が無く、空白も含まない。既定の折り返し
        // （空白でしか折れない）では1文字も折れないので、slug と同じ形として break-all
        // を当てる（本3 で `Badge` に付いた `shrink-0` は縮まない側なので、
        // 折り返しが無いままだと横へ伸びる）。
        <Badge key={credential.name} className="break-all">
          {credential.name}
        </Badge>
      ))}
    </>
  );
}

function Runners() {
  const { data, error, isLoading } = useRunners();
  const runners = data?.runners ?? [];
  const daemonRevision = data?.daemonRevision;

  return (
    <Card>
      <CardHeader
        title="runner"
        subtitle="マネージャーが実際に走る器。鍵は指紋だけが見える（値は返らない）"
      />
      <ErrorNote error={error} className="m-4" />
      {/*
       * **デーモン自身の版を、runner の版と同じカードに並べる。** 別の場所に出すと
       * 人間が手で突き合わせることになり、突き合わせ忘れがそのまま見逃しになる。
       * デーモンと runner は別々にデプロイされるので、同じ main から起こしていても
       * 別のコミットで走る窓が実際に在る。
       *
       * **runner が0台でも出す。** 0台は「まだ配線されていない」状態、つまり版を
       * 確かめたい状態そのものなので、ここで落とすとその状態でだけ答えが消える。
       */}
      {daemonRevision === undefined ? null : (
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-sm">デーモン</p>
            <Badge tone="accent">この画面が見ているプロセス</Badge>
          </div>
          <p className="mt-0.5 font-mono text-[11px] break-all text-muted">
            版: {describeRevisionStatus(daemonRevision)}
          </p>
        </div>
      )}
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
                <p className="font-mono text-sm break-all">{runner.runnerId ?? runner.label}</p>
                <Badge tone={RUNNER_STATES[runner.state].tone}>
                  {RUNNER_STATES[runner.state].label}
                </Badge>
              </div>
              {runner.runnerId === undefined ? null : (
                <p className="mt-0.5 font-mono text-[11px] break-all text-muted">{runner.label}</p>
              )}
              <p className="mt-0.5 font-mono text-[11px] break-all text-muted">
                {runner.workspacePath}
              </p>
              {/*
                いまその宛先に応えているプロセス。**`runnerId` は器を作り直しても同じ**
                なので、名前だけでは「さっき仕事を渡した相手と同じか」が分からない。
                入れ替わっていれば、そこで走っていた委譲は失われている可能性がある。

                **名乗らないことを黙らせない。** 出さないと、人間からは
                「入れ替わっていない」と「判定できない」が同じに見える（クローンは
                `runner_list` で同じものを見ている。片方だけが見える形を作らない）。
              */}
              <p className="mt-0.5 font-mono text-[11px] break-words text-muted">
                {runner.instanceId === undefined
                  ? 'プロセス: 名乗っていない（入れ替わりを判定できない）'
                  : `プロセス: ${runner.instanceId}${
                      runner.instanceSince === undefined
                        ? ''
                        : `（${formatDateTime(runner.instanceSince)} から）`
                    }`}
              </p>
              {/*
                **版は「どのプロセスか」の隣に置く。** この2つは別の問いに答える —
                `instanceId` は「さっき仕事を渡した相手と同じプロセスか」、版は
                「そのプロセスがどのコミットのコードで走っているか」である。器を
                作り直さずにデプロイし直せば `instanceId` は変わって版も変わり、
                器だけ再起動すれば `instanceId` だけが変わる。**並べて置かないと、
                人間はどちらか片方でもう片方を推測する。**

                そして `known` は「最後に聞けた名乗り」であって「いま走っている版」
                ではないので、state から離すと落ちた器の古い値が現役の版として読まれる。
              */}
              <p className="mt-0.5 font-mono text-[11px] break-all text-muted">
                版: {describeRevisionStatus(runner.revision)}
              </p>
              {runner.error === undefined ? null : (
                <p className="mt-1 text-[11px] break-words text-danger">{runner.error}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Credentials runner={runner} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
