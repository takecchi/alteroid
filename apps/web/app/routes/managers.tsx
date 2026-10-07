import { useMemo } from 'react';
import { Link, Outlet, useLocation, useParams, useSearchParams } from 'react-router';

import {
  Page,
  Empty,
  ErrorNote,
  FilterChips,
  ListDetail,
  ListDetailItems,
  Spinner,
  StatusBadge,
  WarnNote,
} from '@alteroid/ui';
import { MANAGERS_PAGE, useManagers, useManagersWindow } from '@alteroid/swr';
import { formatRelative, redactBody, STATUS_SEARCH_PARAM } from '@alteroid/logic';
import { terminalFailureNote } from '~/lib/manager-failure-note';
import { LoadError } from '~/components/load-error';
import type { ManagerDenial, ManagerStatus, ManagerSummary, UnreadableJob } from '@alteroid/logic';

const UNREADABLE_JOB_IDS_SHOWN = 20;

// 「居ないのでも、畳まれたのでもない」を落とさない: 落とすと行が消えたのと区別が付かないため
export function UnreadableJobNote({
  unreadable,
  className,
}: {
  unreadable: readonly UnreadableJob[];
  className?: string;
}) {
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  const ids = idsAll.slice(0, UNREADABLE_JOB_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  return (
    <WarnNote className={className}>
      読めない委譲が {unreadable.length} 件ある
      {ids.length > 0 &&
        `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`}
      。<strong>壊れた行であって、居ないのでも、畳まれたのでもない。</strong>
      この一覧には載っていない。
    </WarnNote>
  );
}

const STATUS: Record<ManagerStatus, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }> =
  {
    running: { tone: 'ok', label: '実行中' },
    waiting_human: { tone: 'warn', label: '人間待ち' },
    // 「完了」と書かない: done はマネージャー自身のターンが終わって待機しているだけで、仕事が終わったとは限らないため
    done: { tone: 'neutral', label: '待機中' },
    failed: { tone: 'danger', label: '失敗' },
    // 「復旧不能」と書かない: 観測したのは前のセッションへ戻れなかったことだけで、成果の有無は見ていないため
    lost: { tone: 'danger', label: 'セッションへ戻れず' },
    // done（待機中）と混ぜない: stopped は外から止められ、runner のセッション一覧から消えたことを確かめた終端のため
    stopped: { tone: 'neutral', label: '停止済み' },
  };

export function ManagerStatusBadge({ status }: { status: ManagerStatus }) {
  return <StatusBadge status={status} map={STATUS} />;
}

// 切ったことは必ず言う: 黙って落とすと「3種類しか止められていない」に見えるため
const LIST_DENIED_TOOLS = 3;

export function summarizeDenials(denials: ManagerDenial[]) {
  // 末尾から採る: デーモンは古い順で返し、読む側が知りたいのはいま止まっているものだから
  const recent = [...denials].reverse();
  return {
    shown: recent.slice(0, LIST_DENIED_TOOLS),
    rest: Math.max(recent.length - LIST_DENIED_TOOLS, 0),
    total: denials.reduce((sum, entry) => sum + entry.count, 0),
  };
}

// manager.ts の同名の関数を import せず写す: この画面は別のデプロイで @alteroid/core を読まないため
export function describeDenialFollowUp(
  denials: readonly Pick<ManagerDenial, 'lastAt'>[],
  lastReportAt: string | undefined,
): string | null {
  if (denials.length === 0) return null;
  const times = denials.map((denial) => denial.lastAt);
  if (times.some((time) => time === undefined)) {
    return '最後に止められた時刻が取れていない拒否が在るので、止められた後に報告が届いたかは判定できない';
  }
  const latest = (times as string[]).reduce((a, b) => (a > b ? a : b));
  if (lastReportAt !== undefined && lastReportAt > latest) {
    return (
      `最後に止められた（${latest}）後にも報告が届いている（${lastReportAt}）。` +
      '止められた道具を別の手で越えたかまでは見ていない'
    );
  }
  return `最後に止められた（${latest}）後の報告はまだ届いていない`;
}

