import { SettingsTabs } from '~/components/group-tabs';
import { settingsDocumentTitle } from '~/lib/nav';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { useLatest } from '~/lib/use-latest';
import { useRef, useState } from 'react';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Empty,
  ErrorNote,
  Input,
  KeyValueList,
  Select,
  Spinner,
  SubmitHint,
  Textarea,
} from '@alteroid/ui';
import {
  ApiError,
  ProfileRejectedError,
  useProfile,
  useRemoveProfileEntry,
  useSetProfileEntry,
  useSetProfileLegacy,
} from '@alteroid/swr';
import { formatDateTime, hasRunnerPushFailure, LEGACY_PROFILE_NOTICE } from '@alteroid/logic';
import type {
  NormalizedProfile,
  ProfileEntryView,
  ProfileScope,
  ProfileUpdateResult,
} from '@alteroid/logic';

const SMALL_NOTE = 'text-[11px] text-muted-foreground';

function describeScope(scope: ProfileScope): { label: string; tone: 'neutral' | 'accent' } {
  switch (scope) {
    case 'all':
      return { label: '共通', tone: 'accent' };
    case 'app':
      return { label: 'クローンだけ', tone: 'neutral' };
    case 'runner':
      return { label: 'マネージャーだけ', tone: 'neutral' };
    default:
      // 投げずに「未知」とそのまま出す: web とデーモンは別々に配られ、サーバのほうが新しい窓が必ず在るため
      return { label: `未知の渡す先（${String(scope)}）`, tone: 'neutral' };
  }
}

const SCOPE_OPTIONS: { value: ProfileScope; label: string }[] = [
  { value: 'all', label: '共通（クローン・マネージャー両方。既定）' },
  { value: 'app', label: 'クローンだけ' },
  { value: 'runner', label: 'マネージャーだけ' },
];

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// 本文は既定で隠す: GET /profile は本文を丸ごと返し、鍵が入りうるため
// 保存の確認を省かない: 送った本文はデーモンの process.env を土台に評価され、サーバ側に確認の印が無く、押す前の確認だけが網になるため
export default function Profile() {
  return (
    <LeaveGuardScope>
      <ProfileBody />
    </LeaveGuardScope>
  );
}

function ProfileBody() {
  const { data, error, isLoading } = useProfile();
  const [editor, setEditor] = useState<EditorState | null>(null);
  // ProfileEditor を key で作り直す: 確認の枠と保存の失敗は ProfileEditor の中の state で、別の行へ切り替えても親の setEditor では畳めないため
  const [editorSerial, setEditorSerial] = useState(0);
  const editorSerialRef = useRef(0);
  const [result, setResult] = useState<{
    label: string;
    update: ProfileUpdateResult | null;
  } | null>(null);
  const [pending, setPending] = useState<
    { kind: 'switch'; entry: ProfileEntryView } | { kind: 'close' } | null
  >(null);

  const dirty = isDirty(editor);
  useReportDirty('editor', dirty);

  function openEntry(entry: ProfileEntryView) {
    setResult(null);
    editorSerialRef.current += 1;
    setEditorSerial(editorSerialRef.current);
    setEditor({
      name: entry.name,
      existing: true,
      script: entry.script,
      scope: entry.scope,
      original: entry,
    });
  }

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/profile')}
      title="実行環境プロファイル"
      description="クローン・マネージャー・作業者が仕事を始めるときに読み込まれる、環境を整えるスクリプトの行。行ごとに渡す先を選べる（シェルの ~/.zprofile に相当）"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="現在の登録内容"
            subtitle="いま登録されている行と、届いているかどうか"
            action={data === undefined ? undefined : <Badge>{data.entries.length}</Badge>}
          />
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-[11px] break-words text-muted-foreground">
              行は名前の辞書順につなげて効く（Linux の /etc/profile.d と同じ並べ方）。
            </p>
            <ErrorNote error={error} />
            {data?.legacy === true && (
              <p className="text-[11px] break-words text-warn">{LEGACY_PROFILE_NOTICE}</p>
            )}
            {isLoading ? (
              <Spinner />
            ) : (
              data !== undefined && (
                <ProfileList
                  profile={data}
                  onEdit={(entry) => {
                    if (dirty) setPending({ kind: 'switch', entry });
                    else openEntry(entry);
                  }}
                  onRemoved={(name, update) => {
                    setResult({
                      label:
                        update === null ? `行 ${name} は既に外されていた` : `行 ${name} を外した`,
                      update,
                    });
                    // 外した行を開いている編集欄は閉じる: 残すと保存で、外された行を確認だけで作り直すため
                    setEditor((current) =>
                      current?.existing === true && current.name === name ? null : current,
                    );
                  }}
                />
              )
            )}
          </div>
        </Card>
        {data !== undefined && (
          <ProfileEditor
            key={editorSerial}
            isCurrent={() => editorSerialRef.current === editorSerial}
            legacy={data.legacy}
            hasDefault={data.entries.some((entry) => entry.name === 'default')}
            editor={editor}
            setEditor={setEditor}
            onClose={() => {
              if (dirty) setPending({ kind: 'close' });
              else setEditor(null);
            }}
            onSaved={(label, update) => setResult({ label, update })}
          />
        )}
        {result !== null && (
          <Card>
            <CardHeader title="反映結果" />
            <div className="px-4 py-3">
              {result.update === null ? (
                <p className="text-xs break-words">{`${result.label}（一覧を取り直した）。`}</p>
              ) : (
                <UpdateReport label={result.label} update={result.update} />
              )}
            </div>
          </Card>
        )}
      </div>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="書きかけの編集があります"
        description={
          pending?.kind === 'switch'
            ? `別の行（${pending.entry.name}）に切り替えると、いま書いている内容は失われます。`
            : 'このまま閉じると、いま書いている内容は失われます。'
        }
        confirmLabel={pending?.kind === 'switch' ? '破棄して切り替える' : '破棄して閉じる'}
        destructive
        onConfirm={() => {
          if (pending?.kind === 'switch') openEntry(pending.entry);
          else setEditor(null);
          setPending(null);
        }}
      />
    </Page>
  );
}

