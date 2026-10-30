import { LoadError } from '~/components/load-error';
import { JournalTabs } from '~/components/group-tabs';
import { OlderButton } from '~/components/older-button';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';

import {
  Page,
  JournalEntryRow,
  Card,
  Empty,
  FilterChips,
  Spinner,
  useMeasuredHeight,
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
import { useChipSelection } from '~/lib/use-chip-selection';
import { useSearchParamDraft } from '~/lib/use-search-param-draft';
import type { JournalEntryType } from '@alteroid/logic';

const EDGE_THRESHOLD_ITEMS = 20;

// 0 ちょうどにしない: 数 px 離れただけで「遡っている」と扱われ、新着が来るたびに shift が意図せず立つため
const AT_TOP_THRESHOLD_PX = 24;

// GET /journal の q と別名にしない: 画面の URL と API のクエリで名前が違うと、片方を見て他方を組み立てられないため
const SEARCH_PARAM = 'q';

// GET /journal?type= と同じ名前にしない: 1つの値と、複数値をカンマ区切りで詰めたものとでは意味が違うため
const TYPES_SEARCH_PARAM = 'types';

export default function Journal() {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [headerRef, headerHeight] = useMeasuredHeight();

  // 絞り込みを画面の state に閉じ込めない（正本は URL）。検索語は打鍵の途中があるので debounce し、チップはしない
  const [draft, setDraft, committed] = useSearchParamDraft(SEARCH_PARAM);
  const [retryNonce, setRetryNonce] = useState(0);
  const {
    selected,
    toggle,
    clear: clearSelected,
  } = useChipSelection<JournalEntryType>(TYPES_SEARCH_PARAM, JOURNAL_TYPES);

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
      journalWindow.olderStatus === 'progress' &&
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
                    // 時刻は文字で渡す: 焦点を受ける <time>（Timestamp）を行ごとに置くと、Tab の停止点が増えるため
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
          {olderStatus === 'progress' && (
            <OlderButton loading={isLoadingOlder} onClick={loadOlder}>
              {`もっと遡る（いま ${entries.length} 件）`}
            </OlderButton>
          )}
          {olderStatus === 'end' && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              これより古い記録は無い（全 {entries.length} 件）。
            </p>
          )}
          {olderStatus === 'end' && horizonNote !== undefined && (
            <p className="py-2 text-center text-xs text-muted-foreground">{horizonNote}</p>
          )}
        </div>
      )}
    </>
  );
}
