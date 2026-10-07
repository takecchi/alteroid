// 接続先をクエリ文字列・ハッシュのような外から渡せる経路から受け取らない: 人間がここで打った値と選んだ値だけから来るため
import { useState } from 'react';

import { useHealth, useStatus, useApiContext } from '@alteroid/swr';
import {
  hasStoredApiBaseUrl,
  looksLikeUrl,
  normalizeEndpointUrl,
  SAME_ORIGIN_BASE_URL,
  type Endpoint,
  type EndpointOrigin,
} from '@alteroid/logic';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNote,
  Input,
  isImeConfirmEnter,
  KeyValueList,
  Select,
} from '@alteroid/ui';

const ORIGIN_LABEL: Record<EndpointOrigin, string> = {
  stored: 'このブラウザに保存した接続先',
  buildTime: 'このアプリに組み込まれた既定の接続先',
  sameOrigin: 'この画面と同じ場所（既定）',
};

// ORIGIN_LABEL と同じ語にしない: 選んでいる行の真下に同じ文字列が2回出るため
const GROUPS: Array<{ origin: EndpointOrigin; label: string }> = [
  { origin: 'buildTime', label: '既定（このアプリに組み込み）' },
  { origin: 'sameOrigin', label: 'この画面と同じ場所' },
  { origin: 'stored', label: 'このブラウザに保存' },
];

function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.label === undefined ? endpoint.url : `${endpoint.label} — ${endpoint.url}`;
}

