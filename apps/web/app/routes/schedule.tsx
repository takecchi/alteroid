import { useState } from 'react';
import { Tabs } from 'radix-ui';

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
  Select,
  Spinner,
  TAB_TRIGGER_ACTIVE_CLASS,
  TAB_TRIGGER_CLASS,
  Textarea,
} from '~/components/ui';
import {
  useCreateSchedule,
  usePostEvent,
  useRemoveSchedule,
  useRunSchedule,
} from '~/hooks/mutations';
import { useSchedule } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime, formatRelative } from '~/lib/format';
import type { ScheduleEntry, ScheduleSpec } from '~/lib/types';

/**
 * 仕事の起点のうち、時間（②）と外部イベント（③）を人間から起こす画面。
 *
 * **「今すぐ回す」と「仕込む」は別の操作である。** 前者は既定で回っているものを
 * 待たずに確かめる口で、日報も発意 tick も放っておいても動く。後者は**依頼そのものを
 * 増やす**もので、CLI（`/schedule <kind> <周期> <依頼>`）とクローンの道具
 * （`schedule_create`）にはあったのに、この画面にだけ無かった。
 *
 * **編集（#496）も同じ upsert（`POST /schedule`）に乗る。** デーモン側に新しい
 * verb は無い——「同じ kind なら置き換わる」という `POST /schedule` の契約
 * そのものが編集である（`apps/daemon/src/app.ts` の doc）。だから
 * `useCreateSchedule` をそのまま使い、新しい hook は増やさない。
 */
