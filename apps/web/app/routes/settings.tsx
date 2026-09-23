// **版の言い方は core の1本を通す**（`@alteroid/core/revision`）。ここに文言を
// 書き写すと、状態が増えたときに画面だけが古くなる——とくに `unknown`（器が自分の
// 版を知らない）と `unheard`（名乗りをまだ聞けていない）の区別が画面で消えると、
// 人間は疑う先を取り違える。**ブラウザが読めるのは subpath の側だけである**
// （`revision.ts` は焼き込んだ正典と zod を読むので初期チャンクへ入れられない）。
import { describeRevisionStatus } from '@alteroid/core/revision';
import { Fragment, useRef, useState } from 'react';

import { ConnectionCard } from '~/components/connection';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useRunners } from '~/hooks/queries';
import { formatDateTime } from '~/lib/format';
import { useAuth } from '~/hooks/use-auth';
import {
  useResetWorkspace,
  useShutdownDaemon,
  type WorkspaceResetSummary,
} from '~/hooks/mutations';
import type { RunnerPushOutcome, RunnerSummary } from '~/lib/types';

export default function Settings() {
  return (
    <Page title="設定" description="この画面がどのデーモンを見ているか">
      <div className="flex flex-col gap-4">
        <ConnectionCard />
        <Account />
        <Runners />
        <ShutdownDaemon />
        <ResetWorkspace />
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

/**
 * 押し込み（push）の直近結果。**指紋（`Credentials`）とは別物。**
 *
 * 指紋は runner へ聞き直した「いま何が乗っているか」だが、こちらはデーモンが
 * 最後に送ろうとして何が起きたかの記憶で、新たな往復は発生しない
 * （`packages/core/src/manager.ts` の `RunnerOverview.pushHealth` の doc）。
 *
 * **`pushHealth` 自体が無ければ何も描かない**（一度も押し込みを試みていない
 * ＝AGENTS.md「取れない軸に0の行を作らない」）。3種類（プロファイル・環境変数・
 * 認証トークン）は独立の軸なので、1つでも失敗していれば個別に赤く出す
 * ——1つの成否へ畳まない。
 */
function PushHealth({ runner }: { runner: RunnerSummary }) {
  const { pushHealth } = runner;
  if (pushHealth === undefined) return null;

  const items: [string, RunnerPushOutcome | undefined][] = [
    ['プロファイル', pushHealth.profile],
    ['環境変数', pushHealth.credentials],
    ['認証トークン', pushHealth.agentToken],
  ];
  const attempted = items.filter(
    (item): item is [string, RunnerPushOutcome] => item[1] !== undefined,
  );
  if (attempted.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1">
      {attempted.map(([label, outcome]) => (
        <div key={label} className="flex flex-wrap items-center gap-1.5">
          <Badge tone={outcome.status === 'ok' ? 'ok' : 'danger'}>
            {label}: {outcome.status === 'ok' ? '押し込み済み' : '押し込み失敗'}（
            {formatDateTime(outcome.at)}）
          </Badge>
          {outcome.status === 'failed' && outcome.error !== undefined ? (
            <span className="text-[11px] break-words text-danger">{outcome.error}</span>
          ) : null}
        </div>
      ))}
    </div>
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
              <PushHealth runner={runner} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** ラベルは表示用の日本語、キーは `WorkspaceResetSummary` の実欄。 */
const RESET_SUMMARY_LABELS: [keyof WorkspaceResetSummary, string][] = [
  ['memory', '記憶'],
  ['journal', '日誌'],
  ['jobs', 'ジョブ'],
  ['approvals', '承認待ち'],
  ['schedules', '継続中の依頼'],
  ['schedulePhases', '既定の仕込みの位相'],
  ['inbox', '受信箱'],
  ['commitments', '引き受けたまま終わっていない仕事'],
  ['practices', '仕事のやり方'],
  ['archive', 'アーカイブ'],
  ['sessions', 'セッション登録簿'],
  ['profile', '実行環境プロファイル'],
  ['usageDaily', '利用状況（日次）'],
  ['usageBaseline', '利用状況（基準）'],
  ['usageLedger', '利用状況（台帳の開始時刻）'],
  ['usageTurns', '利用状況（回数）'],
  ['sessionLog', 'SDK セッション生ログ'],
];

function ResetSummaryView({ cleared }: { cleared: WorkspaceResetSummary }) {
  return (
    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
      {RESET_SUMMARY_LABELS.map(([key, label]) => {
        const value = cleared[key];
        // `sessionLog` は pg 構成でだけ付く（`WorkspaceResetSummary` の doc）。
        if (value === undefined) return null;
        return (
          <Fragment key={key}>
            <dt className="text-muted">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/**
 * デーモンを止める（`POST /shutdown`。CLI の `alteroid daemon stop` と同じ受け口。
 * issue #1124 の (A) —「CLI にしか無い口を Web UI にも」）。
 *
 * **資格は `authenticate` だけ**（`requireOperator` は要求しない。issue #1124
 * の (B) がその強さを「意図」として確定させている——`apps/daemon/src/app.ts`
 * の `/shutdown` の doc）。ボタンを隠す理由は無い。
 *
 * **確認は `ResetWorkspace` と同じ「`<dialog>` に文字を打たせる」形にする。**
 * ただし打つ語は別にする（`stop`）——`reset`（ワークスペース全消去の確認語）と
 * 取り違えると、押し間違いの結果が逆方向に重くなる（`reset` は戻らないが、
 * こちらは起動し直せば戻る）。
 *
 * **`POST /reset` とは軸が違う。** 止めても記憶・日誌・台帳は1行も消えない。
 * 起動し直せば元の状態に戻る。**Railway では、止めるとその場の再起動方針
 * （`railway/daemon.json` の `restartPolicyType: "ALWAYS"`）によって自動的に
 * 再起動として働く**——止めたままにはならない。この画面はどの配置からでも
 * 開けるので、再起動しない配置（ローカル常駐など）では止まったままになり
 * うることも文言で断る。
 *
 * **押した後は最小限の表示にする**（`ResetWorkspace` の後の表示と同じ方針）。
 * デーモンが止まるのでこの画面自身の接続も切れる——引き直しても意味のある
 * 応答が返らないため、`ResetSummaryView` のような内訳は持たない。
 */
function ShutdownDaemon() {
  const shutdownDaemon = useShutdownDaemon();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [done, setDone] = useState(false);

  const canConfirm = confirmText.trim().toLowerCase() === 'stop';

  function openDialog() {
    setConfirmText('');
    setFailure(undefined);
    setDone(false);
    dialogRef.current?.showModal();
  }

  async function runShutdown() {
    if (!canConfirm) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await shutdownDaemon();
      setDone(true);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="デーモンを止める"
        subtitle="起動し直せば元に戻る。記憶・日誌・台帳は消さない"
      />
      <div className="px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed text-muted">
          <code className="font-mono">alteroid daemon stop</code> と同じ操作。止めても、
          <strong className="text-fg">記憶も台帳も消さない</strong>
          （日誌も含めて1行も消えない）。起動し直せば元に戻る——
          <code className="font-mono">POST /reset</code>（記憶そのものを消す操作）とは違う。 Railway
          では、止めると再起動の方針により
          <strong className="text-fg">再起動として働く</strong>
          （止まったままにはならない）。止めた瞬間、この画面自身の接続も切れる。
        </p>
        <div className="mt-3">
          <Button variant="danger" size="sm" onClick={openDialog}>
            デーモンを止める
          </Button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-surface p-0 text-fg backdrop:bg-black/50"
      >
        <div className="p-4">
          <h2 className="text-sm font-semibold">本当に止めますか？</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            デーモンを止めます。<strong className="text-fg">記憶も台帳も消えません</strong>
            （日誌も含めて1行も消えません）。起動し直せば元の状態に戻ります。Railway では
            止めると再起動の方針により
            <strong className="text-fg">再起動として働きます</strong>
            （止まったままにはなりません）。止めた直後、この画面の接続も切れます。
          </p>

          {!done ? (
            <>
              <label className="mt-3 block text-xs text-muted">
                続けるなら <code className="rounded bg-surface-2 px-1 font-mono">stop</code> と入力
                <Input
                  autoFocus
                  className="mt-1"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder="stop"
                />
              </label>
              <ErrorNote error={failure} className="mt-3" />
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" disabled={busy} onClick={() => dialogRef.current?.close()}>
                  やめる
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!canConfirm}
                  loading={busy}
                  onClick={() => void runShutdown()}
                >
                  止める
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-xs font-medium text-ok">
                止めました。この画面との接続は切れます。
              </p>
              <div className="mt-4 flex justify-end">
                <Button variant="primary" size="sm" onClick={() => dialogRef.current?.close()}>
                  閉じる
                </Button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </Card>
  );
}

/**
 * ワークスペースのリセット（「トークン情報以外を全部消す」）。
 *
 * **由来**: 本番（Railway）の Postgres に対して人間の依頼で1度、手作業の
 * `TRUNCATE` を行った（2026-09-14）。ここはその「同条件」を画面からも
 * 起こせるようにしたもの。何を残し何を消すかは `useResetWorkspace`
 * （`@alteroid/core` の `resetWorkspaceState` が正本）の doc を見ること。
 *
 * **確認は `<dialog>`（ブラウザ組み込みのモーダル）で行う。** この画面には
 * 他に確認ダイアログを持つ操作が無い（`memory-detail.tsx` の削除は確認なしで
 * 即実行する）——ここだけ確認を挟むのは、対象がワークスペース全体で取り消せ
 * ないという重さの違いによる。**`reset` という語を打たせる**（`y` 1文字の
 * 誤打で通らないようにするため。CLI の `resetCommand` の確認と同じ判断）。
 *
 * **ボタンは常に出す。** 宣言済み owner（`requireOwner`。issue #1198）でなければ
 * `POST /reset` が 403 を返すが、隠さない——隠すと「なぜ押せないか」が消える
 * （`hooks/mutations.ts` の `useRemoveSchedule` の doc と同じ判断）。
 *
 * **⚠️ 2026-09-17 まで、ここは押すと必ず 403 だった**（issue #1195。`env-vars.tsx`
 * と同じ機序）。**2026-09-17〜18 の間は近似（`grantedBy === 'operator'`）で
 * 通していたが、いまは `ownerDeclaredAt` の宣言（issue #1198。`routes/access.tsx`
 * から行う）へ置き換えてある。**
 */
function ResetWorkspace() {
  const resetWorkspace = useResetWorkspace();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [cleared, setCleared] = useState<WorkspaceResetSummary | null>(null);

  const canConfirm = confirmText.trim().toLowerCase() === 'reset';

  function openDialog() {
    setConfirmText('');
    setFailure(undefined);
    setCleared(null);
    dialogRef.current?.showModal();
  }

  async function runReset() {
    if (!canConfirm) return;
    setBusy(true);
    setFailure(undefined);
    try {
      setCleared(await resetWorkspace());
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="ワークスペースのリセット"
        subtitle="トークン情報以外を全部消す。取り消せない"
      />
      <div className="px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed text-muted">
          記憶・日誌・ジョブ・承認待ち・継続中の依頼・受信箱・引き受けたまま終わって
          いない仕事・アーカイブ・セッション・実行環境プロファイル・利用状況の台帳を 全部消す。
          <strong className="text-fg">
            認証トークンのプール・マネージャーへ 降ろす環境変数・このログインアカウントは消さない。
          </strong>
        </p>
        <div className="mt-3">
          <Button variant="danger" size="sm" onClick={openDialog}>
            リセットする
          </Button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-surface p-0 text-fg backdrop:bg-black/50"
      >
        <div className="p-4">
          <h2 className="text-sm font-semibold">本当に削除しますか？</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            記憶・日誌・ジョブ・承認待ち・継続中の依頼・受信箱・引き受けたまま終わって
            いない仕事・アーカイブ・セッション・実行環境プロファイル・利用状況の台帳を
            全部消します。認証トークンのプール・マネージャーへ降ろす環境変数・この
            ログインアカウントは消しません。<strong className="text-fg">取り消せません。</strong>
          </p>

          {cleared === null ? (
            <>
              <label className="mt-3 block text-xs text-muted">
                続けるなら <code className="rounded bg-surface-2 px-1 font-mono">reset</code> と入力
                <Input
                  autoFocus
                  className="mt-1"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder="reset"
                />
              </label>
              <ErrorNote error={failure} className="mt-3" />
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" disabled={busy} onClick={() => dialogRef.current?.close()}>
                  やめる
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!canConfirm}
                  loading={busy}
                  onClick={() => void runReset()}
                >
                  本当に削除する
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-xs font-medium text-ok">リセットしました。</p>
              <ResetSummaryView cleared={cleared} />
              <div className="mt-4 flex justify-end">
                <Button variant="primary" size="sm" onClick={() => dialogRef.current?.close()}>
                  閉じる
                </Button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </Card>
  );
}
