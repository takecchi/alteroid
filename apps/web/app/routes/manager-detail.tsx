import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  DocumentTitle,
  Markdown,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  isImeConfirmEnter,
  KeyValueList,
  Spinner,
  Textarea,
} from '@alteroid/ui';
import {
  useAbortManager,
  useSendManagerMessage,
  useManager,
  useManagerTranscript,
  ApiError,
} from '@alteroid/swr';
import {
  describeManagerProvider,
  formatDateTime,
  formatRelative,
  redactBody,
  usageHref,
} from '@alteroid/logic';
import { terminalFailureNote as sharedTerminalFailureNote } from '~/lib/manager-failure-note';

/**
 * **`manager-activity.ts` は `@alteroid/core` 本体（`.`）とは別の軽い口
 * （`tsup.config.ts` の doc）。** 実行時の依存を1つも持たないので、
 * バレル全体（サーバ専用のドメイン層ごと）を引き込む #294 / #306 の事故には
 * 当たらない——`describeReportDrift` / `classifyManagerActivity` は、クローンの
 * `manager_list` / `manager_report`（`packages/core/src/tools.ts`）が読んでいる
 * のと同じ判定を、この画面（診断欄）にも1本だけの正本から届ける。
 */
import { classifyManagerActivity, describeReportDrift } from '@alteroid/core/manager-activity';
/**
 * **`cgroup-events-format.ts` は `manager-activity.ts` と同じ形の軽い口**
 * （`tsup.config.ts` の doc）。実行時の依存を1つも持たない。**この画面はかつて
 * この2つ（`CGROUP_EVENTS_UNKNOWN_NOTE` / `formatCgroupEventsNote`）を手で
 * 複製していた**（隣の `cgroup-events.ts` が zod を同じファイルに持つため
 * 軽い口にできなかった、というのが当時の判断）——issue の指摘を受けて
 * 複製をやめ、クローンの `manager_list` / `manager_report`
 * （`packages/core/src/tools.ts`）が読んでいるのと同じ文言を、ここでも
 * 1本だけの正本から届ける形にした。
 */
import {
  CGROUP_EVENTS_UNKNOWN_NOTE,
  formatCgroupEventsNote,
} from '@alteroid/core/cgroup-events-format';
import { maskUrl } from '@alteroid/core/mask-url';
/**
 * **`system-error-format.ts` も同じ形の軽い口。** `formatSystemErrorFacts`
 * （`code`/`errno`/`syscall` の整形）は core と1文字も変えず共有する。
 * D（判定できなかった）の文言は、クローン向け
 * （`packages/core/src/system-error.ts` の `SYSTEM_ERROR_UNKNOWN_NOTE`）と
 * この画面とで末尾の「次にどこを見ればよいか」の指し先だけが意図して違う
 * ——クローン向けは欄名 `lastFailure` を直接指すが、この画面はその欄を
 * 出していないので、代わりに下の「直近のターンは報告ではなく失敗で終わって
 * いる」の注記を指す（`formatSystemErrorUnknownNote` の doc）。共通部分
 * （枠 429 とセッション切断はこの欄の対象外という本文）はここでも複製せず、
 * 指し先の一言だけをこの画面が渡す。
 */
import {
  formatSystemErrorFacts,
  formatSystemErrorUnknownNote,
} from '@alteroid/core/system-error-format';
/**
 * **`unpushed-work-observation-format.ts` も同じ形の軽い口**（Issue #1885）。
 * 台帳の観測が「確かめきれなかった」ことを持つとき、クローンの
 * `manager_list`（`packages/core/src/tools.ts` の
 * `describeUnpushedWorkObservation`）が読んでいるのと同じ1文を、この画面
 * にも同じ生成元から届ける。
 */
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  isEmptyCompleteUnpushedWorkObservation,
  UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE,
} from '@alteroid/core/unpushed-work-observation-format';
import type { ManagerDenial, ManagerStatus, ManagerSummary } from '@alteroid/logic';

import type { Route } from './+types/manager-detail';
/**
 * **`ManagerRunnerLostNote` / `ManagerSessionMissingNote` は書き写さずに一覧から
 * 借りる。** 文言の核は
 * クローン（`tools.ts`）・CLI（`chat.ts`）と逐語で揃える約束のものなので、同じ
 * 画面（Web UI）の中で2箇所に写すと直すときに片方だけ直る（`denialActorTag` と
 * 同じ理由）。ここで変えてよいのは置き場所（`className`）だけである。
 */
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

/**
 * header に添える一文。
 *
 * **ここに依頼の全文（`manager.request`）を渡さない。** `Page` の header は
 * `shrink-0` なので、渡した文字数のぶんだけ header が縦に伸び、その下の本文
 * （状態・返事待ち・最後の報告）が画面の外へ押し出される。実際に「本文が長いと
 * header が大きく content が見えない」という報告が出た場所である。**他の画面の
 * `description` はすべて固定の一文**で、可変長の本文が入っているのはここだけ
 * だった。依頼そのものは本文側の `RequestCard` が全文を持つ。
 */
const PAGE_DESCRIPTION = 'この仕事1本の状態と、走行中に割り込む口。依頼の全文は下';

const NOT_FOUND_DESCRIPTION = '指定されたマネージャーはありません';

