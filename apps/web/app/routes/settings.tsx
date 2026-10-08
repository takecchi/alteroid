// 版の文言を書き写さず core の revision を通す: 状態が増えたとき画面だけが古くなり、unknown と unheard の区別が消えると人間は疑う先を取り違えるため
// 読むのは subpath の側だけにする: revision.ts は焼き込んだ正典と zod を読むので初期チャンクへ入れられないため
import { SettingsTabs } from '~/components/group-tabs';
import { settingsDocumentTitle } from '~/lib/nav';
import { useLogout } from '~/lib/use-logout';
import { describeRevisionStatus } from '@alteroid/core/revision';
import { Fragment, useRef, useState } from 'react';

import { ConnectionCard } from '~/components/connection';
import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  Spinner,
  StatusBadge,
  KeyValueList,
} from '@alteroid/ui';
import {
  useRunners,
  useAuth,
  useReopenCloneSession,
  useResetWorkspace,
  useShutdownDaemon,
  useVacateRunner,
  type ReopenCloneSessionResult,
  type WorkspaceResetSummary,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { RunnerPushOutcome, RunnerSummary } from '@alteroid/logic';

const SMALL_NOTE = 'text-[11px] text-muted-foreground';

export default function Settings() {
  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/settings')}
      title="設定"
      description="この画面がどのサーバを見ているか"
    >
      <div className="flex flex-col gap-4">
        <ConnectionCard />
        <Account />
        <Runners />
        <ShutdownDaemon />
        <ReopenCloneSession />
        <ResetWorkspace />
      </div>
    </Page>
  );
}

