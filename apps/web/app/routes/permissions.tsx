import { describePermissionRuleBreadth } from '@alteroid/core/permission-rule';
import { useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useRevokePermissionGrant } from '~/hooks/mutations';
import { usePermissionGrants } from '~/hooks/queries';
import { formatDateTime } from '~/lib/format';
import type { PermissionGrant } from '~/lib/types';

/**
 * `/permissions` — 人間が承認した Bash 許可の一覧と取り消し（`GET
 * /permission-grants` / `POST /permission-grants/:id/revoke`。Issue #863
 * 「許可をコードではなくデータにする」）。
 *
 * **入口の等価性を埋める最後の1本**（PRD「インターフェース」——CLI・HTTP
 * API・Web UI の3つで同じことができる）。API（`apps/daemon/src/app.ts`）は
 * PR #1491 で、CLI（`alteroid permission list [--all]` / `revoke <id>`、
 * `apps/cli/src/permission.ts`）は PR #1509 で足されたが、Web UI からの
 * 入口が無かった——#863 が #193 から引き継いだ残項目「CLI / Web UI（入口の
 * 等価性）」の CLI 側は埋まったが、Web UI 側はまだ埋まっていなかった。
 *
 * **表示する内容は CLI（`permissionListCommand` / `renderGrant`）と同じ**
 * ——規則・広さの段階・承認した account・承認日時・最終使用・取り消し状態。
 * 既定は有効な（`revokedAt` の無い）ものだけで、`access.tsx` の
 * `showAnswered` トグルと同じ形で取り消し済みも見られる。
 *
 * **規則の広さの段階の判定は `@alteroid/core/permission-rule` の
 * `describePermissionRuleBreadth` をそのまま使う**（純関数。CLI と同じ実装
 * ——`permission-rule.test.ts` が照合器 `matchPermissionRule` と同じ意味論
 * であることを固定している）。**`@alteroid/core`（バレル）からの値 import
 * ではない**——`permission-rule.ts` はもともと import を1つも持たない
 * 純粋な照合器なので（ファイル冒頭の doc）、`usage-format.ts` /
 * `journal-search.ts` と同じ「ブラウザが読む軽い口」として
 * `packages/core/tsup.config.ts` の entry に足した（このコミットの一部）。
 * `@alteroid/core` バレルから値を import するとサーバ専用のドメイン層ごと
 * ブラウザバンドルへ入る事故（#294 / #306、`commitments.tsx` の doc）が
 * あるため、`eslint.config.js` の `no-restricted-imports` がバレルからの
 * 値 import を禁じている——今回は禁じられた経路を使わず、同じ路線
 * （軽い口を1つ足す）で意味論を共有した。
 *
 * **取り消し（`revoke`）は確認の一手を挟む**（`access.tsx` の
 * `AccessGrantControl` と同じ理由——`revokedAt` を立てるのは戻せない操作で、
 * 戻すには同じ規則をもう一度 `request_permission` で人間に承認してもらう
 * 必要がある）。付与（`grant`）はここには無い——許可はクローンの
 * `request_permission` フローでしか作れない（Issue #863 C 節「クローンが
 * 許可の DB へ直接書けてはいけない」の境界。この画面は記録された後の
 * 一覧・取り消しだけを持つ）。
 */
export default function Permissions() {
  const [showAll, setShowAll] = useState(false);
  const { data, error, isLoading } = usePermissionGrants();

  const grants = data?.grants ?? [];
  const active = grants.filter((grant) => grant.revokedAt === undefined);
  const revoked = grants.length - active.length;
  const shown = showAll ? grants : active;

  return (
    <Page
      title="許可（Bash）"
      description="人間が「許可します」と答えた Bash 許可の一覧。alteroid permission list / GET /permission-grants と同じもの。取り消しもここから行える（alteroid permission revoke と同じ）"
      action={
        <Button size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? '有効なものだけ' : '取り消し済みも見る'}
        </Button>
      }
    >
      <Card>
        <CardHeader
          title="許可"
          subtitle="alteroid permission list / GET /permission-grants と同じもの"
          action={data === undefined ? undefined : <Badge>{shown.length}</Badge>}
        />
        <ErrorNote error={error} className="m-4" />
        {isLoading ? (
          <Spinner />
        ) : data === undefined ? null : (
          <PermissionsBody grants={shown} showAll={showAll} revokedCount={revoked} />
        )}
      </Card>
    </Page>
  );
}

