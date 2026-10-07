import { ScheduleTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { unsentInput } from '~/lib/unsent-input';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { useLatest } from '~/lib/use-latest';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Tabs } from 'radix-ui';

import {
  Markdown,
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Empty,
  ErrorNote,
  Input,
  Select,
  Spinner,
  TAB_TRIGGER_ACTIVE_CLASS,
  TAB_TRIGGER_CLASS,
  SubmitHint,
  Textarea,
  cn,
} from '@alteroid/ui';
import {
  ApiError,
  useCreateSchedule,
  usePostEvent,
  useRemoveSchedule,
  useRunSchedule,
  useSchedule,
} from '@alteroid/swr';
import { formatDateTime, formatRelative } from '@alteroid/logic';
import type { ScheduleEntry, ScheduleSpec, UnreadableSchedule } from '@alteroid/logic';

// 「消された依頼ではない」を落とさない: 落とすと行が消えたのと区別が付かないため
const UNREADABLE_SCHEDULE_KINDS_SHOWN = 20;

export function UnreadableScheduleNote({
  unreadable,
  className,
}: {
  unreadable: UnreadableSchedule[];
  className?: string;
}) {
  if (unreadable.length === 0) return null;
  const kindsAll = unreadable
    .map((entry) => entry.kind)
    .filter((kind): kind is string => kind != null);
  const kinds = kindsAll.slice(0, UNREADABLE_SCHEDULE_KINDS_SHOWN);
  const kindsRest = kindsAll.length - kinds.length;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        読めない継続中の依頼が {unreadable.length} 件ある
        {kinds.length > 0 &&
          `（kind: ${kinds.join(', ')}${kindsRest > 0 ? ` …ほか ${kindsRest} 件は省略` : ''}）`}
        。<strong>壊れた行であって、消された依頼ではない。</strong>
        この一覧には載っていない。
      </span>
    </div>
  );
}

export default function Schedule() {
  return (
    <LeaveGuardScope>
      <SchedulePage />
    </LeaveGuardScope>
  );
}

