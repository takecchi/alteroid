import { SettingsTabs } from '~/components/group-tabs';
import { useState } from 'react';

import { NotOwnerHint } from '~/components/not-owner-hint';
import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  KeyValueList,
  Select,
  Spinner,
  Textarea,
} from '@alteroid/ui';
import {
  ProfileRejectedError,
  useProfile,
  useRemoveProfileEntry,
  useSetProfileEntry,
  useSetProfileLegacy,
} from '@alteroid/swr';
import { formatDateTime, LEGACY_PROFILE_NOTICE } from '@alteroid/logic';
import type {
  NormalizedProfile,
  ProfileEntryView,
  ProfileScope,
  ProfileUpdateResult,
} from '@alteroid/logic';

/**
 * 撒く先。**環境変数画面（`env-vars.tsx`）の `describeScope` / `SCOPE_OPTIONS` と同じ
 * 3値・同じ言い方**（2026-10-03。オーナーの指示「env-profileを環境変数と同じように
 * 指定できるようにして欲しい」「デフォルトは両方です」）。
 */
function describeScope(scope: ProfileScope): { label: string; tone: 'neutral' | 'accent' } {
  switch (scope) {
    case 'all':
      return { label: '共通', tone: 'accent' };
    case 'app':
      return { label: 'clone', tone: 'neutral' };
    case 'runner':
      return { label: 'manager', tone: 'neutral' };
    default:
      // **送られてくる値である**（`apps/web` は Vercel、デーモンは Railway で別に配られ
      // るので、サーバのほうが新しい窓が必ず在る）。投げずに「未知」とそのまま出す
      // （`env-vars.tsx` と同じ判断）。
      return { label: `未知の撒く先（${String(scope)}）`, tone: 'neutral' };
  }
}

const SCOPE_OPTIONS: { value: ProfileScope; label: string }[] = [
  { value: 'all', label: '共通（clone・manager 両方。既定）' },
  { value: 'app', label: 'clone だけ' },
  { value: 'runner', label: 'manager だけ' },
];

/** 行の名前の形（`packages/core/src/store.ts` の `PROFILE_ENTRY_NAME` と揃える。ずれてもデーモンが 400 で弾く）。 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `/profile` — 実行環境プロファイル（`.zprofile` / `/etc/profile.d` 相当）を読む・差し替える画面
 * （issue #1122）。**プロファイルは名前付きの行の集まり**で、行ごとに本文（何行でもよい）と
 * 撒く先を持つ（2026-10-03）。
 *
 * **`alteroid profile list|show|status|edit|set|rm|clear` / `GET /profile`・
 * `PUT|DELETE /profile/:name` と同じものを読み書きする。** 経路は新しく足していない
 * （AGENTS.md「画面の都合で API に経路を足さないこと」）。
 *
 * **資格は `requireOwner`**（`env-vars.tsx` の `PUT /credentials` と同じ）。宣言済み owner で
 * なければ読み書きとも 403 になる。**⚠️ この画面を足したとき（#1122）、門は
 * `requireOperator` だった**——ブラウザは「サーバ上のファイルを読めること」という資格を
 * 提示できないので、認証を有効にした構成では誰も開けなかった。人間へ上げ、2026-09-24 に
 * オーナーが `requireOwner` へ移すと決めた（`docs/architecture.md` も同じ PR で直した）。
 * ボタンは隠さない（`access.tsx` の宣言ボタンと同じ「押せない理由を消さない」方針）で、
 * 宣言していないアカウントの 403 には宣言の仕方を案内する。
 *
 * **本文は既定で隠す。** `GET /profile` は本文を丸ごと返し、そこには鍵が入りうる
 * （`credentials` と違って指紋に畳まれていない）。画面を開いただけ・肩越しに
 * 見られただけで鍵が出る形にしないため、「本文を表示する」を押したときだけ出す。
 * 編集欄も同じ理由で、「編集する」を押すまで本文を流し込まない。
 *
 * **保存は2段で確かめる。** 送った本文はデーモンの `process.env` を土台にその場で
 * 評価される＝**記憶ストアの鍵を持つプロセスでの任意コマンド実行**である
 * （`.claude/skills/env-profile/SKILL.md`）。サーバ側に確認の印は無い（`POST /reset`
 * の `confirm: true` に当たるものが無い）ので、押す前の確認だけが網になる。
 * 形は `access.tsx` の「本当に取り消す」と同じ、その場で展開する確認の一手である。
 */
