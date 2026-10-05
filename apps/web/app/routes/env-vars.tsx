import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
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
  KeyValueList,
  Select,
  Spinner,
} from '@alteroid/ui';
import { useCredentials, useRemoveEnvVar, useSetEnvVar } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { EnvVarScope, EnvVarView } from '@alteroid/logic';

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
      description="alteroid 自身の運用設定と、マネージャーへ渡す環境変数。渡す先は「共通」「クローン」「マネージャー」から選べる"
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

function EnvVarList() {
  const { data, error, isLoading, isValidating, mutate } = useCredentials();
  const removeEnvVar = useRemoveEnvVar();
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [removeFailure, setRemoveFailure] = useState<unknown>(undefined);

  async function remove(name: string) {
    setRemovingName(name);
    setRemoveFailure(undefined);
    try {
      await removeEnvVar(name);
    } catch (caught) {
      setRemoveFailure(caught);
    } finally {
      setRemovingName(null);
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
      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : credentials.length === 0 ? (
        <Empty>置かれた環境変数がまだ1件も無い。</Empty>
      ) : (
        <ul>
          {[...credentials]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entry) => (
              <EnvVarRow
                key={entry.name}
                entry={entry}
                busy={removingName === entry.name}
                onRemove={() => void remove(entry.name)}
              />
            ))}
        </ul>
      )}
    </Card>
  );
}

function EnvVarRow({
  entry,
  busy,
  onRemove,
}: {
  entry: EnvVarView;
  busy: boolean;
  onRemove: () => void;
}) {
  const scope = describeScope(entry.scope);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all">{entry.name}</span>
        <Badge tone={scope.tone}>{scope.label}</Badge>
        <Badge tone={entry.secret ? 'warn' : 'neutral'}>
          {entry.secret ? 'シークレット' : '非シークレット'}
        </Badge>
      </div>

      <KeyValueList
        className="mt-2"
        labelWidth="6rem"
        items={[
          {
            label: '値',
            mono: true,
            value: entry.secret
              ? `（シークレット。値は表示されない。識別用の値 sha256=${entry.sha256}）`
              : (entry.value ?? '（サーバがまだ値を返していない版）'),
          },
          { label: '更新', value: formatDateTime(entry.updatedAt) },
        ]}
      />

      {entry.shadowsCloneEnv === true && (
        <p className="mt-2 text-[11px] break-words text-warn">
          ⚠ GitHub
          用の名前のため、デーモン（クローン）が動いている環境側の同じ名前の環境変数の値が優先して渡されている
          （この画面に登録したこの行の値は、どこにも渡されていない）。
          {entry.scope === 'app' &&
            // **scope: app は他の scope と挙動が違う（issue #1894）。** この行は
            // manager に配布されない（issue #1867）ので、上の一文だけでは
            // 「manager も器の env で走っている」と読めてしまう——実際は
            // manager にはこの名前が何も配られていない。そして「配られていない」
            // からといってこの行を外すと、その名前は manager にも配られ始める
            // （scope で閉じた先へ届く）。
            ' 渡す先が「クローンだけ」のこの名前は、マネージャーにはいま何も渡されて' +
              'いない。この行を外すと、動いている環境側の環境変数の値がマネージャーにも渡され始める' +
              '（渡す先を限っていた分が外れるため）。'}
        </p>
      )}

      <div className="mt-2">
        <Button variant="danger" size="sm" loading={busy} onClick={() => setConfirmingRemove(true)}>
          外す
        </Button>
        {/* 外すと置いた値が消えて取り消せない。押した瞬間には実行せず確認を挟む（#2781） */}
        <ConfirmDialog
          open={confirmingRemove}
          onOpenChange={setConfirmingRemove}
          title={`環境変数「${entry.name}」を外しますか`}
          description="置いた値が消え、元に戻せません。これを受け取っていた仕事には、以後この値が配られません。"
          confirmLabel="外す"
          destructive
          onConfirm={onRemove}
        />
      </div>
    </li>
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

  const canSubmit = name.trim().length > 0 && value.length > 0;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await setEnvVar({ name: name.trim(), value, scope, secret });
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
