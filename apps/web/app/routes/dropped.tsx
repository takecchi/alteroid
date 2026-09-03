import { Page } from '~/components/page';
import { Badge, Card, CardHeader, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useDropped } from '~/hooks/queries';
import { ApiError } from '~/lib/api';
import type { DroppedState } from '~/lib/types';

/**
 * `/dropped` — 握り潰しの跡（記録・読み出しの失敗の跡。本文は1文字も含まない）を
 * 読む。
 *
 * 経路は `GET /dropped` の1本だけで、CLI（`alteroid dropped`）とクローンの MCP
 * 道具 `self_dropped` も同じ帳面を見る（`packages/core/src/dropped-record.ts`）。
 * **読み取り専用。**
 *
 * **「無い」の種類を3つ、混ぜずに言い分ける。判定の基準は「次の一手が変わるか」。**
 *
 * 1. **取りに行けなかった** —— 繋がらない・認証で弾かれた・この口を持たない
 *    古いデーモン（404）。**404 は「跡が無い」ではない** —— {@link ErrorNote}
 *    がエラーとしてそのまま出す（下の `DroppedErrorNote` で 404 専用の文言に
 *    差し替える）。0件の文言（{@link describeDroppedTraceEmptyNote}）とは別の
 *    文字列になる。
 * 2. **取りに行けたが0件** —— {@link describeDroppedTraceEmptyNote} をそのまま
 *    出す。「無事だった」とは読ませない。
 * 3. **runner の跡はここには出ない** —— {@link describeDroppedTraceOriginNote}
 *    を、0件でも件数があっても常に出す（構造的に見えないものを黙って0件に
 *    混ぜない）。
 */
export default function Dropped() {
  const { data, error, isLoading } = useDropped();

  return (
    <Page
      title="握り潰しの跡"
      description="記録・読み出しの失敗の跡。本文は1文字も含まない。読み取り専用"
    >
      <Card>
        <CardHeader
          title="帳面"
          subtitle="alteroid dropped / GET /dropped と同じもの"
          action={data === undefined ? undefined : <Badge>{data.total}</Badge>}
        />
        <DroppedErrorNote error={error} />
        {isLoading ? <Spinner /> : data === undefined ? null : <DroppedBody state={data} />}
      </Card>
    </Page>
  );
}

/**
 * **404 は「この口を持たない古いデーモン」専用の文言にする。** `tokens.tsx`
 * の 403 専用文言と同じ判断——汎用の `ErrorNote` に投げっぱなしにすると、
 * 「跡が無い」（0件）と「この版のデーモンにこの口が無い」の違いが読み手に
 * 伝わらない。
 */
function DroppedErrorNote({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="px-4 pt-3 text-sm text-danger">
        このデーモンには GET /dropped が無い（版が古い可能性がある。デーモンを更新してください）。
        跡が0件だった、という意味ではない。
      </div>
    );
  }
  return <ErrorNote error={error} className="m-4" />;
}

