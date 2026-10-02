import { AlertTriangle, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Virtualizer, type VirtualizerHandle } from 'virtua';

import {
  Page,
  JournalEntryRow,
  Card,
  Empty,
  ErrorNote,
  FilterChips,
  Spinner,
  useMeasuredHeight,
  cn,
} from '@alteroid/ui';
import { useJournalWindow, summarizeJournalEntry } from '@alteroid/swr';
import { formatDateTime, formatRelative, shiftForPrepend } from '@alteroid/logic';
import { JournalEntryLinks } from '~/lib/journal-links';
import type { JournalEntryType } from '@alteroid/logic';

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
  // `turn_usage` と同じ理由——失敗したターンの観測も含むが、それ自体は
  // 「その場で壊れて動いていない」ことを表す種別ではない（Issue #976）。
  context_usage: 'neutral',
  // **`warn` にしてある。** この種別が出るのは枠に当たったときで、`rotated` でも
  // 「撒いた（走行中には届いていない）」までしか意味しない。`neutral` にすると
  // `exhausted`（全層が止まる）が普通の行と同じ色で並ぶ。**色は種別ごとに1つしか
  // 選べないので、いちばん重い側に合わせる。**
  token_rotation: 'warn',
  // **`warn` にしてある。** この種別は `outcome` に `woken`（起こし直した＝その場
  // で回復した）と `limit_reached`（上限に達して起こし直さなかった＝自動では
  // 再開しない。`runner.ts` の `#onSubagentStop` の doc）の2値を持つが、**色は
  // 種別ごとに1つしかない**ので、`token_rotation` と同じ理由でいちばん重い側
  // （`limit_reached`）に合わせる。`neutral` にすると、要対応の状態が「作業者が
  // 空回りしただけ」の行と同じ色で並んでしまう。**`danger` にはしていない** —
  // `danger` はこの画面の他所（`manager-detail.tsx` の「セッション切断」等）で
  // 「その場で壊れて動いていない」ことに使っており、`token_rotation` の
  // `exhausted`（全層が止まる、こちらのほうが重い）ですら `warn` に留めている
  // 釣り合いに合わせた。
  subagent_stall: 'warn',
  // **`neutral` にしてある。** この種別は器の記帳（受信箱の流量の計測。
  // Issue #783 段0）で、それ自体は「壊れている」ことを表さない —— 値が
  // 何を意味するかは読んだ人が窓どうしを並べて決めることで、行の色では
  // 言えない（`turn_usage` / `context_usage` と同じ理由）。
  inbox_flow: 'neutral',
  // **`neutral`。** 観測した側の申告の記録で、それ自体は壊れていることを表さない。
  github_observation: 'neutral',
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
 * `packages/logic/src/journal-window.ts`）へ渡す `atTop` を作るのに使う。
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

/**
 * 種別チップの選択を載せる URL のクエリパラメタ名（issue #2029）。
 *
 * **`GET /journal?type=` とは違う名前にしてある。** API 側は種別1つにつき
 * `type=` を複数回付ける形（`use-journal-window.ts`）だが、URL の見た目は
 * カンマ区切りで1つのパラメタにまとめたほうが短く読みやすい
 * （`managers.tsx` の `status` チップも同じ形に揃える。issue #2030）。
 * 名前を変えているのは「1つの値」と「複数値をカンマ区切りで詰めたもの」で
 * 意味が違うことを URL の読み手にも伝えるためである。
 */
const TYPES_SEARCH_PARAM = 'types';

/**
 * `TYPES_SEARCH_PARAM` の生の値から、既知の種別だけを順序を保って取り出す。
 *
 * **知らない値は無視する（#2010 の線）。** URL 経由の値は人間が手で書き換え
 * うるので、`JournalEntryType` として型で縛れない。ここで `TYPES`（＝
 * `JOURNAL_ENTRY_TYPES` から導出した既知の集合）に無い値を弾いておけば、
 * 後段（チップの選択状態・`useJournalWindow` への `selected`・`GET
 * /journal?type=`）はいままでどおり `JournalEntryType` だけを扱える。
 *
 * **「無視する」を選んだ理由**（#2010 は「生の値をそのまま見せる」も選べる
 * 形として書いてあるので、ここで選んだ側を残す）。#2010 の `inboxTypeLabel`
 * は**表示のための倒れ先**（人間が「知らない種類が来た」と気づけるように、
 * ラベルの代わりに生の値を見せる）だが、ここは**絞り込みの状態そのもの**で
 * ある。知らない値を `selected` に残すと、型を `JournalEntryType[]` のまま
 * 保てない（チップの `includes` 判定にも `useJournalWindow` の引数にも
 * 生の文字列が混ざる）うえ、対応するチップが無いので選択されているのに
 * どのチップも押されて見えない状態になる。**落ちないことが目的**なので、
 * 素直に読み捨てる。
 */
