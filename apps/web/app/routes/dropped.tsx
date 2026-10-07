import { JournalTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { Page, Badge, Card, CardHeader, Empty, Spinner } from '@alteroid/ui';
import { useDropped } from '@alteroid/swr';
import { formatDateTime } from '@alteroid/logic';
import type { DroppedState } from '@alteroid/logic';

// 「無い」の3種類（取りに行けなかった・0件・runner の跡は出ない）を混ぜない: 次の一手が変わるため
// 画面の文言に CLI 名・HTTP のパス・内部の語を出さない: 利用者の言葉で書くため
export default function Dropped() {
  const { data, error, isLoading, isValidating, mutate } = useDropped();

  return (
    <Page
      tabs={<JournalTabs />}
      title="記録の失敗"
      description="日誌に書き損ねた記録の一覧です。本文は含まず、見るだけの画面です"
    >
      <Card>
        <CardHeader
          title="失敗の一覧"
          subtitle="古いものが上、新しいものが下に並びます"
          action={data === undefined ? undefined : <Badge>{data.total}</Badge>}
        />
        <LoadError
          what="失敗の一覧"
          error={error}
          onRetry={() => mutate()}
          retrying={isValidating}
          className="m-4"
        />
        {isLoading ? <Spinner /> : data === undefined ? null : <DroppedBody state={data} />}
      </Card>
    </Page>
  );
}

function DroppedBody({ state }: { state: DroppedState }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm">
      <p className="text-muted-foreground">{describeDroppedTraceOriginNote(state.origin)}</p>
      <p className="text-xs text-muted-foreground">数え始めた時刻: {formatDateTime(state.since)}</p>
      <p className="text-xs text-muted-foreground">
        件数: {state.total}（{describeDroppedTraceRetentionNote(state.limit)}）
      </p>
      {state.total === 0 ? (
        <Empty inset="none">{describeDroppedTraceEmptyNote()}</Empty>
      ) : (
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

// core の関数を import せず字面を自前で持つ: packages/core を Web のバンドルへ引き込まないため
// undefined を「不明」と書かず空文字にする: 由来を持たない印は古い版のデーモンのものだけで、新しい語を出すと区別が2つに見えるため
// default 節の値をそのまま画面に出さない: 分岐キーの生の値が画面に出てしまうため
export function describeDroppedTraceOriginNote(origin: DroppedState['origin'] | undefined): string {
  switch (origin) {
    case 'daemon':
      return (
        'ここに出るのは、本体（クローンの動きを含む）が残した記録だけです。' +
        'マネージャーが動く実行環境の側で起きた失敗は出ません。'
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

// 「無事だった」と読ませない: この帳面はプロセスの生存中だけの記憶で、0件は握り潰しが1件も無かったことを意味しないため
export function describeDroppedTraceEmptyNote(): string {
  return (
    '日誌に書き損ねた記録は、いまは0件です。' +
    'ただしこの一覧は本体が動いている間だけの記憶で、再起動や更新で消えます。' +
    '0件でも、過去に失敗が無かったとは限りません。'
  );
}

// limit の値を焼き込まない: サーバから渡させることで、上限が動いたときにここも一緒に動くため
export function describeDroppedTraceRetentionNote(limit: number): string {
  return (
    `直近 ${limit} 件までを残し、あふれた古い分から消えます。` +
    'それより古い分はここでは見られません。'
  );
}
