import { useState } from 'react';

import { NotOwnerHint } from '~/components/not-owner-hint';
import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNote,
  KeyValueList,
  Select,
  Spinner,
  Textarea,
} from '@alteroid/ui';
import { ProfileRejectedError, useSetProfile, useProfile } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { ProfileScope, ProfileState, ProfileUpdateResult } from '@alteroid/logic';

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

/**
 * `/profile` — 実行環境プロファイル（`.zprofile` 相当）を読む・差し替える画面
 * （issue #1122）。
 *
 * **`alteroid profile show|status|edit|set|clear` / `GET`・`PUT /profile` と同じもの
 * を読み書きする。** 経路は新しく足していない——既に在る2本を、この画面からも
 * 呼べるようにしただけである（AGENTS.md「画面の都合で API に経路を足さないこと」）。
 * `clear` も新しい口ではなく、CLI と同じく空文字の `PUT /profile` である。
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

  return (
    <Page
      title="実行環境プロファイル"
      description="クローン・マネージャー・作業者に効くシェルスクリプト（~/.zprofile 相当。撒く先は選べる）。alteroid profile と同じもの"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="いま置かれているもの"
            subtitle="alteroid profile show / status / GET /profile と同じもの"
          />
          <div className="flex flex-col gap-3 px-4 py-3">
            <ErrorNote error={error} />
            <NotOwnerHint failure={error} subject="実行環境プロファイル" />
            {isLoading ? <Spinner /> : data !== undefined && <ProfileView profile={data} />}
          </div>
        </Card>
        {data !== undefined && <ProfileEditor current={data} />}
      </div>
    </Page>
  );
}

function ProfileView({ profile }: { profile: ProfileState }) {
  const [shown, setShown] = useState(false);
  const empty = profile.script.length === 0;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <KeyValueList
        labelWidth="6rem"
        items={[
          {
            label: '状態',
            value: empty ? (
              <Badge>置かれていない</Badge>
            ) : (
              <Badge tone="accent">{`${String(profile.bytes ?? 0)} バイト`}</Badge>
            ),
          },
          ...(!empty
            ? [
                { label: '指紋', value: `sha256=${profile.sha256 ?? '?'}`, mono: true },
                {
                  label: '撒く先',
                  value: (
                    <Badge tone={describeScope(profile.scope).tone}>
                      {describeScope(profile.scope).label}
                    </Badge>
                  ),
                },
                {
                  label: '更新',
                  value: profile.updatedAt === undefined ? '?' : formatDateTime(profile.updatedAt),
                },
              ]
            : []),
        ]}
      />

      {!empty && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] break-words text-warn">
            ⚠ 本文には鍵が丸ごと入っていることがある。表示するのは、周りに見られない場所で。
          </p>
          <div>
            <Button size="sm" onClick={() => setShown((value) => !value)}>
              {shown ? '本文を隠す' : '本文を表示する'}
            </Button>
          </div>
          {shown && (
            <pre
              aria-label="プロファイルの本文"
              className="max-h-96 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap"
            >
              {profile.script}
            </pre>
          )}
        </div>
      )}

      <p className="text-[11px] break-words text-muted-foreground">
        各 runner へ届いているか（alteroid profile status の後半）は「設定」の runner 欄に出る。
      </p>
    </div>
  );
}

/**
 * 差し替え・外す。
 *
 * **編集欄は「編集する」を押すまで出さない**（本文を既定で隠すのと同じ理由。
 * 押すと、いま置かれている本文を流し込む＝ `alteroid profile edit` が
 * `$EDITOR` に現在の本文を開くのと同じ）。
 *
 * **確認の文言は本文が空かどうかで変える。** 空の保存は「外す」であって
 * 「評価して置く」ではない（CLI の `put` も空なら「プロファイルを外しました」と
 * 出し分けている）。
 */
