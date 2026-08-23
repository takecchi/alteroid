import { useState } from 'react';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useCloseCommitment, usePushCommitment } from '~/hooks/mutations';
import { useCommitments } from '~/hooks/queries';
import { commitmentClosedBySchema, textMarkupSchema } from '@alteroid/core';
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

/**
 * `ORIGIN_LABEL[origin]` の実行時の倒れ先（issue #288）。
 *
 * **`ORIGIN_LABEL` は `Record<CommitmentOrigin, string>` のまま維持する** —
 * これがビルド時の網羅性そのものである（`commitmentOriginSchema`
 * （`packages/core/src/schema.ts:892`）に新しい値が足されると、この
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

function OriginBadge({ commitment }: { commitment: Commitment }) {
  return (
    <Badge tone={commitment.origin === 'human' ? 'accent' : 'neutral'}>
      {originLabel(commitment.origin)}
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

/** `human` / `external` の描き方（理由は後述の `CommitmentBody` の doc）。素のテキストのまま。 */
function PlainBody({ body }: { body: string }) {
  return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{body}</p>;
}

/**
 * **網羅性チェック専用（ビルド時）。** `CommitmentBody` の `switch` の
 * `default` から呼ぶ。引数の型は `never` — `commitmentOriginSchema`
 * （`packages/core/src/schema.ts:892`）に新しい値が足されたのに、上の
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
 * `ClosedReasonBody` が `commitmentClosedBySchema.safeParse` で弾いた
 * 時点で別に `console.warn` している（この関数より手前）。**この関数が
 * 実際に呼ばれるのは、`commitmentClosedBySchema` に値が足されたのに
 * `switch` 側の `case` が追いついていない、という版のずれのときだけである。**
 */
function assertClosedByHandled(closedBy: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.closedBy: ${String(closedBy)}`);
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
 * `ManagerRestBody` が `textMarkupSchema.safeParse` で弾いた時点で別に
 * `console.warn` している（この関数より手前）。**この関数が実際に呼ばれる
 * のは、`textMarkupSchema` に値が足されたのに `switch` 側の `case` が
 * 追いついていない、という版のずれのときだけである。**
 */
function assertMarkupHandled(markup: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.bodyMarkup: ${String(markup)}`);
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
 * 緩さを引き継がない** — ここでは `textMarkupSchema.safeParse` で狭めて
 * から分岐する。
 */
function ManagerRestBody({ rest, bodyMarkup }: { rest: string; bodyMarkup: string | undefined }) {
  if (bodyMarkup === undefined) return <Markdown>{rest}</Markdown>;

  const known = textMarkupSchema.safeParse(bodyMarkup);
  if (!known.success) {
    // **`undefined` とは別扱い。** ここでだけ warn する（`undefined` は warn しない）。
    console.warn(
      `commitments.tsx: 未知の commitment.bodyMarkup が来た（undefined とは別扱い）: ${String(bodyMarkup)}`,
    );
    return <PlainBody body={rest} />;
  }

  const markup = known.data;
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
 * 1. **3種類のどれも、人間が打った文字ではない。** 人間の指示が守ろうとして
 *    いるもの（`chat.tsx:710`「自分が書いた文字が勝手に化けないため」）は、
 *    ここでは1件も当たらない
 * 2. **2 は既に本文に `**…**` を持っている**（上の逐語、`manager.ts:1623` /
 *    `2294`）。素のテキストで描くと `**` がそのまま画面に出る。Markdown 側に
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
 * （`manager.ts:2665` の `…挑み直します: ${event.reason}` がその形）。切り分け
 * ようとすると本文の中身を判定することになるが、それは `manager.ts:2157`
 * 付近のコメントが「一覧を出す側は『報告が来た』と『エラーで死んだ』を本文の
 * 先頭を読んで判定することになる（＝ 表示のたびに文言の判定が要る）」として
 * `manager.ts` 自身が避けている形である。**同じ種類の文字列（SDK のエラー文）
 * が、`reports.tsx:42` とこことで扱いが食い違う。この食い違いと、3種類が
 * 型で区別されずに混ざっている件そのものは issue #287 に記録してある。**
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
  switch (commitment.origin) {
    case 'self':
      return <Markdown>{commitment.body}</Markdown>;

    case 'manager': {
      const { prefix, rest } = splitManagerPrefix(commitment.body);
      return (
        <div className="min-w-0">
          {prefix !== null && (
            <span className="mr-1 font-mono text-[11px] text-muted">{prefix}</span>
          )}
          <ManagerRestBody rest={rest} bodyMarkup={commitment.bodyMarkup} />
        </div>
      );
    }

    case 'human':
    case 'external':
      return <PlainBody body={commitment.body} />;

    default:
      /*
       * **実行時はここへ来うる（ビルド時の網羅性チェックとは別の話）。**
       * デーモンが先に新しい `origin` を返し、この画面（この型定義）が
       * まだ古い、という順序はありうる — 型はビルド時にしか効かない。
       * そのときに空白を描くのは、いまより悪い。**だから実行時は安全側
       * （素のテキスト）へ倒し、本文は commitment.body のまま1文字も消さない。**
       */
      assertOriginHandled(commitment.origin);
      return <PlainBody body={commitment.body} />;
  }
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
 * | `'human'` | 素テキスト（`whitespace-pre-wrap` を保つ） | 人間が打った文字を化けさせない（`chat.tsx:710` と同じ線） |
 * | `undefined` | 素テキスト | **「そもそも無い」。** この欄が入る前に閉じられた行にはこの情報が存在しない |
 * | 上記以外（実行時のみ来うる） | 素テキスト＋`console.warn` | デーモンが先に新しい値を返す順序に備える。**`undefined` と同じ扱いにしない** — warn の有無で見分けが付く（`undefined` は warn しない） |
 *
 * **保存層（`commitmentSchema.closedBy`）は `z.string()` で緩く持つ。**
 * `packages/storage-pg/src/commitments.ts` の `parseCommitment` が読めない
 * 行で throw し `list()` がそれを try/catch 無しで map するため、未知の
 * 値が1つ入っただけで台帳の一覧が丸ごと読めなくなるのを避けるためである
 * （`commitmentSchema` の doc）。**表示側までその緩さを引き継がない** —
 * ここでは `commitmentClosedBySchema.safeParse` で狭めてから分岐する。
 */
function ClosedReasonBody({ commitment }: { commitment: Commitment }) {
  if (commitment.closedReason === undefined || commitment.closedReason === null) return null;
  const reason = commitment.closedReason;

  // **「そもそも無い」。** 既定へ倒さない（`'clone'` にも `'human'` にもしない）。
  if (commitment.closedBy === undefined) return <PlainClosedReason reason={reason} />;

  const known = commitmentClosedBySchema.safeParse(commitment.closedBy);
  if (!known.success) {
    // **`undefined` とは別扱い。** ここでだけ warn する（`undefined` は warn しない）。
    console.warn(
      `commitments.tsx: 未知の commitment.closedBy が来た（undefined とは別扱い）: ${String(commitment.closedBy)}`,
    );
    return <PlainClosedReason reason={reason} />;
  }

  const closedBy = known.data;
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
