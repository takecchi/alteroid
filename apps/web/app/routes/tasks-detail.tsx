import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';

import { LoadError } from '~/components/load-error';
import {
  TaskCloseForm,
  TaskMoveControls,
  TaskOriginBadge,
  TaskReopenForm,
  TaskStatusBadge,
  isTaskClosed,
} from '~/components/task-parts';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  Empty,
  ErrorNote,
  Input,
  Markdown,
  Page,
  Spinner,
  SubmitHint,
  Textarea,
} from '@alteroid/ui';
import { ApiError, TaskConflictError, useEditTask, useTask, useTasks } from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';
import type { Task } from '@alteroid/logic';

export default function TaskDetail() {
  const { pathname } = useLocation();
  const { id } = useParams();
  return (
    <LeaveGuardScope staysOn={(next) => next === pathname}>
      <Page title="task" description="待ち行列の1行を、全文で読む・直す・閉じる・並べ替える">
        <div className="flex flex-col gap-4">
          <Link to="/tasks" className="text-sm underline">
            待ち行列の一覧へ戻る
          </Link>
          {id === undefined ? <NotFound /> : <Body key={id} id={id} />}
        </div>
      </Page>
    </LeaveGuardScope>
  );
}

function NotFound() {
  return (
    <Card>
      <Empty inset="card">その task はありません</Empty>
    </Card>
  );
}

function Body({ id }: { id: string }) {
  const { data, error, isLoading, isValidating, mutate } = useTask(id);
  // 並びの位置と、並べ替えの基準に選べる行は一覧から取る: 位置は行の欄ではなく `entries` の順で表すため。
  const list = useTasks(false);
  const notFound = error instanceof ApiError && error.status === 404;

  if (notFound && data === undefined) return <NotFound />;
  return (
    <>
      <LoadError what="task" error={error} onRetry={() => mutate()} retrying={isValidating} />
      {isLoading && data === undefined ? (
        <Spinner />
      ) : data === undefined ? null : (
        <TaskCard
          task={data.entry}
          openTasks={list.data?.entries ?? []}
          listReady={list.data !== undefined}
        />
      )}
    </>
  );
}

// 人間が打った文字は化けさせない素のテキスト、external は書き手が不明なので化けて困る側（素）へ倒す。それ以外（クローン・マネージャーの文）は Markdown。
function TaskText({ task }: { task: Task }) {
  const body = redactBody(task.body);
  if (task.origin === 'human' || task.origin === 'external') {
    return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{body}</p>;
  }
  return <Markdown remoteImages={false}>{body}</Markdown>;
}

function TaskCard({
  task,
  openTasks,
  listReady,
}: {
  task: Task;
  openTasks: readonly Task[];
  listReady: boolean;
}) {
  const now = useMinuteNow();
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const closed = isTaskClosed(task);
  const position = openTasks.findIndex((entry) => entry.id === task.id);
  // 閉じるとページに居たまま行が閉じた側へ移るので、閉じた行には編集欄を出さない。
  const showEditor = editing && !closed;

  function closeEditor() {
    setEditing(false);
    setDirty(false);
    setConfirmingDiscard(false);
  }

  return (
    <Card>
      <CardHeader title={redactBody(task.title)} />
      <div className="px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <TaskStatusBadge status={task.status} />
          <TaskOriginBadge origin={task.origin} />
          {!closed && listReady && position >= 0 && (
            <span>
              優先順 {position + 1} / {openTasks.length}
            </span>
          )}
          {task.editedAt !== undefined && (
            <Badge tone="neutral">編集済み（{formatDateTime(task.editedAt)}）</Badge>
          )}
          <span>{formatDateTime(task.createdAt)}</span>
          <span>({formatRelativeAtMinute(task.createdAt, now)})</span>
        </div>

        {showEditor ? (
          <TaskEditor
            task={task}
            onDone={closeEditor}
            onRequestCancel={() => (dirty ? setConfirmingDiscard(true) : closeEditor())}
            onDirtyChange={setDirty}
          />
        ) : (
          <TaskText task={task} />
        )}

        <ConfirmDialog
          open={confirmingDiscard}
          onOpenChange={setConfirmingDiscard}
          title="保存していない変更があります"
          description="編集をやめると、書きかけの内容は失われます。"
          confirmLabel="破棄して閉じる"
          destructive
          onConfirm={closeEditor}
        />

        {closed ? (
          <>
            {task.closedReason !== undefined && (
              <p className="mt-3 text-xs break-words whitespace-pre-wrap text-muted-foreground">
                <span className="mr-2 text-[11px]">どう閉じたか</span>
                {redactBody(task.closedReason)}
                {task.closedAt !== undefined && `（${formatDateTime(task.closedAt)}）`}
              </p>
            )}
            <TaskReopenForm task={task} />
          </>
        ) : (
          <>
            {!editing && (
              <div className="mt-3">
                <Button size="sm" onClick={() => setEditing(true)}>
                  title / 本文を編集
                </Button>
              </div>
            )}
            <TaskMoveControls task={task} openTasks={openTasks} />
            <TaskCloseForm task={task} />
          </>
        )}
      </div>
    </Card>
  );
}

