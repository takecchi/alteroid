import { useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useDeclareOwner, useRevokeOwnerDeclaration } from '~/hooks/mutations';
import { useAccess } from '~/hooks/queries';
import { ApiError } from '~/lib/api';
import { formatDateTime } from '~/lib/format';
import type { AccessAccount } from '~/lib/types';

/**
 * `/access` — ログインしたアカウントと許可の一覧（`GET /access` / CLI の
 * `alteroid access list` と同じもの）。
 *
 * **`grant` / `revoke`（許可の付与・取り消し）はこの画面からは呼ばない**
 * （Issue #213）。理由は下の「なぜ grant / revoke だけ読み取りのままなのか」。
 *
 * **実行環境の持ち主としての宣言（issue #1198）だけは、ここにボタンを置く。**
 * `POST /access/:id/owner` / `.../owner/revoke` は `requireOperator`——
 * ブラウザは構造的に operator になれない（サーバ上のファイルを読めることが
 * 資格であって、提示できる秘密ではない）ので、**このボタンは Web UI から
 * 押すと必ず 403 になる。** それでも置くのは `env-vars.tsx` `settings.tsx` と
 * 同じ「ボタンは隠さない」方針——押せない理由を消さず、失敗したときに
 * **端末で打つコマンド（`alteroid access owner <id>`）をアカウント id 入りで
 * 案内する。** サーバの規則（誰が宣言できるか）はここへ写さない
 * （`grep -Fn -- 'サーバの規則（誰が直せるか）をここへ写さないこと' apps/web/app/hooks/mutations.ts`）
 * ——先回りしてボタンを隠したり無効化したりせず、返ってきた失敗をそのまま
 * 見せるだけにする。
 *
 * ## なぜ grant / revoke だけ読み取りのままなのか
 *
 * `docs/PRD.md`「要件: インターフェース」の入口の等価性は、見えるもの・起こせる
 * ことの列挙に「許可の付与」を含んでいない（`grep -Fn -- '入口の等価性' docs/PRD.md`）。
 * ⟹ 一覧を出さないことをそのまま**欠落**と読める根拠は列挙からは出ない。それでも
 * 一覧だけをここに足すのは、`AGENTS.md`「実装の前提」が列挙を持たずに定めている
 * 「片方でしかできないことを作らない」を、**取り返しのつく側**（表示を足すだけ）
 * から最小に埋めるためである。
 *
 * **`grant` / `revoke`（書き込み）は出さない。** 取り消し（`revoke`）は、押した
 * 後にその場で元に戻せる操作ではない——許可を戻すには、まだ許可を持つ別の
 * アカウントか実行環境の持ち主が、もう一度 `grant` を実行する必要がある。表示を
 * 足すだけの変更とは取り返しのつき方が違うので、この画面の範囲には含めない。
 *
 * **実行環境の持ち主としての宣言（このページのボタン）は、これと事情が違う。**
 * 宣言・取り消しのどちらも常に `requireOperator` の壁の内側でしか実行できない
 * ——ブラウザから叩けば必ず 403 なので、「取り消したら戻せない」という重さの
 * 話が Web UI 上では発生しない（そもそも成功しない）。だから grant / revoke とは
 * 別に、ボタンを置いてよい。
 *
 * ## この変更のあとも CLI / HTTP にしかできないこと
 *
 * - **許可の付与**（`alteroid access grant <id>` / `POST /access/:id/grant`）
 * - **許可の取り消し**（`alteroid access revoke <id>` / `POST /access/:id/revoke`）
 * - **実行環境の持ち主としての宣言・取り消しの実行そのもの**（ボタンはここに
 *   在るが、Web UI から押しても成立しない——実際に叩けるのは端末だけである）
 *
 * これらは `apps/cli/src/access.ts` と `apps/daemon/src/app.ts` に在るが、Web UI
 * には無い（または、有っても Web UI からは通らない）。**このことを「解消した」と
 * 読まないこと**。
 */
export default function Access() {
  const { data, error, isLoading } = useAccess();

  return (
    <Page
      title="アクセス許可"
      description="alteroid を使う許可の一覧。許可の付与・取り消しは alteroid access grant/revoke、または POST /access/:id/grant|revoke で行う。実行環境の持ち主としての宣言はここから起こせる（実際に通るのは端末だけ）"
    >
      <Card>
        <CardHeader
          title="アカウント"
          subtitle="alteroid access list / GET /access と同じもの"
          action={data === undefined ? undefined : <Badge>{data.accounts.length}</Badge>}
        />
        <ErrorNote error={error} className="m-4" />
        {isLoading ? (
          <Spinner />
        ) : data === undefined ? null : (
          <AccessBody accounts={data.accounts} />
        )}
      </Card>
    </Page>
  );
}

function AccessBody({ accounts }: { accounts: readonly AccessAccount[] }) {
  if (accounts.length === 0) {
    // CLI（`accessListCommand`）と同じ文言。まだ誰もログインしていない既定の
    // 構成でもありうる——「まだ取れていない」との混同を避けるため断る。
    return <Empty>まだ誰もログインしていません。</Empty>;
  }
  return (
    <ul>
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} />
      ))}
    </ul>
  );
}

