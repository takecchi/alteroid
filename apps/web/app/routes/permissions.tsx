import { SettingsTabs } from '~/components/group-tabs';
import { settingsDocumentTitle } from '~/lib/nav';
import { useAction } from '~/lib/use-action';
import { onEscape, useFocusAfter } from '~/lib/use-focus-after';
import {
  describePermissionRuleBreadth,
  describePermissionRuleBreadthText,
} from '@alteroid/core/permission-rule';
import {
  assessPermissionGrantStaleness,
  PERMISSION_GRANT_STALE_DAYS,
} from '@alteroid/core/permission-staleness';
import { useRef, useState } from 'react';

import {
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  KeyValueList,
  Spinner,
} from '@alteroid/ui';
import {
  useRemoveUnreadablePermissionGrants,
  useRevokePermissionGrant,
  usePermissionGrants,
} from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';
import type { PermissionGrant } from '@alteroid/logic';

import { UnreadableRowsNote } from '~/components/unreadable-rows-note';

// 付与（grant）をここに置かない: 許可はクローンの request_permission フローでしか作れないため
export default function Permissions() {
  const [showAll, setShowAll] = useState(false);
  const { data, error, isLoading } = usePermissionGrants();

  const removeUnreadable = useRemoveUnreadablePermissionGrants();
  const grants = data?.grants ?? [];
  const active = grants.filter((grant) => grant.revokedAt === undefined);
  const revoked = grants.length - active.length;
  const shown = showAll ? grants : active;

  return (
    <Page
      tabs={<SettingsTabs />}
      documentTitle={settingsDocumentTitle('/permissions')}
      title="許可（Bash）"
      description="人間が「許可します」と答えた、コマンド実行（Bash）の許可の一覧。取り消しもここでできる"
      action={
        <Button size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? '有効なものだけ' : '取り消し済みも見る'}
        </Button>
      }
    >
      <Card>
        <CardHeader
          title="許可"
          subtitle="いま効いている許可と、取り消し済みの許可"
          action={data === undefined ? undefined : <Badge>{shown.length}</Badge>}
        />
        <ErrorNote error={error} className="m-4" />
        {data?.rowsUnreadable !== undefined && (
          <UnreadableRowsNote
            noun="許可"
            unreadable={data.rowsUnreadable}
            removeUnreadable={removeUnreadable}
            hand="permission-grants.json"
          />
        )}
        {isLoading ? (
          <Spinner />
        ) : data === undefined ? null : (
          <PermissionsBody
            grants={shown}
            showAll={showAll}
            revokedCount={revoked}
            hasUnreadable={data.rowsUnreadable !== undefined}
            now={new Date()}
          />
        )}
      </Card>
    </Page>
  );
}

function PermissionsBody({
  grants,
  showAll,
  revokedCount,
  hasUnreadable,
  now,
}: {
  grants: readonly PermissionGrant[];
  showAll: boolean;
  revokedCount: number;
  hasUnreadable: boolean;
  now: Date;
}) {
  if (grants.length === 0) {
    if (hasUnreadable) {
      // 「許可は無い」と言わない: 読めない行が在り、取り消し済みが在っても有効な許可の可能性を否定できないため
      return (
        <Empty>
          {revokedCount > 0
            ? '読めた有効な許可は無い（有効な許可が無い、とは言えない。「取り消し済みも見る」を押すと取り消し済みも含めて見られます）。'
            : '読めた許可は無い（許可が無い、とは言えない）。'}
        </Empty>
      );
    }
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
        <PermissionRow key={grant.id} grant={grant} now={now} />
      ))}
    </ul>
  );
}

