import { AlertTriangle, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Virtualizer, type VirtualizerHandle } from 'virtua';

import { Page } from '~/components/page';
import { Badge, Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useJournalWindow } from '~/hooks/use-journal-window';
import { useMeasuredHeight } from '~/hooks/use-measured-height';
import { summarizeJournalEntry } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime, formatRelative } from '~/lib/format';
import { shiftForPrepend } from '~/lib/journal-window';
import type { JournalEntry, JournalEntryType } from '~/lib/types';

/**
 * 種別ごとの見た目の強さ。**`Record<JournalEntryType, ...>` で縛ってあるので、
 * 種別を足してここを足し忘れると型で落ちる**（`schema.ts` の
 * `journalEntryTypeNames` が `satisfies Record<JournalEntryType, true>` で
 * 縛っているのと同じ作法）。
 *
 * 下の `TYPES`（絞り込みチップの表示順）はここから導出する — **正本は1つ
 * だけ**にして、`TONE` にだけ足して `TYPES` を足し忘れる形（＝チップに
 * 出ない種別ができる）を構造的に無くす。
 */
const TONE: Record<JournalEntryType, 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  exchange: 'neutral',
  decision: 'accent',
  escalation: 'warn',
  tool_use: 'neutral',
  memory_update: 'ok',
  daily_report: 'accent',
  external_event: 'warn',
  worker_wait: 'neutral',
  turn_usage: 'neutral',
  // **`warn` にしてある。** この種別が出るのは枠に当たったときで、`rotated` でも
  // 「撒いた（走行中には届いていない）」までしか意味しない。`neutral` にすると
  // `exhausted`（全層が止まる）が普通の行と同じ色で並ぶ。**色は種別ごとに1つしか
  // 選べないので、いちばん重い側に合わせる。**
  token_rotation: 'warn',
};

/**
 * 絞り込みチップに出す種別の一覧。**`TONE` から `Object.keys` で起こす** —
 * `schema.ts` が `journalEntryTypeNames`（`satisfies Record<JournalEntryType,
 * true>`）から `JOURNAL_ENTRY_TYPES` を同じ形で起こしているのに倣っただけで、
 * ここだけの新しい発明ではない。
 *
 * **画面側で絞り込みを持たない理由は変わっていない** — ここを固定リストで
 * 持つのは表示順のためだけで、**絞り込みはサーバに投げる**（`GET
 * /journal?type=`）。画面側で捨てると「出していないだけ」の層ができる。
 *
 * **表示順は `TONE` の宣言順が正本になった。** `Object.keys` は文字列キーの
 * 宣言順を保つ（ECMA-262 の仕様）ので、`TONE` の宣言順を変えるとチップの
 * 表示順もそのまま変わる（並び順を変える意図があるときは `TONE` の宣言順を
 * 変えること）。導出前の固定リストと `TONE` はここに来るまで宣言順が
 * 一致していたので、この変更で表示順は1文字も変わっていない。
 */
const TYPES = Object.keys(TONE) as [JournalEntryType, ...JournalEntryType[]];

/**
 * 端に近づいたと判定するしきい値（アイテム数）。virtua 公式の
 * bidirectional infinite scroll の例（`stories/react/basics/
 * Virtualizer.stories.tsx` の `BiDirectionalInfiniteScrolling`）に倣う
 * （あちらは 50、ここは日誌の1行が小さい分だけ控えめに 20 にした）。
 *
 * ⚠️ **この数字は実機で調整すべきもので、テストが通っても正しさの根拠には
 * ならない。** jsdom は virtua を描画しない（このファイル末尾のコメント）ので、
 * 「この値でちょうどよく先読みできているか」はテストでは測れず、実機で
 * スクロールして確かめるしかない。
 */
const EDGE_THRESHOLD_ITEMS = 20;