export function denialActorTag(actor: ManagerDenial['actor']): string {
  return actor === 'manager' ? ' [マネージャー]' : actor === 'worker' ? ' [作業者]' : ' [層不明]';
}

// 「止まっている」と断定しない: 拒否の出所は数から取れず、器側の拒否と alteroid 自身のフックの拒否で帰結が違うため
export function ManagerDenialNote({
  denials,
  lastReportAt,
}: {
  denials: ManagerDenial[];
  lastReportAt?: string;
}) {
  if (denials.length === 0) return null;
  const { shown, rest, total } = summarizeDenials(denials);
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  return (
    <p className="mt-1 text-[11px] text-warn">
      ⚠ 確認へ上がらず止められた道具:{' '}
      {shown
        .map((entry) => `${entry.tool} ${entry.count}件${denialActorTag(entry.actor)}`)
        .join(' / ')}
      {rest > 0 && `（ほか ${rest} 種、全 ${total} 件）`}
      。まず担い手自身に返っている拒否文を読ませること。出所はこの数からは取れない—— (a)
      器の分類器か deny 規則なら、この確認はクローンには回ってきていないので手が止まる。 (b)
      alteroid 自身の PreToolUse フック（bash-wait-guard.ts
      等）なら、理由と代替案は担い手へ直接返っており、自力で抜けられることがある。
      {followUp !== null && `${followUp}。`}
    </p>
  );
}

// 札を「失敗」へ倒さない: 支出上限に当たった回もセッションは生きていて、台帳の status は done のままのため
export function ManagerFailureNote({
  failure,
  status,
  lastFoldedTurn,
}: {
  failure: ManagerSummary['lastFailure'] | undefined;
  status: ManagerStatus;
  lastFoldedTurn: ManagerSummary['lastFoldedTurn'];
}) {
  if (failure === undefined || failure === null) return null;
  // lastFoldedTurn が在る回は出さない: その回の lastFailure は畳まれる前の無関係な古いターンを指すため
  if (lastFoldedTurn !== undefined) return null;
  return (
    <p className="mt-1 text-[11px] text-destructive">
      ⚠ 直近のターンは報告ではなく失敗で終わっている: {failure.code}（{failure.via}）。
      {terminalFailureNote(status) ??
        'セッションは生きているので、原因が解ければ話しかければ続く。'}
    </p>
  );
}

// ManagerSessionMissingNote と1つに畳まない: 源も live との関係も次の一手も違う主張のため
// 「この委譲が失われた」「いま話しかけられない」と書かない: 器の中でまだ走っている可能性が残り、送ればデーモンは実際に resume を試すため
export function ManagerRunnerLostNote({
  runnerLostSince,
  className = 'mt-1 text-[11px] text-destructive',
}: {
  runnerLostSince: string | undefined;
  className?: string;
}) {
  if (runnerLostSince === undefined || runnerLostSince === null) return null;
  return (
    <p className={className}>
      ⚠ 宛先の器は{formatRelative(runnerLostSince)}
      から名乗っていない。新しい委譲の宛先からは外れている（置き先として数えない）。この委譲が失われたという意味ではない
      —
      黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。話しかけることは塞いでいない
      — 戻る先（session_id）が在れば、送ると resume
      を試みる（届くとは限らない）。打つ手はこの委譲の側ではなく器の側にある —
      名乗らなくなった器そのものを確かめること。
    </p>
  );
}

// 時刻は出さない: 消えた時刻は名簿に残っておらず、作ると「いつ消えたか」の嘘になるため
export function ManagerRunnerVanishedNote({
  runnerVanished,
  className = 'mt-1 text-[11px] text-destructive',
}: {
  runnerVanished: boolean | undefined;
  className?: string;
}) {
  if (runnerVanished !== true) return null;
  return (
    <p className={className}>
      ⚠ 宛先の器が名簿から消えている（消えた時刻は名簿に残っていないので分からない）。resume
      を試したわけではないので「戻れなかった(lost)」ではなく、「セッションへ戻れず」で絞っても出てこない。状態は実行中のまま残っている
      — 確かめる前に起こし直さないこと（同じ仕事が2本になる）。
    </p>
  );
}