function AccountRow({ account }: { account: AccessAccount }) {
  const name = account.email ?? account.displayName ?? '(名前なし)';
  const via = account.identities
    .map((identity) =>
      identity.email === null ? identity.provider : `${identity.provider} (${identity.email})`,
    )
    .join(', ');

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-all">{name}</span>
        <Badge tone={account.granted ? 'ok' : 'neutral'}>
          {account.granted ? '許可' : '未許可'}
        </Badge>
        {/* 宣言済みかどうかの印（issue #1198）。`granted` とは独立の資格である。 */}
        <Badge tone={account.ownerDeclaredAt !== null ? 'ok' : 'neutral'}>
          {account.ownerDeclaredAt !== null ? 'owner 宣言済み' : 'owner 未宣言'}
        </Badge>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">id</dt>
        <dd className="font-mono break-all">{account.id}</dd>

        <dt className="mt-2 text-muted sm:mt-0">作成</dt>
        <dd>{formatDateTime(account.createdAt)}</dd>

        {via.length > 0 && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">ログイン手段</dt>
            <dd className="break-all">{via}</dd>
          </>
        )}

        <dt className="mt-2 text-muted sm:mt-0">最終ログイン</dt>
        <dd>
          {account.lastLoginAt === null ? '（まだ無い）' : formatDateTime(account.lastLoginAt)}
        </dd>

        <dt className="mt-2 text-muted sm:mt-0">許可した日時</dt>
        <dd>
          {account.grantedAt === null
            ? '（未許可）'
            : `${formatDateTime(account.grantedAt)}（${describeGrantedBy(account.grantedBy)}）`}
        </dd>

        <dt className="mt-2 text-muted sm:mt-0">実行環境の持ち主として宣言</dt>
        <dd>
          {account.ownerDeclaredAt === null
            ? '（未宣言）'
            : formatDateTime(account.ownerDeclaredAt)}
        </dd>
      </dl>

      <OwnerDeclarationControl account={account} />
    </li>
  );
}

/**
 * 実行環境の持ち主としての宣言・取り消しボタン（issue #1198）。
 *
 * **常にボタンを出す。** `account.ownerDeclaredAt` の有無だけで宣言／取り消し
 * を切り替える——`granted` の値で先回りして隠したり無効化したりしない
 * （サーバが 409 で「先に access grant が要る」を返すので、その文言をそのまま
 * `ErrorNote` に出せば足りる）。
 *
 * **失敗したら、そのアカウント id 入りの端末コマンドを添える。** Web UI から
 * 押すと構造的に必ず 403（`requireOperator`）になるので、汎用のエラー表示
 * だけでは「次に何をすればいいか」が消える。ここで作っているのは*案内文*で
 * あって*権限判定*ではない——判定はサーバに任せ、返ってきた失敗（403 かどうか）
 * だけを見て文言を選ぶ。
 */
function OwnerDeclarationControl({ account }: { account: AccessAccount }) {
  const declareOwner = useDeclareOwner();
  const revokeOwnerDeclaration = useRevokeOwnerDeclaration();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const declared = account.ownerDeclaredAt !== null;

  async function run() {
    setBusy(true);
    setFailure(undefined);
    try {
      if (declared) {
        await revokeOwnerDeclaration(account.id);
      } else {
        await declareOwner(account.id);
      }
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        <Button
          variant={declared ? 'danger' : 'primary'}
          size="sm"
          loading={busy}
          onClick={() => void run()}
        >
          {declared ? '実行環境の持ち主としての宣言を取り消す' : '実行環境の持ち主として宣言する'}
        </Button>
      </div>
      <ErrorNote error={failure} />
      {isNotOperator(failure) && (
        <p className="text-[11px] break-words text-muted">
          デーモンが動いている環境（実行環境の持ち主）で、次を実行してください:
          <br />
          <code className="font-mono">
            alteroid access owner {account.id}
            {declared ? ' --revoke' : ''}
          </code>
        </p>
      )}
    </div>
  );
}

/**
 * 失敗が「実行環境の持ち主ではない」（`requireOperator` の 403）かどうかだけを
 * 見る。**それ以外の理由（404 など）では出さない**——判別できない失敗にまで
 * この案内を出すと、当てずっぽうになる（`apps/cli/src/target.ts` の
 * `ForbiddenKind` と同じ考え方）。
 */
function isNotOperator(failure: unknown): boolean {
  return failure instanceof ApiError && failure.status === 403;
}

/**
 * `grantedBy` を人間が読む形にする。
 *
 * **`'operator'` は固定の特別な値**（実行環境の持ち主。`apps/daemon/src/app.ts`
 * の `actorOf` の doc）。それ以外は許可を与えたアカウントの id そのもの
 * （2026-09-06 の同格化以降、許可を持つアカウントも `grant` を叩けるので、id が
 * 入りうる——`.claude/skills/auth-and-access/SKILL.md`「許可が伝播するように
 * なった」）。**id をここで名前へ解決しない**——このアカウントが一覧から既に
 * 消えている（該当する行が無い）ことがありうるため、常に安全に出せる id のまま
 * 見せる。
 */
function describeGrantedBy(grantedBy: string | null): string {
  if (grantedBy === null) return '不明';
  if (grantedBy === 'operator') return '実行環境の持ち主';
  return grantedBy;
}
