import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  Spinner,
  Textarea,
} from '~/components/ui';
import { useAbortManager, useSendManagerMessage } from '~/hooks/mutations';
import { useManager, useManagerTranscript } from '~/hooks/queries';
import { formatDateTime, formatRelative } from '~/lib/format';

import type { ManagerDenial, ManagerStatus, ManagerSummary } from '~/lib/types';

import type { Route } from './+types/manager-detail';
/**
 * **`ManagerSessionMissingNote` は書き写さずに一覧から借りる。** 文言の核は
 * クローン（`tools.ts`）・CLI（`chat.ts`）と逐語で揃える約束のものなので、同じ
 * 画面（Web UI）の中で2箇所に写すと直すときに片方だけ直る（`denialActorTag` と
 * 同じ理由）。ここで変えてよいのは置き場所（`className`）だけである。
 */
import { denialActorTag, ManagerSessionMissingNote, ManagerStatusBadge } from './managers';

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

export default function ManagerDetail({ loaderData }: Route.ComponentProps) {
  const { id } = loaderData;
  const { data, error, isLoading } = useManager(id);
  const navigate = useNavigate();
  const abortManager = useAbortManager();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const manager = data?.manager;

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link to="/managers" className="text-muted hover:text-fg">
            マネージャー
          </Link>
          <span className="text-muted">/</span>
          <span className="font-mono text-sm">{id}</span>
        </span>
      }
      description={PAGE_DESCRIPTION}
      action={
        /*
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
        */
        manager !== undefined ? (
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              setFailure(undefined);
              // 本文が要る（サーバ側に json バリデータが付いている）。
              abortManager(id, '人間が画面から停止した')
                .then(() => navigate('/managers'))
                .catch(setFailure)
                .finally(() => setBusy(false));
            }}
          >
            停止する
          </Button>
        ) : undefined
      }
    >
      <ErrorNote error={error ?? failure} className="mb-4" />

      {isLoading ? (
        <Spinner />
      ) : manager === undefined ? (
        <Card>
          <Empty>見つからない。</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <RequestCard request={manager.request} />

          <Card>
            <CardHeader title="状態" />
            {/*
              **375px でもラベル列（8rem=128px）に取り分を持っていかれないよう、
              `sm:`（640px）未満は1列に積む。** `sm:` を選んだ理由: `reports.tsx`
              の `lg:grid-cols-[16rem_1fr]` は16remがlg(1024px)の1/4を占める
              太い列だからその境目を選んでいるが、ここは最大でも8rem(128px)＝
              sm(640px)の20%に過ぎず、`md:`/`lg:` まで待つ理由が無い。

              **積んだとき `dt`→`dd` が交互に並ぶので、`gap-y-1.5` だけでは
              「どの `dd` がどの `dt` のものか」が読めなくなる**（同じ間隔が
              対になる行にも次の組にも掛かる）。対策として `dt` に
              `mt-3 first:mt-0` を足す — 対になる `dd` との間隔は据え置きの
              `gap-y-1.5` のまま、次の組が始まる前にだけ余分な間隔が入るので、
              組の境目が間隔の差で分かるようにした（`sm:` 以上では `sm:mt-0`
              で打ち消し、2列表示の見た目は変えていない）。
            */}
            <dl className="grid grid-cols-1 gap-y-1.5 px-4 py-3 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="mt-3 text-muted first:mt-0 sm:mt-0">状態</dt>
              <dd className="flex items-center gap-2">
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
              </dd>
              <dt className="mt-3 text-muted first:mt-0 sm:mt-0">作業ディレクトリ</dt>
              <dd className="font-mono text-xs break-all">{manager.cwd}</dd>
              <dt className="mt-3 text-muted first:mt-0 sm:mt-0">開始</dt>
              <dd>
                {formatDateTime(manager.startedAt)}（{formatRelative(manager.startedAt)}）
              </dd>
              <dt className="mt-3 text-muted first:mt-0 sm:mt-0">更新</dt>
              <dd>
                {formatDateTime(manager.updatedAt)}（{formatRelative(manager.updatedAt)}）
              </dd>
              {manager.runnerId !== undefined && manager.runnerId !== null && (
                <>
                  <dt className="mt-3 text-muted first:mt-0 sm:mt-0">runner</dt>
                  <dd className="font-mono text-xs break-all">{manager.runnerId}</dd>
                </>
              )}
              {manager.sessionId !== undefined && manager.sessionId !== null && (
                <>
                  <dt className="mt-3 text-muted first:mt-0 sm:mt-0">セッション</dt>
                  <dd className="font-mono text-xs break-all">{manager.sessionId}</dd>
                </>
              )}
              {/*
                貸し出し（どのプロセスが握っているか）。**判定は書かない** — 引き取って
                よいかは時刻で変わるので（`packages/core/src/lease.ts`）、画面に焼くと
                読んだ瞬間から古びる。ここに出すのは材料だけである。

                材料が見えないと、引き取りが動かないのを見た人間は「忘れている」と
                「まだ握られていて待っている」を区別できない。
              */}
              {manager.lease !== undefined && manager.lease !== null && (
                <>
                  <dt className="mt-3 text-muted first:mt-0 sm:mt-0">貸し出し</dt>
                  <dd className="font-mono text-xs break-all">
                    {manager.lease.instanceId ?? 'プロセスは未名乗り'} / 世代 {manager.lease.fence}
                    （生存確認 {formatDateTime(manager.lease.seenAt)}）
                  </dd>
                </>
              )}
            </dl>
            <DisconnectedNote live={manager.live} />
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
              className="border-t border-border px-4 py-3 text-xs text-warn"
            />
            <LostNote status={manager.status} />
            <FailureNote failure={manager.lastFailure} />
          </Card>

          <DenialsCard denials={manager.denials} />

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
    </Page>
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
 * **要約も切り詰めもしない。** 一覧（`managers.tsx`）とダッシュボードは
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
        <p className="text-sm break-words whitespace-pre-wrap">{request}</p>
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
    <p className="border-t border-border px-4 py-3 text-xs text-danger">
      このデーモンは、このマネージャーの runner と
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
    <p className="border-t border-border px-4 py-3 text-xs text-danger">
      前のセッションへ戻れなかった。
      <strong className="font-medium">戻れたかどうかしか見ていない</strong>
      ので、この仕事が終わっていたかどうかは分からない。落ちる直前に PR を出して CI
      を通し、マージまで届いていた仕事がこの札を貼られた実例がある。
      <br />
      起こし直す前に、まず
      <strong className="font-medium">リモート（PR・ブランチ・コミット）を確かめること</strong>
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
 * 3. **セッションは生きている** — これが `status` を `failed` へ倒さなかった理由
 *    そのものである（`schema.ts` の `lastFailure` の doc）。書かないと、人間は
 *    続けられる仕事を閉じる
 *
 * **「上限に当たった」と決めつけないこと。** 観測しているのは「SDK が応答ではないと
 * 言った」ことと、その `code` だけである。`code` の意味の解釈は SDK 側が持っている。
 */
function FailureNote({ failure }: { failure: ManagerSummary['lastFailure'] | undefined }) {
  if (failure === undefined || failure === null) return null;
  return (
    <p className="border-t border-border px-4 py-3 text-xs text-danger">
      直近のターンは
      <strong className="font-medium">報告ではなく失敗で終わっている</strong>—{' '}
      <code className="font-mono">{failure.code}</code>（印の出どころ:{' '}
      <code className="font-mono">{failure.via}</code>、{formatDateTime(failure.at)}）。
      <br />
      <strong className="font-medium">この仕事は死んでいない</strong>
      。セッションは生きているので、原因が解ければ下の「話しかける」から続けられる（だから状態は
      <strong className="font-medium">失敗ではなく待機中</strong>
      のままである）。
      <strong className="font-medium">何が起きたかの解釈まではしていない</strong>— 観測したのは「SDK
      がこれは応答ではないと言った」ことと、この
      <code className="font-mono">code</code> だけである。
    </p>
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
    return <Markdown>{lastReport}</Markdown>;
  }
  return (
    <pre className="overflow-x-auto rounded border border-border bg-bg p-2 text-[11px] break-words whitespace-pre-wrap text-muted">
      {lastReport}
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
function DenialsCard({ denials }: { denials: ManagerDenial[] | undefined }) {
  if (denials === undefined || denials.length === 0) return null;
  // デーモンは古い順で返す。新しい側から読ませる。
  const recent = [...denials].reverse();
  return (
    <Card>
      <CardHeader
        title="確認へ上がらず止められた道具"
        subtitle="分類器か deny 規則がその場で拒否した。この確認は人間にもクローンにも回ってきていない"
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
      <p className="border-t border-border px-4 py-3 text-xs text-muted">
        止められた事実は数えているが、
        <strong className="font-medium">それでこの仕事が止まったかどうかは見ていない</strong>
        （デーモンに動きを見る手が無い）。全件は
        <Link to="/journal" className="text-accent hover:underline">
          日誌
        </Link>
        に残っている。 この件数はデーモンのプロセス内にしかないので、
        <strong className="font-medium">器を作り直すと数え直しになる</strong>— 「0
        件」は「止められていない」ではない。
      </p>
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
    <p className="mt-1 text-xs text-muted">
      {formatDateTime(askedAt)}（{formatRelative(askedAt)}）から
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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  function answer(decision: 'allow' | 'deny') {
    setBusy(true);
    setFailure(undefined);
    send(id, {
      text: decision === 'allow' ? '許可する' : '許可しない',
      requestId,
      decision,
    })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <div className="px-4 py-3">
      <p className="text-sm">{summary}</p>
      {askedAtNote}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={() => answer('allow')}>
          許可
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => answer('deny')}>
          拒否
        </Button>
      </div>
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

  function submit() {
    // **空文字・空白のみでは送らない。** ボタンの `disabled` だけに頼らない
    // （Cmd/Ctrl+Enter でもここへ来る）。
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    // **`decision` を付けない。** 質問に allow/deny は無い。
    send(id, { text, requestId })
      .then(() => setText(''))
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <div className="px-4 py-3">
      <p className="text-sm">{summary}</p>
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
          <span className="text-[11px] text-muted">⌘/Ctrl + Enter</span>
        </div>
      </div>
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
 * 黙って閉じることになる（`#unresumable.add` の直前のコメント。2026-08-16 時点で
 * `manager.ts:1400` 付近）。
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
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  function submit() {
    // **ボタンの `disabled` だけに頼らない。** Enter でもここへ来る。
    if (text.trim() === '' || noWayBack) return;
    setBusy(true);
    setFailure(undefined);
    send(id, { text })
      .then((result) => {
        setOutcome(`${result.outcome}: ${result.detail}`);
        setText('');
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader title="話しかける" subtitle="走行中のマネージャーに追加の指示を割り込ませる" />
      <div className="px-4 py-3">
        {noWayBack ? (
          <p id={REASON_ID} className="mb-2 text-xs text-danger">
            <strong className="font-medium">送れない</strong>—
            この仕事は戻る先（session_id）を持っておらず、送っても runner
            へは何も飛ばない。続きが要るなら
            <strong className="font-medium">新しく起こし直すこと</strong>。
          </p>
        ) : (
          !live && (
            <p className="mb-2 text-xs text-danger">
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
        {outcome !== undefined && <p className="mt-2 text-xs text-muted">{outcome}</p>}
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
          ) : (
            <pre className="max-h-[32rem] overflow-auto rounded border border-border bg-bg p-2 text-[11px] text-muted">
              {data === undefined || data === '' ? '(空)' : data}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}