function DroppedBody({ state }: { state: DroppedState }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm">
      {/* **常に出す**（0件でも）。runner の跡はここには構造的に出ない。 */}
      <p className="text-muted">{describeDroppedTraceOriginNote(state.origin)}</p>
      <p className="text-xs text-muted">帳面が数え始めた時刻: {state.since}</p>
      <p className="text-xs text-muted">
        件数: {state.total}（{describeDroppedTraceRetentionNote(state.limit)}）
      </p>
      {state.total === 0 ? (
        <Empty>{describeDroppedTraceEmptyNote()}</Empty>
      ) : (
        // 古い順（末尾が最新）。`GET /dropped` が返す順のまま並べる。
        <ul className="flex flex-col gap-1">
          {state.traces.map((trace, index) => (
            <li key={index} className="font-mono text-[11px] break-words whitespace-pre-wrap">
              {trace}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 帳面が何の跡を持っているかを一言で言う（Web 版の複製）。
 *
 * **`export` してあるのは歯のためである。** 字面は2箇所（core とここ）に
 * 在り、揃っていることを規約（「直すときは両方見ること」）だけで守ると、
 * 片方だけ直しても両方の面のテストが自分の literal を見て緑のまま通って
 * しまう。だから `dropped.test.tsx` が core の `describeDroppedTraceOrigin`
 * を import して、2つが文字列として等しいことを直接測る（テストファイルは
 * `@alteroid/core` の値 import の禁止から明示的に外してある——
 * `eslint.config.js` の該当ルールの doc。先例は `managers.tsx` の
 * `describeSessionMissingKindNote` / `managers.test.tsx`「sessionMissingKind
 * の字面が core と一致する（#579）」）。
 *
 * **字面は `packages/core/src/dropped-record.ts` の `describeDroppedTraceOrigin`
 * と揃えてある。** ここで自前に書いている理由は、`packages/core` を Web の
 * バンドルへ引き込まないためである（`pnpm check:web-bundle-node-traces` /
 * `check:web-bundle-size` がそれを守る）。**文言を直すときは両方見ること**
 * （`grep -Fn -- 'デーモンのプロセス（クローンを含む）が残した跡だけである' packages/core/src/dropped-record.ts`）。
 *
 * **`undefined` は空文字にする（「不明」と書かない）。** 由来を持たない印は、
 * この欄が足される前の版のデーモンが立てたものだけである——そこへ新しい語を
 * 出すと、実際には1つしかない区別が2つに見える。
 *
 * **型の網羅性で塞いだうえで、実行時の倒れ先も足す**（AGENTS.md「型で塞いだ
 * 分岐にも、実行時の倒れ先の歯を足す」）。デーモンと Web は別デプロイなので
 * 版がずれうる——デーモンが先に2値目の `origin` を返し、この画面の型定義
 * （生成 spec）がまだ1値のままという順序が実在しうる。`default` 節は
 * `never` 型の変数へ代入するだけで、**その値をそのまま画面に出さない**
 * （#285 で実際に踏まれた間違い——`never` 型の変数を本文として描いてしまい、
 * 画面に分岐キーの生の値が出た——と同じ形を作らない）。
 */
export function describeDroppedTraceOriginNote(origin: DroppedState['origin'] | undefined): string {
  switch (origin) {
    case 'daemon':
      return (
        'デーモンのプロセス（クローンを含む）が残した跡だけである。' +
        '別プロセスの runner が残した跡はここには出ない。'
      );
    case undefined:
      return '';
    default: {
      const unreachable: never = origin;
      void unreachable;
      return '';
    }
  }
}

/**
 * 跡が0件だったときの読み方を一言で言う（Web 版の複製）。
 *
 * 揃える理由・作法は {@link describeDroppedTraceOriginNote} と同じ。字面は
 * `packages/core/src/dropped-record.ts` の `describeDroppedTraceEmpty` と
 * 揃えてある
 * （`grep -Fn -- 'このプロセスではまだ跡（記録・読み出しの握り潰し）が1件も残っていない' packages/core/src/dropped-record.ts`）。
 *
 * **「無事だった」とは読ませない。** この帳面はプロセスの生存中だけの記憶で、
 * 再起動・デプロイの入れ替えをまたいで残らない——0件は「握り潰しが1件も
 * 無かった」ことを意味しない。
 */
export function describeDroppedTraceEmptyNote(): string {
  return (
    'このプロセスではまだ跡（記録・読み出しの握り潰し）が1件も残っていない。' +
    '0件は「握り潰しが1件も無かった」ことを意味しない —— ' +
    'この帳面はプロセスの生存中だけの記憶で、再起動・デプロイの入れ替えで消える。'
  );
}

/**
 * 帳面の保持のしかた（上限で古い側から押し出される・それより古い分の在り処）
 * を一言で言う（Web 版の複製）。
 *
 * 揃える理由・作法は {@link describeDroppedTraceOriginNote} と同じ。字面は
 * `packages/core/src/dropped-record.ts` の `describeDroppedTraceRetention` と
 * 揃えてある
 * （`grep -Fn -- '件までしか持たず、溢れた古い側から押し出される。' packages/core/src/dropped-record.ts`）。
 *
 * @param limit `GET /dropped` の `limit` をそのまま渡すこと。**値をここへ
 *   焼き込まない**——サーバから渡させることで、上限が動いたときにここも
 *   一緒に動く。
 */
export function describeDroppedTraceRetentionNote(limit: number): string {
  return (
    `直近 ${limit} 件までしか持たず、溢れた古い側から押し出される。` +
    'それより古い分はこの帳面の中には無く、器の外の stderr を見るしかない。'
  );
}
