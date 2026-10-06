import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { EllipsisVertical } from 'lucide-react';
import { useState } from 'react';

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
  Select,
  Spinner,
} from '@alteroid/ui';
import {
  Button as ShadcnButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@alteroid/ui/shadcn';
import { useCredentials, useRemoveEnvVar, useSetEnvVar } from '@alteroid/swr';
import { failedRunnerPushes, formatDateTime } from '@alteroid/logic';
import type { EnvVarScope, EnvVarUpdateResult, EnvVarView } from '@alteroid/logic';

/**
 * `/env-vars` — alteroid 自身の運用設定・マネージャーへ降ろす環境変数（旧
 * 「マネージャーへ降ろす環境変数」）を CLI と同じ資格で見る・置く・外す画面。
 *
 * **`alteroid credential` / `PUT /credentials` と同じものを読み書きする。**
 * 経路は新しく足していない——既に在る `GET`/`PUT /credentials` を、この画面
 * からも呼べるようにしただけである（`.claude/skills/env-profile/SKILL.md`）。
 *
 * **CLI と同じ資格。** 読み出し（一覧・指紋）は `authenticate` だけで開くが、
 * 置く・外す（`PUT /credentials`）は `requireOwner`——中身は素通しで、許可済みで
 * ログインできるアカウントは全員持ち主として通る（2026-10-05 オーナー決定、#2862 / PR #2945）。
 * 許可の無いアカウントは `authenticate` の 403。ボタンは隠さない。
 *
 * **⚠️ 2026-09-17 まで、この画面のボタンは押すと必ず 403 だった**（issue #1195）。
 * 資格が `requireOperator` だったためで、**ブラウザは構造的にそれを通れない**
 * ——「実行環境の持ち主」はサーバ上のファイルを読めることであって、提示できる
 * 秘密ではない。**その後、近似（`grantedBy === 'operator'`）・`ownerDeclaredAt` の宣言と
 * 門が移り、いまは許可済みなら全員通る。**この画面は1バイトも変えていない**——直したのは
 * デーモン側の門だけである。
 */
export default function EnvVars() {
  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/env-vars')}
      title="環境変数"
      description="alteroid 自身の運用設定と、マネージャーへ渡す環境変数。渡す先は「共通」「クローンだけ」「マネージャーだけ」から選べる"
    >
      <div className="flex flex-col gap-4">
        <EnvVarList />
        <AddEnvVarForm />
      </div>
    </Page>
  );
}

function describeScope(scope: EnvVarScope): { label: string; tone: 'neutral' | 'accent' } {
  switch (scope) {
    case 'all':
      return { label: '共通', tone: 'accent' };
    case 'app':
      return { label: 'クローンだけ', tone: 'neutral' };
    case 'runner':
      return { label: 'マネージャーだけ', tone: 'neutral' };
    default:
      // **送られてくる値である**（デーモンが `GET /credentials` で載せる）。
      // `apps/web` は Vercel、デーモンは Railway で別に配られるので、
      // サーバのほうが新しい窓が必ず在る——投げずに「未知」とそのまま出す
      // （`tokens.tsx` の `describeUnknown` と同じ判断）。
      return { label: `未知の渡す先（${String(scope)}）`, tone: 'neutral' };
  }
}

/**
 * 一覧の列。**列の開始位置を全行で揃えるため、行ごとの flex にせず、一覧全体で列幅を共有する**
 * （親が `grid-template-columns` を持ち、各行は `subgrid` でそれを受ける）。名前・値は
 * `minmax(0, …)` で縮められるようにして truncate し、長くても列がずれず、狭い画面でも横に溢れない。
 */
const LIST_COLUMNS = 'grid-cols-[max-content_minmax(0,2fr)_minmax(0,3fr)_auto]';

/** 伏せ字。secret の値は画面に出さない（長さも伝えない固定の並び）。 */
const MASK = '******';