// 札を差し替えず状態に添える: status は done のままで、握り潰しの分岐より前に書き換わるため台帳の軸では区別が付かないため
// undefined のとき何も描かない: runner がこの欄を名乗らない版では、実際に待っていても立たないため
export function ManagerAwaitingBackgroundNote({
  awaitingBackground,
  className = 'mt-1 text-[11px] text-muted-foreground',
}: {
  awaitingBackground: ManagerSummary['awaitingBackground'];
  className?: string;
}) {
  if (awaitingBackground === undefined || awaitingBackground === null) return null;
  return (
    <p className={className}>
      背景処理の完了待ちで畳んだターンである（手が空いたのではない）。器が最後に名乗った在り高は
      {awaitingBackground.tasks} 件（{awaitingBackground.breakdown}）で、
      {formatRelative(awaitingBackground.since)}
      から待っている。この間の報告 {awaitingBackground.withheldReports}{' '}
      本はクローンへ配っていない（捨てたのではない — 完了すれば次の報告と一緒に届く）。
    </p>
  );
}

// 「この委譲が失われた」と書かない: 仕事の途中で失われたのか、完遂後にセッションが畳まれ終端の合図だけが届かなかったのかを台帳から区別できず、決めつけると完遂済みの仕事を委譲し直すため
// text-destructive にしない: 「失われたとは言えない」ことのほうが主張のため
export function ManagerSessionMissingNote({
  sessionMissingSince,
  sessionMissingKind,
  className = 'mt-1 text-[11px] text-warn',
}: {
  sessionMissingSince: string | undefined;
  sessionMissingKind?: ManagerSummary['sessionMissingKind'];
  className?: string;
}) {
  if (sessionMissingSince === undefined || sessionMissingSince === null) return null;
  return (
    <p className={className}>
      ⚠ 宛先の runner は{formatRelative(sessionMissingSince)}
      の時点で、この委譲のセッションを持っていなかった（runner
      がそう答えた。聞けなかったのではない）。{describeSessionMissingKindNote(sessionMissingKind)}
      この委譲が失われたという意味ではない —
      完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える。まず最後の報告とセッションログ（生）を確かめること（報告が届いていなくても、書き終えた報告がそこに残っていることがある）。話しかければ
      resume から入り直すので、同じ依頼をもう一度出して起こし直さないこと — 同じ仕事が2本になる。
    </p>
  );
}

// core の describeSessionMissingKind を import せず写す: packages/core を Web のバンドルへ引き込まないため
export function describeSessionMissingKindNote(kind: ManagerSummary['sessionMissingKind']): string {
  switch (kind) {
    case 'resume-failed':
      return 'resume でも入り直せなかった。';
    case 'unlisted':
      return '名簿に載っていなかった。resume はまだ試していない。';
    case undefined:
      return '';
    default: {
      // 値をそのまま画面に出さない: デーモンが先に3つ目の値を返すと、分岐キーの生の値が画面に出るため
      const unreachable: never = kind;
      void unreachable;
      return '';
    }
  }
}

// 固定リストを別に持たず STATUS から起こす: 札を足したのにチップに出ない状態を無くすため
// 絞りは画面側で filter せずサーバへ投げる: 窓に読み込んだぶんの中でしか絞れず、CLI やクローンでできることが Web でだけできなくなるため
const STATUSES = Object.keys(STATUS) as [ManagerStatus, ...ManagerStatus[]];

// 知らない値を残さない: 対応するチップが無く、選択されているのにどのチップも押されて見えない状態になるため
function parseSelectedStatuses(raw: string | null): readonly ManagerStatus[] {
  if (raw === null || raw === '') return [];
  const result: ManagerStatus[] = [];
  for (const part of raw.split(',')) {
    if (part === '') continue;
    if (!(STATUSES as readonly string[]).includes(part)) continue;
    const status = part as ManagerStatus;
    if (!result.includes(status)) result.push(status);
  }
  return result;
}

