import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  DocumentTitle,
  Markdown,
  Badge,
  Button,
  Card,
  CardHeader,
  AgentModelTag,
  Empty,
  ConfirmDialog,
  ErrorNote,
  KeyValueList,
  Spinner,
  SubmitHint,
  Textarea,
  WindowedText,
} from '@alteroid/ui';
import {
  useAbortManager,
  useSendManagerMessage,
  useManager,
  useManagerTranscript,
  ApiError,
} from '@alteroid/swr';
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  redactBody,
  usageHref,
} from '@alteroid/logic';
import { RemovedBody } from '~/components/load-error';
import { terminalFailureNote as sharedTerminalFailureNote } from '~/lib/manager-failure-note';
import { LeaveGuardScope, useIsMounted, useReportDirty } from '~/lib/leave-guard';
import { unsentInput } from '~/lib/unsent-input';

// `@alteroid/core` 本体（バレル）ではなく軽い口から引く: バレルはサーバ専用のドメイン層ごと引き込む。
import { classifyManagerActivity, describeReportDrift } from '@alteroid/core/manager-activity';
import {
  CGROUP_EVENTS_UNKNOWN_NOTE,
  formatCgroupEventsNote,
} from '@alteroid/core/cgroup-events-format';
import { maskUrl } from '@alteroid/core/mask-url';
import {
  formatSystemErrorFacts,
  formatSystemErrorUnknownNote,
} from '@alteroid/core/system-error-format';
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  isEmptyCompleteUnpushedWorkObservation,
  UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE,
} from '@alteroid/core/unpushed-work-observation-format';
import type { ManagerDenial, ManagerStatus, ManagerSummary } from '@alteroid/logic';

import type { Route } from './+types/manager-detail';
// 注記は書き写さず一覧から借りる: 文言の核はクローン・CLI と逐語で揃える約束なので、写すと片方だけ直る。
import {
  denialActorTag,
  describeDenialFollowUp,
  ManagerAwaitingBackgroundNote,
  ManagerRunnerLostNote,
  ManagerRunnerVanishedNote,
  ManagerSessionMissingNote,
  ManagerStatusBadge,
} from './managers';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { id: params.id };
}

// 依頼の全文（`manager.request`）を渡さない: header は `shrink-0` なので、長いと本文が画面の外へ押し出される。
const PAGE_DESCRIPTION = 'この仕事1本の状態と、走行中に割り込む口。依頼の全文は下';

const NOT_FOUND_DESCRIPTION = '指定されたマネージャーはありません';

