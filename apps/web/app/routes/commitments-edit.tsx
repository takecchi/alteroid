import { EditConflictBand } from '~/components/edit-conflict-band';
import { useReportDirty } from '~/lib/leave-guard';
import { useLatest } from '~/lib/use-latest';
import { useEffect, useState } from 'react';
import { Tabs } from 'radix-ui';

import {
  Button,
  CodeBlock,
  ErrorNote,
  SubmitHint,
  Textarea,
  cn,
  useKeyboardHintsVisible,
} from '@alteroid/ui';
import { CommitmentConflictError, useEditCommitment } from '@alteroid/swr';
import { redactBody } from '@alteroid/logic';
import type { Commitment } from '@alteroid/logic';

import { CommitmentBody } from './commitments-body';
import { snippet, type RowNotePatch } from './commitments-row-note';

const EDITOR_TAB_TRIGGER_CLASS =
  'border-b-2 border-transparent px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground';
const EDITOR_TAB_TRIGGER_ACTIVE_CLASS = 'border-primary text-foreground';

// 誰の行を書き換えられるかは画面に写さない: サーバ側の線が変わった日に画面だけが黙ってずれるため（403 の本文を ErrorNote に出す）。
// draft は Tabs.Root の外に置く: 非活性の Tabs.Content は unmount されるので、内側だとタブを切り替えた瞬間に入力が消える。
export function CommitmentBodyEditor({
  commitment,
  onCancel,
  onRequestCancel,
  onTrack,
  onSettling,
}: {
  commitment: Commitment;
  onTrack: (patch: RowNotePatch) => void;
  onSettling: (on: boolean) => void;
  /** 確認なしで閉じる。保存に成功したときだけ使う（保存直後は下書きが元と違って見えるため）。 */
  onCancel: () => void;
  onRequestCancel: () => void;
}) {
  const editCommitment = useEditCommitment();
  const keyboardHints = useKeyboardHintsVisible();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<string>('preview');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  // 一覧の取り直しで commitment が変わっても版は追従しない: 追従すると、裏の編集を見ずに上書きできる。
  const [baseVersion, setBaseVersion] = useState(() => commitment.editedAt ?? commitment.at);
  // 保存の応答は新しい版を返さないので、取り直した一覧の本文が送った本文と一致したときだけ自分の書き込みの版として取り込む。版だけで追うと、裏で入った編集の版まで拾って上書きする。
  const [ownSent, setOwnSent] = useState<string | undefined>(undefined);
  if (ownSent !== undefined && commitment.body.trim() === ownSent) {
    setBaseVersion(commitment.editedAt ?? commitment.at);
    setOwnSent(undefined);
  }
  const [conflict, setConflict] = useState<Commitment | undefined>(undefined);

  const value = draft ?? commitment.body;
  // trim した値どうしで比べる: 送るのは trim した本文で、末尾の空白だけの下書きを変更ありにすると、保存が押せるのに同じ本文を送ることになる。
  const dirty = draft !== undefined && draft.trim() !== commitment.body.trim();
  const latestDraft = useLatest(draft);

  useReportDirty(commitment.id, dirty);
  // unmount では消さない: 行が一覧から外れたときに、ページが断りとして残すため。
  useEffect(() => {
    onTrack({ draft: dirty ? draft : undefined });
  }, [dirty, draft, onTrack]);

  function save(ifMatch: string = baseVersion) {
    // ⌘/Ctrl+S は dirty で止まるボタンを通らずここへ直接来るので、門はここに置く。
    if (busy) return;
    if (!dirty) return;
    if (draft === undefined || draft.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    onTrack({ editFailure: undefined });
    onSettling(true);
    const sent = draft.trim();
    editCommitment(commitment.id, sent, ifMatch).then(
      () => {
        setConflict(undefined);
        // 応答を待つ間に打ち足した分があるときは畳まず、下書きを残す。
        if (latestDraft.current?.trim() === sent) onCancel();
        else setOwnSent(sent);
        setBusy(false);
        onSettling(false);
      },
      (caught: unknown) => {
        if (caught instanceof CommitmentConflictError && caught.current !== null) {
          setConflict(caught.current);
          setBusy(false);
          onSettling(false);
          return;
        }
        // 失敗の記録と「待ちが終わった」は同じ処理の中で行う: 別の描画だと、行が消えた断りが失敗の無い形で一瞬出る。
        setFailure(caught);
        onTrack({ editFailure: caught });
        setBusy(false);
        onSettling(false);
      },
    );
  }

  function adoptConflictVersion(next: Commitment): string {
    const version = next.editedAt ?? next.at;
    setBaseVersion(version);
    setOwnSent(undefined);
    setConflict(undefined);
    return version;
  }

  return (
    <div className="mt-2 rounded-md border border-border">
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="flex gap-1 border-b border-border px-2">
          <Tabs.Trigger
            value="preview"
            className={cn(
              EDITOR_TAB_TRIGGER_CLASS,
              tab === 'preview' && EDITOR_TAB_TRIGGER_ACTIVE_CLASS,
            )}
          >
            プレビュー
          </Tabs.Trigger>
          <Tabs.Trigger
            value="edit"
            className={cn(
              EDITOR_TAB_TRIGGER_CLASS,
              tab === 'edit' && EDITOR_TAB_TRIGGER_ACTIVE_CLASS,
            )}
          >
            編集
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="preview" className="px-2 py-2">
          <CommitmentBody commitment={{ ...commitment, body: value }} />
        </Tabs.Content>

        <Tabs.Content value="edit" className="px-2 py-2">
          <Textarea
            aria-label={`「${snippet(commitment.body)}」の本文`}
            className="min-h-32 font-mono text-xs leading-relaxed"
            maxHeight="60vh"
            onSubmitShortcut={() => save()}
            submitDisabled={!dirty || value.trim() === '' || busy}
            value={value}
            spellCheck={false}
            // Enter は改行のまま: 長文になりうる本文欄なので Enter 単体では送信せず、IME の門（isComposing / keyCode 229）も付けていない。
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                save();
              }
            }}
          />
        </Tabs.Content>
      </Tabs.Root>

      <div className="flex items-center gap-2 px-2 py-2">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!dirty || value.trim() === ''}
          onClick={() => save()}
        >
          保存
        </Button>
        {tab === 'edit' && keyboardHints && (
          <span className="text-[11px] text-muted-foreground select-none">⌘/Ctrl + S で保存</span>
        )}
        {tab === 'edit' && <SubmitHint action="保存" />}
        <Button size="sm" onClick={onRequestCancel}>
          やめる
        </Button>
      </div>

      {conflict !== undefined && (
        <EditConflictBand
          className="mx-2 mb-2"
          heading="開いたあとに、裏でこの本文が変わった。"
          retryLabel="いまの本文の上で、下書きを保存し直す"
          discardLabel="下書きを捨てて、いまの本文にする"
          busy={busy}
          onRetry={() => save(adoptConflictVersion(conflict))}
          onDiscard={() => {
            adoptConflictVersion(conflict);
            setDraft(undefined);
          }}
        >
          <CodeBlock label="いまの本文" maxHeight="12rem">
            {redactBody(conflict.body)}
          </CodeBlock>
        </EditConflictBand>
      )}
      <ErrorNote error={failure} className="mx-2 mb-2" />
    </div>
  );
}