export default function ManagerDetail({ loaderData }: Route.ComponentProps) {
  const { id } = loaderData;
  const { data, error, isLoading } = useManager(id);
  const navigate = useNavigate();
  const { search } = useLocation();
  const abortManager = useAbortManager();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const manager = data?.manager;
  /**
   * **「見つからない」は 404 のときだけ言う**（issue #2321）。詳細をまだ一度も読めていない
   * まま 500・通信断で失敗したとき、失敗は上の `ErrorNote` が言う。ここで「見つからない」を
   * 出すと、読めていないのに委譲が存在しないように読める。再検証の失敗で `data` が残って
   * いるときは当たらず、詳細をそのまま出す。
   *
   * **409（委譲の行は在るが、読めない形で入っている。issue #2359）も「見つからない」ではない。**
   * 居ないのではなく壊れているだけなので、デーモンの言い分（理由つき）を `ErrorNote` が出す。
   */
  const notFound = data === undefined && error instanceof ApiError && error.status === 404;
  const detailUnavailable = data === undefined && error !== undefined && !notFound;

  return (
    <>
      {/*
        詳細は一覧の右のペインに出る（親の経路 `managers.tsx` の `ListDetail`）ので、画面の枠
        （`Page`）も戻るリンクも持たない。画面の h1 は親が持ち、ここの見出しは h2。狭い画面では
        `ListDetail` の「マネージャーの一覧を開く」が一覧への戻り口になる。
      */}
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
            **状態で出し分けない。** ここはかつて `running` / `waiting_human` の
            ときだけ停止ボタンを描いていたが、絞っていたのは画面だけだった —
            CLI の `/stop`（`apps/cli/src/chat.ts`）は id を受け取ってそのまま
            `DELETE` を投げるだけで status を見ないし、デーモン
            （`apps/daemon/src/app.ts` の `.delete('/managers/:id')`）も
            `ManagerPool.abort`（`packages/core/src/manager.ts`）も、台帳に
            居ない（`absent`）以外では弾かない。**同じ行為が入口によって
            できたりできなかったりしていた**（PRD「入口の等価性」は「委譲の停止」を
            名指しで挙げている。北極星の禁止1）。

            **揃える方向は「できる側」である。** CLI から能力を削れば対称には
            なるが、それは禁止2 に触れる。

            **`done` を止めたい場面は実在する。** `done` は「死んだ」ではなく
            「終えて待機」で（`schema.ts` の `jobStatusSchema`、この画面の札も
            「待機中」）、セッションは生きている。待機したまま残っているものを
            畳む手が、Web にだけ無かった。

            **状態を列挙する形へ戻さないこと。** 状態は増えうるので、
            `status === X || status === Y` の形は増えた日に黙って新しい状態を
            締め出す（増えたことはこの行からは分からない）。**ここは1つも
            数え上げない**ことでそれを避けている。

            **押せない理由があるときは、非表示ではなく理由で出す。** 停止が
            通らなかった応答は `failure` に入り、下の `ErrorNote` に出る。
            ボタンを消すと、できないことと「この画面が扱っていないこと」を
            人間が区別できない。

            残っている `manager !== undefined` は**状態のガードではなく存在の
            ガード**である（読み込み中はまだ何も描けない）。
          */}
          {manager !== undefined ? (
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              onClick={() => {
                setBusy(true);
                setFailure(undefined);
                // 本文が要る（サーバ側に json バリデータが付いている）。
                abortManager(id, '人間が画面から停止した')
                  .then(() => navigate({ pathname: '/managers', search }))
                  .catch(setFailure)
                  .finally(() => setBusy(false));
              }}
            >
              停止する
            </Button>
          ) : undefined}
        </div>
      </header>

      {/* 404 は下のカードが日本語で言う。応答の素の文（英語の `not found`）を重ねて出さない（#2791）。 */}
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
                // **同じ母集合（この委譲の managerId）で使用量へ飛ぶだけ（issue
                // #2077）。ここで使用量を集計し直さない** — 数字の意味は
                // `/usage` が持つ（`usage.tsx` の doc）。逆向きのリンク
                // （`/usage` の「マネージャー別」→ `/managers/<id>`）は #2046 /
                // PR #2047 で在る。
                <Link
                  to={usageHref({ managerId: id })}
                  className="text-xs text-primary hover:underline"
                >
                  使用量を見る
                </Link>
              }
            />
            {/*
              **375px でもラベル列（8rem=128px）に取り分を持っていかれないよう、
              `sm:`（640px）未満は1列に積む。** `sm:` を選んだ理由: `reports.tsx`
              の `lg:grid-cols-[16rem_1fr]` は16remがlg(1024px)の1/4を占める
              太い列だからその境目を選んでいるが、ここは最大でも8rem(128px)＝
              sm(640px)の20%に過ぎず、`md:`/`lg:` まで待つ理由が無い。

              **積んだとき `dt`→`dd` が交互に並ぶので、行間だけでは
              「どの `dd` がどの `dt` のものか」が読めなくなる**（同じ間隔が
              対になる行にも次の組にも掛かる）。対策として、先頭以外の `dt` に
              上の余白を足す — 対になる `dd` との間隔は据え置きのまま、次の組が
              始まる前にだけ余分な間隔が入るので、組の境目が間隔の差で分かる
              （`sm:` 以上では打ち消し、2列表示の見た目は変えていない）。
              **この余白は `KeyValueList` が付ける**（先頭かどうかは添字で決める。
              理由は `KeyValueList` の doc）。
            */}
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
                      {/*
                        **状態の札の隣に並べる。** 拒否は `status` を置き換えない
                        — 分類器か deny 規則がその場で止めた仕事は「実行中」のまま
                        手が動かない。札を差し替えると、その事実が消える。
                      */}
                      {denialTotal(manager.denials) > 0 && (
                        <Badge tone="warn">
                          ⚠ 確認へ上がらず止められた {denialTotal(manager.denials)} 件
                        </Badge>
                      )}
                      {/*
                        **ここも札を差し替えない。** 上限に当たった回も `status` は
                        `done`（終えて待機中）のままである — 直近の1ターンがどう終わった
                        かは、状態とは別の軸である（`schema.ts` の `lastFailure`）。
                      */}
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
                // 欄が無いのは「不明」。claude とは描かない（`describeManagerProvider`）。
                {
                  label: 'provider',
                  value: describeManagerProvider(manager.managerProvider),
                  mono: true,
                },
                ...(manager.sessionId !== undefined && manager.sessionId !== null
                  ? [{ label: 'セッション', value: manager.sessionId, mono: true }]
                  : []),
                /*
                  貸し出し（どのプロセスが握っているか）。**判定は書かない** — 引き取って
                  よいかは時刻で変わるので（`packages/core/src/lease.ts`）、画面に焼くと
                  読んだ瞬間から古びる。ここに出すのは材料だけである。

                  材料が見えないと、引き取りが動かないのを見た人間は「忘れている」と
                  「まだ握られていて待っている」を区別できない。
                */
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
            {/*
              **`DisconnectedNote` の直後に置く。** あちらは「繋がっていない」と
              言うだけで理由を言わない——この欄が `live: false` の理由を1つ名指し
              する（`isLive()` は宛先が `silentRunners` に居ると false を返す）。
              **この注記は送信可否を推論しない**（`ManagerRunnerLostNote` の doc の
              実測表）。名簿が `lost` と判定した器でも `RunnerRegistry#get()` は client を
              返し、`send()` の `outcome` は実測で `delivered` / `session_missing` に
              なった（「名簿に開いていない」の `unknown` は *一度も開けていない* 宛先で
              しか出ない）⟹ ここで「いま話しかけられない」と書くと `ba4053d`（#67）が
              閉じた欠陥——「いま送っても届かず」の真下に届く送信ボタンが並ぶ形——の
              再発になる。**#67 の commit 本文の2値の表は `0fb068f`（PR #571）で
              4値になったので、そのまま当てないこと。**
            */}
            <ManagerRunnerLostNote
              runnerLostSince={manager.runnerLostSince}
              className="border-t border-border px-4 py-3 text-xs text-destructive"
            />
            <ManagerRunnerVanishedNote
              runnerVanished={manager.runnerVanished}
              className="border-t border-border px-4 py-3 text-xs text-destructive"
            />
            {/*
              **`DisconnectedNote` と排他ではない。** あちらは `live: false`
              （繋がっていない）のときだけ出る。こちらは `live: true` のまま出る
              のが正しい形で、上の「接続あり」の札と**同時に**並ぶ
              （`ManagerSessionMissingNote` の doc）。文言は一覧と同じ1箇所から
              借り、ここでは他の注記（`DisconnectedNote` / `LostNote` /
              `FailureNote`）と同じ置き場所へ揃えるだけにしてある。
            */}
            <ManagerSessionMissingNote
              sessionMissingSince={manager.sessionMissingSince}
              sessionMissingKind={manager.sessionMissingKind}
              className="border-t border-border px-4 py-3 text-xs text-warn"
            />
            {/*
              **「待機中」の札のすぐ下に置く。** 札だけだと、背景処理の完了を
              待っているマネージャーが「手が空いている」に見える——クローンの
              `manager_list` は `done/背景処理待ち×N` と読むので、この画面にだけ
              材料が無いと同じ状態を見て人間とクローンが違う判断をすることになる
              （`ManagerAwaitingBackgroundNote` の doc）。
            */}
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
              {/*
                **失敗で終わった回を「報告」と呼ばない。** 本文は runner 側で
                「（このターンは応答を返さずに終わった: …）」と包まれているが、
                見出しが「最後の報告」のままだと、人間は包みの内側だけを読んで
                報告として扱う（それが `You've hit your org's monthly spend
                limit …` を報告として読ませていた形そのものである）。
              */}
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
    </>
  );
}

/**
 * この仕事へ渡した依頼の全文。
 *
 * **header ではなく本文に置く。** 以前はこれを `Page` の `description` へ渡して
 * いた。header は `shrink-0`（`components/page.tsx`）なので、依頼が長いぶんだけ
 * header が縦に伸び、スクロールできる本文の領域がそのぶん潰れる — 長い依頼では
 * 状態カードすら画面に入らなくなっていた。**本文側に置けば、伸びるのは
 * スクロールできる側になる。**
 *
 * **要約も切り詰めもしない。** 一覧（`managers.tsx`）は
 * `truncate` で1行に畳んでいるが、詳細まで降りてきた人間が読みに来るのは
 * 「何を頼まれた仕事なのか」そのものである。長いときは**消さずにこのカードの
 * 中でスクロールさせる** — 上限で切ると、下のカード（状態・返事待ち・最後の報告）を
 * 押し出す側の問題に戻る。
 *
 * **改行はそのまま出す（`whitespace-pre-wrap`）。** 依頼は箇条書きや手順で書かれる
 * ことが多く、潰すと読めない。Markdown として解釈はしない — ここに出したいのは
 * クローンが渡した文字列そのものであって、その整形結果ではない。
 */
