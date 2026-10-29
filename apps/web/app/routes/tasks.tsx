import { useId, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';

import { WorkTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import {
  AnchorSelect,
  PLACEMENT_KIND_LABEL,
  TaskCloseForm,
  TaskMoveControls,
  TaskOriginBadge,
  TaskReopenForm,
  TaskStatusBadge,
  excerptOf,
  isTaskClosed,
  placementOf,
} from '~/components/task-parts';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { unreadableIdsNote } from '~/lib/unreadable-ids-note';
import { unsentInput } from '~/lib/unsent-input';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  FieldHint,
  Input,
  Page,
  Select,
  Spinner,
  SubmitHint,
  Textarea,
  WarnNote,
} from '@alteroid/ui';
import { useTasks, usePushTask, type TaskPlacement } from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';
import type { Task, UnreadableTask } from '@alteroid/logic';

const CLOSED_PARAM = 'closed';

/** 優先度や締切の数値の札を足さない: 並びが優先順のすべてで、数値を持つと「やることの一覧」の判断が器へ移るため。 */
export default function Tasks() {
  const { pathname } = useLocation();
  return (
    <LeaveGuardScope staysOn={(next) => next === pathname}>
      <TasksPage />
    </LeaveGuardScope>
  );
}

function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const showClosed = searchParams.get(CLOSED_PARAM) === '1';
  const toggleClosed = () =>
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        if (showClosed) params.delete(CLOSED_PARAM);
        else params.set(CLOSED_PARAM, '1');
        return params;
      },
      { replace: true },
    );
  const { data, error, isLoading, isValidating, mutate } = useTasks(showClosed);

  // ここで並べ直さない: `entries` の順が優先順で、並べ直すと CLI・クローンの見え方と食い違う。
  const all = data?.entries ?? [];
  const open = all.filter((task) => !isTaskClosed(task));
  const closed = all.filter(isTaskClosed);
  const unreadable = data?.unreadable ?? [];
  // 取れなかったのを0件と描かない: 読めていないのに「待っている仕事はない」と読めてしまうため。
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Page
      tabs={<WorkTabs />}
      title="待ち行列"
      description="引き受けた仕事を、順序と状態を持つ行として並べる。先頭が先にやるもの。数値の優先度や締切は持たない"
      action={
        <Button size="sm" onClick={toggleClosed}>
          {showClosed ? '開いているものだけ' : '閉じたものも見る'}
        </Button>
      }
    >
      <LoadError
        what="待ち行列の一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="mb-4"
      />

      <PushForm openTasks={open} />

      {isLoading && data === undefined ? (
        <Spinner />
      ) : listUnavailable ? null : (
        <>
          <UnreadableNote unreadable={unreadable} />

          <Card className="mb-4">
            <CardHeader title="開いている" subtitle="先頭が先にやるもの" />
            {open.length === 0 ? (
              <Empty>
                {unreadable.length > 0
                  ? '読めた範囲では、開いている task はない。'
                  : '開いている task はない。'}
              </Empty>
            ) : (
              <ol aria-label="開いている task（優先順）">
                {open.map((task, index) => (
                  <OpenRow key={task.id} task={task} position={index + 1} openTasks={open} />
                ))}
              </ol>
            )}
          </Card>

          {showClosed && (
            <Card>
              <CardHeader title="閉じた" subtitle="新しい順。何をもって閉じたかを残す" />
              {closed.length === 0 && isLoading ? (
                <Spinner />
              ) : closed.length === 0 ? (
                <Empty>
                  {unreadable.length > 0
                    ? // 読めない行は閉じた行かもしれないので、閉じた側も言い切れない。
                      '読めた範囲では、閉じた task はない。'
                    : '閉じた task はまだない。'}
                </Empty>
              ) : (
                <ul aria-label="閉じた task">
                  {closed.map((task) => (
                    <ClosedRow key={task.id} task={task} />
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

// 「無い」でも「閉じた」でもない第3の状態を `Empty` の顔にしない: `Empty` は「無い」を表す部品なので、読めない行を混ぜると「特に何も無い」に見えるため。
// 0件なら描かない: 常に出る断りは、出ていることが情報にならない。
function UnreadableNote({ unreadable }: { unreadable: readonly UnreadableTask[] }) {
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  return (
    <WarnNote className="mb-4" block>
      読めない行が {unreadable.length} 件ある
      {unreadableIdsNote('id', idsAll)}。<strong>閉じたのではない。</strong>
    </WarnNote>
  );
}

function OpenRow({
  task,
  position,
  openTasks,
}: {
  task: Task;
  position: number;
  openTasks: readonly Task[];
}) {
  const now = useMinuteNow();
  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{position}.</span>
        <TaskStatusBadge status={task.status} />
        <TaskOriginBadge origin={task.origin} />
        {task.editedAt !== undefined && (
          <Badge tone="neutral">編集済み（{formatDateTime(task.editedAt)}）</Badge>
        )}
        <span>{formatDateTime(task.createdAt)}</span>
        <span>({formatRelativeAtMinute(task.createdAt, now)})</span>
      </div>
      <TaskTitle task={task} />
      <p className="mt-1 text-xs leading-relaxed break-words text-muted-foreground">
        {excerptOf(task.body)}
      </p>
      <TaskMoveControls task={task} openTasks={openTasks} />
      <TaskCloseForm task={task} />
    </li>
  );
}

function TaskTitle({ task }: { task: Task }) {
  return (
    <Link
      to={`/tasks/${encodeURIComponent(task.id)}`}
      className="text-sm font-medium hover:underline"
    >
      {redactBody(task.title)}
    </Link>
  );
}

function ClosedRow({ task }: { task: Task }) {
  const reason = task.closedReason === undefined ? undefined : redactBody(task.closedReason);
  return (
    <li className="border-b border-border px-4 py-3 text-muted-foreground last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <TaskStatusBadge status={task.status} />
        <TaskOriginBadge origin={task.origin} />
        <span>
          {formatDateTime(task.createdAt)} → {formatDateTime(task.closedAt ?? '')}
        </span>
      </div>
      <TaskTitle task={task} />
      {reason !== undefined && (
        <p className="mt-1 text-xs break-words whitespace-pre-wrap">
          <span className="mr-2 text-[11px]">どう閉じたか</span>
          {reason}
        </p>
      )}
      <TaskReopenForm task={task} />
    </li>
  );
}

const PUSH_FORM_DIRTY_ID = 'task-push-form';
type PlacementChoice = 'default' | TaskPlacement['kind'];

// 積むだけでクローンのターンは起こさない（CLI の `alteroid tasks add` と同じ口）。置き場所を省くと既定（開いている human 起点の最後の直後）。
function PushForm({ openTasks }: { openTasks: readonly Task[] }) {
  const pushTask = usePushTask();
  const titleId = useId();
  const bodyId = useId();
  const placementId = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [choice, setChoice] = useState<PlacementChoice>('default');
  const [anchorId, setAnchorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useReportDirty(PUSH_FORM_DIRTY_ID, title !== '' || body !== '');

  const placement = choice === 'default' ? undefined : placementOf(choice, anchorId);
  // 基準の行が要る置き場所は、選ぶまで積めない: 黙って既定の置き場所へ倒すと、指した場所と違う所に積むことになる。
  const placementIncomplete = choice !== 'default' && placement === undefined;
  const canSubmit = title.trim() !== '' && body.trim() !== '' && !placementIncomplete;

  async function submit() {
    if (busy || !canSubmit) return;
    const sentTitle = title;
    const sentBody = body;
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      await pushTask({
        title: sentTitle.trim(),
        body: sentBody.trim(),
        ...(placement === undefined ? {} : { placement }),
      });
      setTitle((current) => unsentInput(current, sentTitle));
      setBody((current) => unsentInput(current, sentBody));
      setNotice('積んだ。');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="task を積む" subtitle="引き受けたことを、待ち行列に載せる" />
      <div className="flex flex-col gap-2 px-4 py-3">
        <label htmlFor={titleId} className="text-xs font-medium text-muted-foreground">
          タイトル（一行・200字まで）
        </label>
        <Input
          id={titleId}
          value={title}
          placeholder="例: 週次レビューを出す"
          onChange={(event) => setTitle(event.target.value)}
          onSubmitShortcut={() => void submit()}
          submitDisabled={!canSubmit || busy}
        />
        <label htmlFor={bodyId} className="text-xs font-medium text-muted-foreground">
          本文
        </label>
        <Textarea
          id={bodyId}
          rows={3}
          maxHeight="60vh"
          value={body}
          placeholder="何を引き受けたかを全文で書く"
          onChange={(event) => setBody(event.target.value)}
          onSubmitShortcut={() => void submit()}
          submitDisabled={!canSubmit || busy}
        />
        <label htmlFor={placementId} className="text-xs font-medium text-muted-foreground">
          置き場所
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56">
            <Select
              id={placementId}
              value={choice}
              onChange={(event) => setChoice(parseChoice(event.target.value))}
            >
              <option value="default">既定（人間が積んだ行の最後の直後）</option>
              <option value="front">{PLACEMENT_KIND_LABEL.front}</option>
              <option value="back">{PLACEMENT_KIND_LABEL.back}</option>
              <option value="before">{PLACEMENT_KIND_LABEL.before}</option>
              <option value="after">{PLACEMENT_KIND_LABEL.after}</option>
            </Select>
          </div>
          {(choice === 'before' || choice === 'after') && (
            <div className="min-w-40 flex-1">
              <AnchorSelect
                label="置き場所の基準の行"
                value={anchorId}
                onChange={setAnchorId}
                openTasks={openTasks}
              />
            </div>
          )}
        </div>
        <FieldHint id={`${placementId}-hint`}>
          クローンの手は止めない。いま考えさせたいときはチャットで頼む。
        </FieldHint>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            積む
          </Button>
          <SubmitHint action="積む" />
        </div>
        <ErrorNote error={failure} />
        {notice !== undefined && (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </Card>
  );
}

function parseChoice(value: string): PlacementChoice {
  return value === 'front' || value === 'back' || value === 'before' || value === 'after'
    ? value
    : 'default';
}
