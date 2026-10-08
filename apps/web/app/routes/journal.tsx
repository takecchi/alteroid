import { LoadError } from '~/components/load-error';
import { JournalTabs } from '~/components/group-tabs';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Virtualizer, type VirtualizerHandle } from 'virtua';

import {
  Page,
  JournalEntryRow,
  Card,
  Empty,
  FilterChips,
  Spinner,
  useMeasuredHeight,
  WarnNote,
} from '@alteroid/ui';
import { useJournalWindow, summarizeJournalEntry } from '@alteroid/swr';
import {
  formatDateTime,
  formatRelative,
  JOURNAL_TONE,
  JOURNAL_TYPES,
  journalTypeLabel,
  SEARCH_SCOPE_NOTE_JA,
  shiftForPrepend,
} from '@alteroid/logic';
import { JournalEntryLinks } from '~/lib/journal-links';
import type { JournalEntryType } from '@alteroid/logic';

const EDGE_THRESHOLD_ITEMS = 20;

// 0 ちょうどにしない: 数 px 離れただけで「遡っている」と扱われ、新着が来るたびに shift が意図せず立つため
const AT_TOP_THRESHOLD_PX = 24;

// 打鍵ごとに撃たない: 日誌の検索はストア全体を舐めうるため
const SEARCH_DEBOUNCE_MS = 300;

// GET /journal の q と別名にしない: 画面の URL と API のクエリで名前が違うと、片方を見て他方を組み立てられないため
const SEARCH_PARAM = 'q';

// GET /journal?type= と同じ名前にしない: 1つの値と、複数値をカンマ区切りで詰めたものとでは意味が違うため
const TYPES_SEARCH_PARAM = 'types';

// 知らない値を selected に残さない: 型を JournalEntryType[] のまま保てず、対応するチップが無いので選択されているのにどのチップも押されて見えない状態になるため
function parseSelectedTypes(raw: string | null): readonly JournalEntryType[] {
  if (raw === null || raw === '') return [];
  const result: JournalEntryType[] = [];
  for (const part of raw.split(',')) {
    if (part === '') continue;
    if (!(JOURNAL_TYPES as readonly string[]).includes(part)) continue;
    const type = part as JournalEntryType;
    if (!result.includes(type)) result.push(type);
  }
  return result;
}

export default function Journal() {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [headerRef, headerHeight] = useMeasuredHeight();

  // 絞り込みを画面の state に閉じ込めない（正本は URL）: 開き直すと消え、戻るで戻れず、リンクで共有できないため
  // replace: true にする: 打鍵やチップの操作ごとに履歴が積まれると「戻る」が使えなくなるため
  // チップは debounce しない: 1回のクリックがそのまま1回の意図した操作で、検索語のような「入力の途中」が無いため
  const [searchParams, setSearchParams] = useSearchParams();
  const committed = searchParams.get(SEARCH_PARAM) ?? '';
  const [draft, setDraft] = useState(committed);
  // 自分が URL へ書いた語を持つ: 外からの変更と区別しないと、打鍵中の入力を自分の書き込みの反映で巻き戻すため
  const [written, setWritten] = useState<string | null>(null);
  const [seen, setSeen] = useState(committed);
  // effect でなく描画中に取り込む: effect の中で setState すると描き直しが1往復増えるため
  // 打鍵の途中でも外からの変更を優先して draft を捨てる: 残すと約 300ms 後に URL を元の語へ書き戻すため
  if (committed !== seen) {
    setSeen(committed);
    setWritten(null);
    if (committed !== written) setDraft(committed);
  }
  const [retryNonce, setRetryNonce] = useState(0);
  // useMemo で包み、生の文字列が変わらない限り同じ参照を返す: 描画のたびに selected が新しい配列になり、useJournalWindow の effect が毎回走り直すため
  const rawTypes = searchParams.get(TYPES_SEARCH_PARAM);
  const selected = useMemo(() => parseSelectedTypes(rawTypes), [rawTypes]);

  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => {
      setWritten(draft);
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
      tabs={<JournalTabs />}
      title="日誌"
      description="聞かずに実行した判断・エスカレーション・ツール実行。追記専用で、あとから否定できる"
      scrollRef={scrollAreaRef}
    >
      {/* startMargin にここの実測の高さを渡す: scrollRef を Page のスクロール領域に向けており、直接の親でない祖先までの距離は自分で申告する必要があるため */}
      <div ref={headerRef}>
        {/* 絞り込みを画面側で本文を突き合わせて捨てない: 窓に読み込んだぶんの中でしか探せず、CLI やクローンでできることが Web でだけできなくなるため */}
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
              placeholder="本文を語で探す"
              aria-label="日誌を語で探す"
              className="w-full rounded border border-border bg-background py-1.5 pr-2 pl-8 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </div>
        </div>
        {/* 検索していないときは出さない: 常に出すと、本当に効いているときの目印にならないため */}
        {committed !== '' && (
          <p className="mb-3 text-[11px] text-muted-foreground">{SEARCH_SCOPE_NOTE_JA}</p>
        )}
        <FilterChips
          className="mb-4"
          label="種別で絞り込む"
          options={JOURNAL_TYPES.map((type) => ({ value: type, label: journalTypeLabel(type) }))}
          selected={selected}
          onToggle={toggle}
          onClear={clearSelected}
        />
      </div>

      {/* effect の中で reset せず key で作り直す: prop が変わったら effect の中で reset する形は eslint（react-hooks/set-state-in-effect）に落ちるため */}
      <JournalBody
        key={`${selected.join(',')}\u0000${committed}\u0000${retryNonce}`}
        onRetry={() => setRetryNonce((n) => n + 1)}
        selected={selected}
        q={committed}
        scrollAreaRef={scrollAreaRef}
        startMargin={headerHeight}
      />
    </Page>
  );
}

