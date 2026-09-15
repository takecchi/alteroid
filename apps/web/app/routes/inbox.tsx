import { useMemo, useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, ErrorNote, Input } from '~/components/ui';
import { useInboxRemoveMany } from '~/hooks/mutations';
import type { InboxEventType, InboxRemoveManyResult } from '~/lib/types';

/**
 * `/inbox` — 受信箱（`inbox_events`。まだ処理し終えていない合図の器）の未読を、
 * 絞り込んでまとめて畳む（消す）。issue #972 / PR #1042。
 *
 * サーバ（`POST /inbox/remove`。`apps/daemon/src/app.ts`）・CLI
 * （`alteroid inbox remove`。`apps/cli/src/inbox.ts`）と同じ口。**これが
 * Web UI 側を埋める**（サーバと CLI は既に在り、残っていたのが Web UI だけ
 * だった——PRD「インターフェース」の入口の等価性）。
 *
 * ## 7種類すべてを選べる（クローンの道具とは違う）
 *
 * クローンの道具 `inbox_remove_many`（`packages/core/src/tools.ts`）は
 * `human_message` / `human_answer`（人間起点の合図）を構造的に除く——「クローンは
 * 自分の側の都合で溜まった合図だけを畳める」というオーナー判断
 * （`packages/core/src/inbox-backlog.ts` の該当 doc）。**それは道具の線引きで
 * あって、この HTTP の口の線引きではない。** `apps/daemon/src/openapi.ts` の
 * `inboxRemoveManyRequestSchema` の doc が「この HTTP の口は `types` に7種類の
 * どれも制限なく渡せる（人間が直接操作する入口なので……）」と逐語で書いている
 * とおり、CLI も絞っていない。ここで7種類のうち2つを外すと、**人間の入口だけ
 * 能力が落ちる**（AGENTS.md「範囲外でも気づいたことは上げる」の対になる、
 * north_star の禁止1「能力の削除」）。
 *
 * ## 「絞り込みが無い」の判定はサーバに任せる
 *
 * `types` に在る7種類を全部並べた呼びは 400 で断られる（絞り込みが無いのと
 * 同じで、1回で受信箱を空にできてしまうため——それは `POST /reset` の役目）。
 * **その判定をここで複製しない。** `useInboxRemoveMany`（`hooks/mutations.ts`）が
 * サーバの `{error}` をそのまま `ApiError.message` へ載せるので、ここは
 * `ErrorNote` に渡すだけでよい（`apps/cli/src/inbox.ts` の `post()` と同じ
 * 役割分担）。**ただし7種類全部を選んだ時点で「この呼びは断られる」と事前に
 * 注意するのは良い**（断るのはサーバ、注意は UI ——下の `AllSelectedWarning`）。
 *
 * ## 既定は試算。実行は明示の一手
 *
 * 画面を開いた時点では何も送らない。「試算する」（`dryRun: true`）→ 結果
 * （一致件数・対象件数・持ち越し件数・消える id の一覧）を見せる→ 明示の
 * 「実行する」でだけ `dryRun: false` を送る。
 *
 * **絞り込み（`types` / `sources` / `before` / `limit`）を変えたら、前の試算・
 * 実行結果を無効にする。** 古い試算の件数を見たまま「実行する」を押せる形を
 * 作らない——`resetResult()` を絞り込みの変更ハンドラからだけ呼ぶ（`reason` の
 * 変更では呼ばない。`reason` は一致件数に影響しない——日誌に残す文言だけの
 * 違いなので、無効化の対象は「絞り込み」に絞ってある）。
 *
 * ## 確認ダイアログは置いていない
 *
 * `settings.tsx` の「ワークスペースのリセット」は `<dialog>` で確認を挟むが、
 * あちらは「全部消す・取り消せない」操作にだけ確認を足す方針（同画面の
 * `ResetWorkspace` の doc）。ここは `archive.tsx` の「本文を消す」と同じ
 * ボタン直押しの形を採った——理由は、この画面には既に「試算する→結果を見る→
 * 実行する」という2段構えが要件として入っており（上記）、これ自体が
 * settings.tsx の確認ダイアログより詳しい確認（対象の正確な件数と id の一覧）
 * を先に見せている。ダイアログを重ねると同じ確認を二重に求めることになる。
 */
