import { useState } from 'react';

import { Page } from '~/components/page';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  Select,
  Spinner,
} from '~/components/ui';
import { useCredentials } from '~/hooks/queries';
import { useRemoveEnvVar, useSetEnvVar } from '~/hooks/mutations';
import { formatDateTime } from '~/lib/format';
import type { EnvVarScope, EnvVarView } from '~/lib/types';

/**
 * `/env-vars` — alteroid 自身の運用設定・マネージャーへ降ろす環境変数（旧
 * 「マネージャーへ降ろす環境変数」）を CLI と同じ資格で見る・置く・外す画面。
 *
 * **`alteroid credential` / `PUT /credentials` と同じものを読み書きする。**
 * 経路は新しく足していない——既に在る `GET`/`PUT /credentials` を、この画面
 * からも呼べるようにしただけである（`.claude/skills/env-profile/SKILL.md`）。
 *
 * **CLI と同じ資格。** 読み出し（一覧・指紋）は `authenticate` だけで開くが、
 * 置く・外す（`PUT /credentials`）は `requireOperator`——実行環境の持ち主
 * でなければ 403 になる。ボタンは隠さない（`settings.tsx` の
 * `ResetWorkspace` と同じ「なぜ押せないかを消さない」方針）。
 */
export default function EnvVars() {
  return (
    <Page
      title="環境変数"
      description="alteroid 自身の運用設定・マネージャーへ降ろす環境変数。撒く先は共通/clone/manager から選べる"
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
      return { label: 'clone', tone: 'neutral' };
    case 'runner':
      return { label: 'manager', tone: 'neutral' };
    default:
      // **送られてくる値である**（デーモンが `GET /credentials` で載せる）。
      // `apps/web` は Vercel、デーモンは Railway で別に配られるので、
      // サーバのほうが新しい窓が必ず在る——投げずに「未知」とそのまま出す
      // （`tokens.tsx` の `describeUnknown` と同じ判断）。
      return { label: `未知の撒く先（${String(scope)}）`, tone: 'neutral' };
  }
}

function EnvVarList() {
  const { data, error, isLoading } = useCredentials();
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

  return (
    <Card>
      <CardHeader
        title="一覧"
        subtitle="alteroid credential list / GET /credentials と同じもの"
        action={<Badge>{credentials.length}</Badge>}
      />
      <ErrorNote error={error} className="m-4" />
      <ErrorNote error={removeFailure} className="m-4" />
      {isLoading ? (
        <Spinner />
      ) : credentials.length === 0 ? (
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

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all">{entry.name}</span>
        <Badge tone={scope.tone}>{scope.label}</Badge>
        <Badge tone={entry.secret ? 'warn' : 'neutral'}>
          {entry.secret ? 'シークレット' : '非シークレット'}
        </Badge>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[6rem_1fr]">
        <dt className="text-muted">値</dt>
        <dd className="font-mono break-all">
          {entry.secret
            ? `（シークレット。値は表示されない。指紋 sha256=${entry.sha256}）`
            : (entry.value ?? '（サーバがまだ値を返していない版）')}
        </dd>

        <dt className="mt-2 text-muted sm:mt-0">更新</dt>
        <dd>{formatDateTime(entry.updatedAt)}</dd>
      </dl>

      {entry.shadowsCloneEnv === true && (
        <p className="mt-2 text-[11px] break-words text-warn">
          ⚠ GitHub の名前で、デーモン（クローン）の器の環境変数の値が優先して配られている
          （正本のこの行はどこにも配られていない）。
        </p>
      )}

      <div className="mt-2">
        <Button variant="danger" size="sm" loading={busy} onClick={onRemove}>
          外す
        </Button>
      </div>
    </li>
  );
}

const SCOPE_OPTIONS: { value: EnvVarScope; label: string }[] = [
  { value: 'all', label: '共通（clone・manager 両方。既定）' },
  { value: 'app', label: 'clone だけ' },
  { value: 'runner', label: 'manager だけ' },
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
        title="置く"
        subtitle="alteroid credential set / PUT /credentials と同じもの。シークレット可否は作成時に決まり、後から変更できない"
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">名前（英大文字・数字・_ のみ）</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value.toUpperCase())}
            placeholder="TZ"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">値</span>
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">撒く先</span>
          <Select value={scope} onChange={(event) => setScope(event.target.value as EnvVarScope)}>
            {SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={secret}
            onChange={(event) => setSecret(event.target.checked)}
          />
          シークレット扱いにする（値を
          API/CLI/この画面に表示しない。新規行にのみ効き、後から変更できない）
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