/**
 * 「上端に居る」と判定するしきい値（px）。`shiftForPrepend`（
 * `~/lib/journal-window.ts`）へ渡す `atTop` を作るのに使う。
 *
 * ⚠️ **この数字も実機で調整すべきもので、テストが通っても正しさの根拠には
 * ならない。** 0 ちょうどだと「あと数 px」で上端から離れただけの状態を
 * 「遡っている」と扱ってしまい、新着が来るたびに `shift` が意図せず立つ
 * （＝新着が視界に増えず、読んでいる行が動かない）体感になりかねない。
 * 逆に大きすぎると、実際には遡っているのに「上端」扱いされて新着が割り
 * 込み、読んでいる行が動く。**この値（24px）は当てずっぽうで、実機での
 * 検証はしていない。**
 */
const AT_TOP_THRESHOLD_PX = 24;

/**
 * 検索欄の打鍵から `GET /journal` を撃つまでの待ち（ミリ秒。issue #250）。
 *
 * **打鍵ごとに撃たない。** 日誌の検索はストア全体を舐めうる（pg は
 * `ILIKE` に索引を張っていない。`packages/storage-pg/src/journal.ts` の
 * `journalSearchMatches` の doc）ので、1文字ごとに撃つと打っている間
 * ずっと重い問い合わせが並ぶ。
 *
 * ⚠️ **この数字は実機で調整すべきもので、テストが通っても正しさの根拠には
 * ならない**（このファイルの `EDGE_THRESHOLD_ITEMS` / `AT_TOP_THRESHOLD_PX`
 * と同じ断り）。短すぎれば上の重さがそのまま出るし、長すぎれば「打ったのに
 * 何も起きない」時間になる。**300ms は当てずっぽうで、実機での検証はして
 * いない。**
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 検索語を載せる URL のクエリパラメタ名。**`GET /journal` の `q` と同じ名前**
 * にしてある（画面の URL と API のクエリで名前が違うと、片方を見て他方を
 * 組み立てられない）。
 */
const SEARCH_PARAM = 'q';

