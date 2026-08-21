import { useMemo, useState } from 'react';

import { Page } from '~/components/page';
import { Badge, Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useJournalFeed } from '~/hooks/journal-feed';
import { summarizeJournalEntry, useJournal } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime, formatRelative } from '~/lib/format';
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
