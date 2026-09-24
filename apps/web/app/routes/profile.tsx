import { useRef, useState } from 'react';

import { Page } from '~/components/page';
import { Button, Card, CardHeader, ErrorNote, Input, Spinner, Textarea } from '~/components/ui';
import { useSetProfile } from '~/hooks/mutations';
import { useProfile } from '~/hooks/queries';
import { formatBytes, formatDateTime } from '~/lib/format';
import type {
  ProfileApplyOutcome,
  ProfileRunnerApplyOutcome,
  ProfileUpdateResult,
} from '~/lib/types';

/**
 * `/profile` — 実行環境プロファイル（`.zprofile` 相当）を Web UI から読む・
 * 直す画面（issue #1122）。CLI の `alteroid profile show|status|edit|set|clear`
 * のうち、本文の閲覧・編集にあたる部分を画面から行えるようにする。**経路は
 * 新しく足していない** ——既に在る `GET`/`PUT /profile` を、この画面からも
 * 呼べるようにしただけである（`.claude/skills/env-profile/SKILL.md`）。
 *
 * **chat のスラッシュコマンドは対象外**（issue #1122「判断が要る点」）。
 * `memory` が「top-level が書き込み・chat が読み取りだけ」という役割分担を
 * 既に採っているのに対し、プロファイルの CLI は top-level にしか無く
 * （`apps/cli/src/index.ts` の `profileCommand`）、chat 側の口
 * （`apps/cli/src/chat.ts`）は元から無い。**この PR はその状態を変えない**
 * ——「CLI に在る」を top-level で満たしているとみなす側の判断で、chat 側を
 * 追加するかどうかはオーナー判断のまま残す（issue 本文の「判断が要る点」）。
 *
 * **資格は `requireOperator`。** `env-vars.tsx`（`PUT /credentials`）や
 * `settings.tsx` の `ResetWorkspace`（`POST /reset`）と違い、`GET`/`PUT
 * /profile` は 2026-09-06 の同格化にも 2026-09-17/18 の `requireOwner` への
 * 降格にも入っていない（`useProfile` の doc）。**ブラウザ経由の通常のログイン
 * ではこの資格を構造的に持てない**——実際に開くのは認証を無効にした構成
 * （`ALTEROID_AUTH=off`）だけである。それでも**ボタンは隠さない**
 * （`env-vars.tsx` `access.tsx` と同じ「押せない理由を消さない」方針）——403
 * は `ErrorNote` でそのまま見せる。
 *
 * **確認の導線は `env-vars.tsx` ではなく `settings.tsx` の `ResetWorkspace` /
 * `ShutdownDaemon` に倣った（`<dialog>` に語を打たせる）。** `env-vars.tsx` の
 * 「置く」には確認が無い——環境変数は1件ずつの静的な値だからである。
 * プロファイルは違う。`docs/architecture.md` が逐語で言うとおり
 * 「プロファイルの差し替えは、記憶ストアの鍵を持つプロセスでの任意コマンド
 * 実行そのものである」——`PUT` の本文はデーモンの `process.env` を土台に
 * その場で評価され、クローンと全 runner に即座に配られる。`VacateRunner`
 * の「2ボタンで確認」（`settings.tsx`）はここには弱すぎる——あちらは器を
 * 空けるだけで、鍵をまるごとは運ばない。**重さは `POST /reset` 以上**なので、
 * 確認の強さも `ResetWorkspace` と同格にする。
 */
