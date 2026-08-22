/**
 * 接続先を決める部品。
 *
 * **設定画面の外でも使う。** 繋がらないときに出す画面にもこれを置く — 接続先が
 * 間違っていると設定画面そのものへ到達できないからである（設定画面は「通ってから
 * 出す」側にいる）。直す手段を、詰まっている場所と同じところに置く。
 */
import { useState } from 'react';

import { useHealth } from '~/hooks/queries';
import { useApiContext } from '~/lib/api';
import { SAME_ORIGIN_BASE_URL } from '~/lib/config';

import { Badge, Button, Card, CardHeader, ErrorNote, Input } from './ui';

export function ConnectionCard({ compact = false }: { compact?: boolean }) {
  const { baseUrl, setBaseUrl } = useApiContext();
  const health = useHealth();
  const [draft, setDraft] = useState(baseUrl);

  const normalized = draft.trim().replace(/\/+$/, '');
  const dirty = normalized !== baseUrl;

  return (
    <Card>
      <CardHeader
        title="接続先"
        subtitle="ビルドし直さずに向き先を変えられる（同じ成果物をどの配置でも使うため）"
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
        <div className="flex gap-2">
          <Input
            value={draft}
            spellCheck={false}
            aria-label="接続先"
            placeholder={SAME_ORIGIN_BASE_URL}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && dirty) setBaseUrl(draft);
            }}
          />
          <Button variant="primary" disabled={!dirty} onClick={() => setBaseUrl(draft)}>
            適用
          </Button>
          <Button
            onClick={() => {
              setBaseUrl(null);
              setDraft(SAME_ORIGIN_BASE_URL);
            }}
          >
            既定に戻す
          </Button>
        </div>

        <ErrorNote error={health.error} />

        {health.data !== undefined && (
          <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
            <dt className="text-muted">記憶</dt>
            <dd className="font-mono text-xs break-all">{health.data.storage}</dd>
            <dt className="text-muted">pid</dt>
            {/* pid は `z.number().int()`（apps/daemon/src/openapi.ts）＝ process.pid。
                有界の小さい整数（Linux の pid_max は既定で7桁までしか無い）なので、
                このセクションの幅で折り返しが要る長さにはならない。break-all は
                意図して付けていない。 */}
            <dd className="font-mono text-xs">{health.data.pid}</dd>
          </dl>
        )}

        {/*
          ここは「ドメインが違うときどうするか」の答えを画面の中に置いている。
          設定を触るのは大抵それで詰まったときなので、別の文書へ飛ばさない。
        */}
        {!compact && (
          <div className="rounded-md border border-border bg-bg p-3 text-xs leading-relaxed text-muted">
            <p className="mb-1.5 font-medium text-fg">別のオリジンのデーモンに繋ぐとき</p>
            <p className="mb-1.5">
              既定の <code className="font-mono">{SAME_ORIGIN_BASE_URL}</code>{' '}
              は同一オリジン向け（開発サーバの proxy と、画面の手前に置いたリバースプロキシが
              これで当たる）。<code className="font-mono">https://api.example.com</code>{' '}
              のように別オリジンを指す場合は、デーモン側でそのオリジンを明示的に許可する必要がある。
            </p>
            <pre className="rounded border border-border bg-surface p-2">
              ALTEROID_ALLOWED_ORIGINS=https://www.example.com
            </pre>
            <p className="mt-1.5">
              許可は<strong className="text-fg">列挙したオリジンだけ</strong>で、ワイルドカードは
              受け付けない。資格情報は Cookie ではなくヘッダ（
              <code className="font-mono">Authorization: Bearer</code>）で運ぶ設計なので、
              別の登録可能ドメイン（例: <code className="font-mono">*.vercel.app</code>）に画面を
              置いても成立する。
            </p>
            <p className="mt-1.5">
              <strong className="text-fg">CORS はブラウザにしか効かない。</strong>
              <code className="font-mono">curl</code>{' '}
              は素通りするので、外から届く場所に置くならデーモン側のログイン（
              <code className="font-mono">ALTEROID_GOOGLE_CLIENT_ID</code>）を有効にするか、
              手前に境界（リバースプロキシ・トンネル）を置くこと。
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
