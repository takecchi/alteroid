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
import {
  hasStoredApiBaseUrl,
  resolveApiBaseUrl,
  resolveApiBaseUrlOrigin,
  SAME_ORIGIN_BASE_URL,
  type ApiBaseUrlOrigin,
} from '~/lib/config';

import { Badge, Button, Card, CardHeader, ErrorNote, Input } from './ui';

/**
 * 3段のどれから来たかを、人間が読む言葉にする。
 *
 * **「段」「解決」のような開発側の語を画面に出さない。** ここを読むのはオーナー
 * であって実装者ではない。
 */
const ORIGIN_LABEL: Record<ApiBaseUrlOrigin, string> = {
  stored: 'このブラウザに保存した接続先',
  buildTime: 'このアプリに組み込まれた既定の接続先',
  sameOrigin: 'この画面と同じ場所（既定）',
};

export function ConnectionCard({ compact = false }: { compact?: boolean }) {
  const { baseUrl, setBaseUrl } = useApiContext();
  const health = useHealth();
  const [draft, setDraft] = useState(baseUrl);
  const origin = resolveApiBaseUrlOrigin();
  const canResetToDefault = hasStoredApiBaseUrl();

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
        {/*
          **`Input` を `min-w-0 flex-1` で包む**（`chat.tsx` の
          `<div className="min-w-0 flex-1"><Textarea .../></div>` と同じ形。
          #53 由来）。`input` はフォームコントロールの既定の最小幅を持つので、
          この div が無いと本3で `h-11`（44px、md: 以上は既定のまま）になった
          ボタン2つとの取り合いで潰れる（ボタン側は短い日本語ラベルなので
          `flex-shrink` の床が高く、先に犠牲になるのは `input` 側である）。

          **`flex-wrap` は付けていない。** `min-w-0 flex-1` だけで `input` が
          縮む側へ吸収するので、ボタン2つを画面外へ押し出す形の破綻は起きない
          — 折り返すと3つの高さが不揃いな行が2段になり、`chat.tsx` の前例とも
          違う形になる。狭い画面で `input` が窮屈になるのは UX の余地だが、
          「本4」が扱う「はみ出し／横スクロール」ではない。
        */}
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
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
          </div>
          <Button variant="primary" disabled={!dirty} onClick={() => setBaseUrl(draft)}>
            適用
          </Button>
          <Button
            disabled={!canResetToDefault}
            onClick={() => {
              setBaseUrl(null);
              // **`SAME_ORIGIN_BASE_URL` 固定で書かない。** `VITE_ALTEROID_API_URL`
              // が設定されていれば、`storeApiBaseUrl(null)` の後に実際に効く値は
              // そちらである——入力欄だけ `/api` を表示すると、本当の接続先と
              // 食い違う（このカードの外から見えている「繋がった」「繋がらない」
              // は実際の接続先に対する結果なので、入力欄の嘘に気づく手段が無い）。
              // `resolveApiBaseUrl(null)` は「保存済みの値を消した後」の解決を
              // ブラウザ無しで再現できる引数付き版（冒頭の doc）に、その状態を
              // そのまま渡しているだけである。
              setDraft(resolveApiBaseUrl(null));
            }}
          >
            既定に戻す
          </Button>
        </div>

        {/* 3つの出どころを区別する（PR 1 の歯3）。値だけでは「既定に戻った」のか
            「消し損ねた」のかが分からない——`hasStoredApiBaseUrl` の使い道。 */}
        <p className="text-xs text-muted">{ORIGIN_LABEL[origin]}</p>

        <ErrorNote error={health.error} />

        {health.data !== undefined && (
          /*
            **`sm:`（640px）未満は1列に積む。** 理由・`dt` の `mt-3 first:mt-0`
            の意味は `manager-detail.tsx` の同型の `dl` に書いたコメントと同じ
            （ここも6remなのでなお余裕がある）。
          */
          <dl className="grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-[6rem_1fr]">
            <dt className="mt-3 text-muted first:mt-0 sm:mt-0">記憶</dt>
            <dd className="font-mono text-xs break-all">{health.data.storage}</dd>
            <dt className="mt-3 text-muted first:mt-0 sm:mt-0">pid</dt>
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