function SchedulePage() {
  const { data, error, isLoading, isValidating, mutate } = useSchedule();
  const runSchedule = useRunSchedule();
  const removeSchedule = useRemoveSchedule();
  // 同じ描画の間に届く2回目のクリックは runningRef が同期的に弾く: running（state）は描き直された後にしか効かないため
  const runningRef = useRef<Set<string>>(new Set());
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [ran, setRan] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [confirmingRemove, setConfirmingRemove] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [editDirty, setEditDirty] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<{ next: string | undefined } | undefined>(
    undefined,
  );
  function requestEditing(next: string | undefined) {
    if (next === editing) return;
    if (editing !== undefined && editDirty) {
      setSwitchingTo({ next });
      return;
    }
    setEditing(next);
  }
  const [failure, setFailure] = useState<unknown>(undefined);
  // 取れなかったのを0件と描かない: 「登録された定期ジョブが無い」は状態の断定になるため
  const listUnavailable = data === undefined && error !== undefined;
  // 一覧が読めていないときは空にする: 確かめようが無いので送る側を止めないため
  const existingKinds: ReadonlySet<string> = new Set([
    ...(data?.entries ?? []).filter((entry) => entry.request !== undefined).map((e) => e.kind),
    ...(data?.unreadable ?? []).flatMap((entry) => (entry.kind != null ? [entry.kind] : [])),
  ]);

  return (
    <Page
      tabs={<ScheduleTabs />}
      title="予定"
      description="決まった時刻に動く依頼と、外部からの知らせを、ここで確かめたり手で起こしたりする"
    >
      <ConfirmDialog
        open={switchingTo !== undefined}
        onOpenChange={(open) => {
          if (!open) setSwitchingTo(undefined);
        }}
        title="保存していない変更があります"
        description={
          switchingTo?.next === undefined
            ? '編集をやめると、書きかけの内容は失われます。'
            : '別の依頼の編集に切り替えると、書きかけの内容は失われます。'
        }
        confirmLabel={switchingTo?.next === undefined ? '破棄して閉じる' : '破棄して切り替える'}
        destructive
        onConfirm={() => {
          if (switchingTo !== undefined) setEditing(switchingTo.next);
          setSwitchingTo(undefined);
        }}
      />
      <LoadError
        what="スケジュール"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="mb-4"
      />
      <ErrorNote error={failure} className="mb-4" />

      <UnreadableScheduleNote unreadable={data?.unreadable ?? []} className="mb-4" />

      <Card className="mb-4">
        <CardHeader title="定期ジョブ" subtitle="既定で回っている。ここは待たずに試すための口" />
        {isLoading ? (
          <Spinner />
        ) : listUnavailable ? null : data === undefined || data.entries.length === 0 ? (
          <Empty>
            {(data?.unreadable ?? []).length > 0
              ? '読めた範囲では、登録された定期ジョブが無い。'
              : '登録された定期ジョブが無い（定期ジョブをすべて止めている場合もある）。'}
          </Empty>
        ) : (
          <ul>
            {data.entries.map((entry) => (
              <li
                key={entry.kind}
                /* flex-wrap と break-words を付ける: 右側の時刻+バッジとボタンが合計で入りきらないことがあり、kind は空白を持たない最大64字で break-words が無いとはみ出しうるため */
                className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                {/* 説明文の列に最小幅を持たせる: min-w-0 flex-1 のままだと折り返しの判定で幅 0 の項目として数えられ、説明文だけが 46px ほどに潰れたため */}
                <div className="min-w-[min(14rem,100%)] flex-1">
                  <p className="text-sm">{entry.description}</p>
                  {/* 既定の仕込みの kind は出さない: 内部の識別子を利用者に見せないため */}
                  {entry.request !== undefined && (
                    <p className="mt-0.5 text-[11px] break-words text-muted-foreground">
                      名前: <span className="font-mono break-words">{entry.kind}</span>
                    </p>
                  )}
                  {/* 既定の仕込みの名前を書き写さない: 数え上げを持つのは RESERVED_SCHEDULE_KINDS だけのため */}
                  {/* 本文は <Markdown> を使わず line-clamp-3 で畳む: 畳まないと一覧の1行が画面外まで伸びるため */}
                  {entry.request !== undefined && (
                    <>
                      <p className="mt-1 line-clamp-3 text-xs break-words text-muted-foreground">
                        {entry.request}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        前回:{' '}
                        {entry.lastRunAt === undefined
                          ? 'まだ一度も動いていない'
                          : formatDateTime(entry.lastRunAt)}
                        {' · 全文・周期は「編集」で見られる'}
                      </p>
                    </>
                  )}
                </div>
                <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                  <p>{formatDateTime(entry.nextAt)}</p>
                  <Badge tone="accent">{formatRelative(entry.nextAt)}</Badge>
                </div>
                <Button
                  size="sm"
                  aria-label={`${entry.kind} を今すぐ回す`}
                  loading={running.has(entry.kind)}
                  onClick={() => {
                    if (runningRef.current.has(entry.kind)) return;
                    runningRef.current.add(entry.kind);
                    setRunning(new Set(runningRef.current));
                    setRan(undefined);
                    setFailure(undefined);
                    runSchedule(entry.kind)
                      // 「終わった」とは書かない: デーモンは scheduler.run が真なら { ok: true } を返すだけで、ターンの結果は待たないため
                      .then(() => setRan(entry.kind))
                      .catch(setFailure)
                      .finally(() => {
                        runningRef.current.delete(entry.kind);
                        setRunning(new Set(runningRef.current));
                      });
                  }}
                >
                  今すぐ回す
                </Button>
                {ran === entry.kind && (
                  <span role="status" className="shrink-0 text-[11px] text-muted-foreground">
                    起こした（結果は待っていない）
                  </span>
                )}
                {/* 既定の仕込みは外すボタンを消さず「既定（外せない）」と書く: ボタンだけ消すと押せない理由が画面から消えるため */}
                {entry.request === undefined ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    既定（外せない）
                  </span>
                ) : (
                  <>
                    <Button
                      size="sm"
                      aria-label={`${entry.kind} を編集`}
                      onClick={() => requestEditing(entry.kind)}
                    >
                      編集
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`${entry.kind} を外す`}
                      loading={removing === entry.kind}
                      onClick={() => setConfirmingRemove(entry.kind)}
                    >
                      外す
                    </Button>
                    {/* 押した瞬間には実行せず確認を挟む: 外すと依頼の本文も周期も消えて取り消せないため */}
                    <ConfirmDialog
                      open={confirmingRemove === entry.kind}
                      onOpenChange={(open) => {
                        if (!open) setConfirmingRemove(undefined);
                      }}
                      title={`予定「${entry.kind}」を外しますか`}
                      description="依頼の本文と周期が消え、元に戻せません。"
                      confirmLabel="外す"
                      destructive
                      onConfirm={() => {
                        setRemoving(entry.kind);
                        setFailure(undefined);
                        removeSchedule(entry.kind)
                          .catch(setFailure)
                          .finally(() => setRemoving(undefined));
                      }}
                    />
                  </>
                )}
                {editing === entry.kind && (
                  <ScheduleEditForm
                    entry={entry}
                    onCancel={() => requestEditing(undefined)}
                    onSaved={() => setEditing(undefined)}
                    onDirtyChange={setEditDirty}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ScheduleForm existingKinds={existingKinds} />
      <EventForm />
    </Page>
  );
}

// 3つの型ぶんの値を常に持つ: type を切り替えても他の型の入力値を捨てないため
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

// 選ばれた型以外の欄も既定値で埋める: 空欄のままだと type を切り替えた瞬間に無効な値になるため
function initialSpecDraft(spec?: ScheduleSpec): ScheduleSpecDraft {
  if (spec === undefined) return DEFAULT_SPEC_DRAFT;
  if (spec.type === 'daily') return { ...DEFAULT_SPEC_DRAFT, type: 'daily', at: spec.at };
  if (spec.type === 'every') {
    return { ...DEFAULT_SPEC_DRAFT, type: 'every', minutes: String(spec.minutes) };
  }
  return { ...DEFAULT_SPEC_DRAFT, type: 'cron', expression: spec.expression };
}

// ここで検査を足さない: 画面でも同じ検査を書くと、片方だけ直したときに画面は通すのにデーモンが弾く（あるいはその逆）が生まれるため
function specDraftToSpec(draft: ScheduleSpecDraft): ScheduleSpec {
  if (draft.type === 'daily') return { type: 'daily', at: draft.at };
  if (draft.type === 'every') return { type: 'every', minutes: Number(draft.minutes) };
  return { type: 'cron', expression: draft.expression };
}

// 新規登録と編集で周期の入力欄を分けて書かない: 片方だけ直され、新規では書けるのに編集では書けない周期が戻るため
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

const EDIT_DIRTY_ID = 'edit';
const SCHEDULE_FORM_DIRTY_ID = 'schedule-form';
const EVENT_FORM_DIRTY_ID = 'event-form';

// 既定は initialValue（開いた時点の値）で決める: value（入力中の値）で決めると、打ち始めた瞬間にプレビューへ切り替わるため
function RequestEditor({
  value,
  onChange,
  activeTab,
  onTabChange,
  placeholder,
  label,
  onSubmit,
  submitDisabled,
}: {
  value: string;
  onChange: (value: string) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  placeholder?: string;
  label: string;
  onSubmit: () => void;
  submitDisabled: boolean;
}) {
  return (
    <Tabs.Root value={activeTab} onValueChange={onTabChange}>
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

      {/* 高さの上限をプレビュー・編集の両方に付ける: 片方だけ抑えても、もう片方のタブへ切り替えた瞬間に一覧を下へ押し出す問題が起きるため */}
      <Tabs.Content
        value="preview"
        className="max-h-64 min-h-24 overflow-y-auto rounded-md border border-border bg-background px-3 py-2"
      >
        {value.trim() === '' ? (
          <p className="text-xs text-muted-foreground">（本文が空）</p>
        ) : (
          <Markdown>{value}</Markdown>
        )}
      </Tabs.Content>

      <Tabs.Content value="edit">
        <Textarea
          aria-label={label}
          rows={6}
          className="min-h-24 font-mono text-xs leading-relaxed"
          maxHeight="16rem"
          onSubmitShortcut={onSubmit}
          submitDisabled={submitDisabled}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}

// busy（state）だけに頼らず ref の inFlight でも守る: 描き直しの前に届いた2回目（⌘/Ctrl+Enter の連打・確認の枠からの送信）を止められないため
function useSending() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  function begin(): boolean {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    return true;
  }
  function end() {
    inFlight.current = false;
    setBusy(false);
  }
  return { busy, inFlight, begin, end };
}

// タブの状態を親が持つ: 送るキーの案内は textarea が出ている編集のタブだけに出すので、案内を置く親も見える必要があるため
function useRequestTab(initialValue: string) {
  const [tab, setTab] = useState<string | undefined>(undefined);
  const activeTab = tab ?? (initialValue.trim() === '' ? 'edit' : 'preview');
  return { activeTab, setTab };
}

// kind は変えさせない: kind を変えて送ると upsert は別の依頼を新しく作り、元の依頼が残るため
// entry.spec が無ければ保存させない: 読めない周期を既定値で埋めて送ると、本文だけ直したつもりの保存が周期を黙って書き換えるため
function ScheduleEditForm({
  entry,
  onCancel,
  onSaved,
  onDirtyChange,
}: {
  entry: ScheduleEntry;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const createSchedule = useCreateSchedule();
  const [specDraft, setSpecDraft] = useState<ScheduleSpecDraft>(() => initialSpecDraft(entry.spec));
  const [request, setRequest] = useState(entry.request ?? '');
  const { activeTab, setTab } = useRequestTab(entry.request ?? '');
  const { busy, begin, end } = useSending();
  const [failure, setFailure] = useState<unknown>(undefined);
  const latestFields = useLatest({ request, specDraft });

  const initialSpec = initialSpecDraft(entry.spec);
  const dirty =
    request !== (entry.request ?? '') ||
    specDraft.type !== initialSpec.type ||
    specDraft.at !== initialSpec.at ||
    specDraft.minutes !== initialSpec.minutes ||
    specDraft.expression !== initialSpec.expression;
  useReportDirty(EDIT_DIRTY_ID, dirty);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const specUnknown = entry.spec === undefined;
  const ready = !specUnknown && request.trim() !== '';

  function submit() {
    if (!ready || !begin()) return;
    setFailure(undefined);
    const sentRequest = request;
    const sentSpec = specDraft;
    createSchedule({
      kind: entry.kind,
      request: request.trim(),
      spec: specDraftToSpec(specDraft),
    })
      .then(() => {
        const now = latestFields.current;
        if (
          now.request === sentRequest &&
          now.specDraft.type === sentSpec.type &&
          now.specDraft.at === sentSpec.at &&
          now.specDraft.minutes === sentSpec.minutes &&
          now.specDraft.expression === sentSpec.expression
        ) {
          onSaved();
        }
      })
      .catch(setFailure)
      .finally(end);
  }

  return (
    <div
      role="group"
      aria-label={`${entry.kind} を編集`}
      className="mt-2 w-full rounded-md border border-border bg-muted p-3"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>名前（変更不可。別の名前にしたいなら外して新しく仕込む）:</span>
        <span className="font-mono break-words">{entry.kind}</span>
      </div>
      {specUnknown ? (
        <ErrorNote
          error={
            new Error(
              '接続先のサーバは周期（spec）を返していない（この画面より古い版の可能性）。' +
                '周期が読めないまま保存すると、上書きで周期が既定値へ黙って変わって' +
                'しまうので、ここでは保存できない。サーバを更新してから開き直すこと。',
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
        activeTab={activeTab}
        onTabChange={setTab}
        label="依頼の本文"
        placeholder="依頼の本文（時刻が来たらそのままクローンへ渡る）"
        onSubmit={submit}
        submitDisabled={!ready || busy}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" size="sm" loading={busy} disabled={!ready} onClick={submit}>
          保存する
        </Button>
        {activeTab === 'edit' && <SubmitHint action="保存" />}
        <Button size="sm" onClick={onCancel} disabled={busy}>
          やめる
        </Button>
      </div>
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}


const RESERVED_KIND_MESSAGE = '既定の名前（予約名）なので使えない。別の名前にする';

// 周期の3つを画面から落とさない: 曜日や月の指定は cron でしか書けず、「毎日起きて曜日を見て何もしない」で代用すると7回に6回はターンを空焼きするため
function ScheduleForm({ existingKinds }: { existingKinds: ReadonlySet<string> }) {
  const createSchedule = useCreateSchedule();
  const kindId = useId();
  const [kind, setKind] = useState('');
  const [request, setRequest] = useState('');
  const { activeTab, setTab } = useRequestTab('');
  const [specDraft, setSpecDraft] = useState<ScheduleSpecDraft>(DEFAULT_SPEC_DRAFT);
  const { busy, inFlight, begin, end } = useSending();
  const [done, setDone] = useState<{ kind: string; replaced: boolean } | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [confirming, setConfirming] = useState(false);

  const ready = kind.trim() !== '' && request.trim() !== '';
  const replacing = existingKinds.has(kind.trim());
  useReportDirty(SCHEDULE_FORM_DIRTY_ID, kind !== '' || request !== '');

  function submit() {
    if (!ready || inFlight.current) return;
    if (replacing) {
      setConfirming(true);
      return;
    }
    send(false);
  }

  function send(replaced: boolean) {
    if (!begin()) return;
    const sentKind = kind;
    const sentRequest = request;
    setFailure(undefined);
    setDone(undefined);

    createSchedule({ kind: kind.trim(), request: request.trim(), spec: specDraftToSpec(specDraft) })
      .then(() => {
        setDone({ kind: sentKind.trim(), replaced });
        setRequest((current) => unsentInput(current, sentRequest));
        setKind((current) => (current === sentKind ? '' : current));
      })
      .catch(setFailure)
      .finally(end);
  }

  // 英語の reserved kind をそのまま出さず、予約名の一覧も画面に出さない: 内部の識別子を利用者に見せないため
  const reservedKindRefused = failure instanceof ApiError && failure.status === 409;

  return (
    <Card className="mb-4">
      <CardHeader
        title="継続する依頼を登録する"
        subtitle="時刻が来れば必ず届く（記憶に書くだけでは、思い出せるかどうかの賭けになる）"
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <label htmlFor={kindId} className="text-xs font-medium text-muted-foreground">
          依頼の名前（半角の英小文字・数字・. _ - が使える）
        </label>
        <Input
          id={kindId}
          value={kind}
          placeholder="例: morning-issues"
          onChange={(event) => setKind(event.target.value)}
        />
        <ScheduleSpecFields draft={specDraft} onChange={setSpecDraft} />
        <RequestEditor
          value={request}
          onChange={setRequest}
          activeTab={activeTab}
          onTabChange={setTab}
          label="依頼の本文"
          placeholder="依頼の本文（時刻が来たらそのままクローンへ渡る）"
          onSubmit={submit}
          submitDisabled={!ready || busy}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" loading={busy} disabled={!ready} onClick={submit}>
            仕込む
          </Button>
          {activeTab === 'edit' && <SubmitHint action="仕込む" />}
          {done !== undefined && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {done.replaced ? '置き換えた' : '仕込んだ'}: {done.kind}
            </span>
          )}
        </div>
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`予定「${kind.trim()}」を置き換えますか`}
          description="同じ名前の依頼が既に在る。前の依頼の本文と周期が置き換わり、元に戻せない（前回動いた時刻は保たれる）。"
          confirmLabel="置き換える"
          destructive
          onConfirm={() => send(true)}
        />
        <ErrorNote error={reservedKindRefused ? RESERVED_KIND_MESSAGE : failure} />
      </div>
    </Card>
  );
}

function EventForm() {
  const postEvent = usePostEvent();
  const sourceId = useId();
  const payloadId = useId();
  const [source, setSource] = useState('');
  const [payload, setPayload] = useState('');
  const { busy, begin, end } = useSending();
  const [sent, setSent] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  useReportDirty(EVENT_FORM_DIRTY_ID, source !== '' || payload !== '');

  function submit() {
    if (source.trim() === '' || !begin()) return;
    const sentPayload = payload;
    setFailure(undefined);
    setSent(undefined);

    // ここで弾かない: 弾くと「送れない形」を画面が勝手に作ることになるため
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      parsed = payload;
    }

    postEvent(source, parsed)
      .then((result) => {
        setSent(result.id);
        setPayload((current) => unsentInput(current, sentPayload));
      })
      .catch(setFailure)
      .finally(end);
  }

  return (
    <Card>
      <CardHeader
        title="外部イベントを送る"
        subtitle="MCP 経由の通知・CI の失敗・レビュー依頼を、人間の手で再現する"
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <label htmlFor={sourceId} className="text-xs font-medium text-muted-foreground">
          送り元の名前
        </label>
        <Input
          id={sourceId}
          value={source}
          placeholder="例: github, slack, ci"
          onChange={(event) => setSource(event.target.value)}
        />
        <label htmlFor={payloadId} className="text-xs font-medium text-muted-foreground">
          知らせの内容
        </label>
        <Textarea
          id={payloadId}
          rows={4}
          value={payload}
          className="font-mono text-xs"
          maxHeight="12rem"
          onSubmitShortcut={submit}
          submitDisabled={source.trim() === '' || busy}
          placeholder="JSON でも素のテキストでもよい"
          onChange={(event) => setPayload(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" loading={busy} disabled={source.trim() === ''} onClick={submit}>
            送る
          </Button>
          <SubmitHint action="送信" />
          {sent !== undefined && (
            <span className="text-[11px] text-muted-foreground">受け付けた</span>
          )}
        </div>
        <ErrorNote error={failure} />
      </div>
    </Card>
  );
}
