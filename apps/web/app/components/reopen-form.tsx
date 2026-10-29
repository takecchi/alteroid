import { useId, useState } from 'react';

import { Button, ErrorNote, Input } from '@alteroid/ui';

import { useReportDirty } from '~/lib/leave-guard';

// 閉じた行を否定する口。commitments と tasks の閉じた行で共有する。
// 閉じた主体（器が自動で閉じた行も含む）で出し分けない: 否定できる相手を画面の側で狭めると、サーバの規則が変わった日に画面だけがずれる。
export function ReopenForm({
  dirtyId,
  label,
  onReopen,
}: {
  dirtyId: string;
  label: string;
  onReopen: (reason: string) => Promise<unknown>;
}) {
  const reasonId = useId();
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  useReportDirty(dirtyId, reason.trim() !== '');

  async function submit() {
    if (busy || reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onReopen(reason.trim());
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
          aria-label={`「${label}」の開き直しを確定`}
          // 理由なしでは開き直せない: 閉じた記録が行から消えるので、日誌に残る理由が唯一の手掛かりになる。
          disabled={reason.trim() === ''}
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