export default function Profile() {
  const { data, error, isLoading } = useProfile();
  // 編集欄（新規 or 既存の行）。一度に1つだけ開く。
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [result, setResult] = useState<{ label: string; update: ProfileUpdateResult } | null>(null);

  return (
    <Page
      tabs={<SettingsTabs />}
      title="実行環境プロファイル"
      description="クローン・マネージャー・作業者に効くシェルスクリプトの行（~/.zprofile 相当。行ごとに撒く先を選べる）。alteroid profile と同じもの"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="現在の登録内容"
            subtitle="alteroid profile list / status / GET /profile と同じもの"
            action={data === undefined ? undefined : <Badge>{data.entries.length}</Badge>}
          />
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-[11px] break-words text-muted-foreground">
              行は名前の辞書順（コード単位順。/etc/profile.d と同じ）につなげて効く。
            </p>
            <ErrorNote error={error} />
            <NotOwnerHint failure={error} subject="実行環境プロファイル" />
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
                    setResult(null);
                    setEditor({
                      name: entry.name,
                      existing: true,
                      script: entry.script,
                      scope: entry.scope,
                      original: entry,
                    });
                  }}
                  onRemoved={(label, update) => setResult({ label, update })}
                />
              )
            )}
          </div>
        </Card>
        {data !== undefined && (
          <ProfileEditor
            legacy={data.legacy}
            hasDefault={data.entries.some((entry) => entry.name === 'default')}
            editor={editor}
            setEditor={setEditor}
            onSaved={(label, update) => setResult({ label, update })}
          />
        )}
        {result !== null && (
          <Card>
            <CardHeader title="反映結果" />
            <div className="px-4 py-3">
              <UpdateReport label={result.label} update={result.update} />
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}

function ProfileList({
  profile,
  onEdit,
  onRemoved,
}: {
  profile: NormalizedProfile;
  onEdit: (entry: ProfileEntryView) => void;
  onRemoved: (label: string, update: ProfileUpdateResult) => void;
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
              label: 'runner 用の合成',
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
        各 runner へ届いているか（alteroid profile status の後半）は「設定」の runner 欄に出る。
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
  /** 古いデーモン: 行ごとの削除は通らないので出さない。 */
  legacy: boolean;
  onEdit: () => void;
  onRemoved: (label: string, update: ProfileUpdateResult) => void;
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
      onRemoved(`行 ${entry.name} を外した`, update);
    } catch (caught) {
      setFailure(caught);
      setConfirming(false);
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
          { label: '指紋', value: `sha256=${entry.sha256}`, mono: true },
          { label: '更新', value: formatDateTime(entry.updatedAt) },
        ]}
      />
      <p className="mt-2 text-[11px] break-words text-warn">
        ⚠ 本文には鍵が丸ごと入っていることがある。表示するのは、周りに見られない場所で。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setShown((value) => !value)}>
          {shown ? '本文を隠す' : '本文を表示する'}
        </Button>
        <Button size="sm" onClick={onEdit}>
          編集する
        </Button>
        {!confirming && !legacy && (
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
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
            行 {entry.name} を外す（alteroid profile rm
            と同じ）。他の行は変えない。これから起こす仕事から、
            この行に書いてあった環境は無くなる。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" size="sm" loading={busy} onClick={() => void remove()}>
              本当に外す
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              外すのをやめる
            </Button>
          </div>
        </div>
      )}
      <ErrorNote error={failure} className="mt-2" />
      <NotOwnerHint failure={failure} subject="実行環境プロファイル" />
    </li>
  );
}

interface EditorState {
  name: string;
  /** 既存の行を直しているなら true（名前は変えられない）。 */
  existing: boolean;
  script: string;
  scope: ProfileScope;
  /** 編集を始めたときの行（変更が無いかの判定用）。新規なら無い。 */
  original?: ProfileEntryView;
}

/**
 * 1行を置く（新規・編集）。
 *
 * **編集欄は「編集する」「行を追加する」を押すまで出さない**（本文を既定で隠すのと
 * 同じ理由。押すと、いま置かれている本文を流し込む＝ `alteroid profile edit` が
 * `$EDITOR` に現在の本文を開くのと同じ）。**空の本文は置けない**（外すのは行の
 * 「この行を外す」。CLI も同じ）。
 */
