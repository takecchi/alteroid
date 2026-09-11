/**
 * 接続先を決める部品。
 *
 * **設定画面の外でも使う。** 繋がらないときに出す画面にもこれを置く — 接続先が
 * 間違っていると設定画面そのものへ到達できないからである（設定画面は「通ってから
 * 出す」側にいる）。直す手段を、詰まっている場所と同じところに置く。
 *
 * ## なぜ「入力欄1つ」ではなく「選ぶ ＋ 足す」なのか
 *
 * 接続先は**複数あるのが普通**である（本番と手元、本番と検証）。入力欄1つだと、
 * 切り替えるたびに URL を打ち直すことになり、**打ち間違いが「繋がらない」として
 * 返ってくる** — しかも間違えた側の値は既に上書きされているので、元へ戻るにも
 * もう一度打ち直すしかない。
 *
 * だから一覧から選ぶ形にし、打つのは**新しい先を足すときだけ**にした。
 * 一覧は3段をそのまま並べる（`lib/config.ts` の `listEndpoints`）。
 *
 * ## ⚠️ 接続先は人間がここで打った値と選んだ値だけから来る
 *
 * クエリ文字列・ハッシュのような外から渡せる経路から受け取らない（理由と歯は
 * `lib/config.ts` の冒頭）。この部品にその種の読み取りを足さないこと。
 */
import { useState } from 'react';

import { useHealth } from '~/hooks/queries';
import { useApiContext } from '~/lib/api';
import {
  hasStoredApiBaseUrl,
  looksLikeUrl,
  normalizeEndpointUrl,
  SAME_ORIGIN_BASE_URL,
  type Endpoint,
  type EndpointOrigin,
} from '~/lib/config';

import { Badge, Button, Card, CardHeader, ErrorNote, Input, Select } from './ui';

/**
 * 3段のどれから来たかを、人間が読む言葉にする。
 *
 * **「段」「解決」のような開発側の語を画面に出さない。** ここを読むのはオーナー
 * であって実装者ではない。
 */
const ORIGIN_LABEL: Record<EndpointOrigin, string> = {
  stored: 'このブラウザに保存した接続先',
  buildTime: 'このアプリに組み込まれた既定の接続先',
  sameOrigin: 'この画面と同じ場所（既定）',
};

/**
 * 一覧の見出し。`ORIGIN_LABEL` とは別に持つ。
 *
 * あちらは「いま選んでいる1つが**どこから来たか**」を1行で言うもので、こちらは
 * 「一覧の**この区画に並んでいるのは何か**」を言うもの。同じ語にすると、選んで
 * いる行の真下に同じ文字列が2回出る。
 */
const GROUPS: Array<{ origin: EndpointOrigin; label: string }> = [
  { origin: 'buildTime', label: '既定（このアプリに組み込み）' },
  { origin: 'sameOrigin', label: 'この画面と同じ場所' },
  { origin: 'stored', label: 'このブラウザに保存' },
];

/** 一覧に出す1行の見え方。**名前を付けていても URL を隠さない**（繋ぐ先は URL である）。 */
function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.label === undefined ? endpoint.url : `${endpoint.label} — ${endpoint.url}`;
}

