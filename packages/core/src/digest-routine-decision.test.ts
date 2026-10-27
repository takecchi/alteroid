import { describe, expect, it } from 'vitest';

import { buildActivityDigest, DIGEST_RETAIN_LIMIT } from './digest.js';
import { DigestSessionDelta } from './digest-session-delta.js';
import { journalEntrySchema } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// decision の `routine`（器の機構が定型で書いた行の印）が、要約の「聞かずに決めたこと」の一覧と件数から外れることの試験。

const window = () => ({ since: new Date(Date.now() - 60_000) });
const NOTE_HEAD = '（器の機構が定型で書いた記録 ';

function sectionOf(digest: string, heading: string): string {
  const lines = digest.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const paths = Array.from({ length: 20 }, (_, i) => `packages/some/deep/dir/file-${i}.txt`);
const routineRow = (i: number) =>
  ({
    type: 'decision',
    decision: `作業ツリー /tmp/wt-${i} の未追跡のファイル 20 件を、デーモンの置き場へ預けなかった。`,
    grounds: paths.map((p) => `${p}（secret-like）`).join('、'),
    routine: true,
  }) as const;

async function seed(stores: Stores, human: number, routine: number): Promise<void> {
  for (let i = 0; i < human; i += 1) {
    await stores.journal.append({ type: 'decision', decision: `判断 ${i}`, grounds: '記憶' });
  }
  for (let i = 0; i < routine; i += 1) await stores.journal.append(routineRow(i));
}

describe('decision.routine の要約への効き方', () => {
  it('routine の行は一覧にも件数にも入らず、注記が1行出る', async () => {
    const stores = createMemoryStores();
    await seed(stores, 2, 3);
    const digest = await buildActivityDigest(stores, window());
    expect(digest).toContain('自分で決めたこと（日誌の decision）: 2 件');
    const section = sectionOf(digest, '## 聞かずに決めたこと');
    expect(section).toContain('判断 0');
    expect(section).not.toContain('未追跡のファイル');
    expect(section).toContain(
      '（器の機構が定型で書いた記録 3 件は一覧に入れていない。`journal_read` の types=["decision"] で見える）',
    );
  });

  it('定型の行が無いときは注記を1文字も出さない（印の無い行は今までどおり一覧に出る）', async () => {
    const stores = createMemoryStores();
    await seed(stores, 3, 0);
    // 印の無い、定型と同じ文面の古い行
    await stores.journal.append({ ...routineRow(9), routine: undefined });
    const digest = await buildActivityDigest(stores, window());
    expect(digest).not.toContain(NOTE_HEAD);
    expect(digest).toContain('自分で決めたこと（日誌の decision）: 4 件');
    expect(sectionOf(digest, '## 聞かずに決めたこと')).toContain('未追跡のファイル');
  });

  it('定型の行だけの窓でも注記だけが出て、件数は 0', async () => {
    const stores = createMemoryStores();
    await seed(stores, 0, 2);
    const digest = await buildActivityDigest(stores, window());
    expect(digest).toContain('自分で決めたこと（日誌の decision）: 0 件');
    expect(sectionOf(digest, '## 聞かずに決めたこと')).toContain(`${NOTE_HEAD}2 件`);
  });

  it('保持上限を routine が食わない', async () => {
    const stores = createMemoryStores();
    await seed(stores, 0, 1);
    for (let i = 0; i < DIGEST_RETAIN_LIMIT + 5; i += 1) {
      await stores.journal.append(routineRow(i));
    }
    await stores.journal.append({ type: 'decision', decision: '古い側の判断', grounds: '記憶' });
    const digest = await buildActivityDigest(stores, window());
    expect(digest).toContain('自分で決めたこと（日誌の decision）: 1 件');
    expect(digest).toContain(`${NOTE_HEAD}${DIGEST_RETAIN_LIMIT + 6} 件`);
  });

  it('counts の形の「聞かずに決めたこと」も定型を除く', async () => {
    const stores = createMemoryStores();
    await seed(stores, 2, 4);
    const counts = await buildActivityDigest(stores, window(), undefined, undefined, {
      shape: 'counts',
    });
    expect(counts).toContain('聞かずに決めたこと 2 ');
  });

  it('同じ会話の2回目の差分でも注記の行は壊れず常に出る', async () => {
    const stores = createMemoryStores();
    await seed(stores, 1, 2);
    const delta = new DigestSessionDelta();
    const first = delta.renderDigest(await buildActivityDigest(stores, window()), new Date());
    delta.commit();
    expect(first.text).toContain(`${NOTE_HEAD}2 件`);
    await stores.journal.append(routineRow(99));
    const second = delta.renderDigest(await buildActivityDigest(stores, window()), new Date());
    expect(second.text).toContain(`${NOTE_HEAD}3 件`);
    expect(second.text).not.toContain('判断 0');
  });

  it('schema は routine の有る行も無い行も読む', () => {
    const base = {
      type: 'decision',
      id: 'j1',
      at: '2026-10-01T00:00:00.000Z',
      decision: 'd',
      grounds: 'g',
    };
    expect(journalEntrySchema.safeParse(base).success).toBe(true);
    const withMark = journalEntrySchema.safeParse({ ...base, routine: true });
    expect(withMark.success).toBe(true);
    expect(journalEntrySchema.safeParse({ ...base, routine: false }).success).toBe(false);
  });
});

describe('字数の前後（旧い形の行 = routine 無し と 新しい形の行）', () => {
  it('クローンの判断 5 件＋定型 15 件で、節が縮む', async () => {
    const build = async (marked: boolean): Promise<string> => {
      const stores = createMemoryStores();
      for (let i = 0; i < 15; i += 1) {
        await stores.journal.append({ ...routineRow(i), routine: marked ? true : undefined });
      }
      for (let i = 0; i < 5; i += 1) {
        await stores.journal.append({ type: 'decision', decision: `判断 ${i}`, grounds: '記憶' });
      }
      return sectionOf(await buildActivityDigest(stores, window()), '## 聞かずに決めたこと');
    };
    const before = await build(false);
    const after = await build(true);
    console.info(`聞かずに決めたこと節の字数: 前 ${before.length} / 後 ${after.length}`);
    expect(after.length).toBeLessThan(before.length / 2);
  });
});