function ProfileEditor({
  legacy,
  hasDefault,
  editor,
  setEditor,
  onSaved,
}: {
  /**
   * 古いデーモン: 行の追加（default 以外）・撒く先の変更はできない。本文の編集だけを、従来の
   * `PUT /profile {script}`（古いデーモンでも通る）へ倒す。名前は default 固定・撒く先は all 固定。
   */
  legacy: boolean;
  hasDefault: boolean;
  editor: EditorState | null;
  setEditor: (next: EditorState | null) => void;
  onSaved: (label: string, update: ProfileUpdateResult) => void;
}) {
  const setEntry = useSetProfileEntry();
  const setLegacy = useSetProfileLegacy();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

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
      onSaved(`行 ${state.name} を更新した`, update);
      setConfirming(false);
      setEditor(null);
    } catch (caught) {
      setFailure(caught);
      // **確認は畳む。** 400（読めなかった）なら本文を直してからもう一度押す
      // ことになるので、確認済みのまま残すと「直したつもりで1回で送る」形になる。
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
      <CardHeader
        title="行を登録する"
        subtitle="alteroid profile edit / set / PUT /profile/:name と同じもの。1行を丸ごと置き換える"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed break-words text-muted-foreground">
          保存すると、本文は置く前にデーモンのプロセスでその場で評価される（記憶ストアの鍵を持つ
          プロセスでの任意コマンド実行と同じ強さ。撒く先が manager だけの行は、デーモンでは評価 せず
          runner が評価する）。読めなければ保存も配布もせず、理由を返す（前のものが残る）。
          秘密は「環境変数」の画面へ置くこと——ここに書いた名前は、そちらの同じ名前を上書きする。
        </p>

        {editor === null ? (
          <div>
            {legacy && hasDefault ? (
              <span className="text-[11px] text-muted-foreground">
                古いデーモンでは、一覧の「編集する」から本文だけ直せる。
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
              <span className="text-xs text-muted-foreground">撒く先</span>
              <Select
                aria-label="プロファイルの撒く先"
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
                  {`行 ${editor.name} を置く。本文をデーモンのプロセスで評価し、通れば${
                    editor.scope === 'all'
                      ? 'クローン・マネージャー・作業者のすべて'
                      : editor.scope === 'app'
                        ? 'クローン（デーモン）だけ'
                        : 'マネージャー・作業者だけ'
                  }へ配る。撒く先から外れた側からは外れる。これから起こす仕事には即座に効く。`}
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
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditor(null)}>
                  編集を閉じる
                </Button>
                {unchanged && (
                  <span className="text-[11px] text-muted-foreground">変更はまだ無い。</span>
                )}
                {!editor.existing && editor.name.length > 0 && !nameValid && (
                  <span className="text-[11px] text-destructive">名前の形が不正。</span>
                )}
                {scriptEmpty && (
                  <span className="text-[11px] text-muted-foreground">
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
          <p className="text-[11px] text-muted-foreground">
            前のプロファイルがそのまま残っている。
          </p>
        )}
        <NotOwnerHint failure={failure} subject="実行環境プロファイル" />
      </div>
    </Card>
  );
}

/**
 * 反映結果。**失敗を小さく出さない**（CLI の `report` と同じ理由——見落とすと、
 * 以後ずっと古い環境で走り続ける）。
 */
function UpdateReport({ label, update }: { label: string; update: ProfileUpdateResult }) {
  // 古いデーモンの応答には無い（`composed` は新しい形で足された）。実行時の倒れ先。
  const composed = (update as Partial<ProfileUpdateResult>).composed;
  const rows = [
    { label: 'クローン', outcome: update.clone },
    ...update.runners.map((runner) => ({ label: runner.runnerId, outcome: runner })),
  ];

  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="font-medium text-ok">{`プロファイルの${label}。`}</p>
      <p className="font-mono text-[11px] break-all text-muted-foreground">
        {composed === undefined
          ? null
          : `合成後の指紋: クローン用 ${composed.clone.sha256 ?? '掛かる行なし'} / runner 用 ${composed.runner.sha256 ?? '掛かる行なし'}`}
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
      <p className="text-[11px] text-muted-foreground">
        これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う
        ——それ以外は次の仕事から。
      </p>
    </div>
  );
}
