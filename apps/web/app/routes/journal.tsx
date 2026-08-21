import { useMemo, useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useJournalFeed } from '~/hooks/journal-feed';
import { summarizeJournalEntry, useJournal } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime, formatRelative } from '~/lib/format';
import type { JournalEntry, JournalEntryType } from '~/lib/types';

/**
 * 種別は spec の union と一致していること。
 *
 * ここを固定リストで持つのは表示順のためだけで、**絞り込みはサーバに投げる**
 * （`GET /journal?type=`）。画面側で捨てると「出していないだけ」の層ができる。
 */
const TYPES: readonly JournalEntryType[] = [
  'exchange',
  'decision',
  'escalation',
  'tool_use',
  'memory_update',
  'daily_report',
  'external_event',
  'worker_wait',
];

const TONE: Record<JournalEntryType, 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  exchange: 'neutral',
  decision: 'accent',
  escalation: 'warn',
  tool_use: 'neutral',
  memory_update: 'ok',
  daily_report: 'accent',
  external_event: 'warn',
  worker_wait: 'neutral',
};

export default function Journal() {
  const [selected, setSelected] = useState<readonly JournalEntryType[]>([]);
  const [limit, setLimit] = useState(100);
  const { data, error, isLoading } = useJournal(limit, selected);
  // SSE で届いた分（`shell.tsx` が1本だけ張った購読の相乗り）。再取得を待たずに出す。
  const { recent } = useJournalFeed();

  /**
   * 履歴（`useJournal`）に `recent` を重ねる。
   *
   * - **種別フィルタに従わせる。** `useJournal` はサーバへ絞り込みを投げるが、
   *   `recent` は絞られていない生の受信なので、ここで同じ条件を掛け直す。
   *   従わせないと、絞り込んでいるはずの画面に無関係な種別が混ざる。
   * - **`id` で重複を除く。** 再取得が終わると同じエントリが履歴側にも現れる。
   * - **`limit`（件数の扱い）にも従わせる。** 重ねた分だけ表示件数が増えてしまうと
   *   画面が持っている「いま何件見ているか」の意味が崩れる。
   * - 並びは両方とも新しい順なので、`recent`（つねに履歴より新しい）を先に置けば
   *   そのまま新しい順になる。
   */
  const entries = useMemo(() => {
    const history = data?.entries ?? [];
    const filteredRecent =
      selected.length === 0 ? recent : recent.filter((entry) => selected.includes(entry.type));
    const historyIds = new Set(history.map((entry) => entry.id));
    const merged = [...filteredRecent.filter((entry) => !historyIds.has(entry.id)), ...history];
    return merged.slice(0, limit);
  }, [data, recent, selected, limit]);

  function toggle(type: JournalEntryType) {
    setSelected((previous) =>
      previous.includes(type) ? previous.filter((t) => t !== type) : [...previous, type],
    );
  }

  return (
    <Page
      title="日誌"
      description="聞かずに実行した判断・エスカレーション・ツール実行。追記専用で、あとから否定できる"
    >
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

      <ErrorNote error={error} className="mb-4" />

      <Card>
        {isLoading ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <Empty>この条件では何も記録されていない。</Empty>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.id} className="border-b border-border last:border-b-0">
                <JournalRow entry={entry} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data !== undefined && data.entries.length >= limit && (
        <button
          type="button"
          onClick={() => setLimit((value) => Math.min(value + 200, 1000))}
          className="mt-3 w-full rounded-md border border-border py-2 text-sm text-muted hover:text-fg"
        >
          もっと遡る（いま {limit} 件）
        </button>
      )}
    </Page>
  );
}

function JournalRow({ entry }: { entry: JournalEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="px-4 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 text-left"
      >
        <span className="w-24 shrink-0 font-mono text-[11px] text-muted">
          {formatDateTime(entry.at)}
        </span>
        <Badge tone={TONE[entry.type]}>{entry.type}</Badge>
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
