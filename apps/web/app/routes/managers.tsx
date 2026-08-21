import { Link } from 'react-router';

import { Page } from '~/components/page';
import { Badge, Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useManagers } from '~/hooks/queries';
import { formatRelative } from '~/lib/format';
import type { ManagerDenial, ManagerStatus, ManagerSummary } from '~/lib/types';

const STATUS: Record<ManagerStatus, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }> =
  {
    running: { tone: 'ok', label: '実行中' },
    waiting_human: { tone: 'warn', label: '人間待ち' },
    // **「完了」と書かない。** `done` はマネージャー自身のターンが終わって待機して
    // いるだけで、仕事が終わったとは限らない（その下で作業者が走っているかも、
    // ここからは見えていない）。`schema.ts` の定義も「待機中」である — 画面だけが
    // 「完了」と言っていた。
    done: { tone: 'neutral', label: '待機中' },
    failed: { tone: 'danger', label: '失敗' },
    // **「完了」の側に寄せない。** 戻れなかった仕事は `done`（終えて待っている）
    // ではない。人間が画面で見たときに「起こし直す対象」だと分かる言葉にする。
    //
    // **かといって「復旧不能」でもない。** 観測したのは「前のセッションへ戻れ
    // なかった」ことだけで、成果の有無は見ていない（デーモンは PR もブランチも
    // 知らない）。落ちる直前にマージまで届いていた仕事がこの札を貼られている。
    lost: { tone: 'danger', label: 'セッションへ戻れず' },
    // **`done`（待機中）と混ぜない。** `done` は自分から手を離しただけで話しかけ
    // れば続くが、`stopped` は外から止められ、runner のセッション一覧から実際に
    // 消えたことを確かめた終端である（`schema.ts` の `jobStatusSchema` の doc）。
    // 「完了」と読ませないのは `done` と同じ理由——ただし `done` 以上に、これは
    // もう話しかけても続かない。
    stopped: { tone: 'neutral', label: '停止済み' },
  };

export function ManagerStatusBadge({ status }: { status: ManagerStatus }) {
  const view = STATUS[status];
  return <Badge tone={view.tone}>{view.label}</Badge>;
}

/**
 * 一覧に添える拒否は、**新しい側から**この件数まで。
 *
 * 1本の異常が一覧を食い潰さないためだが、**切ったことは必ず言う**。黙って落とすと
 * 「3種類しか止められていない」に見える（`manager_list` の `LIST_DENIED_TOOLS` と
 * 同じ理由・同じ数）。
 */
const LIST_DENIED_TOOLS = 3;

/**
 * 拒否を「新しい側から」畳んだ像。
 *
 * デーモンは**古い順**で返す（`ManagerPool.denials()`）。読む側が知りたいのは
 * いま何で止まっているかなので、末尾から採る。
 */
