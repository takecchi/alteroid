import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Input, Spinner } from '~/components/ui';
import { useCloseCommitment, usePushCommitment } from '~/hooks/mutations';
import { useCommitments } from '~/hooks/queries';
import type {
  Commitment,
  CommitmentClosedBy,
  CommitmentOrigin,
  TextMarkup,
  UnreadableCommitment,
} from '@alteroid/core';
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
  // **読めない行（issue #296）。**「無い」でも「片付いた」でもない第3の状態。
  const unreadable = data?.unreadable ?? [];
  // **保持上限を超えて物理削除された片付き行の累計（issue #416）。**
  // `unreadable` と同じ理由で読む——`data` が無ければ0件として扱う
  // （読み込み中・エラー時に「削除が0件」と誤読させる意図ではなく、後段の
  // `TrimmedClosedNote` は `isLoading` の外では描かれないので実害は無い）。
  const trimmedClosed = data?.trimmedClosed ?? 0;

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
          {/* 一覧の上に置く。読める行の中身を見る前に、まず断りが目に入るように。 */}
          <UnreadableNote unreadable={unreadable} />
          <TrimmedClosedNote trimmedClosed={trimmedClosed} />

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
            片付けたものは、押されたときだけ取りに行く。器は行を消さない契約
            なので（「何を片付けたか」は日報の材料である）、読む手立てを画面にも
            置く。**ただし fs 実装は保持上限を超えた古い片付き行を物理削除する
            （issue #416）——削除された累計件数は上の TrimmedClosedNote が持つ。**
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
 * 読めない行が在ることを、一覧の上で断る（issue #296）。
 *
 * **新しい共有部品を増やさない。** `ErrorNote`（`~/components/ui`）と同じ
 * 配色の作法を warn 色で使い回す — `apps/web/app/routes/journal.tsx` の
 * `BlockedNote`（「終端でも空でもない、本物の限界だと分かる形にする」）と
 * 同じ考え方で、この画面にもローカルに1つだけ置く。
 *
 * **「無い」でも「片付いた」でもない第3の状態を、`Empty` の顔にしない。**
 * `Empty`（灰色・控えめ）は「無い」を表す部品なので、読めない行の存在を
 * そこへ混ぜると「特に何も無い」に見えてしまう。
 *
 * **0件なら描かない。** 常に出る断りは、出ていることが情報にならない
 * （`~/components/ui` の `TruncationNote` と同じ判定）。
 *
 * **id が取れない行は件数だけに数える**（`commitment_list` ツール・digest と
 * 同じ扱い。`packages/core/src/tools.ts` / `digest.ts`）。
 */
function UnreadableNote({ unreadable }: { unreadable: UnreadableCommitment[] }) {
  if (unreadable.length === 0) return null;
  const ids = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        読めない行が {unreadable.length} 件ある{ids.length > 0 && `（id: ${ids.join(', ')}）`}。
        <strong>片付いたのではない。</strong>
      </span>
    </div>
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
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        保持上限を超えて物理削除された片付き行が累計 {trimmedClosed} 件ある。
        <strong>削除された分の内容はここでは二度と読めない。</strong>
      </span>
    </div>
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
 *    など。`manager.ts:2223` / `2258` / `2533`）
 * 2. **デーモンが組み立てた通知文**（`manager.ts:1365` / `1656` / `1760` /
 *    `1799` / `2863` / `2327` / `2698` など）。**このうち複数は本文に既に
 *    Markdown の記法を含む**（実例、`manager.ts:1656` の逐語）:
 *    「この委譲は`**`自分より新しい世代の誰かが握っています`**`。…
 *    `**`新しく起こし直さないでください`**`」（`2327` にも同様の例がある）
 * 3. **SDK / runner が出したエラー文**（`manager.ts:2727`
 *    `#emit(event.managerId, 'report', event.reason)` など。1・2 の文の末尾に
 *    埋め込まれて届くことも多い、例: `2698` の `…挑み直します: ${event.reason}`）
 *
 * **3 は `apps/web/app/routes/reports.tsx:42` が「`Markdown` で描かないこと。
 * 中身は SDK が出したエラー文であって、クローンが書いた文章ではない」と
 * 書いているものと同じ種類である。それでもここでは `manager` を丸ごと
 * Markdown のままにする。** 理由は3つ:
 *
 * 1. **3種類のどれも、人間が打った文字ではない。** 人間の指示が守ろうとして
 *    いるもの（`chat.tsx:710`「自分が書いた文字が勝手に化けないため」）は、
 *    ここでは1件も当たらない
 * 2. **2 は既に本文に `**…**` を持っている**（上の逐語、`manager.ts:1656` /
 *    `2327`）。素のテキストで描くと `**` がそのまま画面に出る。Markdown 側に
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
 * （`manager.ts:2698` の `…挑み直します: ${event.reason}` がその形）。切り分け
 * ようとすると本文の中身を判定することになるが、それは `manager.ts:2193`
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
            // IME 変換中の Enter を拾わない。ここは Enter 単体で送るので、
            // 変換確定の Enter がそのまま誤送信になる（`chat.tsx` の
            // ⌘/Ctrl+Enter より直接踏む形）。門の形と理由（`event.nativeEvent.isComposing`
            // を見る理由・`keyCode === 229` を併用する理由）は `chat.tsx` の
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
 * ここでは `isKnownCommitmentClosedBy` で狭めてから分岐する
 * （`commitmentClosedBySchema` の値をこのファイル内に複製したもの。理由は
 * `isKnownCommitmentClosedBy` の doc）。
 */
function ClosedReasonBody({ commitment }: { commitment: Commitment }) {
  if (commitment.closedReason === undefined || commitment.closedReason === null) return null;
  const reason = commitment.closedReason;

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
            // IME 変換中の Enter を拾わない。ここは Enter 単体で送るので、
            // 変換確定の Enter がそのまま誤送信になる（`chat.tsx` の
            // ⌘/Ctrl+Enter より直接踏む形）。門の形と理由（`event.nativeEvent.isComposing`
            // を見る理由・`keyCode === 229` を併用する理由）は `chat.tsx` の
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