export default function Journal() {
  const [selected, setSelected] = useState<readonly JournalEntryType[]>([]);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [headerRef, headerHeight] = useMeasuredHeight();

  /*
   * **検索語の正本は URL である**（issue #250）。
   *
   * 画面の state に閉じ込めると、**その検索結果を人へ渡せない**（開き直すと
   * 消える・戻るで戻れない・リンクで共有できない）。日誌は「あとから否定
   * できる」ための記録なので、**見つけた1行を指して渡せること**そのものに
   * 意味がある。
   *
   * **打っている途中の値（`draft`）と、実際に撃つ値（URL）を分けてある。**
   * 入力欄は打鍵ごとに `draft` を更新して即座に反応し、URL は debounce
   * （`SEARCH_DEBOUNCE_MS`）を通った後だけ書き換える。**`replace: true` に
   * するのは、打鍵1つごとに履歴が積まれると「戻る」が使えなくなるから**で
   * ある（検索語を1文字ずつ巻き戻すのは誰も望んでいない）。
   *
   * **種別チップ（`selected`）は URL に載せていない。** これは #250 の
   * 終了条件（4口に `q` が入る）の外なので手を付けなかっただけで、
   * 「載せるべきでない」と判断したのではない。**いま検索語だけが URL に
   * 在り、チップは在る、という非対称がここに在る。**
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const committed = searchParams.get(SEARCH_PARAM) ?? '';
  const [draft, setDraft] = useState(committed);

  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (draft === '') next.delete(SEARCH_PARAM);
          else next.set(SEARCH_PARAM, draft);
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, committed, setSearchParams]);

  function toggle(type: JournalEntryType) {
    setSelected((previous) =>
      previous.includes(type) ? previous.filter((t) => t !== type) : [...previous, type],
    );
  }

  return (
    <Page
      title="日誌"
      description="聞かずに実行した判断・エスカレーション・ツール実行。追記専用で、あとから否定できる"
      scrollRef={scrollAreaRef}
    >
      {/*
        チップ帯・ErrorNote・新着取りこぼしの注記は、下の `Virtualizer` より
        手前に置く。virtua の `startMargin` にはここの実測の高さを渡す —
        `Virtualizer` の `scrollRef` を `Page` のスクロール領域そのものに
        向けている（`scrollRef` 省略時の既定「直接の親要素」では、チップ帯を
        挟んだ時点でずれる）ので、直接の親でない祖先までの距離を自分で
        申告する必要がある。
      */}
      <div ref={headerRef}>
        {/*
          **絞り込みはサーバに投げる**（下の型チップと同じ判断。この文言は
          `TYPES` の doc に逐語で在る）。画面側で本文を突き合わせて捨てると、
          「窓に読み込んだぶんの中でしか探せない」＝ **CLI やクローンでは
          できることが Web でだけできない**、という層ができる。
        */}
        <div className="mb-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="本文を語で探す（大文字小文字を区別しない部分一致）"
              aria-label="日誌を語で探す"
              className="w-full rounded border border-border bg-bg py-1.5 pr-2 pl-8 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        {/*
          **探す対象に入っていない欄が在ることを、探している人に見せる。**
          黙ると「当たらない＝日誌に無い」と読める（`journal-search.ts` の
          「対象にしていない欄」、AGENTS.md「静かに失敗する道具」）。
          **検索していないときは出さない** —— 常に出すと、本当に効いている
          ときの目印にならない（`memory_read` の注記と同じ倒し方）。
        */}
        {committed !== '' && (
          <p className="mb-3 text-[11px] text-muted">
            tool_use の input・worker_wait・turn_usage
            は探す対象に入っていない（そこにだけ書かれている語は当たらない）。
          </p>
        )}
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => toggle(type)}
              className={cn(
                'rounded border px-2 py-1 text-[11px] transition-colors',
                selected.includes(type)
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border text-muted hover:text-fg',
              )}
            >
              {type}
            </button>
          ))}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => setSelected([])}
              className="ml-1 text-[11px] text-muted underline hover:text-fg"
            >
              解除
            </button>
          )}
        </div>
      </div>

      {/*
        **`key={selected.join(',')}` で丸ごと作り直す。** フィルタが変われば
        `useJournalWindow` の内部状態（`entries` 等）を初期値へ戻したいが、
        「prop が変わったら effect の中で reset する」形は
        `apps/web` の eslint（`react-hooks/set-state-in-effect`）に落ちる
        （`use-journal-window.ts` 冒頭のコメント）。React 公式が推す
        「key を変えて作り直す」を使えば、`useState` の初期値がそのまま
        リセットになる。
      */}
      <JournalBody
        key={`${selected.join(',')}\u0000${committed}`}
        selected={selected}
        q={committed}
        scrollAreaRef={scrollAreaRef}
        startMargin={headerHeight}
      />
    </Page>
  );
}