export default function Managers() {
  // 絞りを画面の state に閉じ込めない（正本は URL）: 開き直すと消え、戻るで戻れず、リンクで共有できないため
  // replace: true にする: チップの操作ごとに履歴が積まれると「戻る」が使えなくなるため
  // debounce しない: チップのクリックは1回で完結した操作で、検索語のような「入力の途中」が無いため
  const [searchParams, setSearchParams] = useSearchParams();
  // useMemo で包む: 描画のたびに selected が新しい配列になり、それに依存する effect・memo が毎回走り直すため
  const rawStatus = searchParams.get(STATUS_SEARCH_PARAM);
  const selected = useMemo(() => parseSelectedStatuses(rawStatus), [rawStatus]);

  function toggle(status: ManagerStatus) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        const current = parseSelectedStatuses(next.get(STATUS_SEARCH_PARAM));
        const updated = current.includes(status)
          ? current.filter((s) => s !== status)
          : [...current, status];
        if (updated.length === 0) next.delete(STATUS_SEARCH_PARAM);
        else next.set(STATUS_SEARCH_PARAM, updated.join(','));
        return next;
      },
      { replace: true },
    );
  }

  function clearSelected() {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(STATUS_SEARCH_PARAM);
        return next;
      },
      { replace: true },
    );
  }

  const all = useManagers({ status: [], limit: MANAGERS_PAGE });
  const nothingAtAll =
    all.data !== undefined &&
    all.data.managers.length === 0 &&
    (all.data.unreadable ?? []).length === 0;
  const hideChips = nothingAtAll && selected.length === 0;

  const { id: selectedId } = useParams();
  const { search } = useLocation();

  return (
    <Page
      title="マネージャー"
      description="クローンが起こした仕事。人間が Claude Code に頼んだのと同じ位置にいる"
      className="overflow-hidden p-0 md:p-0"
    >
      <div className="flex h-full flex-col">
        {hideChips ? null : (
          <FilterChips
            className="shrink-0 border-b border-border px-4 py-3 md:px-6"
            label="状態で絞り込む"
            options={STATUSES.map((status) => ({ value: status, label: STATUS[status].label }))}
            selected={selected}
            onToggle={toggle}
            onClear={clearSelected}
          />
        )}

        <ListDetail
          className="min-h-0 flex-1"
          listLabel="マネージャーの一覧"
          detailLabel="マネージャーの詳細"
          hasSelection={selectedId !== undefined}
          selectionKey={selectedId}
          emptyDetail={<Empty>左の一覧からマネージャーを選ぶと、その中身がここに出る。</Empty>}
          /* effect の中で reset せず key で作り直す: prop が変わったら effect の中で reset する形は eslint（react-hooks/set-state-in-effect）に落ちるため */
          list={
            <ManagersList
              key={selected.join(',')}
              selected={selected}
              selectedId={selectedId}
              search={search}
            />
          }
          /* 詳細は委譲の id で key して作り直す: key が無いと A の書きかけが B へ引き継がれ、A 宛てに書いた指示が B に届くため */
          detail={<Outlet key={selectedId} />}
        />
      </div>
    </Page>
  );
}

const EMPTY_ALL = (
  <>
    まだマネージャーはいません。
    <Link to="/chat" className="underline">
      会話
    </Link>
    で作業を頼むと、ここに出ます。
  </>
);