export function summarizeDenials(denials: ManagerDenial[]) {
  const recent = [...denials].reverse();
  return {
    shown: recent.slice(0, LIST_DENIED_TOOLS),
    rest: Math.max(recent.length - LIST_DENIED_TOOLS, 0),
    total: denials.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/**
 * 「確認へ上がらず止められた」件数を、**状態に添えて**出す一行。
 *
 * **状態を置き換えない。** 分類器か deny 規則がその場で拒否すると、その仕事は
 * `running`（＝画面では「実行中」）のまま手が止まる。だから札は札のまま残し、
 * その隣にこれを並べる。
 *
 * **これが無いと、人間の画面にだけ見えないものができる。** クローンは同じ状態を
 * `manager_list` で読み、そこには拒否件数が出ている（PR #60）。人間の画面が
 * 「実行中」としか言わないと、同じ仕事を見て人間とクローンが違う判断をする
 * — 北極星 禁止1（デグレード禁止）を、いつもと逆の向きに踏むことになる。
 *
 * **ここでも観測した分しか言わない。** 数えているのは拒否そのものであって、それで
 * 止まったかどうかは見ていない（デーモンに動きを見る手が無い）。だから「止まって
 * いる」ではなく「止まっている可能性がある」と書く。
 */
export function ManagerDenialNote({ denials }: { denials: ManagerDenial[] }) {
  if (denials.length === 0) return null;
  const { shown, rest, total } = summarizeDenials(denials);
  return (
    <p className="mt-1 text-[11px] text-warn">
      ⚠ 確認へ上がらず止められた道具:{' '}
      {shown.map((entry) => `${entry.tool} ${entry.count}件`).join(' / ')}
      {rest > 0 && `（ほか ${rest} 種、全 ${total} 件）`}
      。この確認はクローンには回ってきていないので、手が止まっている可能性がある。
    </p>
  );
}

/**
 * 直近の1ターンが**報告ではなく失敗**で終わったことを、**状態に添えて**出す一行。
 *
 * **状態の札を置き換えない。** 支出上限に当たった回もセッションは生きているので、
 * 台帳の `status` は `done`（＝画面では「待機中」）のままである
 * （`packages/core/src/schema.ts` の `lastFailure` の doc）。札を「失敗」へ倒すと
 * 嘘になり、人間は続けられる仕事をそこで閉じる。
 *
 * **これが無いと、人間の画面には「報告が来た」としか出ない。** 直す前は
 * `You've hit your org's monthly spend limit …` が最後の報告としてそのまま出て
 * いた（`packages/core/src/sdk-failure.ts` の doc）。本文の側は runner が包んで
 * あるが、包みだけに頼ると読む側は本文の先頭を読んで判定することになる。
 *
 * **SDK の語（`code` / `via`）をそのまま出す。** 言い換えると人間が SDK の型定義や
 * ログで引ける手がかりが消える。`billing_error` と `rate_limit` は次の一手が違う。
 */
export function ManagerFailureNote({
  failure,
}: {
  failure: ManagerSummary['lastFailure'] | undefined;
}) {
  if (failure === undefined || failure === null) return null;
  return (
    <p className="mt-1 text-[11px] text-danger">
      ⚠ 直近のターンは報告ではなく失敗で終わっている: {failure.code}（{failure.via}）
      。セッションは生きているので、原因が解ければ話しかければ続く。
    </p>
  );
}

export default function Managers() {
  const { data, error, isLoading } = useManagers();
  const managers = data?.managers ?? [];

  return (
    <Page
      title="マネージャー"
      description="クローンが起こした仕事。人間が Claude Code に頼んだのと同じ位置にいる"
    >
      <ErrorNote error={error} className="mb-4" />
      {isLoading ? (
        <Spinner />
      ) : managers.length === 0 ? (
        <Card>
          <Empty>まだ1体も起きていない。会話で依頼するか、発意 tick を待つ。</Empty>
        </Card>
      ) : (
        <Card>
          <ul>
            {managers.map((manager) => (
              <li key={manager.managerId} className="border-b border-border last:border-b-0">
                <Link
                  to={`/managers/${manager.managerId}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <div className="mt-0.5 shrink-0">
                    <ManagerStatusBadge status={manager.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{manager.request}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                      {manager.cwd}
                    </p>
                    {manager.waiting.length > 0 && (
                      <p className="mt-1 text-[11px] text-warn">
                        {manager.waiting.length} 件の確認待ち: {manager.waiting[0]?.summary}
                      </p>
                    )}
                    {/*
                      拒否は `status` に映らない。札は「実行中」のまま、その隣に
                      添える（状態を置き換えるものではない）。
                    */}
                    <ManagerDenialNote denials={manager.denials ?? []} />
                    {/*
                      失敗も `status` に映らない（上限に当たった回も `done` の
                      まま）。札はそのまま残し、その隣に添える。
                    */}
                    <ManagerFailureNote failure={manager.lastFailure} />
                    {/*
                      札だけでは「で、どうすればいいのか」が伝わらない。クローンは
                      `manager_list` で同じ案内を受け取る — 人間の画面にだけ無いと、
                      同じ状態を見て人間とクローンが違う判断をすることになる。
                    */}
                    {manager.status === 'lost' && (
                      <p className="mt-1 text-[11px] text-danger">
                        前のセッションへ戻れなかっただけで、成果が残っているかは見ていない。起こし直す前にリモート（PR・ブランチ）を確かめること。
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-muted">
                    <p>{formatRelative(manager.updatedAt)}</p>
                    {/*
                      `live` はデーモンが今この瞬間その runner と繋がっているか。
                      status と別に出す — 「走っている扱いだが繋がっていない」を
                      隠すと、再起動後の引き取りが効いたのか分からなくなる。

                      `live && <札>` の形は書かない。それだと `live === false`
                      を「札が無い」でしか表せず、読む側は「切断されている」と
                      「この画面が接続状態を報告していない」を区別できない。
                      だから両側を描く。文言はクローンの `manager_list`
                      （`tools.ts`）と CLI（`chat.ts`）に合わせてある
                      （どちらも `/セッション切断`）。
                    */}
                    {manager.live ? (
                      <p className="text-ok">接続あり</p>
                    ) : (
                      <p className="text-danger">セッション切断</p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