export function ConnectionCard({ compact = false }: { compact?: boolean }) {
  const { baseUrl, setBaseUrl, endpoints, saveEndpoint, removeEndpoint } = useApiContext();
  const health = useHealth();
  const status = useStatus();
  const canResetToDefault = hasStoredApiBaseUrl();

  // `?.` で受ける: 保証が壊れたときに画面が落ちず、黙って既定の見え方へ倒れるようにするため
  const selected = endpoints.find((endpoint) => endpoint.url === baseUrl);
  const origin = selected?.origin ?? 'sameOrigin';

  return (
    <Card>
      <CardHeader
        title="接続先"
        subtitle="alteroid のどこへ繋ぐかを、ここで切り替えられる"
        action={
          health.error !== undefined ? (
            <Badge tone="danger">繋がらない</Badge>
          ) : health.data === undefined ? (
            <Badge tone="warn">確認中</Badge>
          ) : (
            <Badge tone="ok">応答あり</Badge>
          )
        }
      />

      <div className="flex flex-col gap-3 px-4 py-3">
        {/* min-w-0 flex-1 の div を外さない: フォームコントロールの既定の最小幅のせいで、ボタンとの取り合いで潰れるため */}
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Select
              aria-label="接続先"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            >
              {GROUPS.map((group) => {
                const rows = endpoints.filter((endpoint) => endpoint.origin === group.origin);
                if (rows.length === 0) return null;
                return (
                  <optgroup key={group.origin} label={group.label}>
                    {rows.map((endpoint) => (
                      <option key={endpoint.url} value={endpoint.url}>
                        {describeEndpoint(endpoint)}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </Select>
          </div>
          <Button
            disabled={!canResetToDefault}
            onClick={() => {
              // 次に効く値を決め打たない: VITE_ALTEROID_API_URL の有無で resolveApiBaseUrl が決めるため
              setBaseUrl(null);
            }}
          >
            既定に戻す
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{ORIGIN_LABEL[origin]}</p>

        {selected !== undefined && selected.origin === 'stored' && (
          <SelectedActions
            endpoint={selected}
            onRename={(label) => saveEndpoint({ url: selected.url, label })}
            onRemove={() => removeEndpoint(selected.url)}
          />
        )}

        <AddEndpoint
          onAdd={(entry) => {
            saveEndpoint(entry);
            setBaseUrl(entry.url);
          }}
        />

        <ErrorNote error={health.error} />

        {health.data !== undefined && (
          <KeyValueList
            labelWidth="6rem"
            items={[
              status.data !== undefined
                ? { label: '記憶', value: status.data.storage, mono: true }
                : {
                    label: '記憶',
                    value:
                      status.error !== undefined
                        ? '取得できません（ログインが要る場合があります）'
                        : '確認中',
                  },
              {
                label: 'pid',
                // break-all を付けない: pid は有界の小さい整数で、このセクションの幅で折り返しが要る長さにならないため
                value: <span className="font-mono text-xs">{health.data.pid}</span>,
              },
            ]}
          />
        )}

        {health.data !== undefined && status.data !== undefined && status.error !== undefined && (
          <p className="text-xs text-warn">
            記憶の置き場を取り直せなかった。上の置き場は前に読めたときのもの。
          </p>
        )}

        {!compact && (
          <div className="rounded-md border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
            <p className="mb-1.5 font-medium text-foreground">別の場所の alteroid に繋ぐとき</p>
            <p className="mb-1.5">
              この画面を開いているブラウザの場所と、繋ぎたい alteroid の場所が違うときは、 alteroid
              側で「この画面の場所から繋いでよい」と設定しておく必要がある （
              <code className="font-mono">ALTEROID_ALLOWED_ORIGINS</code>）。
              許可するのは、設定に書いた場所だけである。
            </p>
            <p className="mb-1.5">
              外から届く場所に置くときは、alteroid 側のログイン（
              <code className="font-mono">ALTEROID_GOOGLE_CLIENT_ID</code>
              ）を有効にするか、手前に別の守り（リバースプロキシ・トンネル）を置くこと。
              この設定が守るのはブラウザからの接続だけで、それ以外の道具からは素通りになる。
            </p>
            <details>
              <summary className="cursor-pointer">開発者向けの詳細</summary>
              <p className="mt-1.5">
                既定の <code className="font-mono">{SAME_ORIGIN_BASE_URL}</code>{' '}
                は同一オリジン向け（開発サーバの proxy と、画面の手前に置いたリバースプロキシが
                これで当たる）。<code className="font-mono">https://api.example.com</code>{' '}
                のように別オリジンを指す場合は、接続先のサーバ側でそのオリジンを明示的に許可する必要がある。
              </p>
              <pre className="mt-1.5 rounded border border-border bg-card p-2 break-all whitespace-pre-wrap">
                ALTEROID_ALLOWED_ORIGINS=https://www.example.com
              </pre>
              <p className="mt-1.5">
                許可は<strong className="text-foreground">列挙したオリジンだけ</strong>
                で、ワイルドカードは受け付けない。資格情報は Cookie ではなくヘッダ（
                <code className="font-mono">Authorization: Bearer</code>
                ）で運ぶ設計なので、別の登録可能ドメイン（例:{' '}
                <code className="font-mono">*.vercel.app</code>）に画面を置いても成立する。
              </p>
              <p className="mt-1.5">
                <strong className="text-foreground">CORS はブラウザにしか効かない。</strong>
                <code className="font-mono">curl</code> は素通りする。
              </p>
              <p className="mt-1.5">
                一覧の「既定」はビルド時の <code className="font-mono">VITE_ALTEROID_API_URL</code>{' '}
                が決める。カンマ区切りで複数書け、<code className="font-mono">本番=https://…</code>{' '}
                の形で名前を付けられる。<strong className="text-foreground">先頭が既定</strong>
                である。
              </p>
            </details>
          </div>
        )}
      </div>
    </Card>
  );
}

// ビルド時の既定と同一オリジンには出さない: 消してもビルドし直すまで戻ってくるため
function SelectedActions({
  endpoint,
  onRename,
  onRemove,
}: {
  endpoint: Endpoint;
  onRename(label: string): void;
  onRemove(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(endpoint.label ?? '');

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            // 書きかけを残さない: 別の接続先を選んだ後に開いたとき前の名前が出るため
            setDraft(endpoint.label ?? '');
            setEditing(true);
          }}
        >
          名前を変更
        </Button>
        <Button size="sm" onClick={onRemove}>
          一覧から削除
        </Button>
        <span className="text-[11px] text-muted-foreground">
          削除しても接続先のサーバ側には何も起きない（このブラウザの一覧から消えるだけ）
        </span>
      </div>
    );
  }

  const commit = (): void => {
    onRename(draft);
    setEditing(false);
  };

  return (
    <div className="flex gap-2">
      <div className="min-w-0 flex-1">
        <Input
          value={draft}
          aria-label="選択中の接続先の名前"
          placeholder={endpoint.url}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isImeConfirmEnter(event)) return;
            if (event.key === 'Enter') commit();
          }}
        />
      </div>
      <Button variant="primary" onClick={commit}>
        保存
      </Button>
      <Button onClick={() => setEditing(false)}>取消</Button>
    </div>
  );
}

// 届くかどうかは試さない: 先回りして弾くと、まだ起動していないデーモンを登録できなくなるため
function AddEndpoint({ onAdd }: { onAdd(entry: { url: string; label?: string }): void }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = (): void => {
    const normalized = normalizeEndpointUrl(url);
    if (normalized === undefined) {
      setProblem('接続先の URL を入れてほしい');
      return;
    }
    if (!looksLikeUrl(normalized)) {
      setProblem(
        `"${normalized}" は接続先として使えない。https:// か http:// で始まる URL か、同一オリジンなら / で始まる経路を入れてほしい`,
      );
      return;
    }
    const trimmed = label.trim();
    onAdd(trimmed === '' ? { url: normalized } : { url: normalized, label: trimmed });
    setUrl('');
    setLabel('');
    setProblem(undefined);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
      <p className="text-xs font-medium text-foreground">接続先を追加</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={label}
          aria-label="追加する接続先の名前（任意）"
          placeholder="名前（任意）"
          spellCheck={false}
          className="sm:w-32 sm:shrink-0"
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            // 変換の確定の Enter で足さない: 名前は日本語で打つ欄のため
            if (isImeConfirmEnter(event)) return;
            if (event.key === 'Enter') submit();
          }}
        />
        <div className="min-w-0 sm:flex-1">
          <Input
            value={url}
            aria-label="追加する接続先の URL"
            placeholder="https://api.example.com"
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (isImeConfirmEnter(event)) return;
              if (event.key === 'Enter') submit();
            }}
          />
        </div>
        <Button variant="primary" className="sm:shrink-0" onClick={submit}>
          追加して接続
        </Button>
      </div>
      {problem !== undefined && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}
