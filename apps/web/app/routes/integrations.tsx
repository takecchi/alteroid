import { exampleBaseUrl } from '~/lib/integration-example';
import { SettingsTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { settingsDocumentTitle } from '~/lib/nav';
import { useNowMs } from '~/lib/use-now';
import { useState } from 'react';
import { Link } from 'react-router';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  Empty,
  ErrorNote,
  FieldHint,
  Input,
  KeyValueList,
  Spinner,
} from '@alteroid/ui';
import {
  useApiContext,
  useIntegrationKeys,
  useIssueIntegrationKey,
  useRevokeIntegrationKey,
} from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type {
  IntegrationKeyInput,
  IntegrationKeyIssued,
  IntegrationKeyView,
} from '@alteroid/logic';

/**
 * `/integrations` — 連携の鍵（外のサービスへ渡す、固定の1つの `source` で外部イベントを送る鍵。
 * #3113 段2）の一覧・発行・失効。`alteroid integration list|create|revoke` と同じ3本の口
 * （`GET`・`POST /integration-keys`、`POST /integration-keys/:id/revoke`）を打つ。経路は足していない。
 *
 * 特定のサービスの名前・分岐は持たない（`source` は人間が決める文字列）。
 *
 * ## 守っている線
 *
 * - **値は1回だけ見せ、どこにも保存しない。** 発行の応答の `value` はこのコンポーネントの state にだけ
 *   置く（localStorage・SWR のキャッシュ・URL へは入れない）。画面を離れる（unmount）か「閉じる」で消える。
 *   デーモンも sha256 しか持たないので、消えたら取り出せない（作り直す）
 * - **使い手の入力を黙って失わせない。** 発行が失敗しても書きかけのフォームは残し、失敗を出す。
 *   入力の誤りは送る前に欄の下で言う（何も作らない）
 * - **一覧の再取得の失敗で画面を置き換えない。** SWR は失敗しても `data` を残すので、一覧は古いまま出し、
 *   失敗は一覧の上の帯（`LoadError`）で言う。初回の失敗でも発行の欄は出す（発行は一覧に依らない）。
 *   一覧の取り直しの失敗は、発行・失効の失敗にしない（`useIssueIntegrationKey` の doc）
 * - **失効は確認つき。** 即座に効き、元に戻せない（外のサービスは 401 になる）
 */

const SOURCE_PATTERN = /^[a-z0-9._-]{1,64}$/;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_PER_MINUTE = 60;
const MAX_INT = 2_147_483_647;
/** 名前の上限（CLI の `integration create` と同じ。デーモンの上限でもある）。 */
const NAME_MAX_LENGTH = 200;

type KeyStatus = 'active' | 'revoked' | 'expired';

/** 失効が先、次に期限切れ。判定できない期限は「使えない」側へ倒す（デーモンの `isIntegrationKeyUsable` と同じ向き）。 */
function statusOf(key: IntegrationKeyView, now: number): KeyStatus {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt === null) return 'active';
  return Date.parse(key.expiresAt) > now ? 'active' : 'expired';
}

const STATUS_VIEW: Record<KeyStatus, { label: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  active: { label: '有効', tone: 'ok' },
  revoked: { label: '失効', tone: 'neutral' },
  expired: { label: '期限切れ', tone: 'warn' },
};