function PermissionsBody({
  grants,
  showAll,
  revokedCount,
}: {
  grants: readonly PermissionGrant[];
  showAll: boolean;
  revokedCount: number;
}) {
  if (grants.length === 0) {
    // CLI（`permissionListCommand`）と同じ文言（「--all」は「取り消し済みも見る」
    // ボタンへ言い換えてある——Web UI にフラグは無い）。
    return (
      <Empty>
        {showAll
          ? '許可はまだ1件もありません。'
          : revokedCount > 0
            ? '有効な許可はありません（「取り消し済みも見る」を押すと取り消し済みも含めて見られます）。'
            : '有効な許可はありません。'}
      </Empty>
    );
  }
  return (
    <ul>
      {grants.map((grant) => (
        <PermissionRow key={grant.id} grant={grant} />
      ))}
    </ul>
  );
}

function PermissionRow({ grant }: { grant: PermissionGrant }) {
  const revokedAt = grant.revokedAt;
  const revoked = revokedAt !== undefined;
  const breadth = describeBreadth(grant.rule);

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all">{grant.rule}</span>
        <Badge tone={revoked ? 'neutral' : 'ok'}>{revoked ? '取り消し済み' : '有効'}</Badge>
        <Badge tone={breadth.tone}>{breadth.label}</Badge>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">id</dt>
        <dd className="font-mono break-all">{grant.id}</dd>

        <dt className="mt-2 text-muted sm:mt-0">承認</dt>
        <dd className="break-all">
          {formatDateTime(grant.grantedAt)}（{grant.route.accountId}・&quot;{grant.answer}&quot;）
        </dd>

        <dt className="mt-2 text-muted sm:mt-0">最終使用</dt>
        <dd>
          {grant.lastUsedAt === undefined
            ? '（まだ使われていません）'
            : formatDateTime(grant.lastUsedAt)}
        </dd>

        {revokedAt !== undefined && (
          <>
            <dt className="mt-2 text-muted sm:mt-0">取り消し</dt>
            <dd>{formatDateTime(revokedAt)}</dd>
          </>
        )}
      </dl>

      {!revoked && <RevokeControl grant={grant} />}
    </li>
  );
}

/**
 * 取り消しボタン（Issue #863）。**押しても最初は叩かない。** 確認の一手
 * （「本当に取り消す」）を挟んでから `POST /permission-grants/:id/revoke`。
 * 取り消しはその場で戻せない（戻すには、同じ規則をもう一度
 * `request_permission` で人間に承認してもらう必要がある）ので、誤クリック
 * 1回で起きないようにする（`access.tsx` の `AccessGrantControl` と同じ形）。
 */
function RevokeControl({ grant }: { grant: PermissionGrant }) {
  const revokePermissionGrant = useRevokePermissionGrant();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function run() {
    setBusy(true);
    setFailure(undefined);
    try {
      await revokePermissionGrant(grant.id);
      setConfirming(false);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!confirming ? (
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            取り消す
          </Button>
        ) : (
          <>
            <span className="text-[11px] text-warn">
              取り消すと、次の Bash
              呼び出しからその場で効く（戻すには、同じ規則をもう一度承認してもらう必要がある）。
            </span>
            <Button variant="danger" size="sm" loading={busy} onClick={() => void run()}>
              本当に取り消す
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              やめる
            </Button>
          </>
        )}
      </div>
      <ErrorNote error={failure} />
    </div>
  );
}

/**
 * 規則の広さを日本語の文言へ（判定は `describePermissionRuleBreadth` に
 * 寄せる）。**文言は CLI（`apps/cli/src/permission.ts` の
 * `describeBreadth`）と一字一句揃えてある**——同じ棚卸しを2つの入口で見る
 * 人が、違う言葉で同じ意味を読まされないようにする。
 */
function describeBreadth(rule: string): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  const breadth = describePermissionRuleBreadth(rule);
  switch (breadth.level) {
    case 'exact':
      return { label: '完全一致（最も狭い。この文字列にしか一致しない）', tone: 'ok' };
    case 'narrow':
      return { label: `前方一致・狭い（固定 ${breadth.prefixWordCount} 語まで一致）`, tone: 'ok' };
    case 'medium':
      return {
        label: `前方一致・中間（固定 ${breadth.prefixWordCount} 語まで一致）`,
        tone: 'warn',
      };
    case 'broad':
      return {
        label: `前方一致・広い（固定 ${breadth.prefixWordCount} 語のみ——この語で始まるコマンドなら何でも通る）`,
        tone: 'danger',
      };
    case 'invalid':
      return { label: '⚠️ 規則が不正（照合されない。壊れている可能性がある）', tone: 'danger' };
  }
}