function Account() {
  const auth = useAuth();
  const { busy, error: logoutError, logout, discard } = useLogout();

  return (
    <Card>
      <CardHeader
        title="ログイン"
        subtitle="この画面がサーバに対して何者か"
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
          <p className="text-xs leading-relaxed text-muted-foreground">
            接続先のサーバは認証を要求していない（ログインの設定が無いか、認証を切っている）。
            守りは待ち受け先（既定は 127.0.0.1）と、手前に置いた境界の側にある。
          </p>
        ) : (
          <>
            <KeyValueList
              labelWidth="6rem"
              items={[
                { label: 'アカウント', value: auth.account?.id ?? '—', mono: true },
                ...(auth.account?.email !== null && auth.account?.email !== undefined
                  ? [{ label: 'メール', value: auth.account.email }]
                  : []),
              ]}
            />
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" loading={busy} onClick={logout}>
                ログアウト
              </Button>
              <span className={SMALL_NOTE}>
                サーバ側のログイン用の鍵も無効にする。アカウントごと締め出すなら「アクセス許可」の画面で取り消す。
              </span>
            </div>
            {logoutError !== null && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
                <span className="break-words">サーバ側を失効させられなかった: {logoutError}</span>
                <button
                  type="button"
                  onClick={discard}
                  className="shrink-0 underline hover:text-foreground"
                >
                  この画面から鍵だけを捨てる
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// 繋がっていないことを隠さない: 上がってこない runner が一覧から消えるだけだと、「設定し忘れた」のか「上がってこない」のかが区別できないため
const RUNNER_STATES = {
  connecting: { label: '接続中', tone: 'neutral' },
  connected: { label: '接続済み', tone: 'ok' },
  unreachable: { label: '繋がらない（つなぎ直しを試している）', tone: 'warn' },
  unusable: { label: '使えない（つなぎ直しは試さない）', tone: 'danger' },
  // 「まだ繋がらない」とは別に見せる: 一度は繋がったのに名乗らなくなった器は、走っていた仕事ごと黙った可能性があるため
  lost: { label: '応答しない（止まった可能性）', tone: 'danger' },
  // warn に留める: 空けると決めた結果で lost と違って黙ったのではなく、danger にすると「落ちた」と誤読されるため
  vacating: { label: '仕事を他へ移している最中', tone: 'warn' },
} as const;

// 知らない state にも倒れ先を持つ: 無いと RUNNER_STATES[state] が undefined になり、render 中に throw して /settings 画面ごと落ちるため
// Object.hasOwn で引く: RUNNER_STATES['constructor'] のような継承したキーは undefined にならず別の形で壊れるため
function RunnerStateBadge({ state }: { state: RunnerSummary['state'] }) {
  return <StatusBadge status={state} map={RUNNER_STATES} />;
}

// 「無い」と言ってよいのは聞けたときだけ: 聞いていない・聞いたが失敗した、で「無い」と書くと確かめられなかったことが確かめた結果として人間に届くため
// 3状態を潰し直さない: 潰す場所が1つ奥へ移るだけになるため
function Credentials({ runner }: { runner: RunnerSummary }) {
  if (runner.credentialsProbe.status === 'unheard') {
    return (
      <span className={SMALL_NOTE}>
        渡している鍵は確かめていない（繋がっていないので聞いていない）
      </span>
    );
  }
  if (runner.credentialsProbe.status === 'failed') {
    return (
      <span className="text-[11px] break-words text-destructive">
        渡している鍵を確かめられなかった: {runner.credentialsProbe.error}
      </span>
    );
  }
  if (runner.credentials.length === 0) {
    return <span className={SMALL_NOTE}>渡している鍵は無い</span>;
  }
  return (
    <>
      {runner.credentials.map((credential) => (
        // break-all を当てる: credential.name は長さの上限が無く空白も含まず、既定の折り返しでは1文字も折れずに横へ伸びるため
        <Badge key={credential.name} className="break-all">
          {credential.name}
        </Badge>
      ))}
    </>
  );
}

// pushHealth 自体が無ければ何も描かない: 一度も押し込みを試みていないものに0の行を作らないため
// 1つの成否へ畳まない: 4種類は独立の軸で、1つでも失敗していれば個別に赤く出すため
function PushHealth({ runner }: { runner: RunnerSummary }) {
  const { pushHealth } = runner;
  if (pushHealth === undefined) return null;

  const items: [string, RunnerPushOutcome | undefined][] = [
    ['プロファイル', pushHealth.profile],
    ['環境変数', pushHealth.credentials],
    ['認証トークン', pushHealth.agentToken],
    ['MCP の登録', pushHealth.mcpServers],
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
            {label}: {outcome.status === 'ok' ? '反映済み' : '反映に失敗'}（
            {formatDateTime(outcome.at)}）
          </Badge>
          {outcome.status === 'failed' && outcome.error !== undefined ? (
            <span className="text-[11px] break-words text-destructive">{outcome.error}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// 開閉のどちらも名乗らない器は何も描かない: 理由を送らない旧い版の runner の見え方を変えないため
// unknown を「頼めない」と描かない: 名乗らない旧い runner は頼めるかどうか判定できないため
// 閉じている peer は理由を描く: ログイン済みなのに開いていない器の理由を見せるため（#4118）
function ManagerPeers({ runner }: { runner: RunnerSummary }) {
  const view = runner.managerPeers;
  if (view === undefined) return null;
  if (view.status === 'unknown') {
    return (
      <p className={`mt-0.5 ${SMALL_NOTE}`}>
        Codex などに作業を頼めるか:
        不明（この実行環境は名乗らない旧い版か、名乗りをまだ受けていない）
      </p>
    );
  }
  const closed = view.closed ?? [];
  if (view.peers.length === 0 && closed.length === 0) return null;
  return (
    <>
      {view.peers.length === 0 ? null : (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {view.peers.map((peer) => (
            <Badge key={peer.provider} tone="accent" className="break-all">
              {peer.provider === 'codex' ? 'Codex' : peer.provider} に作業を頼める
              {peer.models === undefined || peer.models.length === 0
                ? ''
                : `（モデル: ${peer.models.join(', ')}）`}
            </Badge>
          ))}
        </div>
      )}
      {closed.map((entry) => (
        <p key={entry.provider} className={`mt-0.5 ${SMALL_NOTE} break-words`}>
          {entry.provider === 'codex' ? 'Codex' : entry.provider} に作業を頼めない（閉じている）:{' '}
          {entry.reason}
        </p>
      ))}
    </>
  );
}

// Credentials と同じ3状態を潰さない: 出さないとこの画面でだけ「プロファイルが置かれているか」が判定できない非対称が残るため
function Profile({ runner }: { runner: RunnerSummary }) {
  if (runner.profileProbe.status === 'unheard') {
    return (
      <span className={SMALL_NOTE}>
        プロファイルは確かめていない（繋がっていないので聞いていない）
      </span>
    );
  }
  if (runner.profileProbe.status === 'failed') {
    return (
      <span className="text-[11px] break-words text-destructive">
        プロファイルを確かめられなかった: {runner.profileProbe.error}
      </span>
    );
  }
  if (runner.profile === undefined) {
    return <span className={SMALL_NOTE}>プロファイルは置いていない</span>;
  }
  return (
    <span className="font-mono text-[11px] break-all text-muted-foreground">
      プロファイル: 置いてある（内容の識別値 {runner.profile.sha256}、
      {formatDateTime(runner.profile.updatedAt)} 更新）
    </span>
  );
}

function Runners() {
  const { data, error, isLoading } = useRunners();
  const runners = data?.runners ?? [];
  const daemonRevision = data?.daemonRevision;
  // 取れなかったのを0台と描かない: 「登録された runner が無い」は状態の断定になるため
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Card>
      <CardHeader
        title="実行環境"
        subtitle="マネージャーが実際に動く実行環境の一覧。鍵は識別用の値だけが見える（値そのものは出ない）。「この状態になった」の時刻は保存されないので、サーバを再起動すると記録し直される"
      />
      <ErrorNote error={error} className="m-4" />
      {/* デーモン自身の版を runner の版と同じカードに並べる: 別の場所に出すと人間が手で突き合わせることになり、突き合わせ忘れがそのまま見逃しになるため */}
      {/* runner が0台でも出す: 0台は版を確かめたい状態そのもので、落とすとその状態でだけ答えが消えるため */}
      {daemonRevision === undefined ? null : (
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-sm">接続先のサーバ</p>
            <Badge tone="accent">この画面が見ているプロセス</Badge>
          </div>
          <p className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground">
            版: {describeRevisionStatus(daemonRevision)}
          </p>
        </div>
      )}
      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : runners.length === 0 ? (
        <Empty>
          登録された実行環境が無い。ローカルでは、接続先のサーバと同じプロセスの中で動いている。
        </Empty>
      ) : (
        <ul>
          {runners.map((runner) => (
            <li key={runner.label} className="border-b border-border px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-sm break-all">{runner.runnerId ?? runner.label}</p>
                <RunnerStateBadge state={runner.state} />
              </div>
              <p className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground">
                この状態になった: {formatDateTime(runner.since)}
              </p>
              {runner.runnerId === undefined ? null : (
                <p className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground">
                  {runner.label}
                </p>
              )}
              <p className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground">
                {runner.workspacePath}
              </p>
              {/* 名乗らないことを黙らせない: 出さないと「入れ替わっていない」と「判定できない」が同じに見えるため */}
              <p className="mt-0.5 font-mono text-[11px] break-words text-muted-foreground">
                {runner.instanceId === undefined
                  ? 'プロセス: 名乗っていない（入れ替わったかどうか判定できない）'
                  : `プロセス: ${runner.instanceId}${
                      runner.instanceSince === undefined
                        ? ''
                        : `（${formatDateTime(runner.instanceSince)} から）`
                    }`}
              </p>
              {/* 版は「どのプロセスか」の隣に置く: 並べて置かないと人間はどちらか片方でもう片方を推測し、known は最後に聞けた名乗りなので state から離すと落ちた器の古い値が現役の版として読まれるため */}
              <p className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground">
                版: {describeRevisionStatus(runner.revision)}
              </p>
              <ManagerPeers runner={runner} />
              {runner.error === undefined ? null : (
                <p className="mt-1 text-[11px] break-words text-destructive">{runner.error}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Credentials runner={runner} />
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Profile runner={runner} />
              </div>
              <PushHealth runner={runner} />
              {runner.runnerId === undefined || runner.state === 'vacating' ? null : (
                <VacateRunner runnerId={runner.runnerId} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// 1回目の押下では叩かず確認を挟む: 空けると載っている委譲が他の器へ移り、走っているマネージャーを動かす操作のため
// 叩いた後も「空き終わった」とは言わない: 応答は立てたことの確認だけのため
function VacateRunner({ runnerId }: { runnerId: string }) {
  const vacate = useVacateRunner();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ skipped: string | null } | null>(null);

  if (done !== null) {
    return (
      <p className="mt-2 text-[11px] break-words text-muted-foreground">
        仕事を他へ移す指示を出した。まだ終わってはいない——この実行環境で動いている委譲は他の実行環境へ移る。進み具合はこの一覧の状態で見える。
        {done.skipped === null
          ? ''
          : ` ⚠️ 動いている委譲への引き継ぎの連絡は飛ばした（${done.skipped}）。もう一度指示すると連絡をやり直す（この一覧は移している最中の実行環境には押すボタンを出さないので、コマンドラインから指示し直す）。`}
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {confirming ? (
        <>
          <p className={SMALL_NOTE}>
            この実行環境（{runnerId}）で動いている委譲を止めて、他の実行環境へ移す。本当に移すか。
          </p>
          <Button
            size="sm"
            disabled={busy}
            aria-label={`${runnerId} から仕事を移すのを確定する`}
            onClick={() => {
              setBusy(true);
              setError(null);
              vacate(runnerId)
                .then((result) => setDone({ skipped: result.handshakeSkipped?.message ?? null }))
                .catch((reason: unknown) => setError(reason))
                .finally(() => setBusy(false));
            }}
          >
            本当に移す
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`${runnerId} から仕事を移すのをやめる`}
            onClick={() => setConfirming(false)}
          >
            移すのをやめる
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${runnerId} から仕事を移す`}
          onClick={() => setConfirming(true)}
        >
          この実行環境から仕事を移す
        </Button>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

export const RESET_SUMMARY_LABELS: [keyof WorkspaceResetSummary, string][] = [
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
  ['usageLedger', '利用状況（記録の開始時刻）'],
  ['usageTurns', '利用状況（回数）'],
  ['sessionLog', 'セッションの生ログ'],
];

// 確認の文は RESET_SUMMARY_LABELS から組み立てる: 1つの日本語ラベルが複数の WorkspaceResetSummary キーをまとめて指すことがあるため
const RESET_CONFIRM_GROUPS: { label: string; keys: (keyof WorkspaceResetSummary)[] }[] = [
  { label: '記憶', keys: ['memory'] },
  { label: '日誌', keys: ['journal'] },
  { label: 'ジョブ', keys: ['jobs'] },
  { label: '承認待ち', keys: ['approvals'] },
  { label: '継続中の依頼', keys: ['schedules', 'schedulePhases'] },
  { label: '受信箱', keys: ['inbox'] },
  { label: '引き受けた仕事', keys: ['commitments'] },
  { label: '仕事のやり方', keys: ['practices'] },
  { label: 'アーカイブ', keys: ['archive'] },
  { label: 'セッション', keys: ['sessions'] },
  { label: '実行環境プロファイル', keys: ['profile'] },
  {
    label: '利用状況の台帳',
    keys: ['usageDaily', 'usageBaseline', 'usageLedger', 'usageTurns', 'sessionLog'],
  },
];

export const RESET_CONFIRM_GROUPS_FOR_TEST = RESET_CONFIRM_GROUPS;

const RESET_CONFIRM_SUMMARY = RESET_CONFIRM_GROUPS.map((group) => group.label).join('・');

function ResetSummaryView({ cleared }: { cleared: WorkspaceResetSummary }) {
  return (
    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
      {RESET_SUMMARY_LABELS.map(([key, label]) => {
        const value = cleared[key];
        if (value === undefined) return null;
        return (
          <Fragment key={key}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

// 打たせる語は reset と別にする（stop）: 取り違えると押し間違いの結果が逆方向に重くなるため
// 押した後は最小限の表示にする: デーモンが止まるのでこの画面自身の接続も切れ、引き直しても意味のある応答が返らないため
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
        title="alteroid のサーバを止める"
        subtitle="起動し直せば元に戻る。記憶・日誌・各種の記録は消さない"
      />
      <div className="px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed text-muted-foreground">
          止めても、
          <strong className="text-foreground">記憶も各種の記録も消さない</strong>
          （日誌も含めて1行も消えない）。起動し直せば元に戻る——
          「ワークスペースのリセット」（記憶そのものを消す操作）とは違う。Railway
          のように自動で再起動する構成では、止めると
          <strong className="text-foreground">再起動として働く</strong>
          （止まったままにはならない）。止めた瞬間、この画面自身の接続も切れる。
        </p>
        <div className="mt-3">
          <Button variant="danger" size="sm" onClick={openDialog}>
            alteroid のサーバを止める
          </Button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        // 実行中は Esc でも閉じない: 「やめる」が押せないのと揃えるため
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
      >
        <div className="p-4">
          <h2 className="text-sm font-semibold">本当に止めますか？</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            alteroid のサーバを止めます。
            <strong className="text-foreground">記憶も各種の記録も消えません</strong>
            （日誌も含めて1行も消えません）。起動し直せば元の状態に戻ります。Railway
            のように自動で再起動する構成では、止めると
            <strong className="text-foreground">再起動として働きます</strong>
            （止まったままにはなりません）。止めた直後、この画面の接続も切れます。
          </p>

          {!done ? (
            <>
              <label className="mt-3 block text-xs text-muted-foreground">
                続けるなら <code className="rounded bg-muted px-1 font-mono">stop</code> と入力
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
 * `POST /clone/session/reopen` の応答を人間の言葉にする。
 *
 * CLI の `describeReopenResult`（`apps/cli/src/reopen.ts`）と文言を1文字も違えていない。
 * 二重管理である——apps 同士はパッケージを共有しない（共有先は `packages/` だけ）ので、
 * 揃える手段がここへ書き写す以外に無い（`chat.tsx` の `describeCloneInterruptOutcome` と同じ事情）。
 * CLI 側の文言を直したらここも直すこと。
 */
export function describeReopenResult(result: ReopenCloneSessionResult): string {
  const lines: string[] = [];
  switch (result.outcome) {
    case 'deferred':
      lines.push(
        'いまのターンが終わった境界で、新しいセッションに開き直す（走っているターンは最後まで走る）。',
      );
      break;
    case 'now':
      lines.push('いまはセッションが無かった。次の合図から新しいセッションで始まる。');
      break;
    case 'unsupported':
      lines.push('このデーモンのクローンは、セッションを開き直す口を持っていない。');
      return lines.join('\n');
  }
  if (result.previousSessionId !== undefined && result.previousSessionId !== null) {
    lines.push(`古いセッション id: ${result.previousSessionId}`);
  }
  if (result.runningManagers !== undefined && result.runningManagers > 0) {
    lines.push(
      `走っているマネージャーが ${String(result.runningManagers)} 本いる。マネージャーは止めていない。その報告は新しいセッションへ届く。`,
    );
  }
  return lines.join('\n');
}

const REOPEN_REASON_MAX = 500;

// 権限は先回りして判定しない: 資格（owner）は HTTP の口が見るので、足りなければ失敗として ErrorNote に出る
// 確認語は打たせない: 生ログは消さず退避するので、reset と違い取り返しがつく（CLI も `--yes` で省ける確認である）
function ReopenCloneSession() {
  const reopenCloneSession = useReopenCloneSession();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [distill, setDistill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [result, setResult] = useState<ReopenCloneSessionResult | null>(null);

  function openDialog() {
    setFailure(undefined);
    setResult(null);
    dialogRef.current?.showModal();
  }

  async function runReopen() {
    setBusy(true);
    setFailure(undefined);
    try {
      setResult(await reopenCloneSession({ distill, reason }));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="クローンのセッションを開き直す"
        subtitle="resume せず、新しいセッションで始め直す"
      />
      <div className="px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed text-muted-foreground">
          安全分類器に弾かれ続けるときなどに、クローンのセッションを resume せずに新しく開き直す。
          古いセッションの生ログは消さずにアーカイブへ退避し、会話の記録も残る。
          <strong className="text-foreground">
            クローンはそれまでの文脈を持たない新しいセッションで始まる。
          </strong>
          走っているターンは最後まで走る。マネージャーは止めない。
        </p>
        <label className="mt-3 block text-xs text-muted-foreground">
          理由（任意。{REOPEN_REASON_MAX}字まで）
          <Input
            className="mt-1"
            value={reason}
            maxLength={REOPEN_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例: 安全分類器に弾かれ続けている"
          />
        </label>
        <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="mt-0.5 pointer-coarse:size-5 pointer-coarse:shrink-0"
            checked={distill}
            onChange={(event) => setDistill(event.target.checked)}
          />
          <span>
            古いセッションの末尾を記憶へ蒸留する
            <br />
            既定はオフ。弾かれているセッションの末尾を蒸留へ送ると、また弾かれるか、汚れを記憶へ書き込むため。
          </span>
        </label>
        <div className="mt-3">
          <Button variant="danger" size="sm" onClick={openDialog}>
            開き直す
          </Button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        // 実行中は Esc でも閉じない: 「やめる」が押せないのと揃えるため
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
      >
        <div className="p-4">
          <h2 className="text-sm font-semibold">クローンのセッションを開き直しますか？</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            古いセッションの生ログは消さず、アーカイブへ退避します（会話の記録も残ります）。
            <strong className="text-foreground">
              ただし、クローンはそれまでの会話の文脈を持たない新しいセッションで始まります。
            </strong>
            走っているターンは最後まで走ります。マネージャーは止めません。
            {distill
              ? '古いセッションの末尾を記憶へ蒸留します。'
              : '古いセッションの末尾は記憶へ蒸留しません（既定）。'}
          </p>

          {result === null ? (
            <>
              <ErrorNote error={failure} className="mt-3" />
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" disabled={busy} onClick={() => dialogRef.current?.close()}>
                  やめる
                </Button>
                <Button variant="danger" size="sm" loading={busy} onClick={() => void runReopen()}>
                  本当に開き直す
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-3 space-y-1 text-xs font-medium text-ok">
                {describeReopenResult(result)
                  .split('\n')
                  .map((line) => (
                    <p key={line}>{line}</p>
                  ))}
              </div>
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

// reset という語を打たせる: y 1文字の誤打で通らないようにするため
// ボタンは常に出す: 隠すと「なぜ押せないか」が消えるため
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          {RESET_CONFIRM_SUMMARY}を全部消す。
          <strong className="text-foreground">
            登録した認証トークン・マネージャーへ渡す環境変数・このログインアカウントは消さない。
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
        // 実行中は Esc でも閉じない: 「やめる」が押せないのと揃えるため
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        className="w-[min(28rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
      >
        <div className="p-4">
          <h2 className="text-sm font-semibold">本当に削除しますか？</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {RESET_CONFIRM_SUMMARY}
            を全部消します。登録した認証トークン・マネージャーへ渡す環境変数・この
            ログインアカウントは消しません。
            <strong className="text-foreground">取り消せません。</strong>
          </p>

          {cleared === null ? (
            <>
              <label className="mt-3 block text-xs text-muted-foreground">
                続けるなら <code className="rounded bg-muted px-1 font-mono">reset</code> と入力
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
