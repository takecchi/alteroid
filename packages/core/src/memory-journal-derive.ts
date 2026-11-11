/**
 * 記憶の保護状態を日誌（`memory_update`）から導出する場所: 人間が触った印・作った時刻の根拠と、索引を組み直した記録の文面。
 * 導出の基準を器（fs / pg / daemon の起動時 backfill）に散らさず、ここ1本に置く。
 */

import { assertNever } from './assert-never.js';
import type { JournalEntry } from './schema.js';
import type { JournalQuery, JournalStore } from './store.js';

export function assertNeverMemoryProtectionStatus(status: never): never {
  return assertNever('未知の記憶保護状態', status);
}

// 日誌を全件読みにしない: 日誌が育つと1回の呼び出しでヒープに載る量が育ち、起動時の OOM の疑いになるため
export const MEMORY_JOURNAL_SCAN_PAGE_SIZE = 1000;

async function walkMemoryUpdateJournalAscending(
  journal: Pick<JournalStore, 'listPage'>,
  pageSize: number,
  onPage: (page: JournalEntry[]) => void,
): Promise<void> {
  let after: JournalQuery['after'];
  for (;;) {
    const { entries: page, next } = await journal.listPage({
      types: ['memory_update'],
      order: 'asc',
      limit: pageSize,
      ...(after === undefined ? {} : { after }),
    });
    if (page.length > 0) onPage(page);
    // ページの長さで終端を判定しない: store が壊れた行を捨てると、ページは短くなっても・空でも先に行が在りうるため
    if (next === null) return;
    after = next;
  }
}

// 導出の1行ぶんの折り畳みを走査から切り離す: 1周の走査で複数の導出を同時に組む（`deriveMemoryBootBackfillFromJournal`）のと、
// 1つだけ組む（`derive*FromJournal`）のとで、同じ基準の実装を共有するため。基準をここ1本に置く: 散らすと、片方だけ直して残りが古い基準のままになる。
interface MemoryUpdateFold {
  readonly result: Map<string, string>;
  apply(entry: JournalEntry): void;
}

function humanTouchFold(): MemoryUpdateFold {
  const result = new Map<string, string>();
  // 直近の人間の `write` が印を立てる前の値（#4774）: 打ち消しの行（`write_failed`）で、その `write` が無かった状態へ戻すため。
  const beforeLastWrite = new Map<string, string | undefined>();
  return {
    result,
    apply(entry) {
      if (entry.type !== 'memory_update') return;
      // 消した行で、それまでの印を捨てる（#4773）: 器の `remove` は誰が消しても派生値を一緒に消すので、残すと作り直した記憶が再起動の後だけ古い印を名乗るため。
      // 削除そのものは印にしない: 人間による削除は将来この slug に書かれる新しい内容を保護する理由にならないため
      if (entry.action === 'remove') {
        result.delete(entry.slug);
        beforeLastWrite.delete(entry.slug);
        return;
      }
      // 打ち消しの行は印にしない（#4774）: 日誌を先に書くので、本文が書けなかった保存の `write` の行が日誌に残る。それを根拠に再起動の後だけ「人間が書いた」と名乗らせない。
      // 直前の `write` が無い（見えない）打ち消しは何もしない: 守りすぎの側に倒す（印を外すより残す）
      if (entry.action === 'write_failed') {
        if (entry.cause === 'human' && beforeLastWrite.has(entry.slug)) {
          const previous = beforeLastWrite.get(entry.slug);
          if (previous === undefined) result.delete(entry.slug);
          else result.set(entry.slug, previous);
          beforeLastWrite.delete(entry.slug);
        }
        return;
      }
      if (entry.cause !== 'human') return;
      if (entry.action === 'write') beforeLastWrite.set(entry.slug, result.get(entry.slug));
      result.set(entry.slug, entry.at);
    },
  };
}