// 誰の行を書き換えられるかは画面に写さない: サーバ側の線が変わった日に画面だけが黙ってずれるため（403 の本文を ErrorNote に出す）。
// 版は開いた時点の `editedAt ?? createdAt` を握って送る: 一覧の取り直しで task が変わっても追従すると、裏の編集を見ずに上書きできる。
function TaskEditor({
  task,
  onDone,
  onRequestCancel,
  onDirtyChange,
}: {
  task: Task;
  onDone: () => void;
  onRequestCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const editTask = useEditTask();
  const [titleDraft, setTitleDraft] = useState<string | undefined>(undefined);
  const [bodyDraft, setBodyDraft] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [conflict, setConflict] = useState<Task | undefined>(undefined);
  const baseVersion = useRef(task.editedAt ?? task.createdAt);

  const titleChanged = titleDraft !== undefined && titleDraft.trim() !== task.title.trim();
  const bodyChanged = bodyDraft !== undefined && bodyDraft.trim() !== task.body.trim();
  const dirty = titleChanged || bodyChanged;
  const emptyDraft =
    (titleDraft !== undefined && titleDraft.trim() === '') ||
    (bodyDraft !== undefined && bodyDraft.trim() === '');

  useReportDirty(`task-edit:${task.id}`, dirty);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function save(ifMatch: string = baseVersion.current) {
    // ⌘/Ctrl+S は dirty で止まるボタンを通らず直接来るので、門はここに置く。
    if (busy || !dirty || emptyDraft) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await editTask(
        task.id,
        {
          ...(titleChanged && titleDraft !== undefined ? { title: titleDraft.trim() } : {}),
          ...(bodyChanged && bodyDraft !== undefined ? { body: bodyDraft.trim() } : {}),
        },
        ifMatch,
      );
      setConflict(undefined);
      onDone();
    } catch (caught) {
      if (caught instanceof TaskConflictError) setConflict(caught.current);
      else setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  function adoptConflictVersion(next: Task): string {
    const version = next.editedAt ?? next.createdAt;
    baseVersion.current = version;
    setConflict(undefined);
    return version;
  }

  return (
    <div className="rounded-md border border-border px-2 py-2">
      <label className="block text-xs font-medium text-muted-foreground">
        title
        <Input
          className="mt-1"
          value={titleDraft ?? task.title}
          onChange={(event) => setTitleDraft(event.target.value)}
          onSubmitShortcut={() => void save()}
          submitDisabled={!dirty || emptyDraft || busy}
        />
      </label>
      <label className="mt-2 block text-xs font-medium text-muted-foreground">
        本文
        <Textarea
          className="mt-1 min-h-32 font-mono text-xs leading-relaxed"
          maxHeight="60vh"
          value={bodyDraft ?? task.body}
          spellCheck={false}
          // Enter は改行のまま: 長文になりうる本文欄なので Enter 単体では送信しない。
          onChange={(event) => setBodyDraft(event.target.value)}
          onSubmitShortcut={() => void save()}
          submitDisabled={!dirty || emptyDraft || busy}
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!dirty || emptyDraft}
          onClick={() => void save()}
        >
          保存
        </Button>
        <SubmitHint action="保存" />
        <Button size="sm" onClick={onRequestCancel}>
          やめる
        </Button>
      </div>

      {conflict !== undefined && (
        <div
          role="alert"
          className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm"
        >
          <p className="mb-2 break-words">
            <strong>開いたあとに、裏でこの task が変わった。</strong>
            保存していない。下書きはそのまま残してある。
          </p>
          <CodeBlock label="いまの title" maxHeight="4rem">
            {redactBody(conflict.title)}
          </CodeBlock>
          <CodeBlock label="いまの本文" maxHeight="12rem" className="mt-2">
            {redactBody(conflict.body)}
          </CodeBlock>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void save(adoptConflictVersion(conflict))}
            >
              いまの内容の上で、下書きを保存し直す
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                adoptConflictVersion(conflict);
                setTitleDraft(undefined);
                setBodyDraft(undefined);
              }}
            >
              下書きを捨てて、いまの内容にする
            </Button>
          </div>
        </div>
      )}
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}