export default function ManagerDetail({ loaderData }: Route.ComponentProps) {
  const { id } = loaderData;
  const { data, error, isLoading } = useManager(id);
  const navigate = useNavigate();
  const mounted = useIsMounted();
  const { search } = useLocation();
  const abortManager = useAbortManager();
  const [busy, setBusy] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const manager = data?.manager;
  // 「見つからない」は 404 のときだけ言う: 500・409（壊れているだけ）で言うと、読めていないのに委譲が存在しないように読める。
  const notFound = data === undefined && error instanceof ApiError && error.status === 404;
  const detailUnavailable = data === undefined && error !== undefined && !notFound;

  return (
    // ブロッカーはこの画面に1つだけ。親の `managers.tsx` は持たない（最後に登録したものが勝つため）。
    <LeaveGuardScope>
      <DocumentTitle>マネージャーの詳細</DocumentTitle>
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">マネージャーの詳細</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {notFound ? NOT_FOUND_DESCRIPTION : PAGE_DESCRIPTION}
          </p>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{id}</p>
        </div>
        <div className="shrink-0">
          {/*
            状態で出し分けない: CLI の `/stop` もデーモンも status を見ずに止めるので、画面だけ絞ると入口の等価性が崩れる。
            `done`（待機中）も止めたい場面があり、状態を列挙すると増えた日に黙って締め出す。
            押せない理由は非表示ではなく `failure` の `ErrorNote` で出す（消すと「できない」と「扱っていない」を区別できない）。
          */}
          {manager !== undefined ? (
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              onClick={() => setConfirmingStop(true)}
            >
              停止する
            </Button>
          ) : undefined}
          <ConfirmDialog
            open={confirmingStop}
            onOpenChange={setConfirmingStop}
            title="このマネージャーを停止しますか"
            description="セッションを止めます（待機中のセッションも畳まれます）。進行中の作業は失われ、答えを待っている確認は畳まれます。停止すると一覧へ戻ります。"
            confirmLabel="停止する"
            destructive
            onConfirm={() => {
              setBusy(true);
              setFailure(undefined);
              abortManager(id, '人間が画面から停止した')
                .then(() => {
                  // 応答待ちに別のマネージャーへ移っていたら、その画面を動かさない。
                  if (mounted.current) navigate({ pathname: '/managers', search });
                })
                .catch(setFailure)
                .finally(() => setBusy(false));
            }}
          />
        </div>
      </header>

      {/* 404 は下のカードが日本語で言う。応答の素の文（英語の `not found`）を重ねて出さない。 */}
      <ErrorNote error={notFound ? failure : (error ?? failure)} className="mb-4" />

      {isLoading ? (
        <Spinner />
      ) : detailUnavailable ? null : manager === undefined ? (
        <Card>
          <Empty>
            このマネージャーは見つかりません（削除されたか、id が違います）。
            <Link to="/managers" className="ml-2 underline">
              マネージャー一覧へ戻る
            </Link>
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <RequestCard request={manager.request} />

          <Card>
            <CardHeader
              title="状態"
              action={
                // 使用量を集計し直さず飛ぶだけにする: 数字の意味は `/usage` が持つ。
                <Link
                  to={usageHref({ managerId: id })}
                  className="text-xs text-primary hover:underline"
                >
                  使用量を見る
                </Link>
              }
            />
            <KeyValueList
              className="px-4 py-3"
              labelWidth="8rem"
              items={[
                {
                  label: '状態',
                  value: (
                    <div className="flex items-center gap-2">
                      <ManagerStatusBadge status={manager.status} />
                      {manager.live ? (
                        <Badge tone="ok">接続あり</Badge>
                      ) : (
                        <Badge tone="danger">セッション切断</Badge>
                      )}
                      {/* 札は差し替えず隣に並べる: 拒否で止まった仕事は「実行中」のままなので、差し替えるとその事実が消える。 */}
                      {denialTotal(manager.denials) > 0 && (
                        <Badge tone="warn">
                          ⚠ 確認へ上がらず止められた {denialTotal(manager.denials)} 件
                        </Badge>
                      )}
                      {manager.lastFailure !== undefined && manager.lastFailure !== null && (
                        <Badge tone="danger">⚠ 直近のターンは失敗で終わった</Badge>
                      )}
                    </div>
                  ),
                },
                { label: '作業ディレクトリ', value: manager.cwd, mono: true },
                {
                  label: '作成',
                  value: `${formatDateTime(manager.startedAt)}（${formatRelative(manager.startedAt)}）`,
                },
                {
                  label: '更新',
                  value: `${formatDateTime(manager.updatedAt)}（${formatRelative(manager.updatedAt)}）`,
                },
                ...(manager.runnerId !== undefined && manager.runnerId !== null
                  ? [{ label: 'runner', value: manager.runnerId, mono: true }]
                  : []),
                { label: 'モデル', value: <AgentModelTag model={manager.managerModel} /> },
                { label: '作業者', value: <AgentModelTag model={manager.workerModel} /> },
                ...(manager.sessionId !== undefined && manager.sessionId !== null
                  ? [{ label: 'セッション', value: manager.sessionId, mono: true }]
                  : []),
                // 貸し出しは判定を書かず材料だけ出す: 引き取ってよいかは時刻で変わるので、画面に焼くと古びる。
                ...(manager.lease !== undefined && manager.lease !== null
                  ? [
                      {
                        label: '貸し出し',
                        value: `${manager.lease.instanceId ?? 'プロセスは未名乗り'} / 世代 ${manager.lease.fence}（生存確認 ${formatDateTime(manager.lease.seenAt)}）`,
                        mono: true,
                      },
                    ]
                  : []),
              ]}
            />
            <DisconnectedNote live={manager.live} />
            {/* 送信可否を推論する文言にしない: 器が `lost` でも送信は届きうるので、「いま話しかけられない」と書くと真下の送信ボタンと矛盾する。 */}
            <ManagerRunnerLostNote
              runnerLostSince={manager.runnerLostSince}
              className="border-t border-border px-4 py-3 text-xs text-destructive"
            />
            <ManagerRunnerVanishedNote
              runnerVanished={manager.runnerVanished}
              className="border-t border-border px-4 py-3 text-xs text-destructive"
            />
            <ManagerSessionMissingNote
              sessionMissingSince={manager.sessionMissingSince}
              sessionMissingKind={manager.sessionMissingKind}
              className="border-t border-border px-4 py-3 text-xs text-warn"
            />
            <ManagerAwaitingBackgroundNote
              awaitingBackground={manager.awaitingBackground}
              className="border-t border-border px-4 py-3 text-xs text-muted-foreground"
            />
            <LostNote status={manager.status} />
            <FailureNote manager={manager} />
          </Card>

          <DiagnosticsCard manager={manager} />

          <DenialsCard denials={manager.denials} lastReportAt={manager.lastReportAt} />

          {manager.waiting.length > 0 && (
            <Card>
              <CardHeader
                title="このマネージャーが待っていること"
                subtitle="答えるまでこの仕事だけが止まる"
              />
              <ul>
                {manager.waiting.map((request) => (
                  <li key={request.requestId} className="border-b border-border last:border-b-0">
                    <WaitingRow
                      id={id}
                      requestId={request.requestId}
                      summary={request.summary}
                      kind={request.kind}
                      askedAt={request.askedAt}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {manager.lastReport !== undefined && manager.lastReport !== null && (
            <Card className="min-w-0">
              {/* 失敗で終わった回を「報告」と呼ばない: 見出しが「最後の報告」のままだと、包みの内側だけが報告として読まれる。 */}
              <CardHeader
                title={
                  manager.lastFailure === undefined || manager.lastFailure === null
                    ? '最後の報告'
                    : '最後のターンの中身（報告ではない）'
                }
                subtitle={
                  manager.lastFailure === undefined || manager.lastFailure === null
                    ? undefined
                    : 'SDK が「これは応答ではない」と言った回。以下はマネージャーのまとめではなく、失敗の中身である'
                }
              />
              <div className="min-w-0 px-4 py-3">
                <LastReportBody lastReport={manager.lastReport} lastFailure={manager.lastFailure} />
              </div>
            </Card>
          )}

          <SendMessage id={id} live={manager.live} sessionId={manager.sessionId} />
          <Transcript id={id} />
        </div>
      )}
    </LeaveGuardScope>
  );
}

// 切り詰めず、Markdown にも解釈しない: 見せたいのはクローンが渡した文字列そのもの。長いときは `max-h` でカード内をスクロールさせ、他のカードを押し出さない。
function RequestCard({ request }: { request: string }) {
  return (
    <Card className="min-w-0">
      <CardHeader title="依頼" subtitle="この仕事を起こしたときに渡した指示（全文）" />
      <div className="max-h-72 min-w-0 overflow-y-auto px-4 py-3">
        <p className="text-sm break-words whitespace-pre-wrap">{redactBody(request)}</p>
      </div>
    </Card>
  );
}

// 「いま送っても届かない」とも「送れば届く」とも書かない: 送信そのものが resume の契機で、resume は失敗しうるので、契機になるところまでしか言えない。
function DisconnectedNote({ live }: { live: boolean }) {
  if (live) return null;
  return (
    <p className="border-t border-border px-4 py-3 text-xs text-destructive">
      このサーバは、このマネージャーの runner と
      <strong className="font-medium">繋がっていない</strong>
      。ここに出ているのは台帳に残っている最後の姿で、繋ぎ直るまで動かない。ただし
      <strong className="font-medium">送信は塞いでいない</strong>—
      下の「話しかける」から送ると、その一言が
      <strong className="font-medium">引き取り（resume）の契機</strong>
      になる。戻れれば、送った言葉はそのまま続きの指示として届き
      <strong className="font-medium">接続あり</strong>
      へ戻る。
      <br />
      ただし
      <strong className="font-medium">戻れるとは限らない</strong>
      。resume に失敗すれば
      lost（セッションへ戻れず）へ落ちる。戻る先（session_id）を持っていない相手なら、そもそも送信を受け付けない。どちらも理由は送信欄に出る。
    </p>
  );
}

// `lost` は「戻れなかった」の観測であって成果の有無ではない（デーモンは PR もブランチも見ていない）ので、終わっていたかどうかを言い切らない。かといって `done` へも寄せない。
function LostNote({ status }: { status: ManagerStatus }) {
  if (status !== 'lost') return null;
  return (
    <p className="border-t border-border px-4 py-3 text-xs text-destructive">
      前のセッションへ戻れなかった。
      <strong className="font-medium">戻れたかどうかしか見ていない</strong>
      ので、この仕事が終わっていたかどうかは分からない。落ちる直前に PR を出して CI
      を通し、マージまで届いていた仕事がこの札を貼られた実例がある。
      <br />
      起こし直す前に、まず
      <strong className="font-medium">
        外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること
      </strong>
      。どこまで進んでいたかは、下の「最後の報告」とセッションログ（生）にも残っていることがある。続きが要ると判断したときだけ起こし直す。
    </p>
  );
}

// 「上限に当たった」と決めつけない: 観測しているのは「SDK が応答ではないと言った」ことと `code` だけ。
// SDK の語・失敗の時刻・セッションが生きているかの事実は削らない（次の一手が `code` で違い、書かないと続けられる仕事を閉じる／終わった仕事に話しかけ続ける）。
function FailureNote({ manager }: { manager: ManagerSummary }) {
  const { lastFailure: failure, lastFoldedTurn, status } = manager;
  if (failure === undefined || failure === null) return null;
  // `lastFoldedTurn` が在る回の `lastFailure` は畳まれる前の無関係な古いターンを指すので、「直近のターン」として出さない。
  if (lastFoldedTurn !== undefined) return null;
  return (
    <p className="border-t border-border px-4 py-3 text-xs text-destructive">
      直近のターンは
      <strong className="font-medium">報告ではなく失敗で終わっている</strong>—{' '}
      <code className="font-mono">{failure.code}</code>（印の出どころ:{' '}
      <code className="font-mono">{failure.via}</code>、{formatDateTime(failure.at)}）。
      <br />
      {terminalFailureNote(status)}
      <strong className="font-medium">何が起きたかの解釈まではしていない</strong>— 観測したのは「SDK
      がこれは応答ではないと言った」ことと、この
      <code className="font-mono">code</code> だけである。
    </p>
  );
}

// 生きている3値だけここで書く: 「下の『話しかける』」という導線はこの詳細画面にしかなく、共通化した側には置けない。
function terminalFailureNote(status: ManagerStatus): ReactNode {
  const terminal = sharedTerminalFailureNote(status);
  if (terminal !== null) return terminal;
  return (
    <>
      <strong className="font-medium">この仕事は死んでいない</strong>
      。セッションは生きているので、原因が解ければ下の「話しかける」から続けられる（だから状態は
      <strong className="font-medium">失敗ではなく待機中</strong>
      のままである）。
    </>
  );
}

// 軸は `markup` ではなく `lastFailure`: 失敗回の本文はデーモンの頭・SDK の生文言・途中出力の連結で、記法を決められない。
// 失敗回は素のテキストで出す: SDK の生文言を化けさせず検索できるようにするため（犠牲: 途中出力の `**…**` が記法のまま見える）。切り詰めも言い換えもしない。
function LastReportBody({
  lastReport,
  lastFailure,
}: {
  lastReport: string;
  lastFailure: ManagerSummary['lastFailure'] | undefined;
}) {
  if (lastFailure === undefined || lastFailure === null) {
    // マネージャーが書いた本文なので外部の画像は読み込まない: 開いた瞬間に閲覧の時刻・IP が画像の置き場へ漏れるため
    return (
      <Markdown headingOffset={2} remoteImages={false}>
        {redactBody(lastReport)}
      </Markdown>
    );
  }
  return (
    <pre className="overflow-x-auto rounded border border-border bg-background p-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
      {redactBody(lastReport)}
    </pre>
  );
}

function denialTotal(denials: ManagerDenial[] | undefined): number {
  return (denials ?? []).reduce((sum, entry) => sum + entry.count, 0);
}

// key を層込みにする: 同じ道具が層違い（`Bash`(worker) と `Bash`(manager)）で2件返りうるので、`entry.tool` だけだと重複キーになる。
// 件数はデーモンのプロセス内にしか無く、止まったかどうかは見ていないので、観測した分しか言わない。
function DenialsCard({
  denials,
  lastReportAt,
}: {
  denials: ManagerDenial[] | undefined;
  lastReportAt: string | undefined;
}) {
  if (denials === undefined || denials.length === 0) return null;
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  const recent = [...denials].reverse();
  return (
    <Card>
      <CardHeader
        title="確認へ上がらず止められた道具"
        subtitle="まず担い手自身の拒否文を読ませること。出所はこの数からは取れない。(a) 実行環境の分類器か deny 規則なら、この確認はクローンには回ってきていない。(b) alteroid 自身の PreToolUse フック（bash-wait-guard.ts 等）なら、理由と代替案は担い手へ直接返っており、自力で抜けられることがある"
      />
      <ul className="px-4 py-3 text-sm">
        {recent.map((entry) => (
          <li
            key={`${entry.actor ?? 'unresolved'}::${entry.tool}`}
            className="flex items-baseline justify-between gap-3 py-0.5"
          >
            <span className="font-mono text-xs break-all">
              {entry.tool}
              {denialActorTag(entry.actor)}
            </span>
            <span className="shrink-0 text-warn">{entry.count} 件</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        止められた事実は数えているが、
        <strong className="font-medium">それでこの仕事が止まったかどうかは見ていない</strong>
        （サーバに動きを見る手が無い）。全件は
        <Link to="/journal" className="text-primary hover:underline">
          日誌
        </Link>
        に残っている。 この件数はサーバのプロセス内にしかないので、
        <strong className="font-medium">実行環境を作り直すと数え直しになる</strong>— 「0
        件」は「止められていない」ではない。
      </p>
      {followUp !== null && (
        <p className="border-t border-border px-4 py-3 text-xs">{followUp}。</p>
      )}
    </Card>
  );
}

// 判定を複製せず `describeReportDrift` を通す: 字面が割れると人間とクローンが違う結論を読む。
// `lastFoldedTurn` が在る回の `lastReportAt` / `lastReportStatus` は畳まれる前の古い値なので、core と同じく `foldedTurn.at` と `'stopped'` を合成して渡す。
function reportStatusDriftText(manager: ManagerSummary): string {
  const foldedTurn = manager.lastFoldedTurn;
  return describeReportDrift({
    managerId: manager.managerId,
    lastReportAt: foldedTurn !== undefined ? foldedTurn.at : manager.lastReportAt,
    lastReportStatus: foldedTurn !== undefined ? 'stopped' : manager.lastReportStatus,
    status: manager.status,
    now: new Date(),
  });
}

function ReportStatusDriftNote({ manager }: { manager: ManagerSummary }) {
  const note = reportStatusDriftText(manager);
  if (note === '') return null;
  return <p className="border-t border-border px-4 py-3 text-xs text-warn">{note}</p>;
}

// 判定は `classifyManagerActivity` を通して割らない（字面だけこの画面向けに書き直す: クローン向けの原文はクローンの道具名を名指しする）。
// 時刻の閾値は置かない: 「何分経ったか」は症状の下限を決めない。
function toolUseStallText(manager: ManagerSummary): string | null {
  const pending = manager.toolUseStallPending;
  if (pending === undefined || pending.length === 0) return null;
  const kind = classifyManagerActivity({
    turnEndReason: manager.turnEndReason,
    turnEndedAt: manager.turnEndedAt,
    lastReportAt: manager.lastReportAt,
    toolUseStallPending: pending,
    waitingCount: manager.waiting.length,
  });
  if (kind !== 'stalled-tool-use') return null;

  const names = pending.map((item) => `${item.name ?? '（名前不明）'}(${item.id})`).join(' / ');
  const whenNote =
    manager.toolUseStallAt === undefined
      ? 'その行に timestamp が無かったので、いつからかは分からない'
      : `${formatDateTime(manager.toolUseStallAt)}（${formatRelative(manager.toolUseStallAt)}）から`;
  return (
    '道具の応答待ちのまま、誰もその応答を待っていない（矛盾）。生ログの末尾の assistant 行が ' +
    '道具の呼び出しで終わっているのに、対応する結果が生ログに無く、かつこのサーバ側の返事待ち' +
    `も空である。未応答の道具: ${names}。${whenNote}。` +
    'この状態そのものは何も止めていない——委譲は動き続けてよい。長時間の作業者委譲（Agent 等）の' +
    '実行中でも同じ形になりうるので、この行だけで「壊れている」と決めつけないこと。' +
    '生ログの末尾は下の「セッションログ（生）」で読める。'
  );
}

function ToolUseStallNote({ manager }: { manager: ManagerSummary }) {
  const note = toolUseStallText(manager);
  if (note === null) return null;
  return <p className="border-t border-border px-4 py-3 text-xs text-warn">⚠ {note}</p>;
}

function UnreportedNote({ lastUnreported }: { lastUnreported: ManagerSummary['lastUnreported'] }) {
  if (lastUnreported === undefined) return null;
  return (
    <p className="border-t border-border px-4 py-3 text-xs text-destructive">
      直近のターンは、<strong className="font-medium">result を受け取らないまま畳まれた</strong>（
      {formatDateTime(lastUnreported.at)}）。理由: {redactBody(lastUnreported.reason)}
    </p>
  );
}

// `lastReport` と混ぜない: 完遂した報告と、止めた後に打ち切られた途中経過の区別が消える。全文を出す。
function FoldedTurnNote({ lastFoldedTurn }: { lastFoldedTurn: ManagerSummary['lastFoldedTurn'] }) {
  if (lastFoldedTurn === undefined) return null;
  return (
    <div className="border-t border-border px-4 py-3 text-xs">
      <p className="text-muted-foreground">
        <strong className="font-medium text-destructive">
          manager_stop で畳まれたターンの本文
        </strong>
        （{formatDateTime(lastFoldedTurn.at)} 受信。<code className="font-mono">lastReport</code>
        （完遂した報告）ではない）:
      </p>
      <pre className="mt-1 overflow-x-auto rounded border border-border bg-background p-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
        {redactBody(lastFoldedTurn.text)}
      </pre>
    </div>
  );
}

function cgroupEventsText(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastCgroupEvents === undefined) {
    return `⚠ ${CGROUP_EVENTS_UNKNOWN_NOTE}。`;
  }
  return (
    `${formatCgroupEventsNote(manager.lastCgroupEvents)}` +
    `（${formatDateTime(manager.lastCgroupEvents.at)}）。`
  );
}

function CgroupEventsNote({ manager }: { manager: ManagerSummary }) {
  const note = cgroupEventsText(manager);
  if (note === null) return null;
  return <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{note}</p>;
}

// 判定できなかった場合の末尾の指し先だけこの画面のものを渡す: クローン向けは欄名 `lastFailure` を指すが、この画面はその欄を出していない。
function systemErrorText(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastSystemError === undefined) {
    const note = formatSystemErrorUnknownNote(
      '、上の「直近のターンは報告ではなく失敗で終わっている」の注記を見ること',
    );
    return `セッションは失敗で畳まれた。${note}。`;
  }
  return (
    'セッションは実行環境の資源による落ち方で畳まれた可能性 ' +
    `（${formatDateTime(manager.lastSystemError.at)}）: ` +
    formatSystemErrorFacts(manager.lastSystemError)
  );
}

function SystemErrorNote({ manager }: { manager: ManagerSummary }) {
  const note = systemErrorText(manager);
  if (note === null) return null;
  return <p className="border-t border-border px-4 py-3 text-xs text-destructive">⚠ {note}</p>;
}

// `STALE_TOKEN_RESTART_ADVICE` を import しない: 文面がクローンの道具名（`manager_stop` の断り）を名指しするが、この画面にその道具は無い。核2つ（ターン途中かの確認・進行中の作業も失われる）は削らない。
// 未push観測は主ではなく補助として、観測が在るときだけ一文を足す: 最後の1回であっていまの状態ではなく、無ければ指した先が画面に存在しない。
// 未知の値でも落ちない: 版のずれで新しいデーモンが知らない値を返しても、画面ごと落ちないように。
function resetTimeSkewText(manager: ManagerSummary): ReactNode | null {
  const value = manager.resetTimeSkewMatch;
  if (value === undefined) return null;
  if (value === 'stale') {
    const hasUnpushedWorkObservation =
      manager.lastUnpushedWorkObservation !== undefined && unpushedWorkText(manager) !== null;
    return (
      <>
        ⚠ 認証トークンの世代ずれの疑い（429の文言に書かれていた resets 時刻が、現役ではない鍵の
        冷却期限と一致した）。このセッションは古い鍵を掴んだまま走っている可能性がある ——
        鍵が通る状態へ戻っても、このセッション自身はターンの境界に達するまで戻らない。
        この行が消えないまま 429 が続くようなら、
        <strong className="font-medium">
          止める前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること
        </strong>
        。
        {hasUnpushedWorkObservation && (
          <>
            下の「未push観測」にも最後の観測が出ている（いまの状態ではない）ので、合わせて見ること。
          </>
        )}
        確かめずに止めると、
        <strong className="font-medium">失われるのは会話だけではない</strong>
        ——そのターンで進行中だった作業も一緒に失われうる。確かめたうえで、起こし直すこと。
        <strong className="font-medium">この印は枠(利用上限)で止まっている間だけ意味を持つ</strong>
        ——枠から下りれば一緒に消える。
      </>
    );
  }
  if (value === 'active') {
    return (
      '認証トークン: 429の文言に書かれていた resets 時刻が、現役の鍵自身の冷却期限と一致した —— ' +
      '世代ずれではなく、待てば戻る。'
    );
  }
  return `認証トークンの世代ずれの判定: この画面が知らない値 "${String(value)}"（サーバの版が新しい可能性）。`;
}

function ResetTimeSkewNote({ manager }: { manager: ManagerSummary }) {
  const note = resetTimeSkewText(manager);
  if (note === null) return null;
  return <p className="border-t border-border px-4 py-3 text-xs text-warn">{note}</p>;
}

// 答えるのは「どの枝を見ればよいか」までで、成果が届いたかは含まない。`remoteOrigin` はスキーマで落としてあっても、二重の備えとして `maskUrl` を通す。
// `kind` は増えうるので、知らない値でも落ちない。
function unpushedWorkText(manager: ManagerSummary): ReactNode | null {
  const observation = manager.lastUnpushedWorkObservation;
  const swapped = manager.sessionMissingSince !== undefined;
  if (observation === undefined && !swapped) return null;

  // 器の入れ替えで応答不能の委譲は、判定も文言もクローンと同じ生成元を通して3通りに言い分ける。
  if (swapped) {
    if (manager.shutdownObservationArrivedAfterSwap === true && observation !== undefined) {
      if (observation.kind === 'unavailable') {
        return `未push観測: 器が止まる直前（${formatDateTime(observation.at)}）に取ろうとしたが取れなかった: ${redactBody(observation.reason)}`;
      }
      if (observation.kind === 'observed') {
        if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
        return observedUnpushedWorkNode(
          `未push観測: 器が止まる直前（${formatDateTime(observation.at)}）の観測:`,
          observation,
        );
      }
    } else {
      // 古い観測を最新のように見せない: 断りの後に「表示中の観測」として時刻と経路つきで添える。
      const warn = (
        <div className="text-warn">{UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE}</div>
      );
      if (observation === undefined) {
        return (
          <>
            {warn}
            <div className="mt-1">表示中の観測は無い（一度も取れていない）</div>
          </>
        );
      }
      if (observation.kind === 'unavailable') {
        return (
          <>
            {warn}
            <div className="mt-1">
              {`表示中の観測は ${formatDateTime(observation.at)} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの（取れなかった: ${redactBody(observation.reason)}）`}
            </div>
          </>
        );
      }
      if (observation.kind === 'observed') {
        return (
          <>
            {warn}
            <div className="mt-1">
              {observedUnpushedWorkNode(
                `表示中の観測は ${formatDateTime(observation.at)} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの:`,
                observation,
              )}
            </div>
          </>
        );
      }
    }
  }
  if (observation === undefined) return null;
  if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;

  const provenance = describeUnpushedWorkObservationProvenance(observation.source);

  if (observation.kind === 'unavailable') {
    return `未push観測（${provenance}）: 取れなかった（${formatDateTime(observation.at)}）: ${redactBody(observation.reason)}`;
  }
  if (observation.kind === 'observed') {
    return observedUnpushedWorkNode(
      `未push観測（${provenance}、${formatDateTime(observation.at)}）:`,
      observation,
    );
  }
  const unknownKind: string = (observation as { kind: string }).kind;
  return `未push観測: この画面が知らない種類 "${unknownKind}"（サーバの版が新しい可能性）。`;
}

function observedUnpushedWorkNode(
  lead: string,
  observation: Extract<
    NonNullable<ManagerSummary['lastUnpushedWorkObservation']>,
    { kind: 'observed' }
  >,
): ReactNode {
  const incompleteNote = describeUnpushedWorkObservationIncompleteness(observation);
  if (observation.worktrees.length === 0) {
    return `${lead} 見つかった作業ツリー0本${incompleteNote === null ? '' : ` ${incompleteNote}`}`;
  }
  return (
    <>
      {lead}
      {incompleteNote !== null && <div className="mt-1 text-warn">{incompleteNote}</div>}
      <ul className="mt-1 list-disc pl-4">
        {observation.worktrees.map((wt, index) => (
          // key に index を混ぜる: 相対パスだけでは同名の worktree が2箇所に無いとは限らず、一意にならない。
          <li key={`${wt.relativePath}::${index}`} className="break-all">
            {wt.relativePath}: branch=
            {wt.branch === null ? 'null（取れなかった）' : wt.branch}
            {wt.remoteOrigin !== undefined &&
              ` / origin=${maskUrl(`https://${wt.remoteOrigin.host}${wt.remoteOrigin.path}`)}`}
          </li>
        ))}
      </ul>
    </>
  );
}

function UnpushedWorkObservationNote({ manager }: { manager: ManagerSummary }) {
  const note = unpushedWorkText(manager);
  if (note === null) return null;
  return (
    <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{note}</div>
  );
}

// 出さない欄: `usageStoppedAt`（`ResetTimeSkewNote` が既に言う）、`turnEnded*`（デーモンの助言で、既出の材料と重なる）、`tokenGeneration` 系（`resetTimeSkewMatch` が結論を出していて、生の番号は次の一手を増やさない）。
// 無い欄は行ごと出さない。
function DiagnosticsCard({ manager }: { manager: ManagerSummary }) {
  const visible =
    reportStatusDriftText(manager) !== '' ||
    toolUseStallText(manager) !== null ||
    manager.lastUnreported !== undefined ||
    manager.lastFoldedTurn !== undefined ||
    cgroupEventsText(manager) !== null ||
    systemErrorText(manager) !== null ||
    resetTimeSkewText(manager) !== null ||
    unpushedWorkText(manager) !== null;
  if (!visible) return null;

  return (
    <Card>
      <CardHeader
        title="診断"
        subtitle="クローンが manager_list / manager_report で読んでいるのと同じ材料。無ければ行ごと出さない"
      />
      <ReportStatusDriftNote manager={manager} />
      <ToolUseStallNote manager={manager} />
      <UnreportedNote lastUnreported={manager.lastUnreported} />
      <FoldedTurnNote lastFoldedTurn={manager.lastFoldedTurn} />
      <CgroupEventsNote manager={manager} />
      <SystemErrorNote manager={manager} />
      <ResetTimeSkewNote manager={manager} />
      <UnpushedWorkObservationNote manager={manager} />
    </Card>
  );
}

// `askedAt` が届かないときは何も描かない: 版のずれで古いデーモンが持たないことがあり、「不明」と書くほどの情報ではない。
function AskedAtNote({ askedAt }: { askedAt: string | undefined }) {
  if (askedAt === undefined) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {formatDateTime(askedAt)}（{formatRelative(askedAt)}）から
    </p>
  );
}

// 届いたと言ってよいのは `answered` / `delivered` だけ（許可リスト）。知らない値は未達の側へ倒し、識別子を出さず `detail` だけを出す。
const SEND_OUTCOME_LABELS: Record<string, { label: string; reached: boolean }> = {
  answered: { label: '確認に答えた', reached: true },
  delivered: { label: '追加指示を届けた', reached: true },
  session_missing: {
    label: '届いていない（担当がこの仕事の会話を持っておらず、入り直せなかった）',
    reached: false,
  },
  declined: {
    label: '届けていない（世代が食い違う待機中の仕事を畳めなかったため、古い会話へも送らなかった）',
    reached: false,
  },
  unknown: { label: '届いたか確かめられなかった', reached: false },
  unreadable: { label: '届けていない（台帳の行が読めない形で入っている）', reached: false },
};

function describeSendResult(result: { outcome: string; detail: string }): {
  text: string;
  reached: boolean;
} {
  const known = Object.hasOwn(SEND_OUTCOME_LABELS, result.outcome)
    ? SEND_OUTCOME_LABELS[result.outcome]
    : undefined;
  if (known === undefined) return { text: redactBody(result.detail), reached: false };
  return { text: redactBody(`${known.label}: ${result.detail}`), reached: known.reached };
}

function SendOutcomeNote({ note }: { note: { text: string; reached: boolean } | undefined }) {
  if (note === undefined) return null;
  return (
    <p className={`mt-2 text-xs ${note.reached ? 'text-muted-foreground' : 'text-warn'}`}>
      {note.reached ? '' : '⚠ '}
      {note.text}
    </p>
  );
}

const WAITING_LABEL_MAX = 20;

function waitingLabel(summary: string): string {
  const flat = redactBody(summary).replace(/\s+/g, ' ').trim();
  return `「${flat.length > WAITING_LABEL_MAX ? `${flat.slice(0, WAITING_LABEL_MAX)}…` : flat}」`;
}

function PermissionWaitingRow({
  id,
  requestId,
  summary,
  askedAtNote,
}: {
  id: string;
  requestId: string;
  summary: string;
  askedAtNote: ReactNode;
}) {
  const send = useSendManagerMessage();
  // 1本の真偽値にしない: 「拒否」を押しても「許可」が回る。押したほうだけ `loading`、もう片方は `disabled` で塞ぐ。
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [note, setNote] = useState<{ text: string; reached: boolean } | undefined>(undefined);

  function answer(decision: 'allow' | 'deny') {
    if (busy !== null) return;
    setBusy(decision);
    setFailure(undefined);
    setNote(undefined);
    send(id, {
      text: decision === 'allow' ? '許可する' : '許可しない',
      requestId,
      decision,
    })
      .then((result) => {
        const described = describeSendResult(result);
        if (!described.reached) setNote(described);
      })
      .catch(setFailure)
      .finally(() => setBusy(null));
  }

  return (
    <div className="px-4 py-3">
      <p className="text-sm">{redactBody(summary)}</p>
      {askedAtNote}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy === 'allow'}
          aria-label={`${waitingLabel(summary)}を許可`}
          disabled={busy === 'deny'}
          onClick={() => answer('allow')}
        >
          許可
        </Button>
        <Button
          size="sm"
          // 「拒否」は取り返しのつく操作なので danger にしない。
          loading={busy === 'deny'}
          aria-label={`${waitingLabel(summary)}を拒否`}
          disabled={busy === 'allow'}
          onClick={() => answer('deny')}
        >
          拒否
        </Button>
      </div>
      <SendOutcomeNote note={note} />
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

function QuestionWaitingRow({
  id,
  requestId,
  summary,
  askedAtNote,
}: {
  id: string;
  requestId: string;
  summary: string;
  askedAtNote: ReactNode;
}) {
  const send = useSendManagerMessage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [note, setNote] = useState<{ text: string; reached: boolean } | undefined>(undefined);
  useReportDirty(`question-answer:${requestId}`, text.trim() !== '');

  function submit() {
    // ボタンの `disabled` だけに頼らない: Cmd/Ctrl+Enter でもここへ来る。
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    setNote(undefined);
    // `decision` を付けない: 質問に allow/deny は無く、付けると日誌に `[allow]` の接頭辞だけが残って嘘になる。
    const sent = text;
    send(id, { text: sent, requestId })
      .then((result) => {
        const described = describeSendResult(result);
        // 届いていないのに入力を空にしない。届いたときも、応答を待つ間に打ち足した分は残す。
        if (described.reached) setText((current) => unsentInput(current, sent));
        else setNote(described);
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <div className="px-4 py-3">
      <p className="text-sm">{redactBody(summary)}</p>
      {askedAtNote}
      <div className="mt-2">
        <Textarea
          rows={2}
          value={text}
          placeholder="この質問への答えを、自分の言葉で書く"
          aria-label={`${waitingLabel(summary)}への答え`}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          maxHeight="12rem"
          onSubmitShortcut={submit}
          submitDisabled={busy || text.trim() === ''}
          refocusAfterSubmit
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={text.trim() === ''}
            onClick={submit}
            aria-label={`${waitingLabel(summary)}へ答えを送信`}
          >
            送信
          </Button>
          <SubmitHint action="送信" />
        </div>
      </div>
      <SendOutcomeNote note={note} />
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

// `kind` が `'question'` 以外はすべて実行許可として扱う: api-client は実行時検証を持たず、版のずれで `undefined` や未知の文字列が届きうる。倒れ先は何も消さない2ボタン。
function WaitingRow({
  id,
  requestId,
  summary,
  kind,
  askedAt,
}: {
  id: string;
  requestId: string;
  summary: string;
  kind: ManagerSummary['waiting'][number]['kind'] | undefined;
  askedAt: string | undefined;
}) {
  const askedAtNote = <AskedAtNote askedAt={askedAt} />;

  if (kind === 'question') {
    return (
      <QuestionWaitingRow
        id={id}
        requestId={requestId}
        summary={summary}
        askedAtNote={askedAtNote}
      />
    );
  }

  return (
    <PermissionWaitingRow
      id={id}
      requestId={requestId}
      summary={summary}
      askedAtNote={askedAtNote}
    />
  );
}

const REASON_ID = 'send-message-disabled-reason';

// `live === false` というだけで `disabled` にしない: 繋がっていない相手への送信は resume に化けるので、人間が自分の言葉で繋ぎ直す唯一の手になる。
// 止めるのは「戻る先（`session_id`）が無い」と分かっている相手だけ（`live` だけで判定しない: `live === true` なら `session_id` が無くても届く）。
// 無効にするときは、操作するその場に理由を置く（黙って無効にしない）。
function SendMessage({
  id,
  live,
  sessionId,
}: {
  id: string;
  live: boolean;
  sessionId: string | undefined | null;
}) {
  const noWayBack = !live && (sessionId === undefined || sessionId === null);
  const send = useSendManagerMessage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; reached: boolean } | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  useReportDirty('send-message', text.trim() !== '');

  function submit() {
    // ボタンの `disabled` だけに頼らない: ⌘/Ctrl+Enter はボタンを経由しないので、送信中も弾かないと押した数だけ割り込みが飛ぶ。
    if (text.trim() === '' || noWayBack || busy) return;
    setBusy(true);
    setFailure(undefined);
    // 次の送信が失敗しても、前回の「届けた」が今回のものに見えないようにする。
    setOutcome(undefined);
    const sent = text;
    send(id, { text: sent })
      .then((result) => {
        const described = describeSendResult(result);
        setOutcome(described);
        // 届いていないときは入力を残す。届いたときも、応答を待つ間に打ち足した分は残す。
        if (described.reached) setText((current) => unsentInput(current, sent));
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader title="話しかける" subtitle="走行中のマネージャーに追加の指示を割り込ませる" />
      <div className="px-4 py-3">
        {noWayBack ? (
          <p id={REASON_ID} className="mb-2 text-xs text-destructive">
            <strong className="font-medium">送れない</strong>—
            この仕事は戻る先（session_id）を持っておらず、送っても runner
            へは何も飛ばない。続きが要るなら
            <strong className="font-medium">新しく起こし直すこと</strong>。
          </p>
        ) : (
          !live && (
            <p className="mb-2 text-xs text-destructive">
              この相手とは繋ぎ直せていないが、
              <strong className="font-medium">送信は止めていない</strong>—
              送ると引き取り（resume）を試み、戻れればそのまま届く。
              <strong className="font-medium">戻れなければ理由がここに出る。</strong>
            </p>
          )
        )}
        <div className="flex items-end gap-2">
          {/* 入力欄までは塞がない: 書きかけの言葉を取り上げる理由が無く、起こし直した後にそのまま送れる。 */}
          <Textarea
            className="min-w-0 flex-1"
            rows={2}
            value={text}
            placeholder="追加の指示"
            aria-label="追加の指示"
            onChange={(event) => setText(event.target.value)}
            maxHeight="12rem"
            onSubmitShortcut={submit}
            submitDisabled={busy || noWayBack || text.trim() === ''}
          />
          <Button
            variant="primary"
            loading={busy}
            disabled={text.trim() === '' || noWayBack}
            {...(noWayBack ? { 'aria-describedby': REASON_ID } : {})}
            onClick={submit}
          >
            送る
          </Button>
        </div>
        <div className="mt-2">
          <SubmitHint action="送る" />
        </div>
        <SendOutcomeNote note={outcome} />
        <ErrorNote error={failure} className="mt-2" />
      </div>
    </Card>
  );
}

function Transcript({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const { data, error, isLoading } = useManagerTranscript(open ? id : null);
  // 取れなかったのを空と描かない: 「(空)」を出すと、セッションログが空だったように読める。
  const transcriptUnavailable = data === undefined && error !== undefined;
  // 404 は下で日本語で言う: 応答の素の文（英語の `not found`）を赤い帯に出さないため（アーカイブの本文と同じ）
  const noTranscript = transcriptUnavailable && error instanceof ApiError && error.status === 404;
  // 伏せ字は全体に一度だけ掛け、窓で切るのはその後にする: 切れ目をまたぐ秘密を取りこぼさない。数 MB になりうるので `data` が変わったときだけ計算する。
  const redacted = useMemo(() => {
    if (data?.kind !== 'body' || data.body === '') return undefined;
    const text = redactBody(data.body);
    return { text, size: formatBytes(new Blob([text]).size) };
  }, [data]);

  return (
    <Card>
      <CardHeader
        title="セッションログ（生）"
        subtitle="compaction で潰される前の全文"
        action={
          <Button size="sm" onClick={() => setOpen((value) => !value)}>
            {open ? '閉じる' : '開く'}
          </Button>
        }
      />
      {open && (
        <div className="px-4 py-3">
          <ErrorNote error={noTranscript ? undefined : error} />
          {isLoading ? (
            <Spinner />
          ) : noTranscript ? (
            <Empty>このマネージャーの生ログはありません</Empty>
          ) : transcriptUnavailable ? null : data?.kind === 'removed' ? (
            <RemovedBody removedAt={data.removedAt} bytes={data.bytes} />
          ) : redacted === undefined ? (
            <pre className="max-h-[32rem] overflow-auto rounded border border-border bg-background p-2 text-[11px] text-muted-foreground">
              (空)
            </pre>
          ) : (
            <WindowedText
              text={redacted.text}
              totalNote={redacted.size}
              testId="manager-transcript"
            />
          )}
        </div>
      )}
    </Card>
  );
}