export default function Inbox() {
  return (
    <Page
      title="受信箱"
      description="まだ処理し終えていない合図（inbox_events）の未読を、絞り込んでまとめて消す。既定は試算——1件も消さない"
    >
      <InboxRemoveCard />
    </Page>
  );
}

/**
 * 表示順とラベル。**`Record<InboxEventType, string>` が全7種類を強制する**
 * ——`InboxEventType` に値が増えたのにここへ足していなければ `pnpm typecheck`
 * が落ちる。`INBOX_TYPE_ORDER` はこの `Record` の鍵からそのまま作るので、
 * 順序と網羅性を2箇所に分けて持たない。
 *
 * **値そのものは `@alteroid/core` から import しない。** `apps/web` は
 * `@alteroid/core` の値 import が禁止されている（サーバ専用コードごと
 * バンドルへ引き込む。`commitments.tsx` の `KNOWN_COMMITMENT_CLOSED_BY` の
 * doc と同じ理由）——ここは生成 spec から導いた型（`InboxEventType`）に対して
 * 文字列リテラルを合わせているだけで、`packages/core/src/inbox-backlog.ts` の
 * `INBOX_EVENT_TYPE_ORDER` の値そのものを参照してはいない。
 * 字面は揃えてある（`grep -Fn -- "'human_message'," packages/core/src/inbox-backlog.ts`）。
 */
const INBOX_TYPE_LABELS: Record<InboxEventType, string> = {
  human_message: '人間の発言',
  human_answer: '人間の回答（ask_human への応答）',
  distill: '要約（distill）',
  timer: 'タイマー',
  external: '外部イベント',
  self_initiative: '自発（self_initiative）',
  manager_message: 'マネージャーの報告',
};

const INBOX_TYPE_ORDER = Object.keys(INBOX_TYPE_LABELS) as InboxEventType[];

