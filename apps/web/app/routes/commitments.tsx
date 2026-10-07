import { WorkTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { useReportDirty, LeaveGuardScope } from '~/lib/leave-guard';
import { useLatest } from '~/lib/use-latest';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';
import { unsentInput } from '~/lib/unsent-input';
import { Fragment, useCallback, useEffect, useId, useState } from 'react';
import { Tabs } from 'radix-ui';
import { Link } from 'react-router';

import {
  Markdown,
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  Empty,
  ErrorNote,
  FieldHint,
  Input,
  Spinner,
  SubmitHint,
  Textarea,
  WarnNote,
  cn,
  useKeyboardHintsVisible,
} from '@alteroid/ui';
import {
  useCloseCommitment,
  useEditCommitment,
  usePushCommitment,
  useCommitments,
  ApiError,
  useConversation,
  useConversations,
} from '@alteroid/swr';
import { describeUnreadableNames, formatDateTime, redactBody } from '@alteroid/logic';
import type { CommitmentClosedBy, CommitmentOrigin, TextMarkup } from '@alteroid/core';
import type { Commitment, UnreadableCommitment, UnreadableJob } from '@alteroid/logic';

/**
 * 引き受けたまま終わっていない仕事の台帳（`packages/core/src/schema.ts` の
 * `commitmentSchema`）。CLI の `/commitments` `/commit` `/done` と同じものを見る。
 *
 * **承認待ちの画面とは別のものである。** あちらは「クローンが人間の答えを待って
 * 止まっている」で、こちらは「頼まれたことがまだ片付いていない」。止まっていなくても
 * 片付いていない仕事はあるので、片方で他方は代用できない。
 *
 * **器が持つのは「何を頼まれたか」と「まだ片付いていない」の2値だけである。**
 * 順序も優先度も締切も持たない（判断はクローンと人間に残す）ので、この画面にも
 * 並べ替えや優先度の札を足さないこと — 足した瞬間に「やることの一覧」になる。
 */
export default function Commitments() {
  return (
    <LeaveGuardScope>
      <CommitmentsPage />
    </LeaveGuardScope>
  );
}

function CommitmentsPage() {
  const [showClosed, setShowClosed] = useState(false);
  // 離れる前の確認（移動・タブを閉じる前）は `LeaveGuardScope` が1つだけ持ち、編集欄・登録欄が
  // `useReportDirty` で書きかけを知らせる（#2764）。どれか1つでも書きかけなら止める。
  const { data, error, isLoading, isValidating, mutate } = useCommitments(showClosed);

  // 並びはデーモンが決めている（未了が古い順、片付いたものが新しい順で後ろ）。
  // **ここで並べ直さない** — 並べ直すと齢の見え方が CLI・クローンと食い違う。
  const all = data?.entries ?? [];
  const open = all.filter((commitment) => !isClosed(commitment));
  const closed = all.filter(isClosed);
  // **読めない行（issue #296）。**「無い」でも「片付いた」でもない第3の状態。
  const unreadable = data?.unreadable ?? [];
  // **保持上限を超えて物理削除された片付き行の累計（issue #416）。**
  // `unreadable` と同じ理由で読む——`data` が無ければ0件として扱う
  // （読み込み中・エラー時に「削除が0件」と誤読させる意図ではなく、後段の
  // `TrimmedClosedNote` は `isLoading` と `listUnavailable` の外では描かれないので実害は無い）。
  const trimmedClosed = data?.trimmedClosed ?? 0;
  /**
   * **取れなかったのを0件と描かない**（issue #2320）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は `LoadError` が言う。ここで「引き受けたまま終わっていない仕事は
   * ない」を並べると、読めていないのに引き受けた仕事が無いように読め、忘れさせないための
   * 器が空に見える。再検証の失敗で `data` が残っているときは当たらず、一覧をそのまま出す
   * （#2266 と同じ）。
   */
  const listUnavailable = data === undefined && error !== undefined;

  /**
   * **書きかけ・出したままの失敗を、行が消えても持つ**（issue #3751。承認の画面の
   * `leftoverSources`（#3515）と同じ考え方）。行（`OpenRow`）の入力は行の state が持つが、
   * 行が裏で片付いて一覧から外れると `OpenRow` ごと unmount され、書きかけも、押した結果の
   * 409 の本文も消える。そこで行は書きかけと失敗をここへも写し、行が外れたらここから
   * 「既に片付いた」と断って残す（`OrphanNotes`）。
   */
  const [notes, setNotes] = useState<Readonly<Record<string, RowNote>>>({});
  const track = useCallback((commitment: Commitment, patch: RowNotePatch) => {
    setNotes((current) => {
      const before = current[commitment.id];
      const merged: RowNote = { ...before, ...patch, commitment };
      if (isEmptyNote(merged)) {
        if (before === undefined) return current;
        return withoutKey(current, commitment.id);
      }
      if (before !== undefined && sameNote(before, merged)) return current;
      return { ...current, [commitment.id]: merged };
    });
  }, []);
  /** 自分の書き込みの応答を待っている id。一覧が先に取り直されて行が消える一瞬を、断りと取り違えない。 */
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const markSettling = useCallback((id: string, on: boolean) => {
    setSettling((current) => {
      if (current.has(id) === on) return current;
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const dismissNote = useCallback((id: string) => {
    setNotes((current) => withoutKey(current, id));
  }, []);
  // **一覧を読めているときだけ**外れたと見る（読み込み中・失敗で空に見えるだけのときは、書きかけを
  // 断りへ変えない）。未了に載っている行は、いまも行が持っている。
  const orphans = (() => {
    if (data === undefined) return [];
    const openIds = new Set(open.map((c) => c.id));
    return Object.values(notes)
      .filter((note) => !openIds.has(note.commitment.id) && !settling.has(note.commitment.id))
      .map((note) => ({ note, current: all.find((c) => c.id === note.commitment.id) }));
  })();

  return (
    <Page
      tabs={<WorkTabs />}
      title="未了の仕事"
      description="受信箱でも日誌でもここには残らない。忘れさせないための場所であって、やることの一覧ではない"
      action={
        <Button size="sm" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? '未了だけ' : '片付けたものも見る'}
        </Button>
      }
    >
      <LoadError
        what="未了の仕事の一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="mb-4"
      />

      <PushForm />

      {/* `keepPreviousData` のとき `isLoading` は別キーの初回読み込みでも真になる。一覧を置き換えてよいのは、出せるデータが無いときだけ（#3074）。 */}
      {isLoading && data === undefined ? (
        <Spinner />
      ) : listUnavailable ? null : (
        <>
          {/* 一覧の上に置く。読める行の中身を見る前に、まず断りが目に入るように。 */}
          <UnreadableNote unreadable={unreadable} />
          <UnreadableJobsNote unreadableJobs={data?.unreadableJobs ?? []} />
          <TrimmedClosedNote trimmedClosed={trimmedClosed} />

          <OrphanNotes orphans={orphans} onDismiss={dismissNote} />

          <Card className="mb-4">
            <CardHeader
              title="未了"
              subtitle="古い順。齢がそのまま「どれだけ放置されているか」である"
            />
            {open.length === 0 ? (
              <Empty>
                {unreadable.length > 0 || (data?.unreadableJobs ?? []).length > 0
                  ? '読めた範囲では、未了の仕事はない。'
                  : '未了の仕事はない。'}
              </Empty>
            ) : (
              <ul>
                {open.map((commitment) => (
                  <OpenRow
                    key={commitment.id}
                    commitment={commitment}
                    onTrack={track}
                    onSettling={markSettling}
                  />
                ))}
              </ul>
            )}
          </Card>

          {/*
            片付けたものは、押されたときだけ取りに行く。器は行を消さない契約
            なので（「何を片付けたか」は日報の材料である）、読む手立てを画面にも
            置く。**ただし fs 実装は保持上限を超えた古い片付き行を物理削除する
            （issue #416）——削除された累計件数は上の TrimmedClosedNote が持つ。**
          */}
          {showClosed && (
            <Card>
              <CardHeader
                title="完了した仕事"
                subtitle="新しい順。何をもって終わりとしたかを残す"
              />
              {closed.length === 0 && isLoading ? (
                // 閉じた分の初回読み込み中（`isLoading` は新しいキーにキャッシュが無いときだけ真。再検証では偽）は、前のキー（未了だけ）の一覧が `data` に載っている
                // （#3074）。ここで「記録はまだない」と言うと、読めていないのに無いと読める。
                <Spinner />
              ) : closed.length === 0 && error !== undefined ? null : closed.length === 0 ? (
                <Empty>
                  {trimmedClosed > 0
                    ? '残っている範囲に、完了した仕事の記録はない。'
                    : unreadable.length > 0
                      ? // 読めない行は片付いた行かもしれないので、完了の側も言い切れない。
                        '読めた範囲では、完了した仕事の記録はない。'
                      : '完了した仕事の記録はまだない。'}
                </Empty>
              ) : (
                <ul>
                  {closed.map((commitment) => (
                    <ClosedRow key={commitment.id} commitment={commitment} />
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

function isClosed(commitment: Commitment): boolean {
  return commitment.closedAt !== undefined && commitment.closedAt !== null;
}

/**
 * 読めない行が在ることを、一覧の上で断る（issue #296）。
 *
 * **新しい共有部品を増やさない。** `ErrorNote`（`packages/ui/src/components/ui.tsx`）と同じ
 * 配色の作法を warn 色で使い回す — `apps/web/app/routes/journal.tsx` の
 * `BlockedNote`（「終端でも空でもない、本物の限界だと分かる形にする」）と
 * 同じ考え方で、この画面にもローカルに1つだけ置く。
 *
 * **「無い」でも「片付いた」でもない第3の状態を、`Empty` の顔にしない。**
 * `Empty`（灰色・控えめ）は「無い」を表す部品なので、読めない行の存在を
 * そこへ混ぜると「特に何も無い」に見えてしまう。
 *
 * **0件なら描かない。** 常に出る断りは、出ていることが情報にならない
 * （`packages/ui/src/components/ui.tsx` の `TruncationNote` と同じ判定）。
 *
 * **id が取れない行は件数だけに数える**（`commitment_list` ツール・digest と
 * 同じ扱い。`packages/core/src/tools.ts` / `digest.ts`）。
 *
 * **id の列挙にも上限を置く（#409）。** 台帳の破損の度合いに比例して伸びる
 * 列挙で、`packages/core/src/tools.ts` の `commitment_list`（一覧モード）に
 * 在った同じ形の穴の画面側。`ManagerDenialNote`（`managers.tsx`）の
 * `LIST_DENIED_TOOLS` と同じ考え方——**切ったら必ず言う**。
 */
const UNREADABLE_IDS_SHOWN = 20;

function UnreadableNote({ unreadable }: { unreadable: UnreadableCommitment[] }) {
  if (unreadable.length === 0) return null;
  return (
    <WarnNote className="mb-4">
      読めない行が {unreadable.length} 件ある
      {describeUnreadableNames(
        unreadable.map((entry) => entry.id),
        UNREADABLE_IDS_SHOWN,
      )}
      。<strong>片付いたのではない。</strong>
    </WarnNote>
  );
}

/**
 * 読めない委譲が在ることを、一覧の上で断る（issue #2359）。
 *
 * 「進行中（委譲あり）」の印（`InProgressBadge`）は読めた委譲だけから組まれる。読めない委譲に
 * 紐づく行は印が付かず、「委譲なし」と見分けが付かない。**どの行に紐づくかは、委譲の行が壊れて
 * いるので言えない**——だから行には何も足さず、一覧の上で1回だけ断る（推測で紐づけない）。
 *
 * `managers.tsx` の `UnreadableJobNote`（「居ない」「畳まれた」ではないという断り）とは言う
 * ことが違うので、別の部品にする（あちらは「この一覧に載っていない」と言う画面の部品）。
 *
 * **0件なら描かない**（デーモンが古く欄が無いときも同じ）。id の列挙には上限を置き、切ったら言う。
 */
function UnreadableJobsNote({ unreadableJobs }: { unreadableJobs: readonly UnreadableJob[] }) {
  if (unreadableJobs.length === 0) return null;
  return (
    <WarnNote className="mb-4">
      読めない委譲が {unreadableJobs.length} 件ある
      {describeUnreadableNames(
        unreadableJobs.map((entry) => entry.id),
        UNREADABLE_IDS_SHOWN,
      )}
      。<strong>どの行に紐づくかは分からない</strong>
      ——「進行中（委譲あり）」の印が無い行の中に、本当は委譲が走っているものがあるかもしれない。
    </WarnNote>
  );
}

/**
 * 保持上限を超えて物理削除された片付き行が在ることを、一覧の上で断る
 * （issue #416）。
 *
 * **`UnreadableNote` と同じ形にする。** どちらも `CommitmentList`
 * （`packages/core/src/store.ts`）が運ぶ「無い」でも「片付いた」でもない状態
 * ——`unreadable` は読めなかった行、こちらは既に消えた行という違いだけである。
 *
 * **0件なら描かない**（`UnreadableNote` と同じ判定。常に出る断りは情報にならない）。
 */
function TrimmedClosedNote({ trimmedClosed }: { trimmedClosed: number }) {
  if (trimmedClosed === 0) return null;
  return (
    <WarnNote className="mb-4">
      保存できる数の上限を超えたため、古い完了済みの仕事が合わせて {trimmedClosed} 件消えている。
      <strong>消えた分の内容は、ここでは二度と読めない。</strong>
    </WarnNote>
  );
}

/**
 * その未了が何から生まれたか。
 *
 * **「誰が言ったか」ではなく「どの起点から来たか」である**（`schema.ts` の
 * `commitmentOriginSchema`）。人間との約束か自分で思い立ったことかで、
 * 取り返しのつかなさも急ぎ方も変わる。
 */
const ORIGIN_LABEL: Record<CommitmentOrigin, string> = {
  human: '人間',
  manager: 'マネージャー',
  external: '外部',
  self: '自分',
};

/**
 * `ORIGIN_LABEL[origin]` の実行時の倒れ先（issue #288）。
 *
 * **`ORIGIN_LABEL` は `Record<CommitmentOrigin, string>` のまま維持する** —
 * これがビルド時の網羅性そのものである（`packages/core/src/schema.ts` の
 * `commitmentOriginSchema` に新しい値が足されると、この
 * `Record` を埋めるまで `pnpm typecheck` を通せない。変異試験で確認済み、
 * 詳細は PR 本文）。
 *
 * **ただし実行時はビルド時の型を追い越しうる。** デーモンが先に新しい
 * `origin` を返し、この画面（この型定義）がまだ古い、という順序が実在する
 * （Web UI とデーモンは別デプロイ）。そのとき `ORIGIN_LABEL[origin]` は
 * `undefined` を返すが、`Record<CommitmentOrigin, string>` の型の上では
 * `string` にしか見えないので、`ORIGIN_LABEL[origin] ?? origin` は型的には
 * 「絶対に発火しない不要な条件」に見えてしまう。**それを避けるためだけに、
 * ここで `Record<string, string | undefined>` へ広げて引く** — `Record` の
 * 網羅性そのものは1文字も緩めていない。
 *
 * **倒れ先は空文字ではなく、起点の生の値そのもの**（`CommitmentBody` の
 * `PlainBody` フォールバックと同じ「取れないことを出力から消さない」形。
 * AGENTS.md の地雷表「取れない軸に 0 の行を作る」）。`console.warn` も
 * `assertOriginHandled`（下）に揃え、痕跡を残す。
 */
function originLabel(origin: CommitmentOrigin): string {
  const labels: Record<string, string | undefined> = ORIGIN_LABEL;
  const label = labels[origin];
  if (label !== undefined) return label;

  console.warn(`commitments.tsx: 未知の commitment.origin が来た（バッジ）: ${origin}`);
  return origin;
}

/**
 * **`origin: 'manager'` の `source` だけ `/managers/<id>` への `<Link>` にする
 * （issue #2028）。** `source` はそのとき必ずマネージャー id
 * （`packages/core/src/clone.ts` の `commitmentFor` の
 * `source: event.managerId,`）なので、宛先を組み立てられる。`managers.tsx` /
 * `dashboard.tsx` が同じ id を `Link to={`/managers/${managerId}`}` で
 * 詳細へつないでいるのに揃える。
 *
 * **`origin: 'human'` には広げない。** そちらの `source` は意味が複数
 * ありうる（`schema.ts` の doc）ので、`/managers/<id>` へ飛べる保証が無い。
 *
 * **文言は1文字も変えない。** 出す文字列は変わらず、`/ <source>` の部分が
 * リンクになるだけである。
 */
function OriginBadge({ commitment }: { commitment: Commitment }) {
  const label = originLabel(commitment.origin);
  const source = commitment.source;
  const hasSource = source !== undefined && source !== null && source !== '';
  const tone = commitment.origin === 'human' ? 'accent' : 'neutral';

  // **内部 ID（UUID）を利用者に見せない（#2801）。** マネージャーの行は「マネージャーの詳細」
  // という語そのものをリンクにする（id は宛先に含まれるだけで、文字としては出さない）。
  if (commitment.origin === 'manager' && hasSource) {
    return (
      <Badge tone={tone}>
        <Link to={`/managers/${source}`} className="hover:underline">
          {label}の詳細
        </Link>
      </Badge>
    );
  }
  if (commitment.origin === 'human' && hasSource && looksLikeId(source)) {
    return <HumanConversationBadge label={label} source={source} />;
  }
  // 外部の出どころ（webhook の source など、利用者が決めた名前）は、そのまま添える。
  if (commitment.origin === 'external' && hasSource && !looksLikeId(source)) {
    return (
      <Badge tone={tone}>
        {label}（{source}）
      </Badge>
    );
  }
  return <Badge tone={tone}>{label}</Badge>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 内部の識別子（UUID）に見える文字列か。そうなら画面に文字として出さない。 */
function looksLikeId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const CONVERSATION_TITLE_MAX = 24;

/**
 * 人間の行の出どころ。`source` が会話 id なら「会話『冒頭の一言』」にして会話へのリンクにする。
 *
 * **`source` は承認待ちへの回答の id のこともある**（`packages/core/src/schema.ts` の
 * `commitmentRespondedAt` の doc）ので、会話だと確かめられるまでは言い切らない。
 *
 * 1. 直近の一覧（`useConversations()`、30件）に載っていれば、それを使う（行ごとに引かない）。
 * 2. 載っていない id だけ、`GET /conversations/{id}` で1件引く。**中身（`messages`）ごと返る**が、
 *    メタだけ返す口は無い（クエリは `scan` と `includeSuperseded` のみ）ので、一覧に無い id に
 *    限ることで数を抑える。同じ id は SWR が1回にまとめる。
 * 3. 404 は会話ではない（デーモンは日誌を遡り切って該当が無いときだけ 404 を返す）。「人間」とだけ出す。
 * 4. 404 以外の失敗と、「窓の外かもしれない」（200 で `messages` が空・`reachedStart: false`）は
 *    **確かめられなかった**。「人間」に潰さず、その旨を控えめに添える。
 */
function HumanConversationBadge({ label, source }: { label: string; source: string }) {
  const recent = useConversations();
  const recentSettled = recent.data !== undefined || recent.error !== undefined;
  const inRecent = recent.data?.conversations.find((entry) => entry.conversationId === source);
  const single = useConversation(recentSettled && inRecent === undefined ? source : null, {
    retryOnNotFound: false,
  });

  if (inRecent !== undefined) {
    return <ConversationLink label={label} source={source} preview={inRecent.preview} />;
  }
  if (single.data !== undefined) {
    const messages = single.data.messages;
    // 一覧の題と同じく、失敗の知らせではない最後の発言から取る。
    const titled =
      messages.findLast((message) => message.turnFailure === undefined) ?? messages.at(-1);
    if (titled !== undefined) {
      return <ConversationLink label={label} source={source} preview={titled.text} />;
    }
    // 200 で空: 窓の外に続きが残っているかもしれない（無いとは言えない）。
    return <UnconfirmedBadge label={label} />;
  }
  if (single.error !== undefined) {
    if (single.error instanceof ApiError && single.error.status === 404) {
      return <Badge tone="accent">{label}</Badge>;
    }
    return <UnconfirmedBadge label={label} />;
  }
  return <Badge tone="accent">{label}</Badge>;
}

function UnconfirmedBadge({ label }: { label: string }) {
  return (
    <Badge tone="accent">
      {label} / <span className="text-muted-foreground">会話？（確かめられなかった）</span>
    </Badge>
  );
}

function ConversationLink({
  label,
  source,
  preview,
}: {
  label: string;
  source: string;
  preview: string;
}) {
  const flat = preview.replace(/\s+/g, ' ').trim();
  const title =
    flat.length > CONVERSATION_TITLE_MAX ? `${flat.slice(0, CONVERSATION_TITLE_MAX)}…` : flat;
  return (
    <Badge tone="accent">
      {label} /{' '}
      <Link to={`/chat/${source}`} className="hover:underline">
        {title === '' ? '会話' : `会話「${title}」`}
      </Link>
    </Badge>
  );
}

/**
 * `origin: 'manager'` の本文が持つ接頭辞（3つの閉じた列挙）。
 *
 * `packages/core/src/schema.ts` の `manager_message`（`inboxEventSchema`）で
 * `kind: z.enum(['report', 'question', 'permission'])` と閉じているので、
 * 総当たりで前方一致を見れば足りる（正規表現で緩く取る理由が無い）。
 */
const MANAGER_PREFIXES = ['[report] ', '[question] ', '[permission] '] as const;

/**
 * `origin: 'manager'` の本文を、接頭辞（素）と本体（Markdown）へ分ける。
 *
 * **接頭辞の形式（`[kind] text`）の持ち主は `packages/core/src/clone.ts` の
 * `commitmentFor`（`manager_message` の分岐）である。** ここは画面側で
 * その形式を再パースしているだけなので、向こうが接頭辞の付け方を変えれば
 * ここは黙って前方一致しなくなる（＝下の「防御的な分岐」へ落ちて本文全体が
 * Markdown として描かれる。実害は無いが接頭辞が見えなくなる）。
 *
 * **前方一致しなかったときは本文全体を Markdown へ渡す。** `origin: 'manager'`
 * は `commitmentFor` が必ず `[kind] ` を前置してから台帳へ積む経路なので、
 * ここに来るのは形式が変わったときだけの防御的な分岐である。
 */
function splitManagerPrefix(body: string): { prefix: string | null; rest: string } {
  for (const prefix of MANAGER_PREFIXES) {
    if (body.startsWith(prefix)) return { prefix, rest: body.slice(prefix.length) };
  }
  return { prefix: null, rest: body };
}

/**
 * 外部イベント由来の本文は、`{ "note": "…" }` のような JSON のまま来ることがある（#2801）。
 * 利用者向けには、欄が `note` だけならその文面を、平たい欄の並びなら「欄: 値」の行に直す。
 * **JSON として読めない・入れ子や配列を含むときは、手を加えず元の文字列のまま出す**（欠落させない）。
 */
export function readableExternalBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return body;
  const flat = entries.every(
    ([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  if (!flat) return body;
  if (entries.length === 1 && entries[0]?.[0] === 'note' && typeof entries[0][1] === 'string') {
    return entries[0][1];
  }
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join('\n');
}

/** `human` / `external` の描き方（理由は後述の `CommitmentBody` の doc）。素のテキストのまま。 */
function PlainBody({ body }: { body: string }) {
  return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{body}</p>;
}

/**
 * **網羅性チェック専用（ビルド時）。** `CommitmentBody` の `switch` の
 * `default` から呼ぶ。引数の型は `never` — `packages/core/src/schema.ts` の
 * `commitmentOriginSchema` に新しい値が足されたのに、上の
 * `case` がその値を決めていないと、呼び出し側で `commitment.origin` は
 * ここで `never` にならず、この呼び出し自体が型エラーになる。**新しい
 * origin を足した人は、ここで分岐を決めるまで `pnpm typecheck` を通せない。**
 * 型が守っているものは、型を読まない人には見えないので、ここに明記しておく
 * （`.claude/skills/listing-and-detail/SKILL.md` が「歯が1本ずつだと、次に
 * 足す一覧も無上限で入る」として、`CLONE_TOOL_NAMES` から `_list` で終わる
 * 名前を機械的に集める形と同じ発想 — 網の外に在るものを人手ではなく機械
 * （ここではコンパイラ）に捕まえさせる）。
 *
 * **呼ぶこと自体が保証であって、戻り値は使わない。** 本文は呼び出し元が
 * `commitment.body` からそのまま描く — この関数へは渡さない（渡すと、
 * 描かれるのが本文ではなく起点の生の値になってしまう）。
 *
 * **実行時にここへ来たら `console.warn` で残す。** 黙って安全側へ倒すだけ
 * では AGENTS.md「静かに失敗する道具」と同じ形になる — 空白は描かないが、
 * 何が起きたかも残らない。デーモンが先に新しい `origin` を返す順序が
 * 実在しうる以上、次にここを読む人が気づける痕跡を残しておく。
 *
 * **同じ画面の `OriginBadge`（`ORIGIN_LABEL`）にも、`originLabel()` として
 * 同種の実行時の倒れ先が入っている（issue #288）。** 未知の `origin` では
 * ラベルが空文字ではなく起点の生の値になる。ここに書くのは、次に `origin`
 * を足す人が Issue を読むとは限らない一方、**この関数はその人が必ず
 * コンパイルエラーで立ち止まる場所だから**である。
 *
 * **この `console.warn` は、通るテストの出力には現れない**（vitest の既定
 * reporter が console を横取りし、通ったぶんを捨てる）。**「テストに warn が
 * 出ないから呼ばれていない」とは読めない。**
 */
function assertOriginHandled(origin: never): void {
  console.warn(`commitments.tsx: 未知の commitment.origin が来た: ${String(origin)}`);
}

/**
 * **網羅性チェック専用（ビルド時）。** `ClosedReasonBody` の `switch` の
 * `default` から呼ぶ。`assertOriginHandled` と同型 — 引数の型は `never` で、
 * `commitmentClosedBySchema`（`packages/core/src/schema.ts`）に新しい値が
 * 足されたのに上の `case` がその値を決めていないと、`known.data` はここで
 * `never` にならず、この呼び出し自体が型エラーになる。**新しい closedBy を
 * 足した人は、ここで分岐を決めるまで `pnpm typecheck` を通せない。**
 *
 * **呼ぶこと自体が保証であって、戻り値は使わない。** `never` 型の変数を
 * そのまま本文として描かないこと — issue #285 で実際に踏まれた実装ミスと
 * 同じ形である（`never` も `string` を要求する prop に代入できるので、
 * 型では捕まらない。空の見出しではなく分岐キーの生の値が画面に出た）。
 *
 * **実行時にここへ来ることは、`commitmentSchema.closedBy` が `z.string()`
 * で緩く持たれている（保存層は未知の値を拒否しない）ため、
 * `assertOriginHandled` より現実的に起こりうる。** 未知の値は
 * `ClosedReasonBody` が `isKnownCommitmentClosedBy`（`commitmentClosedBySchema`
 * の値を複製した narrow。理由は `isKnownCommitmentClosedBy` の doc）で弾いた
 * 時点で別に `console.warn` している（この関数より手前）。**この関数が
 * 実際に呼ばれるのは、`commitmentClosedBySchema` に値が足されたのに
 * `switch` 側の `case` が追いついていない、という版のずれのときだけである。**
 */
function assertClosedByHandled(closedBy: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.closedBy: ${String(closedBy)}`);
}

/**
 * `commitmentClosedBySchema`（`packages/core/src/schema.ts`）の閉じた2値を
 * ここへ複製する。**なぜ `@alteroid/core` から値として import しないか** —
 * `@alteroid/core` の `index.ts` は `export * from './schema.js'` に加えて
 * `usage-snapshot.js` / `usage-probe.js` などサーバ専用のドメイン層を丸ごと
 * 再エクスポートしている。**値**を1つでも import すると、そのサーバ専用
 * コードごとブラウザバンドルへ入る — 実際に #294 / #306 でこの2つの値 import
 * （このコメントの直下にあった `commitmentClosedBySchema.safeParse` /
 * `textMarkupSchema.safeParse`）が入り、この `commitments` ルートのチャンクが
 * 1.2MB（他ルートの1万〜2万バイト台に対して約80倍）に膨らんだうえ、
 * `node:module` の `createRequire` 呼び出しがブラウザでのモジュール評価
 * 時点で例外を投げ、**このルートが本番で一度も開けなくなった。** この doc の
 * 直後の直し（値 import を外してここへ複製）はその事故の修正である。
 *
 * `@alteroid/core/usage` / `@alteroid/core/revision` はこの画面が既に使って
 * いる「ブラウザへ出す軽い口」（`packages/core/src/revision.ts` の doc）だが、
 * `commitmentClosedBySchema` / `textMarkupSchema` にはその口が無いので、
 * ここでは値そのものをこのファイル内に複製する。
 *
 * **型（`CommitmentClosedBy` / `TextMarkup`）は `import type` のまま core から
 * 引く。** 網羅性の保証（`assertClosedByHandled` / `assertMarkupHandled` の
 * `never` 倒れ先）は型でしか効かないので、そちらは1文字も緩めていない。この
 * 配列が担うのは「保存層の緩い `z.string()` を実行時に狭める」ことだけである。
 *
 * **⚠️ core 側の `z.enum` に値が足されても、この複製は自動では追随しない。**
 * 追随しなくても安全側に倒れる — 新しい値は「未知」として `console.warn` 付き
 * の分岐（下記 `switch` の `default`）へ落ちるだけで、データは1文字も失わない
 * （AGENTS.md「型で塞いだ分岐にも、実行時の倒れ先の歯を足す」と同じ設計）。
 * ずれに気づく手立ては「本番でこのラベルが古いまま」という見え方だけなので、
 * `commitmentClosedBySchema` を変えたら、この配列も手で更新すること。
 */
const KNOWN_COMMITMENT_CLOSED_BY = [
  'clone',
  'human',
] as const satisfies readonly CommitmentClosedBy[];

function isKnownCommitmentClosedBy(value: string): value is CommitmentClosedBy {
  return (KNOWN_COMMITMENT_CLOSED_BY as readonly string[]).includes(value);
}

/**
 * **網羅性チェック専用（ビルド時）。** `ManagerRestBody` の `switch` の
 * `default` から呼ぶ。`assertOriginHandled` / `assertClosedByHandled` と
 * 同型 — 引数の型は `never` で、`textMarkupSchema`
 * （`packages/core/src/schema.ts`）に新しい値が足されたのに上の `case` が
 * その値を決めていないと、`known.data` はここで `never` にならず、この
 * 呼び出し自体が型エラーになる。**新しい markup を足した人は、ここで
 * 分岐を決めるまで `pnpm typecheck` を通せない。**
 *
 * **呼ぶこと自体が保証であって、戻り値は使わない。** `never` 型の変数を
 * そのまま本文として描かないこと（issue #285 で実際に踏まれた実装ミスと
 * 同じ形。`never` も `string` を要求する prop に代入できるので型では
 * 捕まらない）。
 *
 * **実行時にここへ来ることは、`commitmentSchema.bodyMarkup` が
 * `z.string()` で緩く持たれている（保存層は未知の値を拒否しない）ため、
 * `assertOriginHandled` より現実的に起こりうる。** 未知の値は
 * `ManagerRestBody` が `isKnownTextMarkup`（`textMarkupSchema` の値を複製した
 * narrow。理由は `isKnownTextMarkup` の doc）で弾いた時点で別に `console.warn`
 * している（この関数より手前）。**この関数が実際に呼ばれる
 * のは、`textMarkupSchema` に値が足されたのに `switch` 側の `case` が
 * 追いついていない、という版のずれのときだけである。**
 */
function assertMarkupHandled(markup: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.bodyMarkup: ${String(markup)}`);
}

/** `textMarkupSchema` の閉じた2値の複製。理由・追随の扱いは `isKnownCommitmentClosedBy` の doc と同じ。 */
const KNOWN_TEXT_MARKUP = ['markdown', 'none'] as const satisfies readonly TextMarkup[];

function isKnownTextMarkup(value: string): value is TextMarkup {
  return (KNOWN_TEXT_MARKUP as readonly string[]).includes(value);
}

/**
 * `origin: 'manager'` の本文の**接頭辞を除いた本体**（`rest`）を、
 * `bodyMarkup`（`rest` がどの記法で書かれているか。issue #287）で
 * 切り分ける。`ClosedReasonBody` と同じ形（narrow してから switch）。
 *
 * **実行時に区別すべき状態は4つ:**
 *
 * | `bodyMarkup` | 描き方 | 理由 |
 * | --- | --- | --- |
 * | `'markdown'` | `<Markdown>` | 今日と同じ |
 * | `undefined` | `<Markdown>` | **今日と同じ。** 「印が無い＝安全」の推論ではなく、いまの既定を変えないという方針の結果（`textMarkupSchema` の doc） |
 * | `'none'` | 素テキスト（`whitespace-pre-wrap` を保つ。改行を潰さない） | `text` が Markdown の記法として書かれていない（例: 人間が打った停止理由） |
 * | 上記以外（実行時のみ来うる） | 素テキスト＋`console.warn` | デーモンが先に新しい値を返す順序に備える。安全側（素テキスト）へ倒す |
 *
 * **保存層（`commitmentSchema.bodyMarkup`）は `z.string()` で緩く持つ。**
 * `closedBy` と同じ理由（`commitmentSchema` の doc）。**表示側までその
 * 緩さを引き継がない** — ここでは `isKnownTextMarkup` で狭めてから分岐する
 * （`textMarkupSchema` の値をこのファイル内に複製したもの。理由は
 * `isKnownTextMarkup` の doc）。
 */
function ManagerRestBody({ rest, bodyMarkup }: { rest: string; bodyMarkup: string | undefined }) {
  if (bodyMarkup === undefined) return <Markdown>{rest}</Markdown>;

  if (!isKnownTextMarkup(bodyMarkup)) {
    // **`undefined` とは別扱い。** ここでだけ warn する（`undefined` は warn しない）。
    console.warn(
      `commitments.tsx: 未知の commitment.bodyMarkup が来た（undefined とは別扱い）: ${String(bodyMarkup)}`,
    );
    return <PlainBody body={rest} />;
  }

  const markup = bodyMarkup;
  switch (markup) {
    case 'markdown':
      return <Markdown>{rest}</Markdown>;

    case 'none':
      return <PlainBody body={rest} />;

    default:
      assertMarkupHandled(markup);
      return <PlainBody body={rest} />;
  }
}

/**
 * 本文の描き方を `origin`（誰が書いたか）で切り分ける。`OpenRow` と
 * `ClosedRow` が同じ本文の `<p>` を2箇所に持っていたのを、ここへ集める。
 *
 * **切り出す理由**: 分岐の中身が増える（`self` / `manager` / `human` /
 * `external` の4方向）ので、2箇所に同じ分岐を書くと片方だけ直し忘れる形が
 * 生まれる。ここへ集めれば分岐は1箇所にしか存在しない（AGENTS.md「テストが
 * 書けない構造は、テストが無いのと同じ」の「なぜ切り出したかを書く（次に
 * 読む者が「無駄な間接層だ」と思って戻さないように）」に当たる）。
 *
 * **この切り出しは挙動を変えていない、とは言えない。** `human` / `external`
 * は元の `<p>` のままで挙動を変えていないが、`self` / `manager` は意図して
 * 描き方を変えている（それがこの PR の狙いそのものである）。
 *
 * | origin | body の中身 | 描き方 |
 * | --- | --- | --- |
 * | `self` | `commitment_open` のツール引数そのまま（クローンが書いた） | `<Markdown>` |
 * | `manager` | `[kind] text`。`kind` は閉じた3値、`text` は下記の3種が混ざる | 接頭辞は素、残りは `bodyMarkup` で分岐（`ManagerRestBody`。既定は `<Markdown>`） |
 * | `human` | 3経路とも人間の文字（チャット本文・承認待ちの回答・`POST /commitments`） | 素のテキスト（いまのまま） |
 * | `external` | `renderPayload` が整形した外部の中身 | 素のテキスト（いまのまま） |
 *
 * **`manager` の `text` は「マネージャー（AI）の出力」だけではない。** 現物を
 * 当たり直すと（`packages/core/src/manager.ts`、`type: 'manager_message'` を
 * post する箇所は6つ、うち5つは `#post` 直書きでデーモンが組み立てた通知。
 * マネージャーの発言を中継するのは `#emit()` だけで、その呼び出し元は複数
 * ある）、**`text` には型で区別されない3種が混ざる**:
 *
 * 1. **マネージャー自身の出力**（`#emit(event.managerId, 'report', event.text)`
 *    など。`packages/core/src/manager.ts` の `#onEvent` メソッド、
 *    `case 'report'` の分岐）
 * 2. **デーモンが組み立てた通知文**（`packages/core/src/manager.ts` の
 *    `flushWithheldReports` / `#restoreJobs` / `#reattach` / `#onEvent`
 *    （複数の分岐）など）。**このうち複数は本文に既に
 *    Markdown の記法を含む**（実例、`#restoreJobs` の逐語）:
 *    「この委譲は`**`自分より新しい世代の誰かが握っています`**`。…
 *    `**`新しく起こし直さないでください`**`」（`#reattach` にも同じ文言がある）
 * 3. **SDK / runner が出したエラー文**（`packages/core/src/manager.ts` の
 *    `#onEvent` メソッドが `event.reason` を報告文へ埋め込む分岐など。
 *    1・2 の文の末尾に埋め込まれて届くことも多い、例:
 *    `…挑み直します: ${event.reason}`）
 *
 * **3 は `apps/web/app/routes/reports.tsx`
 * （`grep -Fn -- '中身は SDK が出したエラー文であって' apps/web/app/routes/reports.tsx`）
 * が「`Markdown` で描かないこと。
 * 中身は SDK が出したエラー文であって、クローンが書いた文章ではない」と
 * 書いているものと同じ種類である。それでもここでは `manager` を丸ごと
 * Markdown のままにする。** 理由は3つ:
 *
 * 1. **3種類のどれも、人間が打った文字ではない。** 人間の指示が守ろうとして
 *    いるもの（`packages/ui/src/components/features/chat/chat-message.tsx`
 *    （`grep -Fn -- 'クローンの行だけを Markdown にする' packages/ui/src/components/features/chat/chat-message.tsx`）
 *    の「自分が書いた文字が勝手に化けないため」）は、
 *    ここでは1件も当たらない
 * 2. **2 は既に本文に `**…**` を持っている**（上の逐語、`#restoreJobs` /
 *    `#reattach`）。素のテキストで描くと `**` がそのまま画面に出る。Markdown 側に
 *    倒すのは、いまの表示の修正でもある
 * 3. **頻度と、害の向きが違う。** 2（デーモンが組み立てた通知）は器の入れ替え・
 *    再開・世代の拒否のたびに頻繁に出る。3（SDK/runner のエラー文）は失敗した
 *    ときだけの、まれな経路である:
 *
 *    | 種類 | 頻度 | 素テキストのままだと | Markdown にすると |
 *    | --- | --- | --- | --- |
 *    | 2: デーモンの通知 | 頻繁 | `**` が生で見える（情報は失われない） | 正しく描かれる |
 *    | 3: SDK/runner のエラー文 | まれ | 正しく出る | `*` や `_` が化ける（元の文字は推測が付くことが多い） |
 *
 *    頻度が高いほうの確実な利得を取った。
 *
 * **これは「仕組みで塞げている」のではなく「分離できないので Markdown 側へ
 * 倒した」である。** `commitment.body` は1本の文字列で `origin: 'manager'` に
 * 下位区分が無く、3 は 1・2 の文の末尾に埋め込まれて届くことが多い
 * （`#onEvent` の `…挑み直します: ${event.reason}` がその形）。切り分け
 * ようとすると本文の中身を判定することになるが、それは `manager.ts` 自身が
 * 避けている形である——`packages/core/src/manager.ts` の `#onEvent` の
 * `case 'report'` が「一覧を出す側は『報告が来た』と『エラーで死んだ』を本文の
 * 先頭を読んで判定することになる（＝ 表示のたびに文言の判定が要る）」と書いている。
 * **同じ理由は `summaryOf` にも別の言葉で置かれている**（そちらの逐語は
 * 「本文の文言で判定するしかなくなる」で、上とは別の文である——1つの逐語を
 * 2つのシンボルに帰属させない）。**同じ種類の文字列（SDK のエラー文）
 * が、`reports.tsx`（上記の grep が指す箇所）とこことで扱いが食い違う。
 * この食い違いと、3種類が型で区別されずに混ざっている件そのものは
 * issue #287 に記録してある。**
 *
 * **`human` を素のままにする理由**: `event.text` は
 * `packages/ui/src/components/features/chat/chat-message.tsx`
 * （`grep -Fn -- 'クローンの行だけを Markdown にする' packages/ui/src/components/features/chat/chat-message.tsx`）
 * が名指しで守っている文字列そのものである
 * ——「**クローンの行だけを Markdown にする。** 人間が打った本文
 * （`role === 'human'`）は素のテキストのままにする — 自分が書いた文字が
 * 勝手に化けないため」。チャット画面では素・台帳では Markdown、という
 * 食い違いを作らないために、ここでも素のままにする。
 *
 * **`external` を素のままにする理由**: external は AI でも人間でもない
 * （外部サービスが送ってきた中身をそのまま流し込んだもの）。書き手がどちらとも
 * 言えない以上、化けて困る側（素のテキスト）へ倒す。
 *
 * **`closedReason` はここの対象外。** `commitment_close`（クローン）と
 * `POST /commitments/:id/close`（人間）の両方が同じ欄へ書くので、`origin`
 * （開いたときの起点）では書き手を判別できない — 人間が積んだ仕事を
 * クローンが片付けることも、その逆もある。**`closedReason` の描き分けは
 * `commitment.closedBy`（issue #286 で型に足した、別軸の欄）を見る
 * `ClosedReasonBody` が持つ。** 詳細はそちらの doc を見よ。
 *
 * **`manager` の `rest`（接頭辞を除いた本体）の描き方は `bodyMarkup`
 * （issue #287 で型に足した欄）でさらに分岐する。** `bodyMarkup` が指す
 * 対象は `rest` であって `commitment.body`（接頭辞込み）ではない —
 * `packages/core/src/clone.ts` の `commitmentFor` が接頭辞を前置する前の
 * `event.text` に対して立てた印だから（`commitmentSchema.bodyMarkup` の
 * doc）。詳細は `ManagerRestBody` の doc を見よ。
 */
function CommitmentBody({ commitment }: { commitment: Commitment }) {
  // 表示だけ伏せる（編集の下書きの初期値は `commitment.body` のまま。issue #2600）。
  const body = redactBody(commitment.body);
  switch (commitment.origin) {
    case 'self':
      return <Markdown>{body}</Markdown>;

    case 'manager': {
      const { prefix, rest } = splitManagerPrefix(body);
      return (
        <div className="min-w-0">
          {prefix !== null && (
            <span className="mr-1 font-mono text-[11px] text-muted-foreground">{prefix}</span>
          )}
          <ManagerRestBody rest={rest} bodyMarkup={commitment.bodyMarkup} />
        </div>
      );
    }

    case 'human':
      return <PlainBody body={body} />;

    case 'external':
      return <PlainBody body={readableExternalBody(body)} />;

    default:
      /*
       * **実行時はここへ来うる（ビルド時の網羅性チェックとは別の話）。**
       * デーモンが先に新しい `origin` を返し、この画面（この型定義）が
       * まだ古い、という順序はありうる — 型はビルド時にしか効かない。
       * そのときに空白を描くのは、いまより悪い。**だから実行時は安全側
       * （素のテキスト）へ倒し、本文は commitment.body のまま1文字も消さない。**
       */
      assertOriginHandled(commitment.origin);
      return <PlainBody body={body} />;
  }
}

/**
 * `body` を後から直した行に出す印（issue 本文「編集された行に『編集済み』が
 * 分かる印を出す」）。
 *
 * **`editedAt` の有無だけを見る。** 誰が直したか（`editedBy`）は現状 `'human'`
 * 一択で（`commitmentEditedBySchema`）、**サーバ（`PATCH /commitments/:id`）が
 * 書き換えを通す行しか `editedAt` を持たない**ため、ここへ表示のためだけの
 * 網羅性チェック（`assertOriginHandled` 相当）を足すほどの分岐は無い——
 * `editedBy` の値そのものはラベルに使わない。
 *
 * **⚠️ この根拠はサーバ側にある。画面の入口の出し方ではない。** 以前ここには
 * 「`OpenRow` に編集の入口を出す条件（`origin: 'human'` かつ未了）を通った行
 * しか書き換わらない」と書いてあったが、**入口は未了の行すべてに出るように
 * なった**（`OpenRow` の「編集の入口は `origin` で隠さない」）。誰が書き換え
 * られるかを決めているのは最初からサーバだけである。
 *
 * **`OpenRow` / `ClosedRow` の両方に出す。** 編集できるのは未了の行だけだが、
 * `editedAt` は編集後に片付けられても消えない（`commitmentSchema.editedAt`
 * の doc）ので、片付いた行にも原文ではないという事実を残す必要がある。
 */
function EditedBadge({ commitment }: { commitment: Commitment }) {
  if (commitment.editedAt === undefined) return null;
  return <Badge tone="neutral">編集済み（{formatDateTime(commitment.editedAt)}）</Badge>;
}

/**
 * 未了の行に、クローンが答えているかどうかを出す（issue #1003）。
 *
 * **人間の発言（`会話した内容が…溜まってる気がする』）を出どころに持つ行にだけ
 * 出す。** `origin: 'human'` はチャット・承認待ちへの回答・`POST /commitments`
 * の3経路が共有していて、このうち実際に「返答が見つかる」ことがありうるのは
 * チャット経由だけである（`packages/core/src/schema.ts` の
 * `commitmentRespondedAt` の doc）。それ以外の origin（`self` / `manager` /
 * `external`）には「クローンが人間へ返答したか」という概念自体が無いので、
 * この印を出さない——出すと「未着手」という強い言葉を、当てはまらない行にも
 * 貼ることになる。
 *
 * **「返答済み・未クローズ」が出ないからといって「放置」だと断定しない。**
 * `commitmentRespondedAt` が `undefined` を返す行には、チャット以外の経路
 * （承認待ちへの回答・API からの直接積み）も混ざっている——それらは最初から
 * この導出の対象外である（同 doc）。それでも「未着手」の残余バッジを出す
 * のは、依頼者（マネージャー）の指示どおり、issue #1003 の3状態表が
 * 「未着手 = 返答済みが偽」をそのまま導出可能としているためである。
 *
 * **「人間の回答待ち」（3値目）はここに無い。** `PendingApproval` と
 * `Commitment` を結ぶ鍵がリポジトリに無く、結べないものは出さない
 * （issue #1003 本文）。
 *
 * **「進行中（委譲あり）」（4値目）は別のバッジ（`InProgressBadge`、直下）に
 * 分けてある。** この2つは排他ではない——「クローンがまだ返答していない
 * （未着手）が、裏では既に委譲して動いている」も「返答済みだが、さらに
 * 別の委譲が走っている」もありうる。1つの2値バッジへ4状態を無理に畳むと、
 * 両方が真の行を表現できなくなる。
 */
function AnsweredStateBadge({ commitment }: { commitment: Commitment }) {
  if (commitment.origin !== 'human') return null;
  if (commitment.respondedAt !== undefined) {
    return (
      <Badge tone="accent">
        返事済み・まだ片付いていない（{formatDateTime(commitment.respondedAt)}）
      </Badge>
    );
  }
  return <Badge tone="warn">未着手</Badge>;
}

/**
 * 未了の行に、いまも走っている委譲（マネージャー）があるかを出す
 * （issue #1003 段2「進行中（委譲あり）」）。
 *
 * **`AnsweredStateBadge`（直上）と同じ制約——`origin: 'human'` のうち、実際に
 * 一致しうるのはチャット経由の行だけである**
 * （`packages/core/src/schema.ts` の `commitmentActiveDelegationIds` の doc）。
 *
 * **正確な1対1の紐付けではないことを、ラベルでも隠さない。** 同じ会話に
 * 複数の未了行や複数の委譲が並行していれば、無関係な行にも付きうる
 * （同 doc の限界の節）。それでも「放置」と「進行中」を見分けたいという
 * 人間本人の不安（issue #1003 出どころ）には、この粒度で十分に応える。
 *
 * **⛔ この印は自動で閉じる合図ではない。** 委譲が終わって
 * `activeManagerIds` が消えても、行は消えない・閉じない——issue #1003 が
 * 最重要事項として禁じている「返事をしたら閉じる」と同じ形の自動化を、
 * この状態でも作らない。「いつ消えるか」を変えるのは常に人間の
 * `commitment_close` / `PATCH /commitments/:id/close` だけである。
 *
 * **id は `OriginBadge` と同じ形で `/managers/<id>` へのリンクにする**
 * （issue #2097。#2028 / PR #2032 が `OriginBadge` 側だけ直し、こちらは本文に
 * 出てこないため取り残されていた）。**文言・色・バッジの形は変えない**——
 * `ids.join(', ')` していた区切りをそのまま保ち、id 1件ずつをリンクに
 * するだけである。
 *
 * **key は id でよい。** `activeManagerIds` は `managerId`（= `Job.id`）の
 * 配列で、由来の `activeManagersByConversation`（`apps/daemon/src/app.ts`）は
 * `stores.jobs.listJobs()` から組み立てる——ジョブは `id` をキーに持つ
 * ストア（`packages/core/src/testing.ts` の偽物実装は `Map<string, Job>`）
 * から読むので、同じ会話 id の配列内に同じ id が2度現れることはない。
 */
function InProgressBadge({ commitment }: { commitment: Commitment }) {
  if (commitment.origin !== 'human') return null;
  const ids = commitment.activeManagerIds;
  if (ids === undefined || ids.length === 0) return null;
  return (
    <Badge tone="ok">
      進行中（委譲あり:{' '}
      {ids.map((id, index) => (
        <Fragment key={id}>
          {index > 0 && ', '}
          <Link to={`/managers/${id}`} className="hover:underline">
            {ids.length === 1 ? '詳細を見る' : `詳細${index + 1}`}
          </Link>
        </Fragment>
      ))}
      ）
    </Badge>
  );
}

const EDITOR_TAB_TRIGGER_CLASS =
  'border-b-2 border-transparent px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground';
const EDITOR_TAB_TRIGGER_ACTIVE_CLASS = 'border-primary text-foreground';

/**
 * 台帳の本文を人間が直接編集する（未了の行なら `origin` を問わず開ける。
 * `OpenRow` が「編集」を押した行だけに mount する）。
 *
 * **誰の行を実際に書き換えられるかを、この部品は知らない。** 判定はサーバ
 * （`PATCH /commitments/:id`）が持ち、断られたら 403 の本文がそのまま下の
 * `ErrorNote` に出る（`OpenRow` の「編集の入口は `origin` で隠さない」）。
 *
 * **`memory-detail.tsx` と同じ形。** プレビュー / 編集のタブ、既定はプレビュー、
 * 下書き（`draft`）は `Tabs.Root` の外（この部品自身）に置く——非活性の
 * `Tabs.Content` は unmount されるので、内側に置くとタブを切り替えた瞬間に
 * 入力が消える（`memory-detail.tsx` の `draft` の doc と同じ理由）。
 *
 * **プレビューは `CommitmentBody` をそのまま通す**（下書きを `body` に差した
 * 写しを渡す）。`memory-detail.tsx` は記憶（AI/人間どちらも書く自由記述）を
 * 一律 `<Markdown>` で描くが、台帳は `origin` ごとに描き分けが決まっている
 * ——`origin: 'human'` は素のまま（「人間が打った文字を化けさせない」）、
 * `self` / `manager` は Markdown。**編集できるようにしたことが、表示の描き分けを
 * 変える理由にはならない**ので、プレビューは行の見え方をそのまま映す。
 *
 * **⚠️ ここで `origin` を見ているのは「どう描くか」というデータの分岐だけで、
 * 「誰が直せるか」という規則ではない。** 後者を画面へ写すと、サーバ側の線が
 * 変わった日に画面だけが黙ってずれる。
 *
 * **台帳の `body` は必ず非空**（`commitmentEditBody` が `z.string().min(1)`
 * で弾く）ので、`memory-detail.tsx` のような「本文が空なら編集を既定にする」
 * 分岐は要らない——常にプレビューを既定にできる。
 *
 * **一覧の重さ**: この部品は `OpenRow` が「編集」を押した行だけに mount する。
 * 常時全行へ mount すると、行数に比例して Tabs / Textarea のインスタンスが
 * 増える（AGENTS.md 系skill「一覧はタイトルと要旨だけ」と同じ発想——ここは
 * 一覧の重さの話なので、開いた1件だけを実体化する）。
 */
function CommitmentBodyEditor({
  commitment,
  onCancel,
  onRequestCancel,
  onDirtyChange,
  onTrack,
  onSettling,
}: {
  commitment: Commitment;
  /** 下書きと失敗をページへも写す（行が一覧から外れても残すため。#3751）。 */
  onTrack: (patch: RowNotePatch) => void;
  /** 保存の応答を待っている間かを知らせる。 */
  onSettling: (on: boolean) => void;
  /** 確認なしで閉じる。保存に成功したときだけ使う（保存直後は下書きが元と違って見えるため）。 */
  onCancel: () => void;
  /** 「やめる」。書きかけがあれば確認を挟むのは呼び出し側（行）。 */
  onRequestCancel: () => void;
  /** 行が自分の「書きかけか」を持つために知らせる（ページの確認は `useReportDirty` が受け持つ）。 */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const editCommitment = useEditCommitment();
  const keyboardHints = useKeyboardHintsVisible();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<string>('preview');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const value = draft ?? commitment.body;
  // 送るのは trim した本文（積むのと揃える。#3788）。だから「変更あり」も trim した値どうしで比べる。
  // 末尾の空白・改行だけを足した下書きは、送れば元と同じ本文になる。それを「変更あり」にすると、
  // 保存が押せるのに何も送らない（または同じ本文を送り直す）形になるので、変更なしとして扱う。
  const dirty = draft !== undefined && draft.trim() !== commitment.body.trim();
  /** 応答が返った時点の「いまの下書き」（送った時点と比べる。issue #3515）。 */
  const latestDraft = useLatest(draft);

  // 書きかけかどうかをスコープへ知らせる。編集欄が閉じたら（保存・やめる）書きかけでなくなる。
  useReportDirty(commitment.id, dirty);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // 書きかけの下書きをページへ写す。**unmount では消さない**（行が一覧から外れたときに、ページが
  // 断りとして残す。畳む・やめるは `OpenRow` の `closeEditor` が明示的に消す）。
  useEffect(() => {
    onTrack({ draft: dirty ? draft : undefined });
  }, [dirty, draft, onTrack]);

  function save() {
    // 保存中は何もしない。ボタン・⌘/Ctrl+Enter・⌘/Ctrl+S のどの経路もここを通る（#3300）。
    if (busy) return;
    // 変更が無ければ送らない。ボタンと ⌘/Ctrl+Enter は `dirty` で止まるが、⌘/Ctrl+S はここへ直接来る（#3749）。
    if (!dirty) return;
    if (draft === undefined || draft.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    onTrack({ editFailure: undefined });
    onSettling(true);
    // 送った値を控える。成功のあと、いまの下書きがこれと同じときだけ畳む（issue #3515）。
    const sent = draft.trim();
    editCommitment(commitment.id, sent)
      // 成功したら編集モードを畳む。一覧は `useEditCommitment` の中で
      // 取り直されるので、この行の `commitment` はすぐ新しい本文へ差し替わる。
      // 応答を待つ間に打ち足した分があるときは畳まず、下書きを残す。
      .then(
        () => {
          // 送った値は trim 済みなので、いまの下書きも trim して比べる（末尾の空白だけの打ち足しは本文が変わらない）。
          if (latestDraft.current?.trim() === sent) onCancel();
          setBusy(false);
          onSettling(false);
        },
        (caught: unknown) => {
          // 一覧の取り直しが先に行を消すことがある（409）。行の state は届かないので、ページにも渡す。
          // 失敗の記録と「待ちが終わった」は同じ処理の中で行う（別の描画だと、行が消えた断りが失敗の無い形で一瞬出る）。
          setFailure(caught);
          onTrack({ editFailure: caught });
          setBusy(false);
          onSettling(false);
        },
      );
  }

  return (
    <div className="mt-2 rounded-md border border-border">
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="flex gap-1 border-b border-border px-2">
          <Tabs.Trigger
            value="preview"
            className={cn(
              EDITOR_TAB_TRIGGER_CLASS,
              tab === 'preview' && EDITOR_TAB_TRIGGER_ACTIVE_CLASS,
            )}
          >
            プレビュー
          </Tabs.Trigger>
          <Tabs.Trigger
            value="edit"
            className={cn(
              EDITOR_TAB_TRIGGER_CLASS,
              tab === 'edit' && EDITOR_TAB_TRIGGER_ACTIVE_CLASS,
            )}
          >
            編集
          </Tabs.Trigger>
        </Tabs.List>

        {/*
          `draft` はこの `Tabs.Root` の外（`CommitmentBodyEditor` 自身）に在る
          （部品冒頭の doc）。プレビューが映すのは保存前の `value`
          （= draft ?? commitment.body）そのもので、描き方はその行の `origin`
          に従う（`CommitmentBody` — 一覧に出ているのと同じ見え方）。
        */}
        <Tabs.Content value="preview" className="px-2 py-2">
          <CommitmentBody commitment={{ ...commitment, body: value }} />
        </Tabs.Content>

        <Tabs.Content value="edit" className="px-2 py-2">
          <Textarea
            aria-label={`「${snippet(commitment.body)}」の本文`}
            className="min-h-32 font-mono text-xs leading-relaxed"
            maxHeight="60vh"
            onSubmitShortcut={save}
            submitDisabled={!dirty || value.trim() === '' || busy}
            value={value}
            spellCheck={false}
            // **Enter は改行のまま**（送信のキーにしない）。長文になりうる本文
            // 欄なので、`Input`（片付ける理由・積む本文）と違って Enter 単体
            // 送信にしていない——だからここには IME の門（`isComposing` /
            // `keyCode === 229`）を付けていない。送信は保存ボタン・Cmd/Ctrl+Enter（共有の
            // `Textarea` の `onSubmitShortcut`。#3242）・Cmd/Ctrl+S で、どれも Enter 単体の確定と衝突しない
            // （`memory-detail.tsx` と同じ設計）。Cmd/Ctrl+S は下の案内にも出す（#3788。
            // 共有の `MarkdownEditor` の既定の案内「⌘/Ctrl + S で保存」と同じ文言）。
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                save();
              }
            }}
          />
        </Tabs.Content>
      </Tabs.Root>

      <div className="flex items-center gap-2 px-2 py-2">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!dirty || value.trim() === ''}
          onClick={save}
        >
          保存
        </Button>
        {tab === 'edit' && keyboardHints && (
          <span className="text-[11px] text-muted-foreground select-none">⌘/Ctrl + S で保存</span>
        )}
        {tab === 'edit' && <SubmitHint action="保存" />}
        <Button size="sm" onClick={onRequestCancel}>
          やめる
        </Button>
      </div>

      <ErrorNote error={failure} className="mx-2 mb-2" />
    </div>
  );
}

/**
 * 行（`OpenRow`）がページへ写す、書きかけと出したままの失敗（issue #3751）。
 * 行が裏で片付いて一覧から外れたとき、`OrphanNotes` がこれを断りつきで残す。
 */
interface RowNote {
  /** 行が最後に見ていた依頼（外れたあとも本文を見せるため）。 */
  commitment: Commitment;
  /** 本文の編集の書きかけ（元の本文と違うときだけ）。 */
  draft?: string;
  /** 片付けた理由の書きかけ（空白だけなら無い）。 */
  reason?: string;
  /** 本文の保存の失敗（409 など）。 */
  editFailure?: unknown;
  /** 片付けるの失敗（409 など）。 */
  closeFailure?: unknown;
  /** 自分の「片付いた」が通った印（断りが「既に片付いた」と他人事に言わないため。#3842）。 */
  closedHere?: true;
}
type RowNotePatch = Partial<Omit<RowNote, 'commitment'>>;

function isEmptyNote(note: RowNote): boolean {
  return (
    note.draft === undefined &&
    note.reason === undefined &&
    note.editFailure === undefined &&
    note.closeFailure === undefined
  );
}

function sameNote(a: RowNote, b: RowNote): boolean {
  return (
    a.commitment === b.commitment &&
    a.draft === b.draft &&
    a.reason === b.reason &&
    a.editFailure === b.editFailure &&
    a.closeFailure === b.closeFailure &&
    a.closedHere === b.closedHere
  );
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/**
 * 一覧から外れた（裏で片付いた）行の、書きかけと失敗を残して断る（issue #3751）。
 * 承認の画面の `LeftoverDrafts`（#3515）と同じ形——**黙って消さない**。写して、閉じられる。
 *
 * 書きかけ（本文の下書き・理由）が在るあいだは離れる前の確認にも載せる。消えてよいと使い手が
 * 決める（閉じる）までは、まだ使い手が書いたものが画面にしか無いため。失敗の本文だけのときは
 * 載せない（使い手が書いたものではなく、読めば済む）。
 */
function OrphanNotes({
  orphans,
  onDismiss,
}: {
  orphans: { note: RowNote; current: Commitment | undefined }[];
  onDismiss: (id: string) => void;
}) {
  if (orphans.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-3" aria-label="一覧から外れた仕事">
      {orphans.map(({ note, current }) => (
        <OrphanNote key={note.commitment.id} note={note} current={current} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}

function OrphanNote({
  note,
  current,
  onDismiss,
}: {
  note: RowNote;
  /** いまの一覧が持つ同じ id の行（片付いた行を見る表示のときだけ在る）。 */
  current: Commitment | undefined;
  onDismiss: (id: string) => void;
}) {
  const { commitment } = note;
  // 行が持っていた id と同じものを使う（行の unmount と入れ替わるとき、確認が一瞬も途切れない）。
  useReportDirty(commitment.id, note.draft !== undefined);
  useReportDirty(`close-reason:${commitment.id}`, note.reason !== undefined);
  return (
    <li className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
      <p className="mb-2 break-words">
        {note.closedHere === true ? (
          <strong>この仕事は片付けた。編集中だった本文の書きかけは残してある。</strong>
        ) : (
          <>
            <strong>この仕事は既に片付いた（または未了の一覧から外れた）。</strong>
            書きかけは残してある。
          </>
        )}
        ここから保存や片付けはできないので、必要なら写してから閉じる。
        <span className="mt-1 block text-xs text-muted-foreground">
          対象: 「{snippet(commitment.body)}」
        </span>
        {current?.closedReason !== undefined && (
          <span className="mt-1 block text-xs text-muted-foreground">
            片付けた理由: {redactBody(current.closedReason ?? '')}
          </span>
        )}
      </p>
      {note.draft !== undefined && (
        <CodeBlock label="書きかけの本文" maxHeight="12rem">
          {note.draft}
        </CodeBlock>
      )}
      {note.reason !== undefined && (
        <CodeBlock label="書きかけの片付けた理由" maxHeight="12rem" className="mt-2">
          {note.reason}
        </CodeBlock>
      )}
      <ErrorNote error={note.editFailure} className="mt-2" />
      <ErrorNote error={note.closeFailure} className="mt-2" />
      <div className="mt-2">
        <Button size="sm" onClick={() => onDismiss(commitment.id)}>
          閉じる（見送る）
        </Button>
      </div>
    </li>
  );
}

const SNIPPET_MAX = 20;

/** 行ごとの入力欄の名前に入れる、依頼の頭の数文字（同じ見た目の欄が並ぶので、どの行かを区別する）。 */
function snippet(body: string): string {
  const flat = redactBody(body).replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat;
}

function OpenRow({
  commitment,
  onTrack,
  onSettling,
}: {
  commitment: Commitment;
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
}) {
  const closeCommitment = useCloseCommitment();
  const reasonId = useId();
  const reasonHintId = useId();
  // 「N分前」を分の時計で動かす（#3748。刻みは全行で1本）。
  const now = useMinuteNow();
  const [reason, setReason] = useState('');
  // 書きかけ・失敗をページへ写す（行が一覧から外れても残すため。#3751）。依頼が取り直しで変わったら、
  // 写しの「最後に見ていた依頼」も差し替わる（同じ値は no-op）。
  const track = useCallback(
    (patch: RowNotePatch) => onTrack(commitment, patch),
    [onTrack, commitment],
  );
  const settling = useCallback(
    (on: boolean) => onSettling(commitment.id, on),
    [onSettling, commitment.id],
  );
  // **unmount では消さない**（行が外れたらページが断りとして残す）。成功・やめるは明示的に消す。
  useEffect(() => {
    track({ reason: reason.trim() !== '' ? reason : undefined });
  }, [reason, track]);
  // 片付けた理由の書きかけも離れる前の確認へ知らせる（#3750）。本文の編集（`commitment.id`）とは別の id。
  useReportDirty(`close-reason:${commitment.id}`, reason.trim() !== '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  /*
   * **編集の入口は `origin` で隠さない。未了の行にはすべて出す。**
   *
   * ⚠️ ここには以前 `const editable = commitment.origin === 'human'` が在り、
   * 「それ以外の行に入口を出すと、押しても 403 で断られるだけの死んだボタンに
   * なる」と書いてあった。**その判断を覆した**（issue #580 の (C)）。隠すと、
   * 断られること自体は防げても**なぜ直せないのかが画面から消える**——人間には
   * 「編集できない」としか見えず、理由は1文字も出ない。
   *
   * 乗せた線は、この repo が同じ論点で既に持っているもの
   * （`packages/swr/src/hooks/mutations.ts` の `useRemoveSchedule`）:
   * 「画面側でボタンを隠して表現しないこと — 隠すと「なぜ押せないか」が
   * 消える。押せて、断られた理由がその場に出るほうが読める。」
   *
   * **⚠️ そして「誰が編集を許されるか」という規則を、ここへ写さないこと。**
   * 断るのはサーバ（`PATCH /commitments/:id`）で、403 の本文がその行の
   * `origin` を名指しして理由を言う。それが `CommitmentBodyEditor` の
   * `ErrorNote` にそのまま出る。**画面が持ってよいのは「この行の `origin` は
   * 何か」というデータまでで**（バッジと本文の描き分け）、規則を写せば
   * サーバ側の線が変わった日に画面だけが黙ってずれる。
   */
  const [editing, setEditing] = useState(false);
  // この行の編集欄が書きかけか（編集欄が知らせてくる。ページへ渡す前にここでも持つ）。
  const [editDirty, setEditDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  function closeEditor() {
    setEditing(false);
    setEditDirty(false);
    setConfirmingDiscard(false);
    track({ draft: undefined, editFailure: undefined });
  }
  /** 「編集をやめる」「やめる」。書きかけがあるときだけ確かめる（#3375）。 */
  function requestCloseEditor() {
    if (editDirty) setConfirmingDiscard(true);
    else closeEditor();
  }

  async function submit() {
    // Enter はボタン（`loading` で塞がる）を通らないので、送信中の門はここで持つ。
    if (busy || reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    track({ closeFailure: undefined });
    // 応答を待つ間は、行が一覧から消えても断りにしない（一覧は応答より先に取り直される）。
    settling(true);
    try {
      await closeCommitment(commitment.id, reason.trim());
      // 成功したら一覧から消える（部品ごと消える）ので、入力を戻す必要はない。ページの写しだけ消す。
      track({ reason: undefined, closeFailure: undefined, closedHere: true });
    } catch (caught) {
      setFailure(caught);
      // 一覧の取り直しが先に行を消すことがある（409）。ページにも渡し、行が消えても失敗の本文を見せる。
      track({ closeFailure: caught });
    } finally {
      setBusy(false);
      settling(false);
    }
  }

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <OriginBadge commitment={commitment} />
        <EditedBadge commitment={commitment} />
        <AnsweredStateBadge commitment={commitment} />
        <InProgressBadge commitment={commitment} />
        <span>{formatDateTime(commitment.at)}</span>
        {/* 齢。器は優先度も締切も持たないので、急ぎ方を決める材料はこれだけである。 */}
        <span>({formatRelativeAtMinute(commitment.at, now)})</span>
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline hover:text-foreground pointer-coarse:-my-3.5 pointer-coarse:-mr-3 pointer-coarse:px-3 pointer-coarse:py-3.5"
          aria-label={
            editing
              ? `「${snippet(commitment.body)}」の編集をやめる`
              : `「${snippet(commitment.body)}」の本文を編集`
          }
          onClick={() => (editing ? requestCloseEditor() : setEditing(true))}
        >
          {editing ? '編集をやめる' : '本文を編集'}
        </button>
      </div>

      {/*
        本文は器が全文を持つ（要約を持たせない）。畳まずにそのまま出す。
        **編集中の行だけ `CommitmentBodyEditor` を mount する**——一覧の
        重さが行数に比例して増えないよう、Tabs / Textarea の実体を持つのは
        開いている1件だけにする（`CommitmentBodyEditor` の doc）。
      */}
      {editing ? (
        <CommitmentBodyEditor
          commitment={commitment}
          onCancel={closeEditor}
          onRequestCancel={requestCloseEditor}
          onDirtyChange={setEditDirty}
          onTrack={track}
          onSettling={settling}
        />
      ) : (
        <CommitmentBody commitment={commitment} />
      )}

      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        title="保存していない変更があります"
        description="編集をやめると、書きかけの内容は失われます。"
        confirmLabel="破棄して閉じる"
        destructive
        onConfirm={closeEditor}
      />

      <label htmlFor={reasonId} className="mt-2 block text-xs font-medium text-muted-foreground">
        片付けた理由
      </label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id={reasonId}
          aria-describedby={reasonHintId}
          value={reason}
          aria-label={`「${snippet(commitment.body)}」を片付けた理由`}
          placeholder="例: 修正を入れて確認した"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            // IME 変換中の Enter を拾わない。ここは Enter 単体で送るので、
            // 変換確定の Enter がそのまま誤送信になる（`ChatComposer` の
            // ⌘/Ctrl+Enter より直接踏む形）。門の形と理由（`event.nativeEvent.isComposing`
            // を見る理由・`keyCode === 229` を併用する理由）は `packages/ui/src/components/features/chat/ime.ts` の `isImeConfirmEnter` と `packages/ui/src/components/features/chat/chat-composer.tsx` の
            // 「IME で変換している最中の Enter では送らない。」のコメントを参照。
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            ) {
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          loading={busy}
          aria-label={`「${snippet(commitment.body)}」が片付いた`}
          // **理由なしでは閉じられない。** 「閉じた」だけが残ると、人間が後から
          // 否定できない（north_star の最終承認はそこで成り立っている）。
          disabled={reason.trim() === ''}
          onClick={() => void submit()}
        >
          片付いた
        </Button>
      </div>
      <FieldHint id={reasonHintId} className="mt-1.5">
        何をもって片付いたかを書く。後から否定できるように残る。
      </FieldHint>

      <ErrorNote error={failure} className="mt-2" />
    </li>
  );
}

function ClosedRow({ commitment }: { commitment: Commitment }) {
  return (
    <li className="border-b border-border px-4 py-3 text-muted-foreground last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone="ok">片付いた</Badge>
        <OriginBadge commitment={commitment} />
        <EditedBadge commitment={commitment} />
        <span>
          {formatDateTime(commitment.at)} → {formatDateTime(commitment.closedAt ?? '')}
        </span>
      </div>
      <CommitmentBody commitment={commitment} />
      <ClosedReasonBody commitment={commitment} />
    </li>
  );
}

/** `closedReason` のラベルと素テキストをまとめて描く（`clone` 以外の3状態で共通）。 */
function PlainClosedReason({ reason }: { reason: string }) {
  return (
    <p className="mt-1 text-xs break-words whitespace-pre-wrap">
      <span className="mr-2 text-[11px]">どう片付いたか</span>
      {reason}
    </p>
  );
}

/**
 * `closedReason`（どう片付いたか）の描き方を `closedBy`（誰が書いたか）で
 * 切り分ける。`CommitmentBody` と同じ形（narrow してから switch）だが、
 * ここが見る軸は `origin` ではなく `closedBy` である — 別の軸である理由は
 * `commitmentClosedBySchema` の doc（`packages/core/src/schema.ts`）を見よ。
 *
 * **実行時に区別すべき状態は4つ:**
 *
 * | `closedBy` | 描き方 | 理由 |
 * | --- | --- | --- |
 * | `'clone'` | `<Markdown>` | AI が書いた |
 * | `'human'` | 素テキスト（`whitespace-pre-wrap` を保つ） | 人間が打った文字を化けさせない（`grep -Fn -- 'クローンの行だけを Markdown にする' packages/ui/src/components/features/chat/chat-message.tsx` と同じ線） |
 * | `undefined` | 素テキスト | **「そもそも無い」。** この欄が入る前に閉じられた行にはこの情報が存在しない |
 * | 上記以外（実行時のみ来うる） | 素テキスト＋`console.warn` | デーモンが先に新しい値を返す順序に備える。**`undefined` と同じ扱いにしない** — warn の有無で見分けが付く（`undefined` は warn しない） |
 *
 * **保存層（`commitmentSchema.closedBy`）は `z.string()` で緩く持つ。**
 * `packages/storage-pg/src/commitments.ts` の `parseCommitment` が読めない
 * 行で throw し `list()` がそれを try/catch 無しで map するため、未知の
 * 値が1つ入っただけで台帳の一覧が丸ごと読めなくなるのを避けるためである
 * （`commitmentSchema` の doc）。**表示側までその緩さを引き継がない** —
 * ここでは `isKnownCommitmentClosedBy` で狭めてから分岐する
 * （`commitmentClosedBySchema` の値をこのファイル内に複製したもの。理由は
 * `isKnownCommitmentClosedBy` の doc）。
 */
function ClosedReasonBody({ commitment }: { commitment: Commitment }) {
  if (commitment.closedReason === undefined || commitment.closedReason === null) return null;
  // 4経路すべてが通る入口で伏せる（経路ごとに足すと、足し忘れた経路から素のまま出る）。
  const reason = redactBody(commitment.closedReason);

  // **「そもそも無い」。** 既定へ倒さない（`'clone'` にも `'human'` にもしない）。
  if (commitment.closedBy === undefined) return <PlainClosedReason reason={reason} />;

  if (!isKnownCommitmentClosedBy(commitment.closedBy)) {
    // **`undefined` とは別扱い。** ここでだけ warn する（`undefined` は warn しない）。
    console.warn(
      `commitments.tsx: 未知の commitment.closedBy が来た（undefined とは別扱い）: ${String(commitment.closedBy)}`,
    );
    return <PlainClosedReason reason={reason} />;
  }

  const closedBy = commitment.closedBy;
  switch (closedBy) {
    case 'clone':
      return (
        <div className="mt-1 text-xs">
          <span className="mr-2 text-[11px]">どう片付いたか</span>
          <Markdown>{reason}</Markdown>
        </div>
      );

    case 'human':
      return <PlainClosedReason reason={reason} />;

    default:
      assertClosedByHandled(closedBy);
      return <PlainClosedReason reason={reason} />;
  }
}

/** 書きかけの集合（`LeaveGuardScope`）での「仕事を登録する」欄の id。行の id（commitment.id）と衝突しない。 */
const PUSH_FORM_DIRTY_ID = 'push-form';

/**
 * 人間の手で積む口。
 *
 * **読めるだけにしない。** 積みたい場面はたいてい「いま言ったことを忘れられたら
 * 困る」ときなので、クローンのターンを1回起こさないと書けないのは重い。
 * CLI の `/commit` と同じ経路である（片方でしかできないことを作らない）。
 */
function PushForm() {
  const pushCommitment = usePushCommitment();
  const inputId = useId();
  const bodyHintId = useId();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const { data, mutate } = useCommitments(false);
  const dataRef = useLatest(data);

  // 書きかけ（空でない）かどうかをスコープへ知らせる（離れる前の確認はページに1つ。#2764）。
  useReportDirty(PUSH_FORM_DIRTY_ID, body !== '');

  async function submit() {
    const text = body.trim();
    if (text === '') return;
    const sent = body;
    // 積む前の一覧。読めていないときは undefined（「無かった行」を決められない）。
    const before = dataRef.current && new Set(dataRef.current.entries.map((entry) => entry.id));
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      await pushCommitment(text);
      // 応答を待つ間に打ち足した分は残す（issue #3515）。
      setBody((current) => unsentInput(current, sent));
    } catch (caught) {
      // サーバは冪等の鍵を持たず、送り直すと同じ本文が二重に載る。届いたか分からない失敗（接続断・タイムアウト・5xx）
      // のときだけ、取り直した一覧に積む前に無かった同じ本文の行が在るかで、届いたかを確かめる。
      const unknown =
        !(caught instanceof ApiError) || caught.status >= 500 || caught.status === 408;
      const landed =
        unknown &&
        before !== undefined &&
        ((await mutate())?.entries ?? []).some(
          (entry) => !before.has(entry.id) && entry.body.trim() === text,
        );
      if (landed) {
        setBody((current) => unsentInput(current, sent));
        setNotice('応答は届かなかったが、台帳には載っている。送り直さなくてよい。');
      } else {
        setFailure(caught);
        if (unknown)
          setNotice(
            '届いたか分からない。台帳の一覧を確かめてから送り直すこと（二重に載ることがある）。',
          );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="仕事を登録する" subtitle="引き受けたことを、片付くまで残す" />
      <div className="flex flex-col gap-2 px-4 py-3">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          何を引き受けたか
        </label>
        {/*
          複数行の `Textarea`（編集欄 `CommitmentBodyEditor` と同じ部品。#3376）。**Enter は改行**で、
          登録は積むボタン・Cmd/Ctrl+Enter（共有の `Textarea` の `onSubmitShortcut`）。
          IME の変換確定の Enter は改行にもならず送りにもならない（`isSubmitShortcut` が除く）。
        */}
        <Textarea
          id={inputId}
          aria-describedby={bodyHintId}
          rows={3}
          maxHeight="60vh"
          value={body}
          placeholder="例: 金曜までに週次レビューを出す"
          onChange={(event) => setBody(event.target.value)}
          onSubmitShortcut={() => void submit()}
          submitDisabled={body.trim() === '' || busy}
        />
        <FieldHint id={bodyHintId} className="-mt-1">
          何を引き受けたかを全文で書く。クローンへ渡す一覧（commitment_list）は長い本文を先頭だけに切るが、台帳には全文が残る。
        </FieldHint>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={busy}
            disabled={body.trim() === ''}
            onClick={() => void submit()}
          >
            積む
          </Button>
          <SubmitHint action="登録" />
        </div>
        <ErrorNote error={failure} />
        {notice !== undefined && (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </Card>
  );
}