export function ConnectionCard({ compact = false }: { compact?: boolean }) {
  const { baseUrl, setBaseUrl, endpoints, saveEndpoint, removeEndpoint } = useApiContext();
  const health = useHealth();
  const canResetToDefault = hasStoredApiBaseUrl();

  // **必ず見つかる。** `listEndpoints` が「選んでいる先は一覧に必ず入れる」ことを
  // 保証している（`lib/config.ts`）。それでも `?` で受けるのは、保証が壊れたときに
  // 画面が落ちるのではなく黙って既定の見え方へ倒れるようにするため。
  const selected = endpoints.find((endpoint) => endpoint.url === baseUrl);
  const origin = selected?.origin ?? 'sameOrigin';

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
          **`Select` を `min-w-0 flex-1` で包む**（`chat.tsx` の
          `<div className="min-w-0 flex-1"><Textarea .../></div>` と同じ形。
          #53 由来）。フォームコントロールは既定の最小幅を持つので、この div が
          無いと本3で `h-11`（44px、md: 以上は既定のまま）になったボタンとの
          取り合いで潰れる（ボタン側は短い日本語ラベルなので `flex-shrink` の床が
          高く、先に犠牲になるのはコントロール側である）。

          **`flex-wrap` は付けていない。** `min-w-0 flex-1` だけで縮む側へ吸収
          するので、ボタンを画面外へ押し出す形の破綻は起きない。
        */}
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
              // 選択を消すだけ。**次に効く値はここで決め打たない** —
              // `VITE_ALTEROID_API_URL` が在ればそちらへ、無ければ同一オリジンへ
              // 落ちる。どちらになるかは `resolveApiBaseUrl` が決める
              // （`setBaseUrl(null)` がその結果を session に載せ直す）。
              setBaseUrl(null);
            }}
          >
            既定に戻す
          </Button>
        </div>

        {/* 3つの出どころを区別する（PR 1 の歯3）。値だけでは「既定に戻った」のか
            「消し損ねた」のかが分からない。 */}
        <p className="text-xs text-muted">{ORIGIN_LABEL[origin]}</p>

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
            // 足したら、そのまま繋ぎに行く。足しただけで切り替わらないと、
            // 人間は「足せていない」と読む。
            setBaseUrl(entry.url);
          }}
        />

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

        {!compact && (
          <p className="text-[11px] leading-relaxed text-muted">
            一覧の「既定」はビルド時の <code className="font-mono">VITE_ALTEROID_API_URL</code>{' '}
            が決める。カンマ区切りで複数書け、<code className="font-mono">本番=https://…</code>{' '}
            の形で名前を付けられる。<strong className="text-fg">先頭が既定</strong>である。
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * いま選んでいるのが「このブラウザに保存した接続先」のときだけ出す操作。
 *
 * **ビルド時の既定と同一オリジンには出さない。** 消してもビルドし直すまで戻って
 * くるので、押せる削除は嘘になる（押した瞬間は消え、読み込み直すと戻る）。
 */
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
            // **開くたびに現物から読み直す。** 前に開いたときの書きかけを
            // 残すと、別の接続先を選んだ後に開いたとき前の名前が出る。
            setDraft(endpoint.label ?? '');
            setEditing(true);
          }}
        >
          名前を変更
        </Button>
        <Button size="sm" onClick={onRemove}>
          一覧から削除
        </Button>
        <span className="text-[11px] text-muted">
          削除してもデーモン側には何も起きない（このブラウザの一覧から消えるだけ）
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

/**
 * 一覧に無い接続先を足す。
 *
 * **打った値をそのまま保存しない。** `normalizeEndpointUrl` で末尾のスラッシュを
 * 落とし、`looksLikeUrl` で形を見る。弾くのはこの2つだけで、届くかどうかは試さない
 * — 届かないことは「繋がらない」として上のバッジが言う（ここで先回りして弾くと、
 * まだ起動していないデーモンを登録できなくなる）。
 */
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
      <p className="text-xs font-medium text-fg">接続先を追加</p>
      {/*
        **狭い画面では積む。** 3つ（名前・URL・ボタン）を1行に詰めると、375px では
        どれも読めない幅になる。`sm:` 以上で横に並べ、URL の欄だけが伸びる。
      */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={label}
          aria-label="追加する接続先の名前（任意）"
          placeholder="名前（任意）"
          spellCheck={false}
          className="sm:w-32 sm:shrink-0"
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
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
              if (event.key === 'Enter') submit();
            }}
          />
        </div>
        <Button variant="primary" className="sm:shrink-0" onClick={submit}>
          追加して接続
        </Button>
      </div>
      {problem !== undefined && <p className="text-xs text-danger">{problem}</p>}
    </div>
  );
}