export default function Integrations() {
  const { data, error, isLoading, isValidating, mutate } = useIntegrationKeys();
  // 値は state にだけ置く（新しいものが上。発行のたびに前の値を消さない——まだ控えていないかもしれない）。
  const [issued, setIssued] = useState<IntegrationKeyIssued[]>([]);
  // 期限切れの判定に使う（刻んで、期限が過ぎたら画面を開いたままでも「期限切れ」へ変える）。
  const now = useNowMs(30_000);

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/integrations')}
      title="連携"
      description="外のサービスが alteroid へ外部イベントを送るための鍵。鍵ごとに送れる source を1つに固定し、期限と上限を付けられる"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-relaxed break-words text-muted-foreground">
          alteroid から相手の MCP サーバを呼びたいときは、鍵ではなく{' '}
          <Link to="/mcp-servers" className="underline underline-offset-2">
            MCP サーバの登録
          </Link>
          へ。
        </p>

        <IssueForm onIssued={(result) => setIssued((current) => [result, ...current])} />

        {issued.map((result) => (
          <IssuedValue
            key={result.key.id}
            issued={result}
            onClose={() =>
              setIssued((current) => current.filter((row) => row.key.id !== result.key.id))
            }
          />
        ))}

        <Card>
          <CardHeader
            title="発行した鍵"
            subtitle="失効・期限切れを含む。値は残っていない（指紋は見分けるためだけの先頭12桁）"
            action={data === undefined ? undefined : <Badge>{data.keys.length}</Badge>}
          />
          <div className="flex flex-col gap-3 px-4 py-3">
            {/* 再取得の失敗でも data は残る。帯で言うだけで、下の一覧は消さない。 */}
            <LoadError
              what="連携の鍵の一覧"
              error={error}
              onRetry={() => mutate()}
              retrying={isValidating}
            />
          </div>
          {isLoading ? (
            <Spinner />
          ) : data === undefined ? null : data.keys.length === 0 ? (
            <Empty>連携の鍵はまだ無い。</Empty>
          ) : (
            <ul>
              {data.keys.map((key) => (
                <KeyRow key={key.id} view={key} now={now} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}

/** 発行の欄。**失敗しても入力は消さない。** 成功したときだけ空に戻す。 */
function IssueForm({ onIssued }: { onIssued: (issued: IntegrationKeyIssued) => void }) {
  const issueKey = useIssueIntegrationKey();
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [expires, setExpires] = useState('');
  const [maxBodyBytes, setMaxBodyBytes] = useState('');
  const [ratePerMinute, setRatePerMinute] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [problems, setProblems] = useState<string[]>([]);

  // CLI（`integration create`）と同じ上限・同じ数え方（trim 後の `.length`）。黙って切らない。
  const nameTooLong = name.trim().length > NAME_MAX_LENGTH;

  async function submit() {
    if (nameTooLong) return; // 送らない。入力もそのまま残す（言うのは欄の下）。
    const checked = buildInput({ name, source, expires, maxBodyBytes, ratePerMinute });
    if (!checked.ok) {
      // 送らない。入力もそのまま残す。
      setProblems(checked.problems);
      setFailure(undefined);
      return;
    }
    setProblems([]);
    setFailure(undefined);
    setBusy(true);
    try {
      const result = await issueKey(checked.input);
      onIssued(result);
      setName('');
      setSource('');
      setExpires('');
      setMaxBodyBytes('');
      setRatePerMinute('');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="鍵を発行する"
        subtitle="発行した鍵で送れるのは、ここで決めた source のイベントだけ"
      />
      <form
        className="flex flex-col gap-3 px-4 py-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">名前（見分けるための呼び名）</span>
          <Input
            value={name}
            aria-invalid={nameTooLong || undefined}
            aria-describedby={nameTooLong ? 'integration-name-too-long' : undefined}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {nameTooLong && (
          <p
            id="integration-name-too-long"
            role="alert"
            className="-mt-2 text-[11px] break-words text-destructive"
          >
            名前は 1〜{String(NAME_MAX_LENGTH)} 文字で指定してください（いま{' '}
            {String(name.trim().length)} 文字）
          </p>
        )}
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">source</span>
            <Input
              value={source}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="integration-source-hint"
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <FieldHint id="integration-source-hint">
            英小文字・数字・. _ - の 1〜64 文字（^[a-z0-9._-]{'{1,64}'}$）。この鍵は、この source
            のイベントだけを送れる。後から変えられない
          </FieldHint>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">期限（任意。空なら無期限）</span>
          <Input
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </label>
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            上限を変える（任意）
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            <p className="text-[11px] text-muted-foreground">
              空なら既定（本文 1 MiB = {String(DEFAULT_MAX_BODY_BYTES)} バイト・
              {String(DEFAULT_RATE_PER_MINUTE)} 回/分）。この上限は連携の鍵にだけ掛かる。
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">本文の上限（バイト）</span>
              <Input
                inputMode="numeric"
                value={maxBodyBytes}
                placeholder={String(DEFAULT_MAX_BODY_BYTES)}
                onChange={(event) => setMaxBodyBytes(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">1分あたりの回数</span>
              <Input
                inputMode="numeric"
                value={ratePerMinute}
                placeholder={String(DEFAULT_RATE_PER_MINUTE)}
                onChange={(event) => setRatePerMinute(event.target.value)}
              />
            </label>
          </div>
        </details>

        {problems.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-[11px] break-words text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <ErrorNote error={failure} />
        {failure !== undefined && (
          <p className="text-[11px] text-muted-foreground">
            鍵は発行していない。入力はそのまま残してあるので、直して、もう一度押せる。
          </p>
        )}

        <div>
          <Button type="submit" variant="primary" size="sm" loading={busy}>
            発行する
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** 画面の入力を発行の入力にする。誤りは送る前に言う（何も作らない）。 */
function buildInput(fields: {
  name: string;
  source: string;
  expires: string;
  maxBodyBytes: string;
  ratePerMinute: string;
}): { ok: true; input: IntegrationKeyInput } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const name = fields.name.trim();
  if (name.length === 0) problems.push('名前を入れてください');
  if (!SOURCE_PATTERN.test(fields.source)) {
    problems.push('source は英小文字・数字・. _ - の 1〜64 文字で入れてください');
  }
  const input: IntegrationKeyInput = { name, source: fields.source };
  if (fields.expires.trim() !== '') {
    const at = new Date(fields.expires);
    if (Number.isNaN(at.getTime())) problems.push('期限を読めませんでした');
    else if (at.getTime() <= Date.now()) problems.push('期限が過去です');
    else input.expiresAt = at.toISOString();
  }
  const limit = (text: string, label: string): number | undefined => {
    if (text.trim() === '') return undefined;
    const value = Number(text.trim());
    if (!/^\d+$/.test(text.trim()) || value <= 0 || value > MAX_INT) {
      problems.push(`${label}は 1 以上 ${String(MAX_INT)} 以下の整数で入れてください`);
      return undefined;
    }
    return value;
  };
  const body = limit(fields.maxBodyBytes, '本文の上限');
  if (body !== undefined) input.maxBodyBytes = body;
  const rate = limit(fields.ratePerMinute, '1分あたりの回数');
  if (rate !== undefined) input.ratePerMinute = rate;
  return problems.length > 0 ? { ok: false, problems } : { ok: true, input };
}

/**
 * 発行した直後の値。**この画面を離れる・閉じると消え、二度と見られない。**
 * 送り方の例には値を書かない（`<上の値>`。値が画面に2回出ない）。
 */
function IssuedValue({ issued, onClose }: { issued: IntegrationKeyIssued; onClose: () => void }) {
  const { baseUrl } = useApiContext();
  const { key, value } = issued;
  const example =
    `curl -X POST ${exampleBaseUrl(baseUrl, window.location.origin)}/events/${key.source} \\\n` +
    `  -H "Authorization: Bearer <上の値>" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"message":"hello"}'`;
  return (
    <Card>
      <CardHeader
        title={`発行した: ${key.name}`}
        subtitle={`source ${key.source}`}
        action={
          <Button variant="ghost" size="sm" onClick={onClose}>
            値を消して閉じる
          </Button>
        }
      />
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p role="alert" className="text-[11px] break-words text-warn">
          この値は二度と表示されない（alteroid は sha256
          しか保存していない）。いま写して、渡す先の秘密の置き場へ入れる。画面を離れたり閉じたりすると消える。
        </p>
        <CodeBlock label="連携の鍵の値">{value}</CodeBlock>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            送り方の例（本文の JSON がそのまま payload になる）
          </span>
          <CodeBlock label="curl">{example}</CodeBlock>
        </div>
      </div>
    </Card>
  );
}

/** 一覧の1行。失効は2段（押す → 本当に失効する）。 */
function KeyRow({ view, now }: { view: IntegrationKeyView; now: number }) {
  const revokeKey = useRevokeIntegrationKey();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const status = statusOf(view, now);
  const shown = STATUS_VIEW[status];

  async function revoke() {
    setBusy(true);
    setFailure(undefined);
    try {
      await revokeKey(view.id);
      setConfirming(false);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{view.name}</span>
        <Badge tone={shown.tone}>{shown.label}</Badge>
      </div>
      <KeyValueList
        className="mt-2"
        labelWidth="9rem"
        items={[
          { label: 'source', value: view.source, mono: true },
          {
            label: '作成',
            value: `${formatDateTime(view.createdAt)}（${view.createdBy}）`,
          },
          {
            label: '最終使用',
            value:
              view.lastUsedAt === null ? '（まだ使われていない）' : formatDateTime(view.lastUsedAt),
          },
          {
            label: '期限',
            value: view.expiresAt === null ? '（無期限）' : formatDateTime(view.expiresAt),
          },
          ...(view.revokedAt === null
            ? []
            : [{ label: '失効', value: formatDateTime(view.revokedAt) }]),
          { label: '指紋', value: view.fingerprint, mono: true },
          {
            label: '上限',
            value: `本文 ${String(view.limits.maxBodyBytes)} バイト・${String(view.limits.ratePerMinute)} 回/分`,
          },
        ]}
      />
      {view.revokedAt === null && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {!confirming ? (
              <Button
                variant="danger"
                size="sm"
                aria-label={`${view.name} を失効する`}
                onClick={() => setConfirming(true)}
              >
                失効する
              </Button>
            ) : (
              <>
                <span className="text-[11px] text-warn">
                  失効するとすぐ効き、この鍵で送っている外のサービスは 401
                  になる。元には戻せない（必要なら新しく発行する）。
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy}
                  aria-label={`${view.name} を本当に失効する`}
                  onClick={() => void revoke()}
                >
                  本当に失効する
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  やめる
                </Button>
              </>
            )}
          </div>
          <ErrorNote error={failure} />
        </div>
      )}
    </li>
  );
}