export default function Schedule() {
  const { data, error, isLoading } = useSchedule();
  const runSchedule = useRunSchedule();
  const removeSchedule = useRemoveSchedule();
  const [running, setRunning] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
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

                  (3) 編集パネル（`ScheduleEditForm`）は `w-full` で足す —
                  この `li` が `flex flex-wrap` なので、`w-full` の子は
                  折り返して新しい行になる（横並びのボタン列を崩さない）。
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

                    **本文は `line-clamp-3` で畳む**（#496。実測で本文が
                    932〜3,816字あり、畳まないと一覧の1行が画面外まで伸びる）。
                    **黙って切らない** — 「編集」で全文が読めることを隣に書く
                    （`markdown.tsx` の「一覧の1行は Markdown 化の対象外」と
                    同じ理由でここも `<Markdown>` は使わず生テキストのまま）。
                  */}
                  {entry.request !== undefined && (
                    <>
                      <p className="mt-1 line-clamp-3 text-xs break-words text-muted">
                        {entry.request}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        前回:{' '}
                        {entry.lastRunAt === undefined
                          ? 'まだ一度も動いていない'
                          : formatDateTime(entry.lastRunAt)}
                        {' · 全文・周期は「編集」で見られる'}
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

                  **「編集」も同じ条件で出す。** `request` を持つもの＝人間か
                  クローンが仕込んだ依頼だけが編集の対象になる（既定の日報・
                  発意 tick は `spec` も `request` も持たないので、直しようが
                  無い——`ScheduleStatus.spec` の doc「コードに書かれた既定で
                  値そのものが存在しない」）。
                */}
                {entry.request === undefined ? (
                  <span className="shrink-0 text-[11px] text-muted">既定（外せない）</span>
                ) : (
                  <>
                    <Button size="sm" onClick={() => setEditing(entry.kind)}>
                      編集
                    </Button>
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
                  </>
                )}
                {editing === entry.kind && (
                  <ScheduleEditForm
                    entry={entry}
                    onCancel={() => setEditing(undefined)}
                    onSaved={() => setEditing(undefined)}
                  />
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

// ---------------------------------------------------------------------------
// 周期・本文の入力（新規登録と編集で共有する部品）
// ---------------------------------------------------------------------------

/**
 * 周期の入力の下書き。**3つの型ぶんの値を常に持つ。**
 *
 * `type` を切り替えても他の型の入力値を捨てないため（`daily` で時刻を書いた
 * あと `cron` を試し、また `daily` へ戻っても時刻が消えない）。送るときだけ
 * `specDraftToSpec` が選ばれた型の分を切り出す。
 */
interface ScheduleSpecDraft {
  type: 'daily' | 'every' | 'cron';
  at: string;
  minutes: string;
  expression: string;
}

const DEFAULT_SPEC_DRAFT: ScheduleSpecDraft = {
  type: 'daily',
  at: '09:00',
  minutes: '30',
  expression: '0 10 * * 1',
};

/**
 * 仕込まれた周期から下書きを作る。**渡さなければ新規登録の既定値。**
 *
 * 選ばれた型以外の欄は既定値のまま埋める——編集を開いた直後にも `type` を
 * 切り替えられるようにするため（空欄のままだと切り替えた瞬間に無効な値になる）。
 */
function initialSpecDraft(spec?: ScheduleSpec): ScheduleSpecDraft {
  if (spec === undefined) return DEFAULT_SPEC_DRAFT;
  if (spec.type === 'daily') return { ...DEFAULT_SPEC_DRAFT, type: 'daily', at: spec.at };
  if (spec.type === 'every') {
    return { ...DEFAULT_SPEC_DRAFT, type: 'every', minutes: String(spec.minutes) };
  }
  return { ...DEFAULT_SPEC_DRAFT, type: 'cron', expression: spec.expression };
}

/**
 * 下書きから送る形へ。
 *
 * **形は API の型のまま組む。** ここで検査を足さないのは、`scheduleSpecSchema`
 * が時刻の範囲も cron 式が読めるかどうかも見ているからである（読めない式を
 * 保存できると、一覧に出るのに発火しない仕込みが作れる）。画面でも同じ検査を
 * 書くと、片方だけ直したときに**画面は通すのにデーモンが弾く**（あるいはその逆）が
 * 生まれる。断られた理由はそのまま出す。
 */
function specDraftToSpec(draft: ScheduleSpecDraft): ScheduleSpec {
  if (draft.type === 'daily') return { type: 'daily', at: draft.at };
  if (draft.type === 'every') return { type: 'every', minutes: Number(draft.minutes) };
  return { type: 'cron', expression: draft.expression };
}

/**
 * 周期の入力欄。**新規登録（`ScheduleForm`）と編集（`ScheduleEditForm`）の
 * 共有部品**（#496）。分けて書くと片方だけ直され、「新規では書けるのに編集では
 * 書けない周期」が戻る。
 */
function ScheduleSpecFields({
  draft,
  onChange,
}: {
  draft: ScheduleSpecDraft;
  onChange: (next: ScheduleSpecDraft) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="周期"
        value={draft.type}
        className="w-auto"
        onChange={(event) =>
          onChange({ ...draft, type: event.target.value as ScheduleSpecDraft['type'] })
        }
      >
        <option value="daily">毎日この時刻</option>
        <option value="every">この分数ごと</option>
        <option value="cron">cron 式</option>
      </Select>
      {draft.type === 'daily' && (
        <Input
          aria-label="時刻"
          className="w-32"
          value={draft.at}
          placeholder="HH:MM"
          onChange={(event) => onChange({ ...draft, at: event.target.value })}
        />
      )}
      {draft.type === 'every' && (
        <Input
          aria-label="分"
          className="w-24"
          value={draft.minutes}
          inputMode="numeric"
          onChange={(event) => onChange({ ...draft, minutes: event.target.value })}
        />
      )}
      {draft.type === 'cron' && (
        <Input
          aria-label="cron 式"
          className="w-56 font-mono"
          value={draft.expression}
          placeholder="0 10 * * 1"
          onChange={(event) => onChange({ ...draft, expression: event.target.value })}
        />
      )}
    </div>
  );
}

/**
 * 依頼本文の入力。**プレビュー / 編集タブ**（人間の依頼:
 * 「人が編集できるものに関しては記憶と同じで、タブとしてデフォルトが
 * プレビュー、編集を用意する感じで」）。
 *
 * **`memory-detail.tsx` と同じ規則を使う** — 読むものが在ればプレビュー、
 * 無ければ編集を既定にする（`grep -Fn -- "プレビュー、無ければ編集**を既定に
 * する" apps/web/app/routes/memory-detail.tsx`）。この規則1つで、新規登録
 * （本文は必ず空で始まる）は編集タブが、既存の依頼の編集（本文は必ず在る）は
 * プレビュータブが、それぞれ正しく既定になる——新規と編集で別の初期値を
 * 書く必要が無い。
 *
 * 既定は `initialValue`（開いた時点の値）で決める。`value`（入力中の値）で
 * 決めると、打ち始めた瞬間にプレビューへ切り替わってしまう。
 *
 * **新規登録と編集で共有する部品。** 分けて書くと片方だけ古くなる
 * （`ScheduleSpecFields` と同じ理由）。
 */
function RequestEditor({
  value,
  onChange,
  initialValue,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  initialValue: string;
  placeholder?: string;
}) {
  const [tab, setTab] = useState<string | undefined>(undefined);
  const activeTab = tab ?? (initialValue.trim() === '' ? 'edit' : 'preview');

  return (
    <Tabs.Root value={activeTab} onValueChange={setTab}>
      <Tabs.List className="mb-1 flex shrink-0 gap-1 border-b border-border">
        <Tabs.Trigger
          value="preview"
          className={cn(TAB_TRIGGER_CLASS, activeTab === 'preview' && TAB_TRIGGER_ACTIVE_CLASS)}
        >
          プレビュー
        </Tabs.Trigger>
        <Tabs.Trigger
          value="edit"
          className={cn(TAB_TRIGGER_CLASS, activeTab === 'edit' && TAB_TRIGGER_ACTIVE_CLASS)}
        >
          編集
        </Tabs.Trigger>
      </Tabs.List>

      {/*
        **高さに上限を付けて、一覧を下へ押し出さない側にする**（本文が実測
        3,816字あった）。`max-h-64`（16rem）+ `overflow-y-auto` はプレビュー・
        編集の両方に付ける——片方だけ抑えても、もう片方のタブへ切り替えた
        瞬間に同じ問題が起きる。
      */}
      <Tabs.Content
        value="preview"
        className="max-h-64 min-h-24 overflow-y-auto rounded-md border border-border bg-bg px-3 py-2"
      >
        {value.trim() === '' ? (
          <p className="text-xs text-muted">（本文が空）</p>
        ) : (
          <Markdown>{value}</Markdown>
        )}
      </Tabs.Content>

      <Tabs.Content value="edit">
        <Textarea
          rows={6}
          className="max-h-64 min-h-24 resize-y font-mono text-xs leading-relaxed"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}

// ---------------------------------------------------------------------------
// 仕込まれた依頼を直す
// ---------------------------------------------------------------------------

/**
 * 仕込まれた依頼の周期・本文を直す。**新しい HTTP verb は無い** — `POST
 * /schedule` は upsert で、同じ kind なら置き換わる（前回動いた時刻は保つ）。
 *
 * **`kind` は変えさせない。** `kind` を変えて送ると upsert は「別の依頼を
 * 新しく作る」ことになり、元の依頼がそのまま残る（外し忘れた依頼が2つ並ぶ）。
 * だから読み取り専用で見せる。
 *
 * **`entry.spec` が無ければ保存させない。** この画面より古いデーモンは
 * `spec` を返さない。`POST /schedule` は `spec` を必須で要求するので、
 * 読めない周期を既定値（例: daily 09:00）で埋めて送ると、**本文だけ直した
 * つもりの保存が周期を黙って書き換える**（upsert なので）。推測で埋めずに
 * 保存そのものを止める。
 */
function ScheduleEditForm({
  entry,
  onCancel,
  onSaved,
}: {
  entry: ScheduleEntry;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const createSchedule = useCreateSchedule();
  const [specDraft, setSpecDraft] = useState<ScheduleSpecDraft>(() => initialSpecDraft(entry.spec));
  const [request, setRequest] = useState(entry.request ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const specUnknown = entry.spec === undefined;
  const ready = !specUnknown && request.trim() !== '';

  function submit() {
    if (!ready) return;
    setBusy(true);
    setFailure(undefined);
    createSchedule({
      kind: entry.kind,
      request: request.trim(),
      spec: specDraftToSpec(specDraft),
    })
      .then(onSaved)
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <div
      role="group"
      aria-label={`${entry.kind} を編集`}
      className="mt-2 w-full rounded-md border border-border bg-surface-2 p-3"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>kind（変更不可。別の名前にしたいなら外して新しく仕込む）:</span>
        <span className="font-mono break-words">{entry.kind}</span>
      </div>
      {specUnknown ? (
        <ErrorNote
          error={
            new Error(
              'このデーモンは周期（spec）を返していない（この画面より古い版の可能性）。' +
                '周期が読めないまま保存すると、上書きで周期が既定値へ黙って変わって' +
                'しまうので、ここでは保存できない。デーモンを更新してから開き直すこと。',
            )
          }
          className="mb-2"
        />
      ) : (
        <div className="mb-2">
          <ScheduleSpecFields draft={specDraft} onChange={setSpecDraft} />
        </div>
      )}
      <RequestEditor
        value={request}
        onChange={setRequest}
        initialValue={entry.request ?? ''}
        placeholder="依頼の本文（時刻が来たらそのままクローンへ渡る）"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" size="sm" loading={busy} disabled={!ready} onClick={submit}>
          保存する
        </Button>
        <Button size="sm" onClick={onCancel} disabled={busy}>
          やめる
        </Button>
      </div>
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新規に仕込む
// ---------------------------------------------------------------------------

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
  const [specDraft, setSpecDraft] = useState<ScheduleSpecDraft>(DEFAULT_SPEC_DRAFT);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);

  const ready = kind.trim() !== '' && request.trim() !== '';

  function submit() {
    if (!ready) return;
    setBusy(true);
    setFailure(undefined);
    setDone(undefined);

    createSchedule({ kind: kind.trim(), request: request.trim(), spec: specDraftToSpec(specDraft) })
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
        <ScheduleSpecFields draft={specDraft} onChange={setSpecDraft} />
        <RequestEditor
          value={request}
          onChange={setRequest}
          initialValue=""
          placeholder="依頼の本文（時刻が来たらそのままクローンへ渡る）"
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
