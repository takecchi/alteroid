import { useState } from 'react';

import { Page } from '~/components/page';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  Select,
  Spinner,
  Textarea,
} from '~/components/ui';
import {
  useCreateSchedule,
  usePostEvent,
  useRemoveSchedule,
  useRunSchedule,
} from '~/hooks/mutations';
import { useSchedule } from '~/hooks/queries';
import { formatDateTime, formatRelative } from '~/lib/format';

/**
 * 仕事の起点のうち、時間（②）と外部イベント（③）を人間から起こす画面。
 *
 * **「今すぐ回す」と「仕込む」は別の操作である。** 前者は既定で回っているものを
 * 待たずに確かめる口で、日報も発意 tick も放っておいても動く。後者は**依頼そのものを
 * 増やす**もので、CLI（`/schedule <kind> <周期> <依頼>`）とクローンの道具
 * （`schedule_create`）にはあったのに、この画面にだけ無かった。
 */
export default function Schedule() {
  const { data, error, isLoading } = useSchedule();
  const runSchedule = useRunSchedule();
  const removeSchedule = useRemoveSchedule();
  const [running, setRunning] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  return (
    <Page title="スケジュールと外部イベント" description="時間起点と外部イベント起点を手で起こす">
      <ErrorNote error={error ?? failure} className="mb-4" />

      <Card className="mb-4">
        <CardHeader title="定期ジョブ" subtitle="既定で回っている。ここは待たずに試すための口" />
        {isLoading ? (
          <Spinner />
        ) : data === undefined || data.entries.length === 0 ? (
          <Empty>登録された定期ジョブが無い（`off` にしている可能性がある）。</Empty>
        ) : (
          <ul>
            {data.entries.map((entry) => (
              <li
                key={entry.kind}
                /*
                  **この行だけで2種類の直しが要る。**
                  (1) `flex-wrap`: 右側の時刻+バッジ（`shrink-0`）と、本3で
                  `h-11` になったボタン1〜2個が、本文側が `min-w-0 flex-1`
                  で縮んでも合計で入りきらないことがある。折り返さないと
                  画面外へ出る側へ振れる。
                  (2) `entry.kind` は `scheduleKindSchema`（`packages/core/
                  src/schema.ts`）で `min(1).max(64)` かつ `[a-z0-9._-]` のみ
                  ——空白を持たない最大64字の機械可読トークンなので、
                  `break-words` が無いと `min-w-0 flex-1` の中でもテキスト
                  自体がはみ出しうる（`.`/`-`/`_` は必ずしも改行点にならない）。
                  `entry.description` は自由文（空白を含む）なので同じ懸念は
                  無く、ここでは追加していない。
                */
                className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{entry.description}</p>
                  <p className="mt-0.5 font-mono text-[11px] break-words text-muted">
                    {entry.kind}
                  </p>
                  {/*
                    **継続中の依頼だけが持つもの。** `request` があるかどうかが
                    「人間かクローンが仕込んだ依頼」と「既定の仕込み（日報・発意
                    tick）」の境目である（既定のほうは本文も周期も持たない）。

                    `lastRunAt` を出すのは、**仕込んだのに発火していないことに
                    気づけるようにする**ためである。次回時刻だけを見せると、
                    一度も動いていない仕込みが「これから動く」と同じ顔で並ぶ
                    （#96 が直した「器の入れ替えで位相が失われる」がまさにこの
                    形で、CLI では前から見えていた）。
                  */}
                  {entry.request !== undefined && (
                    <>
                      <p className="mt-1 text-xs break-words text-muted">{entry.request}</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        前回:{' '}
                        {entry.lastRunAt === undefined
                          ? 'まだ一度も動いていない'
                          : formatDateTime(entry.lastRunAt)}
                      </p>
                    </>
                  )}
                </div>
                <div className="shrink-0 text-right text-[11px] text-muted">
                  <p>{formatDateTime(entry.nextAt)}</p>
                  <Badge tone="accent">{formatRelative(entry.nextAt)}</Badge>
                </div>
                <Button
                  size="sm"
                  loading={running === entry.kind}
                  onClick={() => {
                    setRunning(entry.kind);
                    setFailure(undefined);
                    runSchedule(entry.kind)
                      .catch(setFailure)
                      .finally(() => setRunning(undefined));
                  }}
                >
                  今すぐ回す
                </Button>
                {/*
                  **既定の仕込みには外すボタンを出さない。** デーモンが名前を
                  守っている（`RESERVED_SCHEDULE_KINDS`）ので押しても断られる。
                  ただし**黙って消さない** — 代わりに「既定（外せない）」と書く。
                  ボタンだけ消すと、押せない理由が画面から消える。
                */}
                {entry.request === undefined ? (
                  <span className="shrink-0 text-[11px] text-muted">既定（外せない）</span>
                ) : (
                  <Button
                    size="sm"
                    variant="danger"
                    loading={removing === entry.kind}
                    onClick={() => {
                      setRemoving(entry.kind);
                      setFailure(undefined);
                      removeSchedule(entry.kind)
                        .catch(setFailure)
                        .finally(() => setRemoving(undefined));
                    }}
                  >
                    外す
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ScheduleForm />
      <EventForm />
    </Page>
  );
}

/**
 * 継続する依頼を仕込む。
 *
 * **記憶に書くだけでは足りない**（PRD「自律」）。記憶は時計を持たないので、そこに
 * だけ書いた依頼は「発意 tick のときに思い出せるかどうかの賭け」になる。ここに置いた
 * 依頼は時刻が来れば必ずクローンの受信箱へ届く。
 *
 * **周期の3つを画面から落とさない。** 曜日や月の指定は cron でしか書けず、
 * 「毎日起きて曜日を見て何もしない」で代用すると7回に6回はターンを空焼きする
 * （`scheduleSpecSchema` の cron のコメント）。だから `daily` / `every` / `cron` の
 * 3つとも置く。
 */
function ScheduleForm() {
  const createSchedule = useCreateSchedule();
  const [kind, setKind] = useState('');
  const [request, setRequest] = useState('');
  const [type, setType] = useState<'daily' | 'every' | 'cron'>('daily');
  const [at, setAt] = useState('09:00');
  const [minutes, setMinutes] = useState('30');
  const [expression, setExpression] = useState('0 10 * * 1');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  const ready = kind.trim() !== '' && request.trim() !== '';

  function submit() {
    if (!ready) return;
    setBusy(true);
    setFailure(undefined);
    setDone(undefined);

    /*
     * **形は API の型のまま組む。** ここで検査を足さないのは、`scheduleSpecSchema`
     * が時刻の範囲も cron 式が読めるかどうかも見ているからである（読めない式を
     * 保存できると、一覧に出るのに発火しない仕込みが作れる）。画面でも同じ検査を
     * 書くと、片方だけ直したときに**画面は通すのにデーモンが弾く**（あるいはその逆）が
     * 生まれる。断られた理由はそのまま出す。
     */
    const spec =
      type === 'daily'
        ? ({ type: 'daily', at } as const)
        : type === 'every'
          ? ({ type: 'every', minutes: Number(minutes) } as const)
          : ({ type: 'cron', expression } as const);

    createSchedule({ kind: kind.trim(), request: request.trim(), spec })
      .then(() => {
        setDone(kind.trim());
        setRequest('');
        setKind('');
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Card className="mb-4">
      <CardHeader
        title="継続する依頼を仕込む"
        subtitle="時刻が来れば必ず届く（記憶に書くだけでは、思い出せるかどうかの賭けになる）"
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <Input
          value={kind}
          placeholder="kind（英小文字・数字・. _ -。例: morning-issues）"
          onChange={(event) => setKind(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="周期"
            value={type}
            className="w-auto"
            onChange={(event) => setType(event.target.value as 'daily' | 'every' | 'cron')}
          >
            <option value="daily">毎日この時刻</option>
            <option value="every">この分数ごと</option>
            <option value="cron">cron 式</option>
          </Select>
          {type === 'daily' && (
            <Input
              aria-label="時刻"
              className="w-32"
              value={at}
              placeholder="HH:MM"
              onChange={(event) => setAt(event.target.value)}
            />
          )}
          {type === 'every' && (
            <Input
              aria-label="分"
              className="w-24"
              value={minutes}
              inputMode="numeric"
              onChange={(event) => setMinutes(event.target.value)}
            />
          )}
          {type === 'cron' && (
            <Input
              aria-label="cron 式"
              className="w-56 font-mono"
              value={expression}
              placeholder="0 10 * * 1"
              onChange={(event) => setExpression(event.target.value)}
            />
          )}
        </div>
        <Textarea
          rows={3}
          value={request}
          placeholder="依頼の本文（時刻が来たらそのままクローンへ渡る）"
          onChange={(event) => setRequest(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" loading={busy} disabled={!ready} onClick={submit}>
            仕込む
          </Button>
          {done !== undefined && (
            <span className="font-mono text-[11px] text-muted">仕込んだ: {done}</span>
          )}
        </div>
        <ErrorNote error={failure} />
      </div>
    </Card>
  );
}

function EventForm() {
  const postEvent = usePostEvent();
  const [source, setSource] = useState('');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  function submit() {
    if (source.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    setSent(undefined);

    // JSON として読めればそのまま、読めなければ文字列として渡す。
    // ここで弾くと「送れない形」を画面が勝手に作ることになる。
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      parsed = payload;
    }

    postEvent(source, parsed)
      .then((result) => {
        setSent(result.id);
        setPayload('');
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader
        title="外部イベントを流す"
        subtitle="MCP 経由の通知・CI の失敗・レビュー依頼を、人間の手で再現する"
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <Input
          value={source}
          placeholder="source（例: github, slack, ci）"
          onChange={(event) => setSource(event.target.value)}
        />
        <Textarea
          rows={4}
          value={payload}
          className="font-mono text-xs"
          placeholder="payload（JSON でも素のテキストでもよい）"
          onChange={(event) => setPayload(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" loading={busy} disabled={source.trim() === ''} onClick={submit}>
            送る
          </Button>
          {sent !== undefined && (
            <span className="font-mono text-[11px] text-muted">受け付けた: {sent}</span>
          )}
        </div>
        <ErrorNote error={failure} />
      </div>
    </Card>
  );
}