function isDirty(editor: EditorState | null): boolean {
  if (editor === null) return false;
  if (editor.original !== undefined) {
    return editor.script !== editor.original.script || editor.scope !== editor.original.scope;
  }
  return editor.script !== '' || (!editor.existing && editor.name !== '') || editor.scope !== 'all';
}

function ProfileList({
  profile,
  onEdit,
  onRemoved,
}: {
  profile: NormalizedProfile;
  onEdit: (entry: ProfileEntryView) => void;
  onRemoved: (name: string, update: ProfileUpdateResult | null) => void;
}) {
  if (profile.entries.length === 0) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <Badge>置かれていない</Badge>
        <Empty>プロファイルの行がまだ1つも無い。</Empty>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      {!profile.legacy && (
        <KeyValueList
          labelWidth="8rem"
          items={[
            {
              label: 'クローン用の合成',
              value: profile.clone.sha256 ?? '（掛かる行なし）',
              mono: true,
            },
            {
              label: 'マネージャー用の合成',
              value: profile.runner.sha256 ?? '（掛かる行なし）',
              mono: true,
            },
          ]}
        />
      )}
      <ul className="-mx-4">
        {profile.entries.map((entry) => (
          <EntryRow
            key={entry.name}
            entry={entry}
            legacy={profile.legacy}
            onEdit={() => onEdit(entry)}
            onRemoved={onRemoved}
          />
        ))}
      </ul>
      <p className="text-[11px] break-words text-muted-foreground">
        各実行環境へ届いているかは、「設定」の実行環境の欄に出る。
      </p>
    </div>
  );
}