function createdAtFold(): MemoryUpdateFold {
  const result = new Map<string, string>();
  // 直近の `write` がこの slug の最初の作成として時刻を置いたか（#4774）: 打ち消しの行で、その時刻を取り下げるため。
  const createdByLastWrite = new Set<string>();
  return {
    result,
    apply(entry) {
      if (entry.type !== 'memory_update') return;
      // 消した行で、それまでの作った時刻を捨てる（#4773。理由は `humanTouchFold` と同じ）
      if (entry.action === 'remove') {
        result.delete(entry.slug);
        createdByLastWrite.delete(entry.slug);
        return;
      }
      // 本文が書けなかった保存の `write` を、作った時刻の根拠にしない（#4774）
      if (entry.action === 'write_failed') {
        if (createdByLastWrite.delete(entry.slug)) result.delete(entry.slug);
        return;
      }
      // action:'append' と action 無しは対象にしない: 広げて誤って早い時刻を拾うより、根拠が無ければ unknown に倒すため
      if (entry.action !== 'write') return;
      createdByLastWrite.delete(entry.slug);
      if (!result.has(entry.slug)) {
        result.set(entry.slug, entry.at);
        createdByLastWrite.add(entry.slug);
      }
    },
  };
}

async function foldMemoryUpdates(
  journal: Pick<JournalStore, 'listPage'>,
  pageSize: number,
  folds: readonly MemoryUpdateFold[],
): Promise<void> {
  await walkMemoryUpdateJournalAscending(journal, pageSize, (page) => {
    for (const entry of page) {
      for (const fold of folds) fold.apply(entry);
    }
  });
}

// 判定基準の単一の実装: storage.ts の起動時 backfill と fs / pg の索引の組み直しが別々に基準を書くと、片方だけ直して残りが古い基準のままになるため
export async function deriveHumanTouchedAtFromJournal(
  journal: Pick<JournalStore, 'listPage'>,
  options: { pageSize?: number } = {},
): Promise<Map<string, string>> {
  const fold = humanTouchFold();
  await foldMemoryUpdates(journal, options.pageSize ?? MEMORY_JOURNAL_SCAN_PAGE_SIZE, [fold]);
  return fold.result;
}

// 起動時の2つの補い（人間が触った印・作った時刻）の根拠を1周の走査で組む: 2周に分けると同じ行を2度読むだけで、結果は変わらないため。
// 結果は人間が触った印と作った時刻を別々の2周で組んだものと同じ（突き合わせの試験が押さえる）。
export async function deriveMemoryBootBackfillFromJournal(
  journal: Pick<JournalStore, 'listPage'>,
  options: { pageSize?: number } = {},
): Promise<{ humanTouchedAt: Map<string, string>; createdAt: Map<string, string> }> {
  const human = humanTouchFold();
  const created = createdAtFold();
  await foldMemoryUpdates(journal, options.pageSize ?? MEMORY_JOURNAL_SCAN_PAGE_SIZE, [
    human,
    created,
  ]);
  return { humanTouchedAt: human.result, createdAt: created.result };
}

// `memory_update` は使わず、新しい `JournalEntryType` も足さない: 記憶（本文）は変わっておらず、種別を足すと web とクローンの道具が型で落ちるため
export function memoryProtectionRebuildDecision(counts: {
  humanRestored: number;
  hashesBaselined: number;
}): { decision: string; grounds: string } {
  return {
    decision:
      '記憶の保護状態の索引（派生値）を日誌から組み直した' +
      `（human 印 ${counts.humanRestored} 件を復元、本文のハッシュ ${counts.hashesBaselined} 件を` +
      '現在の値で基準化）。',
    grounds:
      '索引が読めなかった（無い・壊れている・スキーマが合わない）ため、次の読み出しでその場で' +
      '組み直した。cause:human の記録は日誌が持つので保護（human 印）は失われていないが、' +
      'この組み直しより前に外部から本文が書き換えられていたとしても、それはもう検出できない' +
      '（ハッシュは日誌に無いので、組み直す瞬間の本文の値で新しく基準化するため）。',
  };
}
