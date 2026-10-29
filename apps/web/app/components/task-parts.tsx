import { useId, useState } from 'react';

import { Badge, Button, ErrorNote, FieldHint, Input, Select } from '@alteroid/ui';
import { useCloseTask, useMoveTask, useReopenTask } from '@alteroid/swr';
import { redactBody } from '@alteroid/logic';
import type { Task, TaskPlacementInput } from '@alteroid/logic';

import { useReportDirty } from '~/lib/leave-guard';

// 状態の言い換えに生の値を併記する: 画面の語と CLI・クローンが使う語（queued など）を結べなくならないように。
const STATUS_LABEL: Record<Task['status'], string> = {
  queued: '順番待ち（queued）',
  waiting: '返事待ち（waiting）',
  needs_decision: '判断待ち（needs_decision）',
  done: '完了（done）',
  cancelled: '取りやめ（cancelled）',
};

const STATUS_TONE: Record<Task['status'], 'neutral' | 'ok' | 'warn' | 'accent'> = {
  queued: 'accent',
  waiting: 'neutral',
  needs_decision: 'warn',
  done: 'ok',
  cancelled: 'neutral',
};

export function isTaskClosed(task: Task): boolean {
  return task.status === 'done' || task.status === 'cancelled';
}

// Record<string, …> へ広げて引く: デーモンが先に新しい状態を返すと実行時は undefined になりうるが、型では `?? raw` が不要に見えるため。
// 倒れ先は空文字でなく生の値（取れないことを消さない）。
export function TaskStatusBadge({ status }: { status: Task['status'] }) {
  const labels: Record<string, string | undefined> = STATUS_LABEL;
  const tones: Record<string, 'neutral' | 'ok' | 'warn' | 'accent' | undefined> = STATUS_TONE;
  const label = labels[status];
  if (label === undefined) {
    console.warn(`task-parts.tsx: 未知の task.status が来た: ${String(status)}`);
    return <Badge tone="neutral">{String(status)}</Badge>;
  }
  return <Badge tone={tones[status] ?? 'neutral'}>{label}</Badge>;
}

const ORIGIN_LABEL: Record<string, string | undefined> = {
  human: '人間',
  manager: 'マネージャー',
  external: '外部',
  self: '自分',
};

export function TaskOriginBadge({ origin }: { origin: string }) {
  const label = ORIGIN_LABEL[origin];
  if (label === undefined) {
    console.warn(`task-parts.tsx: 未知の task.origin が来た: ${origin}`);
    return <Badge tone="neutral">{origin}</Badge>;
  }
  return <Badge tone={origin === 'human' ? 'accent' : 'neutral'}>{label}</Badge>;
}

export function taskLabel(task: Task): string {
  const flat = redactBody(task.title).replace(/\s+/g, ' ').trim();
  return Array.from(flat).length > 20 ? `${Array.from(flat).slice(0, 20).join('')}…` : flat;
}