function RequestCard({ request }: { request: string }) {
  return (
    <Card className="min-w-0">
      <CardHeader title="依頼" subtitle="この仕事を起こしたときに渡した指示（全文）" />
      {/*
        **`max-h` はここ（本文の側）に置く。** 依頼だけが長い場合に、この
        カードの中をスクロールさせて他のカードを押し出さないための上限である。
        文字は1つも捨てていない。
      */}
      <div className="max-h-72 min-w-0 overflow-y-auto px-4 py-3">
        <p className="text-sm break-words whitespace-pre-wrap">{redactBody(request)}</p>
      </div>
    </Card>
  );
}

/**
 * 繋がっていないことを、**不在ではなく文で**言う。
 *
 * 札（`セッション切断`）だけだと「で、どうなるのか」が分からない。詳細まで
 * 降りてきた人間は「この1本をどうするか」を決めに来ているので、そこから何が
 * できるのかまで書く。
 *
 * **「いま送っても届かない」とは書かない（PR #66 のこの一言が嘘だった）。**
 * `ManagerPool.send`（`packages/core/src/manager.ts`）は台帳から像を作り直し、
 * `attached === false` なら `#resumeOnce(record, runner, message)` を呼ぶ —
 * **送信そのものが引き取り（resume）の契機**であり、送った言葉は resume の
 * `message` に載って運ばれる。`session_id` を持つ相手なら（`lost` でも）
 * `delivered` が返り、状態は `running`、`live` は `接続あり` へ戻る。
 *
 * **かといって「送れば届く」とも書かない。** resume は失敗しうる（失敗すれば
 * `resume_failed` から `lost` へ落ちる経路がある）。書けるのは**契機になる**
 * ところまでで、成否は観測してから言う — PR #66 で潰した「観測していないことを
 * 断定する」の、ちょうど裏返しである。
 *
 * **繋がっていない間、ここに出ている値は台帳に残っている最後の姿である。**
 * `live: false` は「デーモンのプロセス内にこの像が無い」ことであり（`list()` が
 * 台帳にしか無いジョブを `summaryOf(record, false)` で作る）、繋ぎ直るまで
 * 動かない。
 */
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

/**
 * `lost` の札に添える但し書き。
 *
 * **一覧で `lost` を見た人間が、次に開くのがこの画面である。** 起こし直すかどうかを
 * 決めるのはここなのに、この画面だけが札しか出していなかった — 一覧
 * （`managers.tsx`）にも CLI（`renderManagerList`）にもクローンの `manager_list` にも
 * 但し書きが出ている。人間の画面にだけ無いと、同じ状態を見て人間とクローンが違う
 * 判断をする（北極星 禁止1 を逆向きに踏む）。
 *
 * **言い切れるのは観測した分までである（PR #60）。** `lost` が表しているのは
 * 「前のセッションへ戻れなかった」という**一つの**観測であって、成果の有無ではない
 * — デーモンは PR もブランチも見ていない。落ちる直前に PR を出して CI を通し
 * マージまで済ませていた仕事が、その1分半後の器の作り直しで `lost` になった実例が
 * ある。
 *
 * **かといって `done` の側へも寄せない（PR #42 の分け方は保つ）。** 「戻れなかった」は
 * 「終えて待っている」ではない。
 *
 * **一覧より長く書いてよい。** ここまで降りてきた人間は、この1本をどうするかを
 * 決めに来ている。だから確かめる先に、この画面にしか無い「最後の報告」と生ログも
 * 足してある。
 */
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

/**
 * 直近の1ターンが**報告ではなく失敗**で終わったことに添える但し書き。
 *
 * **一覧（`managers.tsx`）より長く書いてよい。** ここまで降りてきた人間は、この1本を
 * どうするか（待つ・話しかけ直す・人間側で枠を上げる）を決めに来ている。
 *
 * 削ってはいけないのは3つ。
 *
 * 1. **SDK の語（`code` / `via`）そのまま** — `billing_error` と `rate_limit` は次の
 *    一手が違う（前者は人間が枠を上げる話、後者は待てば直る）。言い換えると、人間が
 *    SDK の型定義やログで引ける手がかりが消える
 * 2. **いつの失敗か（`at`）** — 「直近」がいつなのかが無いと、今も止まっているのか
 *    ずっと前に一度失敗しただけなのかが読めない
 * 3. **セッションが生きているかどうかの事実** — これが `status` を `failed` へ倒さ
 *    なかった理由（生きている回）か、既に終端したという事実（終端した回）かの、
 *    どちらかを必ず書く。書かないと、人間は続けられる仕事を閉じる（生きている回）か、
 *    終わった仕事に話しかけ続ける（終端した回）
 *
 * **「上限に当たった」と決めつけないこと。** 観測しているのは「SDK が応答ではないと
 * 言った」ことと、その `code` だけである。`code` の意味の解釈は SDK 側が持っている。
 *
 * ## Issue #1882: `status` を見ずに「生きている」を言い続けていた
 *
 * `status` を受け取らず `lastFailure` だけを見ていたので、`failed` / `lost` /
 * `stopped` のように**既に終端している**回でも「この仕事は死んでいない。セッションは
 * 生きているので……」を言っていた。同じ画面の状態バッジは終端の札（例:
 * 「停止済み」）を出しているので、1画面の中で言い切りが事実と矛盾する
 * （実測は下の `terminalFailureNote` の doc）。
 *
 * **揃える先は core の #1796（PR #1857）の `describeUsageStopped`
 * （`packages/core/src/tools.ts`）——同じ2値に分ける。** `failed` / `lost` は
 * 「セッションそのものが、依頼者が望まない終わり方で既に終端している」、`stopped` は
 * 「人間・クローンが明示的に停止させ、確かめたうえで既に終端している」。**core の値は
 * import できない**（apps/web の import 制限。`eslint.config.js`）ので、文言は
 * この画面の既存の語調（「この仕事は」「終わっている」の言い回し）で別に書く——
 * 意味の線（終端の理由の2値）だけを揃え、文字は複製しない。
 *
 * **一覧（`managers.tsx` の `ManagerFailureNote`）と同じ文を手書きで複製していた
 * ので、終端した回の文言は `~/lib/manager-failure-note` の `terminalFailureNote`
 * へ1本化した（レビュー指摘）。** その doc に、直す前の「もう続かない」という
 * 言い切りが `send()` / `#resume()` の現物より強かったこと（`stopConfirmedAt` は
 * `#retire()` が消す in-memory の印でしかなく、`status` そのものは resume を
 * 止めない）と、揃え直した文言の根拠がある。
 *
 * **`running` / `waiting_human` / `done`（生きている3値）は今までどおり**——
 * 「この仕事は死んでいない。セッションは生きているので……」の文言を1文字も変えて
 * いない（既存の歯「「待機中」の札を残したまま、SDK の語・時刻・次の一手を出す」が
 * そのまま固定している）。
 *
 * ## Issue #1882 / #1798: `lastFoldedTurn` が在る回は出さない
 *
 * `lastFailure` は `manager.ts` の `case 'report'` が `record.job.status ===
 * 'stopped'` の間は一切触らない欄（`lastFoldedTurn` だけを書いて早期 return する
 * 分岐）——**`lastFoldedTurn` が在る回の `lastFailure` は、畳まれる前の無関係な
 * 古いターンを指す。** この行の下に出したいのは「直近のターン」の話なので、
 * 古いターンの失敗を「直近のターン」として出すと読み違える。
 *
 * **判定のコピーを作らない代わりに、core と同じ線を張る。** core の
 * `manager_report`（`packages/core/src/tools.ts`）は `foldedTurn !== undefined`
 * の回に `describeManagerFailure` を呼ばない（Issue #1798）——ここも同じ回に
 * `null` を返す。畳まれたターンの本文そのものは `FoldedTurnNote` が別に出す。
 */