function parseSelectedTypes(raw: string | null): readonly JournalEntryType[] {
  if (raw === null || raw === '') return [];
  const result: JournalEntryType[] = [];
  for (const part of raw.split(',')) {
    if (part === '') continue;
    if (!(TYPES as readonly string[]).includes(part)) continue;
    const type = part as JournalEntryType;
    if (!result.includes(type)) result.push(type);
  }
  return result;
}

export default function Journal() {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [headerRef, headerHeight] = useMeasuredHeight();

  /*
   * **検索語も種別チップも、正本は URL である**（issue #250 / #2029）。
   *
   * 画面の state に閉じ込めると、**その絞り込みを人へ渡せない**（開き直すと
   * 消える・戻るで戻れない・リンクで共有できない）。日誌は「あとから否定
   * できる」ための記録なので、**見つけた1行を指して渡せること**そのものに
   * 意味がある。
   *
   * **打っている途中の値（`draft`）と、実際に撃つ値（URL）を分けてある
   * （検索語だけ）。** 入力欄は打鍵ごとに `draft` を更新して即座に反応し、
   * URL は debounce（`SEARCH_DEBOUNCE_MS`）を通った後だけ書き換える。
   * **`replace: true` にするのは、打鍵1つごとに履歴が積まれると「戻る」が
   * 使えなくなるから**である（検索語を1文字ずつ巻き戻すのは誰も望んで
   * いない）。
   *
   * **種別チップ（`selected`）は #250 の時点では URL に載せていなかった。**
   * 終了条件（4口に `q` が入る）の外なので手を付けなかっただけで、「載せる
   * べきでない」と判断したのではない、という経緯だった（issue #2029）。
   *
   * **いまは検索語と同じ `useSearchParams` の仕組みに乗せた。** ただし
   * **debounce はしない** —— チップの切り替えは打鍵と違って1回のクリックが
   * そのまま1回の意図した操作であり、連打しても検索語のような「入力の
   * 途中」は無い。**`replace: true` は検索語と同じ理由で踏襲する** ——
   * 複数のチップを続けて押す操作は、検索語の連続した打鍵と同じ形で履歴を
   * 汚す（チップを3つ押しただけで「戻る」を3回要求されるのは誰も望んで
   * いない）。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const committed = searchParams.get(SEARCH_PARAM) ?? '';
  const [draft, setDraft] = useState(committed);
  /**
   * **`useMemo` で包み、生の文字列（`rawTypes`）が変わらない限り同じ参照を
   * 返す（issue #2055）。** `parseSelectedTypes` を描画のたびに呼ぶだけだと、
   * `selected` の参照が毎描画で新しくなる——`draft`（検索欄の打鍵ごと）の
   * 更新だけで `Journal` が再描画されても、`JournalBody` へ渡す `selected`
   * の中身は変わっていないのに新しい配列になってしまう。`JournalBody` は
   * `key` が変わらない限り同じインスタンスのまま新しい `selected` を prop
   * として受け取るので、それがそのまま `useJournalWindow` の
   * `useEffect(..., [recent, selected, q])`（`use-journal-window.ts`）に
   * 渡り、チップを押していないのに毎回 effect が走り直していた。
   */
  const rawTypes = searchParams.get(TYPES_SEARCH_PARAM);
  const selected = useMemo(() => parseSelectedTypes(rawTypes), [rawTypes]);

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
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        const current = parseSelectedTypes(next.get(TYPES_SEARCH_PARAM));
        const updated = current.includes(type)
          ? current.filter((t) => t !== type)
          : [...current, type];
        if (updated.length === 0) next.delete(TYPES_SEARCH_PARAM);
        else next.set(TYPES_SEARCH_PARAM, updated.join(','));
        return next;
      },
      { replace: true },
    );
  }

  function clearSelected() {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(TYPES_SEARCH_PARAM);
        return next;
      },
      { replace: true },
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
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="本文を語で探す（大文字小文字を区別しない部分一致）"
              aria-label="日誌を語で探す"
              className="w-full rounded border border-border bg-background py-1.5 pr-2 pl-8 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
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
          <p className="mb-3 text-[11px] text-muted-foreground">
            tool_use の
            input・worker_wait・turn_usage・context_usage・inbox_flow・github_observation
            は探す対象に入っていない（そこにだけ書かれている語は当たらない）。
          </p>
        )}
        <FilterChips
          className="mb-4"
          label="種別で絞り込む"
          options={TYPES.map((type) => ({ value: type }))}
          selected={selected}
          onToggle={toggle}
          onClear={clearSelected}
        />
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