export function excerptOf(body: string, max = 120): string {
  const flat = redactBody(body).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

type PlacementKind = TaskPlacementInput['kind'];

export const PLACEMENT_KIND_LABEL: Record<PlacementKind, string> = {
  front: '先頭',
  back: '末尾',
  before: 'ある行の前',
  after: 'ある行の後',
};

/** `anchorId` が要る置き場所は、基準の行を選ぶまで作らない。 */
export function placementOf(kind: PlacementKind, anchorId: string): TaskPlacementInput | undefined {
  if (kind === 'front' || kind === 'back') return { kind };
  return anchorId === '' ? undefined : { kind, anchorId };
}

export function AnchorSelect({
  id,
  label,
  value,
  onChange,
  openTasks,
  exceptId,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  openTasks: readonly Task[];
  exceptId?: string;
}) {
  return (
    <Select
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">基準の行を選ぶ</option>
      {openTasks
        .map((task, index) => ({ task, position: index + 1 }))
        .filter(({ task }) => task.id !== exceptId)
        .map(({ task, position }) => (
          <option key={task.id} value={task.id}>
            {position}. {taskLabel(task)}
          </option>
        ))}
    </Select>
  );
}

// 並びの持ち主は器（store）だけ: 画面は「どこへ」だけを送り、数値の優先度や位置は持たない。
// 先頭へ・末尾へはその場で動かし、ある行の前／後へは基準の行を選んでから動かす。
export function TaskMoveControls({ task, openTasks }: { task: Task; openTasks: readonly Task[] }) {
  const moveTask = useMoveTask();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [relative, setRelative] = useState<'before' | 'after'>('before');
  const [anchorId, setAnchorId] = useState('');
  const label = taskLabel(task);

  async function move(placement: TaskPlacementInput) {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await moveTask(task.id, placement);
      setAnchorId('');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  const relativePlacement = placementOf(relative, anchorId);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">並べ替え</span>
        <Button
          size="sm"
          disabled={busy}
          aria-label={`「${label}」を先頭へ`}
          onClick={() => void move({ kind: 'front' })}
        >
          先頭へ
        </Button>
        <Button
          size="sm"
          disabled={busy}
          aria-label={`「${label}」を末尾へ`}
          onClick={() => void move({ kind: 'back' })}
        >
          末尾へ
        </Button>
        <div className="w-24">
          <Select
            aria-label={`「${label}」を動かす向き`}
            value={relative}
            onChange={(event) => setRelative(event.target.value === 'after' ? 'after' : 'before')}
          >
            <option value="before">の前へ</option>
            <option value="after">の後ろへ</option>
          </Select>
        </div>
        <div className="min-w-40 flex-1">
          <AnchorSelect
            label={`「${label}」を動かす基準の行`}
            value={anchorId}
            onChange={setAnchorId}
            openTasks={openTasks}
            exceptId={task.id}
          />
        </div>
        <Button
          size="sm"
          loading={busy}
          disabled={relativePlacement === undefined}
          aria-label={`「${label}」を選んだ行の${relative === 'before' ? '前' : '後ろ'}へ動かす`}
          onClick={() => relativePlacement !== undefined && void move(relativePlacement)}
        >
          動かす
        </Button>
      </div>
      <ErrorNote error={failure} />
    </div>
  );
}

type CloseStatus = 'done' | 'cancelled';

// 理由なしでは閉じられない: 「閉じた」だけが残ると、人間が後から否定できない（HTTP も空の理由を 400 で断る）。
export function TaskCloseForm({ task, onClosed }: { task: Task; onClosed?: () => void }) {
  const closeTask = useCloseTask();
  const reasonId = useId();
  const hintId = useId();
  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<CloseStatus>('done');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const label = taskLabel(task);
  useReportDirty(`task-close-reason:${task.id}`, reason.trim() !== '');

  async function submit() {
    if (busy || reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await closeTask(task.id, status, reason.trim());
      onClosed?.();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  if (!opened) {
    return (
      <div className="mt-2 text-[11px]">
        <Button size="sm" aria-label={`「${label}」を閉じる`} onClick={() => setOpened(true)}>
          閉じる
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <label htmlFor={reasonId} className="block text-xs font-medium text-muted-foreground">
        閉じる理由
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <div className="w-40">
          <Select
            aria-label={`「${label}」の閉じ方`}
            value={status}
            onChange={(event) =>
              setStatus(event.target.value === 'cancelled' ? 'cancelled' : 'done')
            }
          >
            <option value="done">終わった（done）</option>
            <option value="cancelled">取りやめた（cancelled）</option>
          </Select>
        </div>
        <div className="min-w-40 flex-1">
          <Input
            id={reasonId}
            aria-describedby={hintId}
            value={reason}
            aria-label={`「${label}」を閉じる理由`}
            placeholder="例: 修正を入れて確認した"
            onChange={(event) => setReason(event.target.value)}
            onSubmitShortcut={() => void submit()}
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={reason.trim() === ''}
          aria-label={`「${label}」の閉じるを確定`}
          onClick={() => void submit()}
        >
          閉じる
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setOpened(false);
            setReason('');
            setFailure(undefined);
          }}
        >
          やめる
        </Button>
      </div>
      <FieldHint id={hintId} className="mt-1.5">
        何をもって閉じるかを書く。後から否定できるように残る。
      </FieldHint>
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

// 閉じた主体（器が自動で閉じた行も含む）で出し分けない: 否定できる相手を画面の側で狭めると、サーバの規則が変わった日に画面だけがずれる。
export function TaskReopenForm({ task }: { task: Task }) {
  const reopenTask = useReopenTask();
  const reasonId = useId();
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const label = taskLabel(task);
  useReportDirty(`task-reopen-reason:${task.id}`, reason.trim() !== '');

  async function submit() {
    if (busy || reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await reopenTask(task.id, reason.trim());
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  if (!opened) {
    return (
      <div className="mt-1.5 text-[11px]">
        <Button size="sm" aria-label={`「${label}」を開き直す`} onClick={() => setOpened(true)}>
          開き直す
        </Button>
      </div>
    );
  }
  return (
    <>
      <label htmlFor={reasonId} className="mt-2 block text-xs font-medium text-muted-foreground">
        開き直す理由
      </label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id={reasonId}
          value={reason}
          aria-label={`「${label}」を開き直す理由`}
          placeholder="例: まだ終わっていなかった"
          onChange={(event) => setReason(event.target.value)}
          onSubmitShortcut={() => void submit()}
        />
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          loading={busy}
          disabled={reason.trim() === ''}
          aria-label={`「${label}」の開き直しを確定`}
          onClick={() => void submit()}
        >
          開き直す
        </Button>
        <Button
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={() => {
            setOpened(false);
            setReason('');
            setFailure(undefined);
          }}
        >
          やめる
        </Button>
      </div>
      <ErrorNote error={failure} className="mt-2" />
    </>
  );
}