function FailureNote({ manager }: { manager: ManagerSummary }) {
  const { lastFailure: failure, lastFoldedTurn, status } = manager;
  if (failure === undefined || failure === null) return null;
  // Issue #1798 と同じ線（上の doc の「Issue #1882 / #1798」を見よ）。
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

/**
 * {@link FailureNote} の第2段落（生きているか、既に終端しているか）。
 *
 * **終端した回（`failed` / `lost` / `stopped`）の文言は
 * `~/lib/manager-failure-note` の `terminalFailureNote` から取る。** 一覧
 * （`managers.tsx` の `ManagerFailureNote`）と同じ文を2箇所で手書きしていたので、
 * レビュー指摘で生成元を1本化した——**「もう続かない」が `send()` / `#resume()`
 * の現物より強かったことの根拠と、揃え直した文言はそちらの doc にある。**
 *
 * **`running` / `waiting_human` / `done`（生きている3値）はここでだけ書く。**
 * 「下の『話しかける』」という導線はこの詳細画面にしかない（一覧の行には
 * 送信欄が無い）ので、共通化した側には置いていない——文言は直す前と1文字も
 * 変えていない。
 */
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

/**
 * `Job.lastReport`（最後のターンの中身）を、`Markdown` で描くか素のテキストで
 * 描くかを分ける。issue #293。
 *
 * **軸は `markup` ではなく `lastFailure` である。** `manager_message.text` に
 * 立てた `markup`（issue #287、`packages/core/src/schema.ts` の
 * `textMarkupSchema`）は、ここには当てない。理由は推測ではなく
 * `textMarkupSchema` の doc の逐語 ——
 *
 * > **立てられる場所にだけ立てる。** 複数の書き手・複数の由来の文字列が
 * > 連結済みで届く経路（例: `packages/core/src/manager.ts` の
 * > `failedReportText` 由来のメッセージ。デーモンの定型文・SDK の失敗文言・
 * > マネージャーの途中出力が1本の文字列に混ざる）には立てない。**立てられ
 * > ないから立てないのであって、安全だから立てないのではない**（issue #287）。
 *
 * `lastReport` が失敗回に持つ本文はまさにこの「連結済みで届く経路」そのもの
 * ——`packages/core/src/runner.ts` の `failedReportText` が「デーモンの頭＋SDK
 * の生の失敗文言＋マネージャーの途中出力」を1本へ連結する。**#306 が明示で
 * 引いた「ここには立てない」線を、ここへ `lastReportMarkup` を足して消す形は
 * 取らない。**
 *
 * 使うのは「その文字列がどの記法で書かれているか」ではなく、「**この回は
 * 失敗で終わったので、本文に由来の違う文字列が連結されている**」という別の
 * 軸の事実 —— それを表す印が `manager.lastFailure` である。
 *
 * - `record.job.lastReport = event.text` と `lastFailure` の設定／`delete` は
 *   **同じ `report` イベントの中で同時に動く**（`packages/core/src/manager.ts`
 *   の `#onEvent` の `case 'report'`）。成功で終わった回は
 *   `delete record.job.lastFailure` する。**だから「`lastFailure` が立って
 *   いる ⇒ その `lastReport` はその失敗回の本文」が成り立つ** —— 古い報告に
 *   新しい失敗が貼り付く形は無い
 * - 判定は本文の文言ではなく構造化された印で行う、という約束が repo 全体で
 *   通っている（同じ `#onEvent` のコメント、`reports.tsx` の `isUnavailable`
 *   の doc）。`lastFailure` はその印である
 *
 * **`lastFailure` が無い回で `Markdown` を使うのは「安全だと推論した」から
 * ではない。** `textMarkupSchema` の doc の `undefined` の扱いと同じ言い方を
 * 揃える —— **いまの既定を変えない、という方針の結果である。**
 *
 * **体裁は `reports.tsx` の `UnavailableNote` へ寄せた**（`commitments.tsx` の
 * `PlainBody` ではなく）。理由: `lastReport` の失敗回の本文は、`UnavailableNote`
 * が扱う日報の `unavailable` 欄と**同じ種類の文字列**（SDK の生文言を含みうる
 * 連結済みテキスト）であり、あちらには既にこの種の文字列についての明示の
 * 判断（`Markdown` で描かない・言い換えない）が doc として在る。`overflow-x-auto`
 * を含む `<pre>` の形も流用し、長い1行が横に溢れて画面を壊さないようにする。
 *
 * **本文を1文字も消さない・切り詰めない・言い換えない。** SDK の文言で人間が
 * 検索できることが要件である（`UnavailableNote` の doc、`usage-limits.ts` の
 * 「言い換えないこと」と同じ約束）。
 *
 * **犠牲: 失敗回のマネージャー自身の途中出力（`failedReportText` の
 * `partial`）が素のテキストとして出るので、そこに含まれる `**…**` は強調に
 * 化けず、記法の文字がそのまま画面に見える。** 承知のうえの犠牲である ——
 * `commitment.body`（`commitments.tsx` の `CommitmentBody`）はデーモンの定型文
 * について**逆**（`Markdown` 側）へ倒しているが、あちらは「分離できないうえ
 * 頻度と害の向きが違う」（デーモンの定型文は頻繁に出るが SDK のエラー文は失敗
 * したときしか出ない）ことを理由にしている。こちらは分離はできない点は同じ
 * だが、**`lastFailure` という印で失敗回だけを切り出せる**点が違う ——
 * 失敗回に限れば「マネージャーの途中出力が素で出る」犠牲より「SDK の生文言が
 * 化けて読めなくなる」害のほうが大きいと判断し、素のテキスト側へ倒した。
 *
 * 関連: issue #293（この Issue） / #287（`markup` 軸の導入） / #306（`markup`
 * を「立てられる場所にだけ立てる」と決めた PR、および `commitment.body` の
 * `markup` 側フォールバック）。
 */
function LastReportBody({
  lastReport,
  lastFailure,
}: {
  lastReport: string;
  lastFailure: ManagerSummary['lastFailure'] | undefined;
}) {
  if (lastFailure === undefined || lastFailure === null) {
    return <Markdown headingOffset={2}>{redactBody(lastReport)}</Markdown>;
  }
  return (
    <pre className="overflow-x-auto rounded border border-border bg-background p-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
      {redactBody(lastReport)}
    </pre>
  );
}

/** 拒否の総件数。`undefined`（観測していない）と `[]` はどちらも 0。 */
function denialTotal(denials: ManagerDenial[] | undefined): number {
  return (denials ?? []).reduce((sum, entry) => sum + entry.count, 0);
}

/**
 * 確認へ上がらずに止められた道具の全件。
 *
 * **一覧は新しい側から3種で畳むが、ここは畳まない。** 詳細まで降りてきた人間が
 * 見に来たのは「何で止まっているのか」そのものだからである。
 *
 * **「返事待ち」の上に置く。** どちらも手が止まっている理由だが、返事待ちは人間が
 * 答えれば動くのに対し、こちらは**そもそも人間にもクローンにも確認が来ていない**。
 * 気づかなければ永久に止まったままなので、先に目に入る位置へ出す。
 *
 * **観測した分しか言わない。** 数えているのは拒否であって、それで止まったかどうか
 * は見ていない。件数がデーモンのプロセス内にしか無いことも書く — 「0 件」を
 * 「止められていない」と読まれると、器を作り直した直後がいちばん静かに見える。
 *
 * **各件に `denialActorTag` で層を添える（Issue #373）。** 添えるだけでなく
 * key も直す必要があった——`manager.ts` の `denials()` は帳面のキーを
 * `道具::層`（`denialKey`）で作っているので、**同じ道具が層違いで2件
 * 返りうる**（`Bash`(worker) と `Bash`(manager)）。`key={entry.tool}` のままだと
 * React の重複キーになり、層を描く前は画面にも見分けの付かない `Bash` の行が
 * 2つ並んでいた。key は `denialKey` と同じ規則（`${actor ?? 'unresolved'}::${tool}`）
 * で層込みにする——`denials()` が返す時点で `道具::層` の組ごとに一意なので、
 * 同じ規則で作れば必ず一意になる。
 */
function DenialsCard({
  denials,
  lastReportAt,
}: {
  denials: ManagerDenial[] | undefined;
  lastReportAt: string | undefined;
}) {
  if (denials === undefined || denials.length === 0) return null;
  // 止められた後に報告が届いたか（#1455）。3値のどれかで、畳まない。
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  // デーモンは古い順で返す。新しい側から読ませる。
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

// ---------------------------------------------------------------------------
// 診断——クローンの manager_list / manager_report が読んでいるが、この画面には
// 出ていなかった欄（オーナーの決定「人間が後から読んで確かめられることが
// alteroid の芯」）。
// ---------------------------------------------------------------------------

/**
 * `lastReport` を「直近の報告」と呼んでよいかとは別の軸——**その報告を書いた
 * 瞬間の `status` が、いまの `status` と食い違っていないか**（Issue #1036）。
 *
 * **判定のコピーを作らない。** クローンの `manager_list` / `manager_report`
 * （`packages/core/src/tools.ts`）はこの1行を `describeReportDrift`
 * （`@alteroid/core/manager-activity`）から取っている——ここも同じ関数を
 * 同じ引数で呼ぶ。字面が割れると、同じ委譲を見た人間とクローンが違う結論を
 * 読むことになる。
 *
 * **健全な回（drift 無し）では空文字が返る**（`describeReportDrift` の doc）
 * ——その場合は1行も出さない。
 *
 * ## Issue #1882 / #1797: `lastFoldedTurn` が在る回は、その材料で組む
 *
 * `manager.lastReportAt` / `manager.lastReportStatus` は `manager.ts` の
 * `case 'report'` が `record.job.status === 'stopped'` の間は一切触らない欄
 * （`lastFoldedTurn` だけを書いて早期 return する分岐）——**`lastFoldedTurn` が
 * 在る回のこの2欄は、畳まれる前の無関係な古いターンの値のままである。** そのまま
 * `describeReportDrift` へ渡すと、「いま読んでいる畳まれた本文」とは無関係な
 * drift を語ることになる（Issue の実測: `status: 'stopped'` + 古い
 * `lastReportStatus: 'running'` の組で「この報告は…いま走っているターンの中身
 * ではない」が出た）。
 *
 * **判定のコピーは作らない代わりに、core と同じ合成をする。** core の
 * `manager_report`（`packages/core/src/tools.ts`、Issue #1797）は
 * `lastReportAt` を `foldedTurn.at`（この本文が実際に届いた時刻）へ、
 * `lastReportStatus` を `'stopped'` へ差し替える——`lastFoldedTurn` は
 * `case 'report'` が `status === 'stopped'` の間だけ書く欄なので、書かれた瞬間の
 * status は構造的に `'stopped'` だったと分かる（専用の記録欄が無くても合成できる）。
 * ここも同じ2値を合成して渡す——生成元（`describeReportDrift`）は1箇所のまま
 * 割らない。
 */
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

/**
 * 「道具の応答待ちのまま、誰もその応答を待っていない」という矛盾（Issue #572）。
 *
 * **判定（3条件目まで含む）はクローンと同じ `classifyManagerActivity`
 * （`@alteroid/core/manager-activity`）に通す。** 字面はこの画面向けに
 * 書き直す（クローン向けの原文は `manager_transcript` / `manager_stop` という
 * クローンの道具名を名指しするので、人間の画面にそのまま出しても次の一手に
 * ならない——出典は
 * `grep -Fn -- '道具の応答待ちのまま、誰もその応答を待っていない' packages/core/src/tools.ts`）。
 * **判定そのもの（3条件目「waiting が空か」を含む）は割らない**——同じ
 * 委譲について、この画面とクローンとで「止まっている／いない」の結論が
 * 違うことは無い。
 *
 * ⚠️ **`turnEndReason` / `turnEndedAt` はこの画面に出していない**（このファイル
 * 冒頭の `DiagnosticsCard` の doc「出さないと決めた欄」）。
 * `classifyManagerActivity` は2つの探り（ターン終わり型・道具待ち型）が同じ
 * 生ログの末尾行を見ているため通常は同時に立たないとしつつ、万一立ったときは
 * ターン終わり型を優先してこの行を消す（`manager-activity.ts` の
 * `classifyManagerActivity` の doc）——その優先で消えた場合、この画面には
 * 代わりの行が無い。**実測でこの優先分岐が発火した例は無い**（同 doc の
 * 「万一」という言葉どおり、防御的な分岐である）。
 *
 * **時刻の閾値は置かない。** クローン向けの原文と同じ理由——「何分経ったか」は
 * 症状の下限を決めないので判定に使わない。読み手が `toolUseStallAt` を見て
 * 自分で判断する。
 */
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

/**
 * 直近のターンが `result` を受け取らないまま畳まれたこと（Issue #917）。
 * `lastFailure`（SDK が「これは応答ではない」と声明した回）とは軸が違う——
 * こちらは声明すら届かないまま器の入れ替え・`manager_stop`・クラッシュ等で
 * 畳まれた回（`schema.ts` の `lastUnreported` の doc）。
 */
function UnreportedNote({ lastUnreported }: { lastUnreported: ManagerSummary['lastUnreported'] }) {
  if (lastUnreported === undefined) return null;
  return (
    <p className="border-t border-border px-4 py-3 text-xs text-destructive">
      直近のターンは、<strong className="font-medium">result を受け取らないまま畳まれた</strong>（
      {formatDateTime(lastUnreported.at)}）。理由: {redactBody(lastUnreported.reason)}
    </p>
  );
}

/**
 * `manager_stop`（running・非force）で畳まれたターンの本文（Issue #1038）。
 * `lastReport`（完遂した報告）とは別の欄——混ぜると「完遂した報告」と
 * 「止めた後に打ち切られた途中経過」の区別が読み手から消える
 * （`schema.ts` の `lastFoldedTurn` の doc）。
 *
 * **全文を出す（クローン向けの `manager_stop` 応答は240字で切る——
 * `packages/core/src/tools.ts` の `MANAGER_STOP_FOLDED_TURN_EXCERPT`）。**
 * ここは一覧ではなく詳細画面なので、`RequestCard` / `LastReportBody` と同じ
 * 理由で切り詰めない。
 */
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

/**
 * セッションが `failed` として畳まれたときの、器の資源による落ち方の分類
 * （Issue #1517「最小の形」2）。
 *
 * **文言は `@alteroid/core/cgroup-events-format`（`CGROUP_EVENTS_UNKNOWN_NOTE` /
 * `formatCgroupEventsNote`）の1本だけの正本から引く。** クローンの
 * `manager_list` / `manager_report`（`packages/core/src/tools.ts`。同じ
 * 軽い口を re-export する `cgroup-events.ts` 経由で使う）と、この画面とで
 * 文言を複製しない——**かつてはここで文言を手で複製していたが**（`cgroup-events.ts`
 * が `cgroupEventsDeltaSchema`（zod）を同じファイルに持ち、軽い口にできな
 * かったため）、文言だけを切り出した `cgroup-events-format.ts` へ寄せて
 * 複製をやめた（import 文の doc）。
 */
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

/**
 * セッションが `failed` として畳まれたときの、Node が構造として持つ失敗の
 * 分類（`code` / `errno` / `syscall`。#713 段3）。
 *
 * **`CgroupEventsNote` と対で読むが軸は別**——あちらは cgroup のカウンタ、
 * こちらは Node の例外分類（`packages/core/src/system-error.ts` の
 * `SystemErrorFacts`）。文言は `@alteroid/core/system-error-format` の
 * `formatSystemErrorFacts` と1本だけの正本から引く。
 *
 * **D（判定できなかった）の文言は、末尾の指し先だけこの画面のものを渡す。**
 * `formatSystemErrorUnknownNote` の共通部分（枠 429・セッション切断はこの欄の
 * 対象外という本文）はクローン向けと共有し、末尾の「本文と◯◯を見ること」の
 * ◯◯だけ、クローン向けの欄名（`lastFailure`）ではなくこの画面の該当箇所
 * （下の「直近のターンは報告ではなく失敗で終わっている」の注記）を指す言葉に
 * 差し替える（import 文の doc）。
 */
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

/**
 * 429の文言の `resets` 時刻を、プールの各鍵の `cooldownUntil` と突き合わせた
 * 結果（Issue #914 オーナー提案(2)）。
 *
 * **クローン向けの `describeResetTimeSkew`（`tools.ts`）との違い**: あちらは
 * `tokenGeneration` / `activeTokenGeneration`（世代の生の番号）が既に食い違いを
 * 名指ししているときは二重に鳴らさないよう、この行を抑える分岐を持つ。
 * **この画面は世代の生の番号を出していない**（`DiagnosticsCard` の doc
 * 「出さないと決めた欄」——resetTimeSkewMatch 自身が既に人間向けの結論を
 * 出しているため）ので、抑える判定に使う材料そのものが無い。抑えずにそのまま
 * 出す——二重に鳴る先（世代番号の行）がこの画面には無いので、実害は無い。
 *
 * **未知の値でも落ちない**（#1623 / #1630 の流儀）。既知の2値
 * （`'stale'` / `'active'`）のどちらでもなければ、その旨をそのまま出す——
 * 版のずれで新しいデーモンがこの画面の知らない値を返しても、画面ごと落ちない。
 *
 * **`'stale'` の「起こし直すこと」には、core が1本化した安全弁を添える**
 * （Issue #1845）。`packages/core/src/usage-limits.ts` の
 * `STALE_TOKEN_RESTART_ADVICE`（#1175 / #1287 を経て、`tools.ts` の呼び出し
 * 箇所5箇所がこの1本だけを呼ぶ形に揃えた正本）が運ぶ核は2つ——(1) 止める前に、
 * その委譲がターンの途中かどうかを確かめること (2) 失われるのは会話だけでは
 * なく、進行中だった作業も失われること。この画面はその定数を import しない。
 *
 * - **定数の文面はクローンの道具の名（`manager_stop` の断り）を名指しするが、
 *   その道具はこの画面には無い。** 人間はここでは「停止する」ボタンを押す
 *   だけで、押した瞬間に `abortManager` が呼ばれて一覧へ戻る（クローン向けの
 *   断りに相当する確認の一手が無い）。定数をそのまま転記すると、押しても
 *   出てこない道具名を人間に読ませることになる
 * - **`LostNote`（このファイル、上）が既に採っている作法に倣う**——
 *   確かめ先の主は「起こし直す前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を
 *   確かめること」と同じ語にする。**`UnpushedWorkObservationNote`
 *   （「未push観測」）は主ではなく補助——最初のレビューでは確かめ先の主に
 *   据えたが、2つ理由で降格した**:
 *   1. `manager.lastUnpushedWorkObservation` が `undefined` なら
 *      `UnpushedWorkObservationNote` 自身が `null` を返して**何も描かない**
 *      （一度も観測が無い委譲では、指した先が画面に存在しない）
 *   2. 在っても、それは「`manager_stop` の断り・`report` 終わり・`git push`
 *      検出のいずれかで取った**最後の1回**であって、いまの状態そのものでは
 *      ない」（`describeUnpushedWorkObservation` の doc・この下の
 *      `unpushedWorkText` の `provenance` と同じ注意）——**それだけを見て
 *      「確かめた」とは言えない**
 * - **⟹ 観測の有無で文言を分ける。** 観測が在るときだけ、「未push観測」にも
 *   最後の観測が出ている（いまの状態ではないという断りごと）という一文を
 *   補助として足す。無いときはその一文自体を出さない——`AGENTS.md`
 *   「無い欄は行ごと出さない」と同じ向きで、存在しない参照先を指さない
 * - **定数を import しない代わりに、上の核2つは1文字も削らない。**
 *   `pnpm check:stale-token-restart-advice` が生成元の外で禁じているのは
 *   助言の行動そのものを指す逐語と、#914 が名指しした過小な旧文言の2つの
 *   逐語であって、意味を保った言い換えではない
 *   （`check-stale-token-restart-advice-core.mjs` の doc「言い換えは
 *   捕まえられない」。⚠ この doc 自身が禁じられた逐語を引用すると、将来この
 *   検査が `.tsx` まで対象を広げたときに自分自身へ誤検知するので、ここでは
 *   逐語を引用しない）
 */
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

/**
 * `manager_stop`（running・非force）の断り、ターンが `report` で終わったとき、
 * Bash で `git push` か新しい枝を作る操作を検出したとき、または止める操作
 * そのもの（`manager_stop` の force・`done`/`waiting_human` の非force・
 * 人間の停止・自動畳み。Issue #1266 残り2）で取った最後の未push観測
 * （Issue #1266）。**答えるのは「どこ（どの枝）を見ればよいか」
 * までである——「成果が届いたか」は含まない**（`schema.ts` の
 * `lastUnpushedWorkObservationSchema` の doc）。
 *
 * **`remoteOrigin` は `maskUrl`（`@alteroid/core/mask-url`）へ通す**（#1627 の
 * 流儀）。この欄はスキーマの時点で既に userinfo・クエリ・フラグメント・生の
 * URL 文字列を落として `{ host, path }` だけにしてある
 * （`schema.ts` の `observedWorktreeBranchSchema.remoteOrigin` の doc）ので、
 * ここへ通しても大抵は1文字も変わらない——それでも通すのは、万一 `path` に
 * 想定外の断片が紛れ込んだ場合の二重の備えとして、である。
 *
 * **`unavailable` / `observed` のどちらでもない値でも落ちない**（#1623 /
 * #1630 の流儀。discriminated union の `kind` は増えうる）。
 */
function unpushedWorkText(manager: ManagerSummary): ReactNode | null {
  const observation = manager.lastUnpushedWorkObservation;
  const swapped = manager.sessionMissingSince !== undefined;
  if (observation === undefined && !swapped) return null;

  // **Issue #2457** — 器の入れ替えで応答不能（`sessionMissingSince`）の委譲は、
  // クローンの `manager_list`（`describeUnpushedWorkObservation`）と同じ3通りに
  // 言い分ける。判定（`shutdownObservationArrivedAfterSwap === true` かつ観測が
  // 在る）も文言（断りの1文・経路の1句）もそちらと同じ生成元
  // （`unpushed-work-observation-format`）を通す。
  if (swapped) {
    if (manager.shutdownObservationArrivedAfterSwap === true && observation !== undefined) {
      if (observation.kind === 'unavailable') {
        return `未push観測: 器が止まる直前（${formatDateTime(observation.at)}）に取ろうとしたが取れなかった: ${redactBody(observation.reason)}`;
      }
      if (observation.kind === 'observed') {
        // 作業ツリー0本で探索の失敗も無いなら行を省く（Issue #2970）。
        if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
        return observedUnpushedWorkNode(
          `未push観測: 器が止まる直前（${formatDateTime(observation.at)}）の観測:`,
          observation,
        );
      }
    } else {
      // 届いていない（観測が無い・古いセッションのもの・`source` が
      // `'shutdown'` ではない、のどれかを区別しない）。**古い観測を最新のように
      // 見せない**——断りの後に「表示中の観測」として時刻と経路つきで添える。
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
  // 以降は、器の入れ替えで応答不能ではない委譲（と、知らない kind）。
  if (observation === undefined) return null;
  // 作業ツリー0本で探索の失敗も無いなら行を省く（Issue #2970）。
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
  // 版のずれ（新しいデーモンがこの画面の知らない kind を返した）でも落ちない。
  const unknownKind: string = (observation as { kind: string }).kind;
  return `未push観測: この画面が知らない種類 "${unknownKind}"（サーバの版が新しい可能性）。`;
}

/**
 * `kind: 'observed'` の観測の本体（作業ツリーの一覧と、確かめきれなかった
 * ことの注記）を、`lead`（何の観測かを言う1句）の後ろへ描く。
 */
function observedUnpushedWorkNode(
  lead: string,
  observation: Extract<
    NonNullable<ManagerSummary['lastUnpushedWorkObservation']>,
    { kind: 'observed' }
  >,
): ReactNode {
  // **Issue #1885** — 確かめきれなかったことの4欄が載っているとき、
  // クローンの `manager_list`（`describeUnpushedWorkObservation`）と
  // 同じ1文をここにも出す。判定はそちらと同じ生成元
  // （`describeUnpushedWorkObservationIncompleteness`）を素通しするだけ。
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
          // key に index を混ぜる——相対パスだけでは、同名の worktree が
          // 2箇所に無いとは限らないので一意にならない。
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

/**
 * **診断**（オーナーの決定「人間が後から読んで確かめられることが alteroid の
 * 芯」）。
 *
 * クローンは `manager_list` / `manager_report`（`packages/core/src/tools.ts`）
 * で `ManagerSummary` の同じ欄を読んでいるが、この画面にはまだ出ていなかった
 * ——人間とクローンが同じ委譲を見て違う情報しか持てない形になっていた
 * （`docs/north_star.md` 禁止1 と同じ向き）。ここへ集めたのは、いずれも
 * (a) クローンの道具は既に本文へ出している (b) この画面にはまだ出ていない、
 * の両方を満たす欄のうち、**Issue #1628 が足した8欄すべて**
 * （`lastReportStatus` / `lastUnreported` / `lastFoldedTurn` /
 * `lastCgroupEvents` / `lastUnpushedWorkObservation` / `toolUseStallAt` /
 * `toolUseStallPending` / `resetTimeSkewMatch`）と、`lastSystemError`
 * （人間が「器の資源で落ちたのか」を後から確かめるのに要る欄。#713 段3）を
 * 合わせた9欄である。
 *
 * ## 出さないと決めた欄（同じ (a)/(b) を満たすが、この PR では出さない）
 *
 * - `usageStoppedAt` — 枠(利用上限)に当たった時刻。`ResetTimeSkewNote` 自身が
 *   「枠で止まっている間だけ意味を持つ」と書くので、独立した行を増やさなくても
 *   読める
 * - `turnEndedAt` / `turnEndReason` / `turnEndTail` — デーモンが生ログの末尾から
 *   計算した「ターンが終わったらしい」という**助言**（#567）であって判定では
 *   ない。`waiting` / `lastReport` など、この画面に既に出ている材料との重なりが
 *   大きい（内部の判定材料としては `ToolUseStallNote` が読んでいる——表示だけを
 *   見送った）
 * - `tokenGeneration` / `activeTokenGeneration` / `tokenGenerationUnknownReason`
 *   — 認証トークンのプール内部の世代番号。`resetTimeSkewMatch` が既にこの軸の
 *   **結論**を人間向けの言葉で出しているので、生の世代番号を並べても人間の
 *   次の一手は増えない
 *
 * **無い欄は行ごと出さない**（`AGENTS.md`「取れない軸に0の行を作る」）——
 * どの行も材料が無ければ `null` を返し、このカード自体も何も無ければ描かない
 * （`DenialsCard` と同じ約束）。
 */
function DiagnosticsCard({ manager }: { manager: ManagerSummary }) {
  const visible =
    reportStatusDriftText(manager) !== '' ||
    toolUseStallText(manager) !== null ||
    manager.lastUnreported !== undefined ||
    manager.lastFoldedTurn !== undefined ||
    cgroupEventsText(manager) !== null ||
    systemErrorText(manager) !== null ||
    resetTimeSkewText(manager) !== null ||
    // 観測が無くても、器の入れ替えで応答不能なら「届いていない」を言う（Issue #2457）。
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

/**
 * 「◯分前から」の1行。**共通部品にする**——質問・実行許可のどちらの待ちも
 * 「いつから待っているか」で人間の次の一手が変わる（#323: 報告が何時間も
 * 遅れても人間には分からない欠陥）。書式は `manager.startedAt` /
 * `manager.updatedAt` と同じ道具（`formatDateTime` + `formatRelative`）を
 * 使う——新しい書式を自分で作らない。
 *
 * **`askedAt` が届かないときは何も描かない。** `kind` と同じ理由（版のずれで
 * 古いデーモンが未知のフィールドを持たないことがある）で、無いことを空欄
 * 以外の形で嘘つかない——「不明」と書くほどではない付随情報なので、無ければ
 * 単に出さない。
 */
function AskedAtNote({ askedAt }: { askedAt: string | undefined }) {
  if (askedAt === undefined) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {formatDateTime(askedAt)}（{formatRelative(askedAt)}）から
    </p>
  );
}

/**
 * **`send` の戻り値（`ManagerSendResult`、`packages/core/src/manager.ts` の表）を、使い手向けの
 * 言い方にする（#3066）。** `outcome` の識別子（`session_missing` など）は画面に出さない。
 *
 * **届いたと言ってよいのは `answered` / `delivered` だけ**（許可リスト）。残りは未達で、
 * 知らない値も未達の側へ倒す——知らない値を成功の見た目にしない。未達は HTTP 200 で返る
 * もの（`session_missing` / `declined`）が本命で、`unknown`（404）・`unreadable`（409）は
 * 通常は例外側へ行くが、戻り値で来ても未達として言える形にしてある。
 * 知らない値は識別子を出さず、`detail`（日本語の文）だけを出す（`archive.tsx` の
 * `continuityLabel` と同じ作り）。
 */
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

/** 未達の結果の1行（警告色）。届いた結果は呼び側が灰色で出す。 */
function SendOutcomeNote({ note }: { note: { text: string; reached: boolean } | undefined }) {
  if (note === undefined) return null;
  return (
    <p className={`mt-2 text-xs ${note.reached ? 'text-muted-foreground' : 'text-warn'}`}>
      {note.reached ? '' : '⚠ '}
      {note.text}
    </p>
  );
}

/**
 * **`kind === 'permission'` の見た目（許可／拒否の2ボタン）。1文字も変えて
 * いない**（`askedAtNote` の差し込みを除く。Issue #334 の指示どおり）。
 */
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
  // どちらを送っているか。**押したほうだけが回る**（`loading`）。もう片方は
  // 二重に答えさせないよう塞ぐだけ（`disabled`）。1本の真偽値だと、
  // 「拒否」を押しても「許可」が回った（#3068）。
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  // 戻り値を見る。未達（`session_missing` など、HTTP 200）を成功として黙らせない。
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
        // 届いたときは今までどおり何も足さない（待ちが解ければ行ごと消える）。
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
          disabled={busy === 'deny'}
          onClick={() => answer('allow')}
        >
          許可
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={busy === 'deny'}
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

/**
 * **`kind === 'question'` の見た目。** `AskUserQuestion` には allow / deny が
 * 無いので、人間が自分の言葉で書いた本文を送る。**`decision` は付けない** —
 * `runner.ts` の `kind === 'question'` 分岐は `answer.decision` を一度も読まず
 * （`withAnswers` が本文をそのまま答えに使う）、付けると日誌に `[allow]` の
 * 接頭辞だけが残って嘘になる（Issue #334 の doc）。
 *
 * 送信欄は `approvals.tsx` の回答欄と同じ道具・同じ操作系に揃える
 * （`Textarea` + Cmd/Ctrl+Enter で送信）——このリポジトリで唯一の「人間が
 * マネージャーへ自由文を返す」画面と、操作感を分けない。
 */
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

  function submit() {
    // **空文字・空白のみでは送らない。** ボタンの `disabled` だけに頼らない
    // （Cmd/Ctrl+Enter でもここへ来る）。
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    setNote(undefined);
    // **`decision` を付けない。** 質問に allow/deny は無い。
    send(id, { text, requestId })
      .then((result) => {
        const described = describeSendResult(result);
        // 届いていないのに入力を空にしない（書いた答えを残す）。
        if (described.reached) setText('');
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
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // 長文になりうるので Enter は改行のまま。送信は Cmd/Ctrl+Enter。
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={text.trim() === ''}
            onClick={submit}
          >
            送信
          </Button>
          <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter</span>
        </div>
      </div>
      <SendOutcomeNote note={note} />
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

/**
 * 1件の待ち——質問（`AskUserQuestion`）か実行許可かで見た目を出し分ける
 * （Issue #334。かつては区別できず、質問に拒否を押すと文字列「許可しない」
 * が回答として注入されていた）。
 *
 * **`kind` が `'question'` 以外はすべて実行許可として扱う。** 型の上では
 * `'question' | 'permission'` の2値だが、`packages/api-client` は型だけで
 * 実行時検証を持たない（`packages/api-client/src/index.ts`）——古いデーモン
 * ＋新しい画面という版のずれで、実際には `undefined` や未知の文字列が届き
 * うる（AGENTS.md「型で塞いだ分岐にも、実行時の倒れ先の歯を足す」）。**倒れ
 * 先は現状の2ボタン（許可確認）——何も消さない、安全側の既定。**
 */
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

/** 無効の理由の段落。`aria-describedby` でボタンから名指しするために要る。 */
const REASON_ID = 'send-message-disabled-reason';

/**
 * 話しかける口。
 *
 * **`live === false` というだけで `disabled` にしないこと。** 繋がっていない
 * 相手への送信は `ManagerPool.send` の中で引き取り（resume）に化けるので、
 * ここが人間にとって**自分の言葉で繋ぎ直す唯一の手**である（`DisconnectedNote`
 * に経緯）。塞ぐのは能力の削除（north_star 禁止1）であり、しかも
 * `packages/core/src/manager.ts` が
 * **「人間とクローンの明示的な `manager_send` は塞がない（`#unresumable` は見られ
 * ていないし、戻れたら忘れる）」**と書いて意図的に開けてある線を、画面側から
 * 黙って閉じることになる（`#onEvent` メソッド内、
 * `this.#unresumable.add(event.managerId)` の直前のコメント）。
 *
 * **止めるのは「戻る先が無い」と分かっている相手だけ**である。`live === false`
 * かつ `session_id` を持っていないと、`#resume` は `sessionId === undefined` で
 * 即 `false` を返し、**runner へは何も飛ばない**（`resume` も `send` も呼ばれ
 * ない。実測で確かめた）。ここだけは押しても何も起きないので止める。
 *
 * **`live` だけで判定しないこと。** 分岐しているのは `session_id` の有無であって
 * 接続の有無ではない。`live === true` なら `session_id` が無くても `runner.send`
 * で届く（繋がっている相手には resume が要らない）ので、**両方を見る**。
 *
 * **停止（`status` で出し分けている）と混ぜないこと。** 止めるのは runner と
 * 繋がっていなくても意味がある操作で、見ている軸が違う。
 *
 * **そして黙って無効にしない。** 押せないのに理由が無いのは、PR #66 で直した
 * 「`live === false` を札の不在でしか表していない」のと同じ形を、操作の側で
 * 作り直すことになる。無効にするなら、**なぜ無効かがその場で読める**こと。
 * 送れる側（繋がっていないが session_id はある）でも同じで、真上の注記が
 * 「繋がっていない」と言っている下で送信欄が黙っていると、押してよいのかが
 * 読めない。**どちらの側にも、操作するその場に一行を置く。**
 */
function SendMessage({
  id,
  live,
  sessionId,
}: {
  id: string;
  live: boolean;
  sessionId: string | undefined | null;
}) {
  // 戻る先が無い。押しても runner へは何も飛ばない（`#resume` が即 false）。
  const noWayBack = !live && (sessionId === undefined || sessionId === null);
  const send = useSendManagerMessage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; reached: boolean } | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  function submit() {
    // **ボタンの `disabled` だけに頼らない。** Enter でもここへ来る。
    // 送っている最中の Enter も弾く。ボタンは `loading` で塞がるが、Enter の
    // 道はボタンを経由しないので、押した数だけ割り込みが飛ぶ。
    if (text.trim() === '' || noWayBack || busy) return;
    setBusy(true);
    setFailure(undefined);
    // 前回の結果を消す。次の送信が失敗しても、前回の「届けた」が今回のものに見えない。
    setOutcome(undefined);
    send(id, { text })
      .then((result) => {
        const described = describeSendResult(result);
        setOutcome(described);
        // 届いていないときは入力を残す（書いた指示を消さない）。
        if (described.reached) setText('');
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
        <div className="flex gap-2">
          {/*
            **入力欄までは殺さない。** 書きかけの言葉を取り上げる理由が無いし、
            起こし直した後にそのまま送れる。止めるのは送信だけでよい。
          */}
          <Input
            value={text}
            placeholder="追加の指示"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // IME の変換を確定する Enter では送らない（門の形と理由は
              // `isImeConfirmEnter` の注釈）。ここは Enter 単体で送るので、
              // 門が無いと確定前の途中の文字列がそのまま割り込む。
              if (isImeConfirmEnter(event)) return;
              if (event.key === 'Enter') submit();
            }}
          />
          {/*
            **理由と結び付ける。** `disabled` だけだと、支援技術には「押せない」
            としか伝わらず、理由の段落はただ近くにあるだけの文になる。
            `aria-describedby` で名指ししておけば、読み上げでも「なぜ押せないか」
            が操作と一緒に届く。
          */}
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
        <SendOutcomeNote note={outcome} />
        <ErrorNote error={failure} className="mt-2" />
      </div>
    </Card>
  );
}

/**
 * 生ログ。
 *
 * 日誌で足りないときの最後の拠り所（PRD 可観測性の3層目）なので、要約せずに
 * そのまま出す。既定では畳んでおく — 長いため。
 */
function Transcript({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  // 開くまで取りに行かない（長いので、見たいと言われてから読む）。
  const { data, error, isLoading } = useManagerTranscript(open ? id : null);
  /**
   * **取れなかったのを空と描かない**（issue #2321）。まだ一度も読めていないまま失敗した
   * とき、失敗は上の `ErrorNote` が言う。ここで「(空)」を出すと、セッションログが空だった
   * ように読める。本当に空の文字列が返ったときの「(空)」は残す。
   */
  const transcriptUnavailable = data === undefined && error !== undefined;

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
          <ErrorNote error={error} />
          {isLoading ? (
            <Spinner />
          ) : transcriptUnavailable ? null : (
            <pre className="max-h-[32rem] overflow-auto rounded border border-border bg-background p-2 text-[11px] text-muted-foreground">
              {data === undefined || data === '' ? '(空)' : redactBody(data)}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}