function ManagersList({
  selected,
  selectedId,
  search,
}: {
  selected: readonly ManagerStatus[];
  selectedId: string | undefined;
  search: string;
}) {
  const {
    managers,
    isLoadingInitial,
    error,
    unreadable,
    olderStatus,
    isLoadingOlder,
    olderError,
    olderRefreshError,
    loadOlder,
    reload,
    isReloading,
  } = useManagersWindow(selected);
  // 取れなかったのを0件と描かない: 読めていないのにマネージャーが居ないように読めるため
  const listUnavailable = error !== undefined && managers.length === 0;

  return (
    <>
      <LoadError
        what="マネージャー一覧"
        error={error}
        onRetry={reload}
        retrying={isReloading}
        className="m-3"
      />
      <UnreadableJobNote unreadable={unreadable} className="m-3" />
      {isLoadingInitial ? (
        <Spinner />
      ) : listUnavailable ? null : managers.length === 0 ? (
        <Empty inset="card">
          {unreadable.length > 0
            ? selected.length === 0
              ? '読めたマネージャーは無い（読めない行が在るので、居ないとは言えない）。'
              : '読めた範囲では、この状態のマネージャーは無い（読めない行の状態は分からない）。'
            : selected.length === 0
              ? EMPTY_ALL
              : 'この状態のマネージャーは無い（絞りを解除すれば他の状態も出る）。'}
        </Empty>
      ) : (
        <ListDetailItems
          label="マネージャー"
          items={managers.map((manager) => ({
            key: manager.managerId,
            href: `/managers/${manager.managerId}${search}`,
            current: manager.managerId === selectedId,
            children: (
              <>
                <div className="flex items-center gap-2">
                  <ManagerStatusBadge status={manager.status} />
                  {/* live && <札> の形は書かない: live === false が「札が無い」でしか表せず、「切断されている」と「接続状態を報告していない」を区別できないため */}
                  {manager.live ? (
                    <span className="text-[11px] text-ok">接続あり</span>
                  ) : (
                    <span className="text-[11px] text-destructive">セッション切断</span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatRelative(manager.updatedAt)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 break-words text-sm">
                  {redactBody(manager.request)}
                </p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {manager.cwd}
                </p>
                {manager.waiting.length > 0 && (
                  <p className="mt-1 text-[11px] text-warn">
                    {manager.waiting.length} 件の確認待ち:{' '}
                    {redactBody(manager.waiting[0]?.summary ?? '')}
                  </p>
                )}
                <ManagerDenialNote
                  denials={manager.denials ?? []}
                  lastReportAt={manager.lastReportAt}
                />
                <ManagerFailureNote
                  failure={manager.lastFailure}
                  status={manager.status}
                  lastFoldedTurn={manager.lastFoldedTurn}
                />
                <ManagerAwaitingBackgroundNote awaitingBackground={manager.awaitingBackground} />
                <ManagerRunnerLostNote runnerLostSince={manager.runnerLostSince} />
                <ManagerRunnerVanishedNote runnerVanished={manager.runnerVanished} />
                {/* ManagerRunnerLostNote と else で繋がない: 2本並ぶ形が在るため */}
                <ManagerSessionMissingNote
                  sessionMissingSince={manager.sessionMissingSince}
                  sessionMissingKind={manager.sessionMissingKind}
                />
                {manager.status === 'lost' && (
                  <p className="mt-1 text-[11px] text-destructive">
                    前のセッションへ戻れなかっただけで、成果が残っているかは見ていない。起こし直す前に外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。
                  </p>
                )}
              </>
            ),
          }))}
          renderLink={({ href, ...rest }) => <Link to={href} {...rest} />}
        />
      )}

      {/* 3つの状態を畳まない: 進めなくなった状態が「全部読み終えた」と同じ顔で出るため */}
      {!isLoadingInitial &&
        managers.length > 0 &&
        olderRefreshError !== undefined &&
        error === undefined && (
          <p role="status" className="mx-3 mb-2 text-xs text-warn">
            「もっと見る」で読み足した行を最新に取り直せなかった。先頭の頁より後ろの行は、前に読めたときのもの。
          </p>
        )}
      {!isLoadingInitial && managers.length > 0 && (
        <div className="p-3">
          {olderStatus === 'progress' && (
            <button
              type="button"
              onClick={loadOlder}
              disabled={isLoadingOlder}
              className="w-full rounded-md border border-border py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              {isLoadingOlder ? '読み込み中…' : `もっと見る（いま ${managers.length} 件）`}
            </button>
          )}
          {olderStatus === 'end' && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              これより古い委譲は無い（全 {managers.length} 件）。
            </p>
          )}
          {olderStatus === 'blocked' && (
            <div>
              <ErrorNote error={olderError} className="mb-2" />
              <p className="mb-2 text-xs text-muted-foreground">
                これより古い委譲へ自動では進めない（いま {managers.length}{' '}
                件。全部読み終えたのではない）。読んでいる間にその委譲の状態が動いて、絞りの外へ出た場合に起きる。もう一度押すか、絞りを変えて先頭から読み直すこと。
              </p>
              <button
                type="button"
                onClick={loadOlder}
                disabled={isLoadingOlder}
                className="w-full rounded-md border border-border py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                {isLoadingOlder ? '読み込み中…' : 'もう一度試す'}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