function EntryRow({
  entry,
  legacy,
  onEdit,
  onRemoved,
}: {
  entry: ProfileEntryView;
  legacy: boolean;
  onEdit: () => void;
  onRemoved: (name: string, update: ProfileUpdateResult | null) => void;
}) {
  const removeEntry = useRemoveProfileEntry();
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const scope = describeScope(entry.scope);

  async function remove() {
    setBusy(true);
    setFailure(undefined);
    try {
      const update = await removeEntry(entry.name);
      onRemoved(entry.name, update);
    } catch (caught) {
      // 404 は失敗の注記にせず親へ渡す: 取り直しで行が消え、注記を出す先も無くなるため
      if (caught instanceof ApiError && caught.status === 404) {
        onRemoved(entry.name, null);
      } else {
        setFailure(caught);
        setConfirming(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all">{entry.name}</span>
        <Badge tone={scope.tone}>{scope.label}</Badge>
        <Badge tone="accent">{`${String(entry.bytes)} バイト`}</Badge>
      </div>
      <KeyValueList
        className="mt-2"
        labelWidth="6rem"
        items={[
          { label: '識別用の値', value: entry.sha256, mono: true },
          { label: '更新', value: formatDateTime(entry.updatedAt) },
        ]}
      />
      <p className="mt-2 text-[11px] break-words text-warn">
        ⚠ 本文には鍵が丸ごと入っていることがある。表示するのは、周りに見られない場所で。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-label={`${entry.name} の本文を${shown ? '隠す' : '表示する'}`}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? '本文を隠す' : '本文を表示する'}
        </Button>
        <Button size="sm" aria-label={`${entry.name} を編集する`} onClick={onEdit}>
          編集する
        </Button>
        {!confirming && !legacy && (
          <Button
            variant="danger"
            size="sm"
            aria-label={`${entry.name} の行を外す`}
            onClick={() => setConfirming(true)}
          >
            この行を外す
          </Button>
        )}
      </div>
      {shown && (
        <pre
          aria-label={`プロファイルの行 ${entry.name} の本文`}
          className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap"
        >
          {entry.script}
        </pre>
      )}
      {confirming && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
          <p className="text-[11px] break-words text-warn">
            行 {entry.name} を外す。他の行は変えない。これから起こす仕事から、
            この行に書いてあった環境は無くなる。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              aria-label={`${entry.name} の行を本当に外す`}
              onClick={() => void remove()}
            >
              本当に外す
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              外すのをやめる
            </Button>
          </div>
        </div>
      )}
      <ErrorNote error={failure} className="mt-2" />
    </li>
  );
}

interface EditorState {
  name: string;
  existing: boolean;
  script: string;
  scope: ProfileScope;
  original?: Pick<ProfileEntryView, 'script' | 'scope'>;
}

function ProfileEditor({
  legacy,
  hasDefault,
  editor,
  setEditor,
  onClose,
  onSaved,
  isCurrent,
}: {
  legacy: boolean;
  hasDefault: boolean;
  editor: EditorState | null;
  setEditor: (next: EditorState | null) => void;
  onClose: () => void;
  onSaved: (label: string, update: ProfileUpdateResult) => void;
  // 保存の完了が戻る前に別の行へ切り替えられていたら閉じない: 新しい行の書きかけが消えるため
  isCurrent: () => boolean;
}) {
  const setEntry = useSetProfileEntry();
  const setLegacy = useSetProfileLegacy();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const latestEditor = useLatest(editor);

  const unchanged =
    editor?.original !== undefined &&
    editor.script === editor.original.script &&
    editor.scope === editor.original.scope;
  const nameValid = editor !== null && NAME_PATTERN.test(editor.name);
  const scriptEmpty = editor !== null && editor.script.trim().length === 0;

  async function submit(state: EditorState) {
    setBusy(true);
    setFailure(undefined);
    try {
      const update = legacy
        ? await setLegacy(state.script)
        : await setEntry(state.name, state.script, state.scope);
      // 結果は閉じるかどうかと関係なく出す: 書き込みは起きており、行の名前つきの文言なので別の行を開いていても取り違えないため
      onSaved(`行 ${state.name} を更新した`, update);
      if (isCurrent()) {
        setConfirming(false);
        const now = latestEditor.current;
        if (
          now !== null &&
          (now.name !== state.name || now.script !== state.script || now.scope !== state.scope)
        ) {
          if (now.name === state.name) {
            setEditor({
              ...now,
              existing: true,
              original: { script: state.script, scope: state.scope },
            });
          }
        } else {
          setEditor(null);
        }
      }
    } catch (caught) {
      setFailure(caught);
      // 確認は畳む: 確認済みのまま残すと「直したつもりで1回で送る」形になるため
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  function open(next: EditorState) {
    setEditor(next);
    setConfirming(false);
    setFailure(undefined);
  }

  return (
    <Card>
      <CardHeader title="行を登録する" subtitle="1行を丸ごと置き換える" />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed break-words text-muted-foreground">
          保存すると、本文は置く前にサーバ上でその場で実行して確かめられる（記憶を扱うサーバでの任意のコマンド実行と同じ強さ。渡す先がマネージャーだけの行は、サーバでは確かめず、マネージャーが動く実行環境で確かめる）。実行できなければ保存も反映もせず、理由を返す（前のものが残る）。
          秘密は「環境変数」の画面へ置くこと——ここに書いた名前は、そちらの同じ名前を上書きする。
        </p>

        {editor === null ? (
          <div>
            {legacy && hasDefault ? (
              <span className={SMALL_NOTE}>
                接続先のサーバが古いと、一覧の「編集する」から本文だけ直せる。
              </span>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  open({
                    name: legacy ? 'default' : '',
                    existing: legacy,
                    script: '',
                    scope: 'all',
                  })
                }
              >
                行を追加する
              </Button>
            )}
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                名前（英数字で始まり、英数字と . _ - が使える。64字まで）
              </span>
              <Input
                aria-label="プロファイルの行の名前"
                value={editor.name}
                disabled={editor.existing}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => {
                  setEditor({ ...editor, name: event.target.value });
                  setConfirming(false);
                }}
                placeholder="例: rust"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">渡す先</span>
              <Select
                aria-label="プロファイルの渡す先"
                value={editor.scope}
                disabled={legacy}
                onChange={(event) => {
                  setEditor({ ...editor, scope: event.target.value as ProfileScope });
                  setConfirming(false);
                }}
              >
                {SCOPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">本文（シェルスクリプト）</span>
              <Textarea
                aria-label="プロファイルの新しい本文"
                className="min-h-64 font-mono text-xs"
                maxHeight="60vh"
                onSubmitShortcut={() => setConfirming(true)}
                submitDisabled={unchanged || !nameValid || scriptEmpty || confirming || busy}
                spellCheck={false}
                autoComplete="off"
                value={editor.script}
                onChange={(event) => {
                  setEditor({ ...editor, script: event.target.value });
                  setConfirming(false);
                }}
                placeholder={'export PATH="$HOME/.local/bin:$PATH"'}
              />
            </label>
            {confirming ? (
              <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
                <p className="text-[11px] break-words text-warn">
                  {`行 ${editor.name} を置く。本文をサーバ上で実行して確かめ、通れば${
                    editor.scope === 'all'
                      ? 'クローン・マネージャー・作業者のすべて'
                      : editor.scope === 'app'
                        ? 'クローンだけ'
                        : 'マネージャー・作業者だけ'
                  }へ渡す。渡す先から外れた側からは外れる。これから起こす仕事には即座に効く。`}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy}
                    onClick={() => void submit(editor)}
                  >
                    本当に保存する
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    保存をやめる
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={unchanged || !nameValid || scriptEmpty}
                  onClick={() => setConfirming(true)}
                >
                  保存する
                </Button>
                <SubmitHint action="保存" />
                <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                  編集を閉じる
                </Button>
                {unchanged && <span className={SMALL_NOTE}>変更はまだ無い。</span>}
                {!editor.existing && editor.name.length > 0 && !nameValid && (
                  <span className="text-[11px] text-destructive">名前の形が不正。</span>
                )}
                {scriptEmpty && (
                  <span className={SMALL_NOTE}>
                    本文が空の行は置けない（外すのは一覧の「この行を外す」）。
                  </span>
                )}
              </div>
            )}
          </>
        )}

        <ErrorNote error={failure} />
        {failure instanceof ProfileRejectedError && failure.detail.length > 0 && (
          <pre
            aria-label="評価の失敗の詳細"
            className="max-h-64 overflow-auto rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-destructive"
          >
            {failure.detail}
          </pre>
        )}
        {failure instanceof ProfileRejectedError && (
          <p className={SMALL_NOTE}>前のプロファイルがそのまま残っている。</p>
        )}
      </div>
    </Card>
  );
}

// 失敗を小さく出さない: 見落とすと以後ずっと古い環境で走り続けるため
function UpdateReport({ label, update }: { label: string; update: ProfileUpdateResult }) {
  const composed = (update as Partial<ProfileUpdateResult>).composed;
  const runnerFailed = hasRunnerPushFailure(update);
  const cloneFailed = !update.clone.ok;
  const partial = runnerFailed || cloneFailed;
  const failedTargets =
    cloneFailed && runnerFailed
      ? 'クローンと一部の実行環境'
      : cloneFailed
        ? 'クローン'
        : '一部の実行環境';
  const rows = [
    { label: 'クローン', outcome: update.clone },
    ...update.runners.map((runner) => ({ label: runner.runnerId, outcome: runner })),
  ];

  return (
    <div className="flex flex-col gap-2 text-xs">
      {partial ? (
        <p role="alert" className="font-medium text-warn">
          {`プロファイルの${label}が、${failedTargets}へ反映できていない（保存はできている）。`}
        </p>
      ) : (
        <p className="font-medium text-ok">{`プロファイルの${label}。`}</p>
      )}
      <p className="font-mono text-[11px] break-all text-muted-foreground">
        {composed === undefined
          ? null
          : `合成後の識別値: クローン用 ${composed.clone.sha256 ?? '掛かる行なし'} / マネージャー用 ${composed.runner.sha256 ?? '掛かる行なし'}`}
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map(({ label: rowLabel, outcome }) => (
          <li key={rowLabel} className="break-words">
            <span className="font-mono">{rowLabel}</span>:{' '}
            {outcome.ok ? (
              <span className="text-ok">
                反映した
                {(outcome.names ?? []).length > 0 && `（${(outcome.names ?? []).join(' ')}）`}
              </span>
            ) : (
              <span className="text-destructive">
                反映できなかった — {outcome.error ?? '理由不明'}
              </span>
            )}
            {(outcome.output ?? '').trim().length > 0 && (
              <pre className="mt-1 overflow-auto font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
                {outcome.output}
              </pre>
            )}
          </li>
        ))}
      </ul>
      <p className={SMALL_NOTE}>
        これから起こす仕事には即座に効く。動いている最中の仕事には、gh と git
        だけが次の呼び出しから反映される。それ以外は次の仕事から。
      </p>
    </div>
  );
}