function PermissionRow({ grant, now }: { grant: PermissionGrant; now: Date }) {
  const staleness = assessPermissionGrantStaleness(grant, now);
  const revokedAt = grant.revokedAt;
  const revoked = revokedAt !== undefined;
  const breadth = describeBreadth(grant.rule);
  // 描く所だけ伏せる: rule と answer は人間かクローンが書いた文で、鍵を貼ってしまうことがあり、CLI の permission list も伏せて出すため
  const shownRule = redactBody(grant.rule);

  // 取り消しが通ると取り消しのボタンが行から無くなって焦点が body に落ちるので、行そのものへ移す（取り消しの前後で行は同じ要素のまま）
  const rowRef = useRef<HTMLLIElement>(null);
  const focusRowAfter = useFocusAfter(rowRef, revoked);

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="border-b border-border px-4 py-3 outline-none last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all">{shownRule}</span>
        <Badge tone={revoked ? 'neutral' : 'ok'}>{revoked ? '取り消し済み' : '有効'}</Badge>
        <Badge tone={breadth.tone}>{breadth.label}</Badge>
        {staleness.stale && (
          <Badge tone="warn">
            {staleness.idleDays} 日使われていない（起点:{' '}
            {staleness.basis === 'lastUsedAt' ? '最終使用' : '付与'}・{PERMISSION_GRANT_STALE_DAYS}{' '}
            日以上）
          </Badge>
        )}
      </div>

      <KeyValueList
        className="mt-2"
        labelWidth="9rem"
        items={[
          { label: 'id', value: grant.id, mono: true },
          {
            label: '承認',
            value: `${formatDateTime(grant.grantedAt)}（${grant.route.accountId}・"${redactBody(grant.answer)}"）`,
          },
          {
            label: '最終使用',
            value:
              grant.lastUsedAt === undefined
                ? '（まだ使われていません）'
                : formatDateTime(grant.lastUsedAt),
          },
          ...(revokedAt !== undefined
            ? [{ label: '取り消し', value: formatDateTime(revokedAt) }]
            : []),
        ]}
      />

      {!revoked && <RevokeControl grant={grant} revoke={(revoke) => focusRowAfter('', revoke)} />}
    </li>
  );
}

// 押しても最初は叩かず確認を挟む: 取り消しはその場で戻せないため
function RevokeControl({
  grant,
  revoke,
}: {
  grant: PermissionGrant;
  revoke: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const revokePermissionGrant = useRevokePermissionGrant();
  const { busy, failure, run: runAction } = useAction();
  const [confirming, setConfirming] = useState(false);
  // ボタンの名前も伏せる: 読み上げにも rule がそのまま乗るため（PermissionRow と同じ）
  const shownRule = redactBody(grant.rule);

  function run() {
    return runAction(async () => {
      await revoke(() => revokePermissionGrant(grant.id));
      setConfirming(false);
    });
  }

  // 確認の行は「取り消す」を差し替えて出すので、押したボタンごと消えて焦点が body に落ちる。切り替えた先の最初のボタンへ移す:
  // 開いたら「本当に取り消す」へ、やめたら「取り消す」へ
  const controlRef = useRef<HTMLDivElement>(null);
  const focusFirstButtonAfter = useFocusAfter(controlRef, confirming);

  function cancel() {
    void focusFirstButtonAfter('button');
    setConfirming(false);
  }

  return (
    <div
      ref={controlRef}
      className="mt-2 flex flex-col gap-2"
      onKeyDown={confirming && !busy ? onEscape(cancel) : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        {!confirming ? (
          <Button
            variant="danger"
            size="sm"
            aria-label={`${shownRule} を取り消す`}
            onClick={() => {
              void focusFirstButtonAfter('button');
              setConfirming(true);
            }}
          >
            取り消す
          </Button>
        ) : (
          <>
            <span className="text-[11px] text-warn">
              取り消すと、次の Bash
              呼び出しからその場で効く（戻すには、同じ規則をもう一度承認してもらう必要がある）。
            </span>
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              aria-label={`${shownRule} を本当に取り消す`}
              onClick={() => void run()}
            >
              本当に取り消す
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              やめる
            </Button>
          </>
        )}
      </div>
      <ErrorNote error={failure} />
    </div>
  );
}

// 文は core の describePermissionRuleBreadthText で作る（CLI と同じ関数。一字一句そろえるため）。頭の語は伏せ字を通した規則から取る
function describeBreadth(rule: string): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  const label = describePermissionRuleBreadthText(rule, redactBody(rule));
  switch (describePermissionRuleBreadth(rule).level) {
    case 'exact':
    case 'narrow':
      return { label, tone: 'ok' };
    case 'medium':
      return { label, tone: 'warn' };
    case 'broad':
    case 'invalid':
      return { label, tone: 'danger' };
  }
}