function EnvVarList() {
  const { data, error, isLoading, isValidating, mutate } = useCredentials();
  const removeEnvVar = useRemoveEnvVar();
  const [removeFailure, setRemoveFailure] = useState<unknown>(undefined);
  const [removeResult, setRemoveResult] = useState<EnvVarUpdateResult | undefined>(undefined);

  async function remove(name: string) {
    setRemoveFailure(undefined);
    setRemoveResult(undefined);
    try {
      setRemoveResult(await removeEnvVar(name));
    } catch (caught) {
      setRemoveFailure(caught);
    }
  }

  const credentials = data?.credentials ?? [];
  /**
   * **取れなかったのを0件と描かない**（issue #2324）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は `LoadError` が言う。再検証の失敗で `data` が残っているときは
   * 当たらず、一覧をそのまま出す。
   */
  const listUnavailable = data === undefined && error !== undefined;

  return (
    <Card>
      <CardHeader
        title="一覧"
        subtitle="登録済みの環境変数"
        action={listUnavailable ? undefined : <Badge>{credentials.length}</Badge>}
      />
      <LoadError
        what="環境変数の一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="m-4"
      />
      <ErrorNote error={removeFailure} className="m-4" />
      {removeResult !== undefined && (
        <RunnerPushWarning update={removeResult} saved="外した" className="m-4" />
      )}
      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : credentials.length === 0 ? (
        <Empty>置かれた環境変数がまだ1件も無い。</Empty>
      ) : (
        <div role="list" className={`grid ${LIST_COLUMNS}`}>
          {[...credentials]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entry) => (
              <EnvVarRow key={entry.name} entry={entry} onRemove={() => remove(entry.name)} />
            ))}
        </div>
      )}
    </Card>
  );
}

/**
 * 保存はできたが、一部の実行環境へ反映できていないときの警告（#3157）。**成功の見出しは出さない**
 * （全部届いたときは何も出さない。従来どおり一覧が更新されるだけ）。実行環境が0台のときは
 * 失敗ではないので出さない（`@alteroid/logic` の `failedRunnerPushes` の doc）。
 * 失敗した実行環境ごとの理由を出し、いつ追いつくかを言う。
 */
function RunnerPushWarning({
  update,
  saved,
  className,
}: {
  update: EnvVarUpdateResult;
  /** 「環境変数を〇〇」の〇〇（置いた・外した・保存した）。 */
  saved: string;
  className?: string;
}) {
  const failed = failedRunnerPushes(update);
  if (failed.length === 0) return null;
  return (
    <div
      role="alert"
      className={`flex flex-col gap-1 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn ${className ?? ''}`}
    >
      <p className="font-medium">
        {`環境変数を${saved}が、${String(failed.length)} 台の実行環境へ反映できていない。`}
      </p>
      <ul className="flex flex-col gap-1">
        {failed.map((runner) => (
          <li key={runner.runnerId} className="break-words">
            <span className="font-mono break-all">{runner.runnerId}</span>:{' '}
            {runner.error ?? '理由不明'}
          </li>
        ))}
      </ul>
      <p className="text-[11px]">失敗した実行環境へは、次につなぎ直したときに渡す。</p>
    </div>
  );
}

function EnvVarRow({ entry, onRemove }: { entry: EnvVarView; onRemove: () => Promise<void> }) {
  const scope = describeScope(entry.scope);
  const [editing, setEditing] = useState(false);
  // 開くたびに編集ダイアログを作り直す鍵。開く操作はメニューから来るので Dialog の onOpenChange(true) は
  // 呼ばれない——作り直さないと、前回やめたときの入力途中の値が次に開いたときに残る。
  const [editSession, setEditSession] = useState(0);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const shownValue = entry.secret ? MASK : (entry.value ?? '（サーバがまだ値を返していない版）');

  return (
    <div
      role="listitem"
      className="col-span-4 grid grid-cols-subgrid items-center gap-x-3 border-b border-border px-4 py-2 last:border-b-0"
    >
      <Badge tone={scope.tone}>{scope.label}</Badge>
      <span className="truncate font-mono text-sm" title={entry.name}>
        {entry.name}
      </span>
      <span
        className="truncate font-mono text-sm text-muted-foreground"
        title={`更新 ${formatDateTime(entry.updatedAt)}${entry.secret ? `（識別用の値 ${entry.sha256}）` : ''}`}
      >
        {shownValue}
      </span>
      {/* modal={false}: メニューの項目からダイアログを開くと、Radix のモーダルなメニューが閉じるときに
          body の pointer-events: none を戻し損ねて画面が押せなくなることがある。メニュー自体は
          モーダルである必要が無いので外す。 */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <ShadcnButton variant="ghost" size="icon-sm" aria-label={`「${entry.name}」の操作`}>
            <EllipsisVertical aria-hidden />
          </ShadcnButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setEditSession((n) => n + 1);
              setEditing(true);
            }}
          >
            編集
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingRemove(true)}>
            削除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditEnvVarDialog key={editSession} entry={entry} open={editing} onOpenChange={setEditing} />
      {/* 削除すると置いた値が消えて取り消せない。押した瞬間には実行せず確認を挟む（#2781） */}
      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title={`環境変数「${entry.name}」を削除しますか`}
        description="置いた値が消え、元に戻せません。これを受け取っていた仕事には、以後この値が配られません。"
        confirmLabel="削除"
        destructive
        onConfirm={() => void onRemove()}
      />
    </div>
  );
}