function journalEmptyMessage(selected: readonly JournalEntryType[], q: string): string {
  const typeLabel =
    selected.length > 0
      ? selected.map((type) => `「${journalTypeLabel(type)}」`).join('')
      : undefined;
  if (typeLabel === undefined && q === '') {
    return 'この条件では何も記録されていない。';
  }
  if (typeLabel === undefined) {
    return `「${q}」に当たる記録はありません（この条件の中では）。`;
  }
  if (q === '') {
    return `${typeLabel}の記録はありません（絞り込みを外せば見えるかもしれません）。`;
  }
  return `${typeLabel}に絞った上で、「${q}」に当たる記録はありません（絞り込みを外せば見えるかもしれません）。`;
}

function JournalBody({
  selected,
  q,
  onRetry,
  scrollAreaRef,
  startMargin,
}: {
  selected: readonly JournalEntryType[];
  onRetry: () => void;
  q: string;
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
  startMargin: number;
}) {
  const journalWindow = useJournalWindow(selected, q);
  const {
    entries,
    isLoadingInitial,
    error,
    loadMoreError,
    retryLoadMore,
    olderStatus,
    isLoadingOlder,
    loadOlder,
    horizonNote,
  } = journalWindow;

  const virtualizerRef = useRef<VirtualizerHandle>(null);
  const triedNewerAtLengthRef = useRef(-1);
  const [atTop, setAtTop] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const update = () => {
      const selection = document.getSelection();
      const selecting =
        selection !== null &&
        !selection.isCollapsed &&
        selection.anchorNode !== null &&
        list.contains(selection.anchorNode);
      setReading(selecting || list.querySelector('[aria-expanded="true"]') !== null);
    };
    // DOM の変化を見る: 行の開閉は React の描画の後に aria-expanded が変わり、クリックの listener では描画の前に読んでしまうため
    const observer = new MutationObserver(update);
    observer.observe(list, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
    document.addEventListener('selectionchange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('selectionchange', update);
    };
  }, []);

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
  const listUnavailable = error !== undefined && entries.length === 0;

  return (
    <>
      <LoadError what="日誌" error={error} onRetry={onRetry} className="mb-4" />
      <LoadError
        what="日誌の続き"
        error={loadMoreError}
        onRetry={retryLoadMore}
        retrying={isLoadingOlder || journalWindow.isLoadingNewer}
        className="mb-4"
      />
      {journalWindow.newerBlocked && (
        <BlockedNote className="mb-4">
          新着の取りこぼし確認が、同じ時刻の記録の詰まりで止まった。この画面を開き直すと直る場合がある。
        </BlockedNote>
      )}

      <div ref={listRef}>
        {listUnavailable && !isLoadingInitial ? null : (
          <Card>
            {isLoadingInitial ? (
              <Spinner />
            ) : entries.length === 0 ? (
              <Empty>{journalEmptyMessage(selected, q)}</Empty>
            ) : (
              <Virtualizer
                ref={virtualizerRef}
                scrollRef={scrollAreaRef}
                startMargin={startMargin}
                // インラインの &&/! 式を書かない: 測れるはずの決定まで JSX の中に埋もれて測れなくなるため
                shift={shiftForPrepend(journalWindow.prepended, atTop, reading)}
                onScroll={handleScroll}
              >
                {entries.map((entry) => (
                  <JournalEntryRow
                    key={entry.id}
                    atLabel={formatDateTime(entry.at)}
                    // at / relativeLabel で渡さない: 部品の既定の Timestamp は JST 固定の tooltip と焦点を受ける <time> を持ち、Tab の停止点が増えるため
                    time={formatRelative(entry.at)}
                    type={entry.type}
                    typeLabel={journalTypeLabel(entry.type)}
                    tone={JOURNAL_TONE[entry.type]}
                    summary={summarizeJournalEntry(entry, 'localized')}
                    links={<JournalEntryLinks entry={entry} />}
                    raw={entry}
                    isLast={entry.id === lastId}
                    // 帯を出さない: 開いた行で種別の文字が2箇所に出て、この画面に無かった操作も増えるため
                    rawBar={false}
                  />
                ))}
              </Virtualizer>
            )}
          </Card>
        )}
      </div>

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

// Empty や「これより古い記録は無い」と同じ顔にしない: 終端でも空でもない、本物の限界だと分かる形にするため
function BlockedNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <WarnNote className={className}>{children}</WarnNote>;
}
