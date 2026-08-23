import { useState } from 'react';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useCloseCommitment, usePushCommitment } from '~/hooks/mutations';
import { useCommitments } from '~/hooks/queries';
import type { Commitment, CommitmentOrigin } from '@alteroid/core';
import { formatDateTime, formatRelative } from '~/lib/format';

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
  const [showClosed, setShowClosed] = useState(false);
  const { data, error, isLoading } = useCommitments(showClosed);

  // 並びはデーモンが決めている（未了が古い順、片付いたものが新しい順で後ろ）。
  // **ここで並べ直さない** — 並べ直すと齢の見え方が CLI・クローンと食い違う。
  const all = data?.entries ?? [];
  const open = all.filter((commitment) => !isClosed(commitment));
  const closed = all.filter(isClosed);

  return (
    <Page
      title="引き受けたまま終わっていない仕事"
      description="受信箱でも日誌でもここには残らない。忘れさせないための器であって、やることの一覧ではない"
      action={
        <Button size="sm" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? '未了だけ' : '片付けたものも見る'}
        </Button>
      }
    >
      <ErrorNote error={error} className="mb-4" />

      <PushForm />

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <Card className="mb-4">
            <CardHeader
              title="未了"
              subtitle="古い順。齢がそのまま「どれだけ放置されているか」である"
            />
            {open.length === 0 ? (
              <Empty>引き受けたまま終わっていない仕事はない。</Empty>
            ) : (
              <ul>
                {open.map((commitment) => (
                  <OpenRow key={commitment.id} commitment={commitment} />
                ))}
              </ul>
            )}
          </Card>

          {/*
            片付けたものは、押されたときだけ取りに行く。器は行を消さないので
            （「何を片付けたか」は日報の材料である）、読む手立てを画面にも置く。
          */}
          {showClosed && (
            <Card>
              <CardHeader
                title="片付いたもの"
                subtitle="新しい順。何をもって終わりとしたかを残す"
              />
              {closed.length === 0 ? (
                <Empty>片付いた記録はまだない。</Empty>
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

function OriginBadge({ commitment }: { commitment: Commitment }) {
  return (
    <Badge tone={commitment.origin === 'human' ? 'accent' : 'neutral'}>
      {ORIGIN_LABEL[commitment.origin]}
      {commitment.source !== undefined && commitment.source !== null && ` / ${commitment.source}`}
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
 * 本文の描き方を `origin`（誰が書いたか）で切り分ける。`OpenRow` と
 * `ClosedRow` が同じ本文の `<p>` を2箇所に持っていたのを、ここへ集める。
 *
 * **切り出す理由**: 分岐の中身が増える（`self` / `manager` / `human` /
 * `external` の4方向）ので、2箇所に同じ分岐を書くと片方だけ直し忘れる形が
 * 生まれる。ここへ集めれば分岐は1箇所にしか存在しない
 * （AGENTS.md「テストが書けない構造は、テストが無いのと同じ」— 出力・挙動は
 * 1文字も変えていない切り出しである）。
 *
 * | origin | body の中身 | 描き方 |
 * | --- | --- | --- |
 * | `self` | `commitment_open` のツール引数そのまま（クローンが書いた） | `<Markdown>` |
 * | `manager` | `[kind] text`。`kind` は閉じた3値、`text` は下記の3種が混ざる | 接頭辞は素、残りは `<Markdown>` |
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
 *    など。`manager.ts:2190` / `2225` / `2500`）
 * 2. **デーモンが組み立てた通知文**（`manager.ts:1333` / `1623` / `1727` /
 *    `1766` / `2830` / `2294` / `2665` など）。**このうち複数は本文に既に
 *    Markdown の記法を含む**（実例、`manager.ts:1623` の逐語）:
 *    「この委譲は`**`自分より新しい世代の誰かが握っています`**`。…
 *    `**`新しく起こし直さないでください`**`」（`2294` にも同様の例がある）
 * 3. **SDK / runner が出したエラー文**（`manager.ts:2694`
 *    `#emit(event.managerId, 'report', event.reason)` など。1・2 の文の末尾に
 *    埋め込まれて届くことも多い、例: `2665` の `…挑み直します: ${event.reason}`）
 *
 * **3 は `apps/web/app/routes/reports.tsx:42` が「`Markdown` で描かないこと。
 * 中身は SDK が出したエラー文であって、クローンが書いた文章ではない」と
 * 書いているものと同じ種類である。それでもここでは `manager` を丸ごと
 * Markdown のままにする。** 理由は3つ:
 *
 * - **3種類のどれも、人間が打った文字ではない。** 人間の指示が守ろうとして
 *   いるもの（`chat.tsx:710`「自分が書いた文字が勝手に化けないため」）は、
 *   ここでは1件も当たらない
 * - **2 は既に Markdown の記法を本文に持っている**（上の逐語）。素のテキストで
 *   描くと `**…**` がそのまま画面に出る。Markdown 側に倒すのは、いまの表示の
 *   修正でもある
 * - **3 だけを切り分ける材料が画面にも型にも無い。** `commitment.body` は
 *   1本の文字列で、`origin: 'manager'` に下位の区別が無い。3 が単独で来る
 *   経路（`2694`）はあるが、多くは 1 / 2 の文の末尾に埋め込まれて届くので、
 *   切り分けようとすると本文の中身を判定することになる（それは
 *   `manager.ts:2157` 付近のコメントが「表示のたびに文言の判定が要る」として
 *   避けている形そのもの）。**これは「たまたま踏まなかった」ではなく、
 *   「仕組みでは塞げていない」側である** — 3 が単独で `manager` の本文に来た
 *   とき、SDK のエラー文がそのまま Markdown として描かれることがある。実害は
 *   小さい（エラー文が記法を含むことは稀）が、`reports.tsx:42` の線と正面から
 *   食い違う場所として次に読む人へ残しておく。
 *
 * **`human` を素のままにする理由**: `event.text` は
 * `apps/web/app/routes/chat.tsx:710` が名指しで守っている文字列そのものである
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
 * `POST /commitments/:id/close`（人間）の両方が同じ欄へ書き、**どちらが
 * 書いたかを型が記録していない。** `origin` は開いたときの起点なので判別に
 * 使えない。書き手が判らない以上、Markdown にすると人間が書いた回だけ静かに
 * 化ける。**実装しなかったのではなく、判別する材料が無いので据え置いた。**
 * （`ClosedRow` の `closedReason` は1文字も変えていない。この判別材料の
 * 欠落そのものを issue #286 として立ててある）
 */
function CommitmentBody({ commitment }: { commitment: Commitment }) {
  if (commitment.origin === 'self') {
    return <Markdown>{commitment.body}</Markdown>;
  }

  if (commitment.origin === 'manager') {
    const { prefix, rest } = splitManagerPrefix(commitment.body);
    return (
      <div className="min-w-0">
        {prefix !== null && (
          <span className="mr-1 font-mono text-[11px] text-muted">{prefix}</span>
        )}
        <Markdown>{rest}</Markdown>
      </div>
    );
  }

  // `human` / `external` は素のテキストのまま（理由は上の doc）。
  return (
    <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{commitment.body}</p>
  );
}

function OpenRow({ commitment }: { commitment: Commitment }) {
  const closeCommitment = useCloseCommitment();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function submit() {
    if (reason.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await closeCommitment(commitment.id, reason.trim());
      // 成功したら一覧から消えるので、入力を戻す必要はない（部品ごと消える）。
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <OriginBadge commitment={commitment} />
        <span>{formatDateTime(commitment.at)}</span>
        {/* 齢。器は優先度も締切も持たないので、急ぎ方を決める材料はこれだけである。 */}
        <span>({formatRelative(commitment.at)})</span>
      </div>

      {/* 本文は器が全文を持つ（要約を持たせない）。畳まずにそのまま出す。 */}
      <CommitmentBody commitment={commitment} />

      <div className="mt-2 flex items-center gap-2">
        <Input
          value={reason}
          placeholder="何をもって片付いたか（後から否定できるように残す）"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
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
          // **理由なしでは閉じられない。** 「閉じた」だけが残ると、人間が後から
          // 否定できない（north_star の最終承認はそこで成り立っている）。
          disabled={reason.trim() === ''}
          onClick={() => void submit()}
        >
          片付いた
        </Button>
      </div>

      <ErrorNote error={failure} className="mt-2" />
    </li>
  );
}

function ClosedRow({ commitment }: { commitment: Commitment }) {
  return (
    <li className="border-b border-border px-4 py-3 text-muted last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone="ok">片付いた</Badge>
        <OriginBadge commitment={commitment} />
        <span>
          {formatDateTime(commitment.at)} → {formatDateTime(commitment.closedAt ?? '')}
        </span>
      </div>
      <CommitmentBody commitment={commitment} />
      {/*
        **`closedReason` は1文字も触らない（Markdown 化の対象外）。**
        `commitment_close`（クローン）と `POST /commitments/:id/close`
        （人間）の両方が同じ欄へ書き、**どちらが書いたかを型が記録していない。**
        `origin` は開いたときの起点なので判別に使えない。書き手が判らない以上、
        Markdown にすると人間が書いた回だけ静かに化ける。**実装しなかったの
        ではなく、判別する材料が無いので据え置いた。**
        この判別材料の欠落は issue #286 として立ててある。
      */}
      {commitment.closedReason !== undefined && commitment.closedReason !== null && (
        <p className="mt-1 text-xs break-words">
          <span className="mr-2 text-[11px]">どう片付いたか</span>
          {commitment.closedReason}
        </p>
      )}
    </li>
  );
}

/**
 * 人間の手で積む口。
 *
 * **読めるだけにしない。** 積みたい場面はたいてい「いま言ったことを忘れられたら
 * 困る」ときなので、クローンのターンを1回起こさないと書けないのは重い。
 * CLI の `/commit` と同じ経路である（片方でしかできないことを作らない）。
 */
function PushForm() {
  const pushCommitment = usePushCommitment();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  async function submit() {
    if (body.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await pushCommitment(body.trim());
      setBody('');
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="台帳へ積む" subtitle="引き受けたことを、片付くまで残す" />
      <div className="flex flex-col gap-2 px-4 py-3">
        <Input
          value={body}
          placeholder="何を引き受けたか（全文で書く。切るのは一覧側の仕事）"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div>
          <Button
            variant="primary"
            loading={busy}
            disabled={body.trim() === ''}
            onClick={() => void submit()}
          >
            積む
          </Button>
        </div>
        <ErrorNote error={failure} />
      </div>
    </Card>
  );
}