/**
 * 0件のときの文言を組み立てる。
 *
 * **絞り込んだ結果の0件を、絞っていないときの0件と同じ文言で出さない**
 * （#2203。手本は CLI `/journal` の `type=` 0件、#2073 / PR #2089）。
 * 種別チップ（`selected`）で絞ったときは選んだ種別を名指しし、検索語
 * （`q`）と両方かかっているときは両方を言う。**どちらも掛かっていない
 * ときの文言（`selected.length === 0 && q === ''`）と、検索語だけで絞った
 * ときの文言（`selected.length === 0 && q !== ''`）は変えない** —
 * 後者には既に「この条件の中では」という注記とテストが在る
 * （`journal.test.tsx`「当たらなかったら、その語では無いと言う」）。
 */
function journalEmptyMessage(selected: readonly JournalEntryType[], q: string): string {
  const typeLabel = selected.length > 0 ? `type=${selected.join(',')}` : undefined;
  if (typeLabel === undefined && q === '') {
    return 'この条件では何も記録されていない。';
  }
  if (typeLabel === undefined) {
    return `「${q}」に当たる記録は無い（この条件の中では）。`;
  }
  if (q === '') {
    return `${typeLabel} に当たる記録は無い（絞り込みを外せば見えるかもしれない）。`;
  }
  return `${typeLabel} に絞った上で、「${q}」に当たる記録は無い（絞り込みを外せば見えるかもしれない）。`;
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
  const { entries, isLoadingInitial, error, olderStatus, isLoadingOlder, loadOlder, horizonNote } =
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
  /**
   * **取れなかったのを0件と描かない**（issue #2322）。日誌をまだ1件も読めていないまま
   * 失敗したとき、失敗は上の `ErrorNote` が言う。ここで「何も記録されていない」を並べると、
   * 読めていないのに記録が無いように読める。フックは `error` を初回の失敗と後続の失敗で
   * 共用するが、後続は行が在って初めて起こるので、`error` と0件の組は初回の失敗を指す。
   * 一覧が残っているときは当たらず、そのまま出す。
   */
  const listUnavailable = error !== undefined && entries.length === 0;

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
        ) : listUnavailable ? null : entries.length === 0 ? (
          <Empty>{journalEmptyMessage(selected, q)}</Empty>
        ) : (
          <Virtualizer
            ref={virtualizerRef}
            scrollRef={scrollAreaRef}
            startMargin={startMargin}
            // **決定そのものは `shiftForPrepend` が持つ**（`packages/logic/src/journal-window.ts`）。
            // ここでインラインの `&&`/`!` 式を書かない — 書くと、測れるはず
            // の決定まで JSX の中に埋もれて測れなくなる（人間の指示、
            // 2026-08-23）。
            shift={shiftForPrepend(journalWindow.prepended, atTop)}
            onScroll={handleScroll}
          >
            {entries.map((entry) => (
              <JournalEntryRow
                key={entry.id}
                atLabel={formatDateTime(entry.at)}
                // **`time` で渡す（`at` / `relativeLabel` にしない）。** 部品の既定の
                // `Timestamp` は JST 固定の tooltip と焦点を受ける `<time>` を持つ。この画面の
                // 時刻は `@alteroid/logic` の整形で閲覧者の端末の時間帯のまま出しており、
                // 開閉の `<button>` の中に Tab の停止点も増やさない。
                time={formatRelative(entry.at)}
                type={entry.type}
                tone={TONE[entry.type]}
                summary={summarizeJournalEntry(entry)}
                links={<JournalEntryLinks entry={entry} />}
                raw={entry}
                isLast={entry.id === lastId}
                // 種別は行の頭の札に出ている。帯（種別の名前と「写す」ボタン）を出すと、
                // 開いた行で種別の文字が2箇所に出て、この画面に無かった操作も増える。
                rawBar={false}
              />
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
              className="w-full rounded-md border border-border py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              {isLoadingOlder ? '読み込み中…' : `もっと遡る（いま ${entries.length} 件）`}
            </button>
          )}
          {olderStatus === 'end' && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              これより古い記録は無い（全 {entries.length} 件）。
            </p>
          )}
          {/*
            **日誌の地平（issue #1510 の積み残し）。** `olderStatus === 'end'`
            だけでは「本当に無い」のか「記憶ストアがそこまで遡れないだけ」
            なのか区別が付かない場合がある——`horizonNote` はその区別が付かない
            ときにだけ中身を持つ（`journalHorizonNote` の doc）。上の
            「これより古い記録は無い」に続けて出す（同じ `olderStatus === 'end'`
            の中の、より詳しい断り）。
          */}
          {olderStatus === 'end' && horizonNote !== undefined && (
            <p className="py-2 text-center text-xs text-muted-foreground">{horizonNote}</p>
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
 * （`packages/logic/src/journal-window.ts` の `pageOutcome` の doc）。見た目は既存の
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
