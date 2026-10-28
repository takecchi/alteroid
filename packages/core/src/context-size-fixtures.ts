/**
 * クローンの1ターンに載る文脈の量を測るための偽データ（#5469 P0）。
 * 乱数を使わない: 同じ引数なら同じ文字列になり、測り直しの差が「コードが動いたとき」だけになるため。
 */

import type { Commitment, Job, JobStatus } from './schema.js';
import type { Stores } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const SENTENCES = [
  '依頼の背景と狙いを先に書き、確かめた事実と確かめていないことを分けて報告する。',
  'リポジトリの現物を読んでから判断し、食い違ったら現物を採るという運用を続けている。',
  '台帳の未了は件数が増えるほど毎回の判断の費用が増えるので、閉じ方を決めておく。',
  'PR は ready にしてから CI の緑を確かめ、マージの許可は依頼者が出す。',
  'GitHub の通知は件名だけで判断せず、本文と差分を読んでから返事を書く。',
  'メールの下書きは送る前に人間へ見せ、署名と宛先を確かめる。',
  '定期の点検では、前回から変わったものだけを短く挙げる。',
  '費用の大きい作業は、先に見積りを出して人間の承認を得てから始める。',
];

/** 決定的に作る日本語の文章（`chars` 字ちょうど）。 */
export function fillerText(chars: number, seed = 0): string {
  let text = '';
  for (let index = seed; text.length < chars; index += 1) {
    text += SENTENCES[index % SENTENCES.length]!;
  }
  return text.slice(0, chars);
}

export type MemoryFixtureSize = 'small' | 'cap';

interface MemoryShape {
  premiseDocs: number;
  premiseBodyChars: number;
  premiseSections: number;
  factDocs: number;
}

// 'cap' は「索引が上限近くまで膨らんだ記憶」を作るための偽物であって、本番の実値ではない（本番の記憶は読んでいない）
const MEMORY_SHAPES: Record<MemoryFixtureSize, MemoryShape> = {
  small: { premiseDocs: 4, premiseBodyChars: 1_500, premiseSections: 3, factDocs: 10 },
  cap: { premiseDocs: 24, premiseBodyChars: 12_000, premiseSections: 40, factDocs: 300 },
};

export async function seedMemory(stores: Stores, size: MemoryFixtureSize): Promise<void> {
  const shape = MEMORY_SHAPES[size];
  for (let doc = 0; doc < shape.premiseDocs; doc += 1) {
    const slug = `premise-${String(doc).padStart(2, '0')}`;
    const sectionChars = Math.floor(shape.premiseBodyChars / shape.premiseSections);
    const sections = Array.from(
      { length: shape.premiseSections },
      (_unused, section) =>
        `## ${slug} の節 ${String(section + 1)}: ${fillerText(24, section + doc).replace(/[。\n]/g, '')}\n\n${fillerText(sectionChars, section + doc)}`,
    );
    await stores.persona.write(
      slug,
      `---\ndescription: ${fillerText(400, doc)}\ntype: premise\n---\n# ${slug}\n\n${sections.join('\n\n')}`,
    );
  }
  for (let doc = 0; doc < shape.factDocs; doc += 1) {
    const slug = `fact-${String(doc).padStart(3, '0')}`;
    await stores.persona.write(
      slug,
      `---\ndescription: ${fillerText(80, doc)}\ntype: fact\n---\n# ${slug}\n\n${fillerText(600, doc)}`,
    );
  }
}

const ORIGINS = ['manager', 'manager', 'manager', 'human', 'external', 'self'] as const;

/** 未了 `open` 件。いちばん古い行が `oldestDaysAgo` 日前になるよう、一定の間隔で並べる。 */
export async function seedCommitments(
  stores: Stores,
  open: number,
  now: number,
  oldestDaysAgo = 30,
  idPrefix = 'commit-',
): Promise<void> {
  for (let index = 0; index < open; index += 1) {
    const ageMs = open === 1 ? 0 : ((open - 1 - index) / (open - 1)) * oldestDaysAgo * DAY_MS;
    const entry: Commitment = {
      id: `${idPrefix}${String(index).padStart(5, '0')}`,
      at: new Date(now - ageMs).toISOString(),
      origin: ORIGINS[index % ORIGINS.length]!,
      body: `${fillerText(180, index)}`,
    };
    await stores.commitments.open(entry);
  }
}

const JOB_STATUS_CYCLE: readonly JobStatus[] = [
  'done',
  'done',
  'done',
  'running',
  'done',
  'failed',
  'done',
  'waiting_human',
  'lost',
  'stopped',
];

export async function seedJobs(stores: Stores, count: number, now: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const createdAt = new Date(now - (count - index) * 2 * 60 * 60 * 1000).toISOString();
    const status = JOB_STATUS_CYCLE[index % JOB_STATUS_CYCLE.length]!;
    const job: Job = {
      id: `mgr-${String(index + 100)}`,
      createdAt,
      updatedAt: createdAt,
      status,
      managerId: `mgr-${String(index + 100)}`,
      summary: fillerText(60, index),
      request: fillerText(400, index),
      lastReport: fillerText(1_500, index),
      lastReportAt: createdAt,
      lastReportStatus: status,
    };
    await stores.jobs.putJob(job);
  }
}

/** 直近 24 時間の日誌（digest の材料）。人間との往復と、マネージャーとのやり取り。 */
export async function seedJournal(stores: Stores, rows: number): Promise<void> {
  for (let index = 0; index < rows; index += 1) {
    const withWho = (['human', 'manager', 'manager', 'self'] as const)[index % 4]!;
    await stores.journal.append({
      type: 'exchange',
      with: withWho,
      role: index % 2 === 0 ? 'inbound' : 'outbound',
      text: fillerText(300, index),
      ...(withWho === 'manager' ? { managerId: `mgr-${String(100 + (index % 40))}` } : {}),
      ...(withWho === 'human' ? { conversationId: `conv-${String(index % 7)}` } : {}),
    });
  }
}