/**
 * 値と渡す先を、同じ名前のまま上書きする（`PUT /credentials` の部分更新）。
 *
 * **`secret` は送らない。**作成後は変えられない（`packages/core/src/store.ts` の
 * `StoredCredential.secret` の doc）ので、送ると別の意味になりうる。**空の値では保存させない**
 * ——空は「外す」の意味になる（削除はメニューの「削除」から、確認を通して行う）。
 * secret の現在値はサーバが返さないので、初期値は空で「新しい値」を入れさせる。
 */
function EditEnvVarDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: EnvVarView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setEnvVar = useSetEnvVar();
  const initialValue = entry.secret ? '' : (entry.value ?? '');
  const [value, setValue] = useState(initialValue);
  const [scope, setScope] = useState<EnvVarScope>(entry.scope);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [result, setResult] = useState<EnvVarUpdateResult | undefined>(undefined);

  const canSave = value.length > 0;

  function handleOpenChange(next: boolean) {
    if (next) {
      // 開くたびに、いまの登録内容から始め直す（前回の入力途中や失敗を持ち越さない）。
      setValue(initialValue);
      setScope(entry.scope);
      setFailure(undefined);
      setResult(undefined);
    }
    onOpenChange(next);
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setFailure(undefined);
    setResult(undefined);
    try {
      const update = await setEnvVar({ name: entry.name, value, scope });
      // 一部の実行環境へ反映できていなければ閉じない（閉じると警告ごと消えて、成功と見分けが付かない）。
      if (failedRunnerPushes(update).length > 0) setResult(update);
      else onOpenChange(false);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>環境変数を編集</DialogTitle>
          <DialogDescription>
            名前は変えられない。{entry.secret ? 'シークレットなので、値は新しく入れ直す。' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">名前</span>
            <Input value={entry.name} readOnly className="font-mono" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {entry.secret ? '新しい値' : '値'}
            </span>
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">渡す先</span>
            <Select value={scope} onChange={(event) => setScope(event.target.value as EnvVarScope)}>
              {SCOPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <ErrorNote error={failure} />
          {result !== undefined && <RunnerPushWarning update={result} saved="保存した" />}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={() => handleOpenChange(false)}>
            やめる
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            loading={busy}
            onClick={() => void save()}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SCOPE_OPTIONS: { value: EnvVarScope; label: string }[] = [
  { value: 'all', label: '共通（クローン・マネージャー両方。既定）' },
  { value: 'app', label: 'クローンだけ' },
  { value: 'runner', label: 'マネージャーだけ' },
];

function AddEnvVarForm() {
  const setEnvVar = useSetEnvVar();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<EnvVarScope>('all');
  const [secret, setSecret] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [result, setResult] = useState<EnvVarUpdateResult | undefined>(undefined);

  const canSubmit = name.trim().length > 0 && value.length > 0;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(undefined);
    setResult(undefined);
    try {
      setResult(await setEnvVar({ name: name.trim(), value, scope, secret }));
      setName('');
      setValue('');
      // **scope・secret は次の1件のために引き継ぐ。** 同じ設定で複数を続けて
      // 置く運用（例: TZ に続けて他の非シークレット値を置く）を打ちやすくする。
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="登録する"
        subtitle="秘密の値にするかどうかは登録するときに決まり、後から変えられない"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">名前（英大文字・数字・_ のみ）</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value.toUpperCase())}
            placeholder="TZ"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">値</span>
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">渡す先</span>
          <Select value={scope} onChange={(event) => setScope(event.target.value as EnvVarScope)}>
            {SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="pointer-coarse:size-5 pointer-coarse:shrink-0"
            checked={secret}
            onChange={(event) => setSecret(event.target.checked)}
          />
          シークレット扱いにする（値を
          この画面にも他の経路にも表示しない。新規行にのみ効き、後から変更できない）
        </label>

        <ErrorNote error={failure} />
        {result !== undefined && <RunnerPushWarning update={result} saved="置いた" />}

        <div>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            loading={busy}
            onClick={() => void submit()}
          >
            置く
          </Button>
        </div>
      </div>
    </Card>
  );
}
