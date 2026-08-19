import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useAbortManager, useSendManagerMessage } from '~/hooks/mutations';
import { useManager, useManagerTranscript } from '~/hooks/queries';
import { formatDateTime, formatRelative } from '~/lib/format';

import type { ManagerDenial, ManagerStatus } from '~/lib/types';

import type { Route } from './+types/manager-detail';
import { ManagerStatusBadge } from './managers';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { id: params.id };
}

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
      description={manager?.request}
      action={
        manager !== undefined &&
        (manager.status === 'running' || manager.status === 'waiting_human') ? (
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
          <Card>
            <CardHeader title="状態" />
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 px-4 py-3 text-sm">
              <dt className="text-muted">状態</dt>
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
              </dd>
              <dt className="text-muted">作業ディレクトリ</dt>
              <dd className="font-mono text-xs break-all">{manager.cwd}</dd>
              <dt className="text-muted">開始</dt>
              <dd>
                {formatDateTime(manager.startedAt)}（{formatRelative(manager.startedAt)}）
              </dd>
              <dt className="text-muted">更新</dt>
              <dd>
                {formatDateTime(manager.updatedAt)}（{formatRelative(manager.updatedAt)}）
              </dd>
              {manager.runnerId !== undefined && manager.runnerId !== null && (
                <>
                  <dt className="text-muted">runner</dt>
                  <dd className="font-mono text-xs">{manager.runnerId}</dd>
                </>
              )}
              {manager.sessionId !== undefined && manager.sessionId !== null && (
                <>
                  <dt className="text-muted">セッション</dt>
                  <dd className="font-mono text-xs break-all">{manager.sessionId}</dd>
                </>
              )}
            </dl>
            <DisconnectedNote live={manager.live} />
            <LostNote status={manager.status} />
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
                    <WaitingRow id={id} requestId={request.requestId} summary={request.summary} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {manager.lastReport !== undefined && manager.lastReport !== null && (
            <Card className="min-w-0">
              <CardHeader title="最後の報告" />
              <div className="min-w-0 px-4 py-3">
                <Markdown>{manager.lastReport}</Markdown>
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
          <li key={entry.tool} className="flex items-baseline justify-between gap-3 py-0.5">
            <span className="font-mono text-xs break-all">{entry.tool}</span>
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

function WaitingRow({
  id,
  requestId,
  summary,
}: {
  id: string;
  requestId: string;
  summary: string;
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
