import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Card, CardHeader, Markdown } from '@alteroid/ui';
import { formatDateTime, formatRelative, redactBody } from '@alteroid/logic';
import { terminalFailureNote as sharedTerminalFailureNote } from '~/lib/manager-failure-note';

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
  describeObservedWorktreeBranch,
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  isEmptyCompleteUnpushedWorkObservation,
  UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE,
} from '@alteroid/core/unpushed-work-observation-format';
import { denialActorTag, describeDenialFollowUp } from '@alteroid/core/denial-format';
import type { ManagerDenial, ManagerStatus, ManagerSummary } from '@alteroid/logic';

// 「いま送っても届かない」とも「送れば届く」とも書かない: 送信そのものが resume の契機で、resume は失敗しうるので、契機になるところまでしか言えない。
export function DisconnectedNote({ live }: { live: boolean }) {
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
export function LostNote({ status }: { status: ManagerStatus }) {
  if (status !== 'lost') return null;
  return (
    <p className="border-t border-border px-4 py-3 text-xs text-destructive">
      前のセッションへ戻れなかった。
      <strong className="font-medium">戻れたかどうかしか見ていない</strong>
      ので、このマネージャーが終わっていたかどうかは分からない。落ちる直前に PR を出して CI
      を通し、マージまで届いていたマネージャーがこの札を貼られた実例がある。
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
export function FailureNote({ manager }: { manager: ManagerSummary }) {
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
      <strong className="font-medium">このマネージャーは死んでいない</strong>
      。セッションは生きているので、原因が解ければ下の「話しかける」から続けられる（だから状態は
      <strong className="font-medium">失敗ではなく待機中</strong>
      のままである）。
    </>
  );
}

// 軸は `markup` ではなく `lastFailure`: 失敗回の本文はデーモンの頭・SDK の生文言・途中出力の連結で、記法を決められない。
// 失敗回は素のテキストで出す: SDK の生文言を化けさせず検索できるようにするため（犠牲: 途中出力の `**…**` が記法のまま見える）。切り詰めも言い換えもしない。
export function LastReportBody({
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

export function denialTotal(denials: ManagerDenial[] | undefined): number {
  return (denials ?? []).reduce((sum, entry) => sum + entry.count, 0);
}

// key を層込みにする: 同じ道具が層違い（`Bash`(worker) と `Bash`(manager)）で2件返りうるので、`entry.tool` だけだと重複キーになる。
// 件数はデーモンのプロセス内にしか無く、止まったかどうかは見ていないので、観測した分しか言わない。
export function DenialsCard({
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
        <strong className="font-medium">
          それでこのマネージャーが止まったかどうかは見ていない
        </strong>
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
    'この状態そのものは何も止めていない——このマネージャーは動き続けてよい。長時間の作業者委譲（Agent 等）の' +
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
            {describeObservedWorktreeBranch(wt)}
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
export function DiagnosticsCard({ manager }: { manager: ManagerSummary }) {
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