export default function Profile() {
  const { data, error, isLoading } = useProfile();
  const setProfile = useSetProfile();

  /**
   * `undefined` は「まだ人間が触っていない」（`memory-detail.tsx` と同じ作法）。
   * サーバの値を state へ写さないので、保存前に他経路（`alteroid profile set`
   * や別のタブ）が変えても書きかけが消えない。
   */
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const loaded = data?.script ?? '';
  const value = draft ?? loaded;
  const dirty = draft !== undefined && draft !== loaded;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [applied, setApplied] = useState<ProfileUpdateResult | null>(null);

  const canConfirm = confirmText.trim().toLowerCase() === 'apply';
  const willClear = value.trim().length === 0;

  function openDialog() {
    if (!dirty) return;
    setConfirmText('');
    setFailure(undefined);
    setApplied(null);
    dialogRef.current?.showModal();
  }

  async function runApply() {
    if (!canConfirm) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await setProfile(value);
      setApplied(result);
      setDraft(undefined);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="実行環境プロファイル"
      description="alteroid profile show/edit と同じもの（.zprofile 相当）。クローン・マネージャー・作業者すべてに効く"
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="いまの状態"
            subtitle="alteroid profile status と同じもの。runner ごとの反映結果は設定画面（/settings）で見える"
          />
          <div className="px-4 py-3 text-xs">
            <ErrorNote error={error} className="mb-2" />
            {isLoading ? (
              <Spinner />
            ) : data === undefined ? null : data.script.length === 0 ? (
              <p className="text-muted">置かれていません。</p>
            ) : (
              <p className="font-mono text-muted">
                {formatBytes(data.bytes ?? 0)}
                {data.sha256 === undefined ? '' : ` (sha256 ${data.sha256}`}
                {data.updatedAt === undefined
                  ? data.sha256 === undefined
                    ? ''
                    : ')'
                  : ` / 更新 ${formatDateTime(data.updatedAt)})`}
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="編集"
            subtitle="ここで書き換えたシェルスクリプトが、クローンと全 runner に配られる"
          />
          <div className="flex flex-col gap-3 px-4 py-3 text-sm">
            <p className="text-xs leading-relaxed text-muted">
              置いたものはクローン・マネージャー・作業者すべてに効く。器（コンテナ）を
              作り直す必要はない——差し替えは<strong className="text-fg">これから起こす仕事</strong>
              に効き、既に走っている仕事のうち次の呼び出しから拾うのは{' '}
              <code className="font-mono">gh</code> / <code className="font-mono">git</code>{' '}
              だけである。記憶（人格）ではない——価値観や「何を任せてよいか」は chat で伝える。
            </p>
            <Textarea
              aria-label="プロファイル本文"
              className="min-h-[50vh] font-mono text-xs leading-relaxed"
              value={value}
              spellCheck={false}
              placeholder={
                '# 例:\n#   export SOME_API_TOKEN=xxxx\n#   export PATH="$HOME/.local/bin:$PATH"'
              }
              onChange={(event) => setDraft(event.target.value)}
            />
            <div>
              <Button variant="danger" size="sm" disabled={!dirty} onClick={openDialog}>
                {dirty ? (willClear ? 'プロファイルを外す' : '保存する') : '変更なし'}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <dialog
        ref={dialogRef}
        className="w-[min(32rem,calc(100vw-2rem))] rounded-md border border-border bg-surface p-0 text-fg backdrop:bg-black/50"
      >
        <div className="p-4">
          <h2 className="text-sm font-semibold">
            {willClear ? '本当にプロファイルを外しますか？' : '本当に反映しますか？'}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {willClear ? (
              <>
                プロファイルを外します。以後、クローン・マネージャー・作業者へこの内容は
                配られません。
              </>
            ) : (
              <>
                この本文はデーモンの環境を土台にその場で評価され、
                <strong className="text-fg">
                  記憶ストアの鍵を持つプロセスでの任意コマンド実行そのもの
                </strong>
                になる。壊れていれば保存も配布もしない（前のものが残る）。通れば
                <strong className="text-fg">クローンと全 runner へ即座に配られる</strong>。
              </>
            )}
          </p>

          {applied === null ? (
            <>
              <label className="mt-3 block text-xs text-muted">
                続けるなら <code className="rounded bg-surface-2 px-1 font-mono">apply</code> と入力
                <Input
                  autoFocus
                  className="mt-1"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder="apply"
                />
              </label>
              <ErrorNote error={failure} className="mt-3" />
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" disabled={busy} onClick={() => dialogRef.current?.close()}>
                  やめる
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!canConfirm}
                  loading={busy}
                  onClick={() => void runApply()}
                >
                  {willClear ? '本当に外す' : '本当に反映する'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-xs font-medium text-ok">反映しました。</p>
              <AppliedSummary result={applied} />
              <div className="mt-4 flex justify-end">
                <Button variant="primary" size="sm" onClick={() => dialogRef.current?.close()}>
                  閉じる
                </Button>
              </div>
            </>
          )}
        </div>
      </dialog>
    </Page>
  );
}

/**
 * 直後の適用結果（クローン＋各 runner）。CLI の `apps/cli/src/profile.ts` の
 * `report()` と同じ内容——**「反映しました」と「反映できませんでした」を
 * 畳まない**（失敗を小さく出さない。見落とすと以後ずっと古い環境で走り続ける）。
 *
 * **これは一度きりのスナップショットである。** 継続的に見るなら
 * `/settings` の `PushHealth`（`pushHealth.profile`）と `Credentials` の
 * 指紋を見る——あちらは runner が再接続するたびに更新される。
 */
function AppliedSummary({ result }: { result: ProfileUpdateResult }) {
  return (
    <Card>
      <CardHeader title="直前の適用結果" subtitle="クローンと各 runner への配布" />
      <ul className="flex flex-col gap-2 px-4 py-3 text-xs">
        <AppliedRow label="クローン" outcome={result.clone} />
        {result.runners.map((runner) => (
          <AppliedRow key={runner.runnerId} label={runner.runnerId} outcome={runner} />
        ))}
      </ul>
    </Card>
  );
}

function AppliedRow({
  label,
  outcome,
}: {
  label: string;
  outcome: ProfileApplyOutcome | ProfileRunnerApplyOutcome;
}) {
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono break-all">{label}</span>
        <span className={outcome.ok ? 'text-ok' : 'text-danger'}>
          {outcome.ok ? '反映しました' : '反映できませんでした'}
        </span>
      </div>
      {!outcome.ok && <p className="mt-1 break-words text-danger">{outcome.error ?? '理由不明'}</p>}
      {outcome.output !== undefined && outcome.output.trim().length > 0 && (
        <pre className="mt-1 overflow-x-auto rounded bg-surface-2 p-2 font-mono whitespace-pre-wrap text-muted">
          {outcome.output}
        </pre>
      )}
    </li>
  );
}