function ProfileEditor({ current }: { current: ProfileState }) {
  const setProfile = useSetProfile();
  const [draft, setDraft] = useState<string | null>(null);
  const [draftScope, setDraftScope] = useState<ProfileScope>(current.scope);
  const [confirming, setConfirming] = useState<'save' | 'clear' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [result, setResult] = useState<{ cleared: boolean; update: ProfileUpdateResult } | null>(
    null,
  );

  const editing = draft !== null;
  const empty = current.script.length === 0;
  const draftClears = editing && draft.trim().length === 0;
  // 撒く先だけを変えるのも更新である（本文が同じでも、外れる側が出る）。
  const unchanged = editing && draft === current.script && draftScope === current.scope;

  async function submit(script: string, scope?: ProfileScope) {
    setBusy(true);
    setFailure(undefined);
    try {
      const update = await setProfile(script, scope);
      setResult({ cleared: script.trim().length === 0, update });
      setConfirming(null);
      setDraft(null);
    } catch (caught) {
      setFailure(caught);
      // **確認は畳む。** 400（読めなかった）なら本文を直してからもう一度押す
      // ことになるので、確認済みのまま残すと「直したつもりで1回で送る」形になる。
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  function startEditing() {
    setDraft(current.script);
    setDraftScope(current.scope);
    setConfirming(null);
    setFailure(undefined);
    setResult(null);
  }

  return (
    <Card>
      <CardHeader
        title="差し替える"
        subtitle="alteroid profile edit / set / clear / PUT /profile と同じもの。丸ごと置き換える"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p className="text-xs leading-relaxed break-words text-muted-foreground">
          保存すると、本文は置く前にデーモンのプロセスでその場で評価される（記憶ストアの鍵を持つ
          プロセスでの任意コマンド実行と同じ強さ）。読めなければ保存も配布もせず、理由を返す
          （前のものが残る）。秘密は「環境変数」の画面へ置くこと——ここに書いた名前は、そちらの
          同じ名前を上書きする。
        </p>

        {!editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={startEditing}>
              編集する
            </Button>
            {!empty && confirming !== 'clear' && (
              <Button variant="danger" size="sm" onClick={() => setConfirming('clear')}>
                プロファイルを外す
              </Button>
            )}
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">本文（シェルスクリプト）</span>
              <Textarea
                aria-label="プロファイルの新しい本文"
                className="min-h-64 font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setConfirming(null);
                }}
                placeholder={'export PATH="$HOME/.local/bin:$PATH"'}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">撒く先</span>
              <Select
                aria-label="プロファイルの撒く先"
                value={draftScope}
                onChange={(event) => {
                  setDraftScope(event.target.value as ProfileScope);
                  setConfirming(null);
                }}
              >
                {SCOPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            {confirming !== 'save' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={unchanged}
                  onClick={() => setConfirming('save')}
                >
                  {draftClears ? '空で保存する（外す）' : '保存する'}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
                  編集を閉じる
                </Button>
                {unchanged && (
                  <span className="text-[11px] text-muted-foreground">変更はまだ無い。</span>
                )}
              </div>
            )}
          </>
        )}

        {confirming === 'save' && editing && (
          <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
            <p className="text-[11px] break-words text-warn">
              {draftClears
                ? 'プロファイルを外す。これから起こす仕事から、ここに書いてあった環境は無くなる。'
                : `この本文をデーモンのプロセスで評価し、通れば${
                    draftScope === 'all'
                      ? 'クローン・マネージャー・作業者のすべて'
                      : draftScope === 'app'
                        ? 'クローン（デーモン）だけ'
                        : 'マネージャー・作業者だけ'
                  }へ配る。撒く先から外れた側からは外れる。これから起こす仕事には即座に効く。`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" size="sm" loading={busy} onClick={() => void submit(draft, draftScope)}>
                {draftClears ? '本当に外す' : '本当に保存する'}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                保存をやめる
              </Button>
            </div>
          </div>
        )}

        {confirming === 'clear' && !editing && (
          <div className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
            <p className="text-[11px] break-words text-warn">
              プロファイルを外す（alteroid profile clear と同じ）。これから起こす仕事から、
              ここに書いてあった環境は無くなる。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" size="sm" loading={busy} onClick={() => void submit('')}>
                本当に外す
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                外すのをやめる
              </Button>
            </div>
          </div>
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

        {result !== null && <UpdateReport cleared={result.cleared} update={result.update} />}
      </div>
    </Card>
  );
}

/**
 * 反映結果。**失敗を小さく出さない**（CLI の `report` と同じ理由——見落とすと、
 * 以後ずっと古い環境で走り続ける）。
 */
function UpdateReport({ cleared, update }: { cleared: boolean; update: ProfileUpdateResult }) {
  const rows = [
    { label: 'クローン', outcome: update.clone },
    ...update.runners.map((runner) => ({ label: runner.runnerId, outcome: runner })),
  ];

  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="font-medium text-ok">
        {cleared
          ? 'プロファイルを外した。'
          : `プロファイルを更新した（sha256 ${update.sha256 ?? '?'}）。`}
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map(({ label, outcome }) => (
          <li key={label} className="break-words">
            <span className="font-mono">{label}</span>:{' '}
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
      {!cleared && (
        <p className="text-[11px] text-muted-foreground">
          これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う
          ——それ以外は次の仕事から。
        </p>
      )}
    </div>
  );
}