function JournalBody({
  selected,
  q,
  scrollAreaRef,
  startMargin,
}: {
  selected: readonly JournalEntryType[];
  q: string;
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
  startMargin: number;
}) {
  const journalWindow = useJournalWindow(selected, q);
  const { entries, isLoadingInitial, error, olderStatus, isLoadingOlder, loadOlder } =
    journalWindow;

  const virtualizerRef = useRef<VirtualizerHandle>(null);
  // 「その件数のぶんはもう新着を確認しに行った」の目印。件数が変わらない限り
  // 同じ scroll イベントの連打で何度も撃たない（下端側は `olderStatus` という
  // 意味のある状態で止まるが、上端側は「いま新着が無い」だけで終わることが
  // 多く、件数が動かない限りは撃たない、という目印が要る）。
  const triedNewerAtLengthRef = useRef(-1);
  // 「いま上端に居るか」（`shiftForPrepend` の `atTop`）。既定は上端＝
  // `true`（画面を開いた直後は上端に居る。仮想化する前と同じ初期状態）。
  const [atTop, setAtTop] = useState(true);

  function handleScroll(offset: number) {
    const handle = virtualizerRef.current;
    if (handle === null) return;
    const count = entries.length;

    const nowAtTop = offset <= AT_TOP_THRESHOLD_PX;
    if (nowAtTop !== atTop) setAtTop(nowAtTop);

    if (
      !journalWindow.isLoadingOlder &&
      (journalWindow.olderStatus === 'progress' || journalWindow.olderStatus === 'retryLarger') &&
      handle.findItemIndex(offset + handle.viewportSize) + EDGE_THRESHOLD_ITEMS > count
    ) {
      journalWindow.loadOlder();
    }

    if (
      !journalWindow.isLoadingNewer &&
      triedNewerAtLengthRef.current !== count &&
      handle.findItemIndex(offset) - EDGE_THRESHOLD_ITEMS < 0
    ) {
      triedNewerAtLengthRef.current = count;
      journalWindow.refreshNewer();
    }
  }

  const lastId = entries.at(-1)?.id;

  return (
    <>
      <ErrorNote error={error} className="mb-4" />
      {journalWindow.newerBlocked && (
        <BlockedNote className="mb-4">
          新着の取りこぼし確認が、同じ時刻の記録の詰まりで止まった。この画面を開き直すと直る場合がある。
        </BlockedNote>
      )}

      <Card>
        {isLoadingInitial ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <Empty>
            {q === ''
              ? 'この条件では何も記録されていない。'
              : `「${q}」に当たる記録は無い（この条件の中では）。`}
          </Empty>
        ) : (
          <Virtualizer
            ref={virtualizerRef}
            scrollRef={scrollAreaRef}
            startMargin={startMargin}
            // **決定そのものは `shiftForPrepend` が持つ**（`~/lib/journal-window.ts`）。
            // ここでインラインの `&&`/`!` 式を書かない — 書くと、測れるはず
            // の決定まで JSX の中に埋もれて測れなくなる（人間の指示、
            // 2026-08-23）。
            shift={shiftForPrepend(journalWindow.prepended, atTop)}
            onScroll={handleScroll}
          >
            {entries.map((entry) => (
              <JournalRow key={entry.id} entry={entry} isLast={entry.id === lastId} />
            ))}
          </Virtualizer>
        )}
      </Card>

      {!isLoadingInitial && entries.length > 0 && (
        <div className="mt-3">
          {(olderStatus === 'progress' || olderStatus === 'retryLarger') && (
            <button
              type="button"
              onClick={loadOlder}
              disabled={isLoadingOlder}
              className="w-full rounded-md border border-border py-2 text-sm text-muted hover:text-fg disabled:opacity-60"
            >
              {isLoadingOlder ? '読み込み中…' : `もっと遡る（いま ${entries.length} 件）`}
            </button>
          )}
          {olderStatus === 'end' && (
            <p className="py-2 text-center text-xs text-muted">
              これより古い記録は無い（全 {entries.length} 件）。
            </p>
          )}
          {olderStatus === 'blocked' && (
            <BlockedNote>
              同じ時刻の記録が多く並んでいて、これより古い記録へ自動では進めない（いま{' '}
              {entries.length} 件）。
            </BlockedNote>
          )}
        </div>
      )}
    </>
  );
}

/**
 * `pageOutcome` が `'blocked'` を返したとき（同一 `at` の詰まりで自動では
 * 進めない）に出す。**`Empty` や「これより古い記録は無い」と同じ顔にしない**
 * — 終端でも空でもない、本物の限界だと分かる形にする
 * （`~/lib/journal-window.ts` の `pageOutcome` の doc）。見た目は既存の
 * `ErrorNote`（`components/ui.tsx`）と同じ配色の作法を warn 色で使い回す。
 */
function BlockedNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function JournalRow({ entry, isLast }: { entry: JournalEntry; isLast: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn('px-4 py-2', !isLast && 'border-b border-border')}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 text-left"
      >
        <span className="w-24 shrink-0 font-mono text-[11px] text-muted">
          {formatDateTime(entry.at)}
        </span>
        <Badge tone={TONE[entry.type]}>{entry.type}</Badge>
        {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
        <span className="min-w-0 flex-1 truncate text-sm text-muted">
          {summarizeJournalEntry(entry)}
        </span>
        <span className="shrink-0 text-[11px] text-muted">{formatRelative(entry.at)}</span>
      </button>

      {open && (
        // 掘れば生の中身まで降りられること（PRD 可観測性）。要約で止めない。
        <pre className="mt-2 max-h-96 overflow-y-auto rounded border border-border bg-bg p-2 text-xs text-muted">
          {JSON.stringify(entry, null, 2)}
        </pre>
      )}
    </div>
  );
}