/** カンマ区切りの入力を、空文字を除いた配列にする（CLI の `splitList` と同じ形）。 */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function InboxRemoveCard() {
  const removeMany = useInboxRemoveMany();

  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<InboxEventType>>(new Set());
  const [sourcesText, setSourcesText] = useState('');
  const [beforeText, setBeforeText] = useState('');
  const [reason, setReason] = useState('');
  const [limitText, setLimitText] = useState('');

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [result, setResult] = useState<InboxRemoveManyResult | null>(null);

  const types = useMemo(
    () => INBOX_TYPE_ORDER.filter((type) => selectedTypes.has(type)),
    [selectedTypes],
  );
  const sources = useMemo(() => splitList(sourcesText), [sourcesText]);
  const before = beforeText.trim() === '' ? undefined : beforeText.trim();
  const limitTrimmed = limitText.trim();
  const limitNumber = Number(limitTrimmed);
  const limitValid = limitTrimmed === '' || (Number.isInteger(limitNumber) && limitNumber >= 1);
  const limit = limitTrimmed === '' || !limitValid ? undefined : limitNumber;

  const allSelected = types.length === INBOX_TYPE_ORDER.length;
  const canRun = types.length > 0 && reason.trim() !== '' && limitValid && !busy;

  /**
   * 絞り込みを変えたときだけ呼ぶ。**前の試算・実行結果を無効にする** ——
   * 呼ばないと、絞り込みを変えた後も古い件数・古い id の一覧が画面に残ったまま
   * 「実行する」を押せてしまう（依頼の設計判断そのもの）。
   */
  function invalidatePreviousResult() {
    setResult(null);
    setFailure(undefined);
  }

  function toggleType(type: InboxEventType) {
    setSelectedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
    invalidatePreviousResult();
  }

  async function runDryRun() {
    if (!canRun) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const response = await removeMany({
        types,
        sources: sources.length === 0 ? undefined : sources,
        before,
        reason: reason.trim(),
        limit,
        dryRun: true,
      });
      setResult(response);
    } catch (caught) {
      setResult(null);
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  async function runExecute() {
    // `result === null` や既に実行済み（`dryRun: false`）のときは呼べない
    // ——ボタン自体をその条件でしか出さない（下の JSX）ので、ここは防御のみ。
    if (result === null || !result.dryRun || !canRun) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const response = await removeMany({
        types,
        sources: sources.length === 0 ? undefined : sources,
        before,
        reason: reason.trim(),
        limit,
        dryRun: false,
      });
      setResult(response);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="絞り込み"
        subtitle="alteroid inbox remove / POST /inbox/remove と同じもの"
      />
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <div>
          <p className="mb-1 text-xs text-muted">種類（最低1つ）</p>
          <div className="flex flex-col gap-1">
            {INBOX_TYPE_ORDER.map((type) => (
              <label key={type} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedTypes.has(type)}
                  onChange={() => toggleType(type)}
                />
                <span>{INBOX_TYPE_LABELS[type]}</span>
                <span className="font-mono text-muted">{type}</span>
              </label>
            ))}
          </div>
          <AllSelectedWarning show={allSelected} />
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">
            送信元（完全一致・カンマ区切り。例 external:foo, manager:mgr-1。任意）
          </span>
          <Input
            value={sourcesText}
            onChange={(event) => {
              setSourcesText(event.target.value);
              invalidatePreviousResult();
            }}
            placeholder="任意"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">
            この時刻より古い行だけを対象にする（ISO8601。任意）
          </span>
          <Input
            value={beforeText}
            onChange={(event) => {
              setBeforeText(event.target.value);
              invalidatePreviousResult();
            }}
            placeholder="例 2026-09-15T00:00:00.000Z"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">理由（日誌に残る・必須）</span>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">1回で消す上限（任意。省略時はサーバの既定）</span>
          <Input
            value={limitText}
            onChange={(event) => {
              setLimitText(event.target.value);
              invalidatePreviousResult();
            }}
            placeholder="例 500"
          />
          {!limitValid && <span className="text-xs text-danger">1以上の整数を入れること</span>}
        </label>

        <ErrorNote error={failure} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!canRun}
            loading={busy}
            onClick={() => void runDryRun()}
          >
            試算する
          </Button>
          {result !== null && result.dryRun && (
            <Button
              variant="danger"
              size="sm"
              disabled={!canRun}
              loading={busy}
              onClick={() => void runExecute()}
            >
              実行する（対象 {result.targeted} 件を消す）
            </Button>
          )}
        </div>

        {result !== null && <ResultView result={result} />}
      </div>
    </Card>
  );
}

/**
 * 7種類全部を選んだときの事前の注意。**断るのはサーバ、注意は UI**
 * ——ここでは「渡せば必ず400になる」という判定を複製せず、選んだ時点で
 * 気づけるようにするだけ（サーバ側の条件が変わってもここは古い判定のまま
 * 残らない。実際に断るかどうかは常にサーバに聞きに行く）。
 */
function AllSelectedWarning({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="mt-2 text-xs text-warn">
      7種類全部を選んでいる。これは「絞り込みが無い」のと同じ呼びなので、サーバに
      断られる（400。1回で受信箱を空にできてしまうことを防ぐための制約——それは
      「設定」画面のワークスペースのリセットの役目である）。消したい種類だけを選ぶこと。
    </p>
  );
}

function ResultView({ result }: { result: InboxRemoveManyResult }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge tone={result.dryRun ? 'warn' : 'ok'}>{result.dryRun ? '試算' : '実行済み'}</Badge>
      </div>
      <p className="mt-2">
        未読 {result.totalPending} 件中 {result.matched} 件が絞り込みに一致（対象 {result.targeted}{' '}
        件、上限で持ち越し {result.remaining} 件）
      </p>
      {result.dryRun ? (
        <p className="mt-2 text-muted">
          1件も消していません（試算）。この内容でよければ「実行する」を押してください。
        </p>
      ) : (
        <p className="mt-2 text-muted">実行しました。消した id は日誌にも残っています。</p>
      )}
      {result.removedIds.length === 0 ? (
        <p className="mt-2 text-muted">対象になる id は無い。</p>
      ) : (
        <>
          <p className="mt-2">
            {result.dryRun ? '消える予定の id' : '消した id'}（{result.removedIds.length}件）:
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono break-all">
            {result.removedIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
