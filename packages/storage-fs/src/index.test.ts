import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MemoryConflictError,
  memoryVersion,
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  decodeState,
  renderMemoryDocuments,
  verifyCommitmentEditIfMatchContract,
  verifyCommitmentRemoveForConversationContract,
  verifyCommitmentEditUnreadableContract,
  verifyCommitmentFoldContract,
  verifyCommitmentTieOrderContract,
  verifyConversationReadStoreContract,
  verifyMcpServerStoreContract,
  verifyMcpServersIfMatchContract,
  verifyCredentialSeedOnceContract,
  verifyCredentialVaultContract,
  verifyTokenPoolContract,
  verifyPersonaNulContract,
  verifyJobNulContract,
  verifyScheduleNulContract,
  verifyScheduleIfMatchContract,
  verifyScheduleUnreadableContract,
  verifySessionRegistryNulContract,
  verifyProfileStoreContract,
  verifyPermissionGrantStoreContract,
  verifyPracticeStoreContract,
  verifyStoreIsolationContract,
  verifyJournalStoreHorizonContract,
  verifyConversationPageContract,
  verifyJournalStoreOrderContract,
  verifyJournalStorePageContract,
  verifyJournalStoreQueryEdgeContract,
  verifyJournalStoreUnreadableGetContract,
  verifyJournalStoreSearchContract,
  verifyJournalStoreDeletedConversationContract,
  verifyJournalStoreWithdrawnContract,
  verifyJournalStoreWithContract,
  verifyTranscriptArchiveContract,
} from '@alteroid/core';
import type {
  Commitment,
  InboxEvent,
  JournalEntry,
  OAuthProfile,
  OAuthProvider,
} from '@alteroid/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { CLOSED_HISTORY_LIMIT, createFsStores, initWorkspace } from './index.js';

let root: string;
let stores: ReturnType<typeof createFsStores>;

beforeEach(async () => {
  root = await makeTempDir('alteroid-test-');
  stores = createFsStores(root);
});

describe('initWorkspace', () => {
  it('人格データディレクトリを生成する（受け入れ基準1）', async () => {
    const result = await initWorkspace(root);

    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        'memory',
        'journal',
        'jobs',
        'archive',
        'state',
        'auth',
        'README.md',
      ]),
    );
    expect(result.created.some((p) => p.endsWith('about-me.md'))).toBe(true);
  });

  it('二度目は既存ファイルを上書きしない（人間の編集を消さない）', async () => {
    await initWorkspace(root);
    await stores.persona.write('about-me', '# 私\n\n手で書いた内容\n');

    const second = await initWorkspace(root);

    expect(second.created).toEqual([]);
    expect((await stores.persona.read('about-me'))?.content).toContain('手で書いた内容');
  });
});

describe('FsPersonaStore', () => {
  it('本文の NUL の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyPersonaNulContract(stores.persona);
  });

  describe('write の前提の版 ifMatch（Issue #2743。fs・pg・インメモリで同じ挙動）', () => {
    it('読んだ版と同じなら書ける。違えば書かずに MemoryConflictError（current は書かれている文書）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const read = await stores.persona.read('values');
      const v1 = memoryVersion(read?.content ?? '');
      await stores.persona.write('values', '# 価値観\n\nV1\n\nクローンの判断\n');

      const error = await stores.persona
        .write('values', '# 価値観\n\n人間の編集\n', { ifMatch: v1 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current?.content).toContain('クローンの判断');
      expect((await stores.persona.read('values'))?.content).toContain('クローンの判断');

      const latest = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const ok = await stores.persona.write('values', '# 価値観\n\n人間の編集\n', {
        ifMatch: latest,
      });
      expect(ok.content).toBe('# 価値観\n\n人間の編集\n');
    });

    it('null は「無かった」: 無ければ作れ、在れば書かない。在るものを null 前提で書かない', async () => {
      await stores.persona.write('values', '# A\n', { ifMatch: null });
      const error = await stores.persona
        .write('values', '# B\n', { ifMatch: null })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((await stores.persona.read('values'))?.content).toBe('# A\n');
    });

    it('文書が無いのに版を指定したら 409（current は null）。書かれない', async () => {
      const error = await stores.persona
        .write('values', '# B\n', { ifMatch: memoryVersion('# 昔あった\n') })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current).toBeNull();
      expect(await stores.persona.read('values')).toBeNull();
    });

    it('同じ版を前提にした2つの書き込みが重なっても、勝つのは1つだけ', async () => {
      await stores.persona.write('values', '# 価値観\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const results = await Promise.allSettled([
        stores.persona.write('values', '# 一\n', { ifMatch: v }),
        stores.persona.write('values', '# 二\n', { ifMatch: v }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('ifMatch を付けなければ従来どおり後勝ち（後方互換）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      await stores.persona.write('values', '# 価値観\n\nV2\n');
      await stores.persona.write('values', '# 価値観\n\nV3\n', {});
      expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n\nV3\n');
    });
  });

  describe('remove の前提の版 ifMatch（Issue #2881。fs・pg・インメモリで同じ挙動）', () => {
    it('読んだ後に別の書き手が書いたなら、消さずに MemoryConflictError（current は書かれている文書）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const v1 = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      await stores.persona.write('values', '# 価値観\n\nV1\n\nクローンの判断\n');

      const error = await stores.persona.remove('values', { ifMatch: v1 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current?.content).toContain('クローンの判断');
      expect((await stores.persona.read('values'))?.content).toContain('クローンの判断');
    });

    it('版が合えば消せる。無い文書に版を指定したら MemoryConflictError（current は null）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      await stores.persona.remove('values', { ifMatch: v });
      expect(await stores.persona.read('values')).toBeNull();

      const error = await stores.persona.remove('values', { ifMatch: v }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current).toBeNull();
    });

    it('同じ版を前提にした書き込みと削除が重なっても、勝つのは1つだけ', async () => {
      await stores.persona.write('values', '# 価値観\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const results = await Promise.allSettled([
        stores.persona.write('values', '# 一\n', { ifMatch: v }),
        stores.persona.remove('values', { ifMatch: v }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('ifMatch を付けなければ従来どおり無条件に消す（後方互換）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.remove('values');
      expect(await stores.persona.read('values')).toBeNull();
    });
  });

  it('書いて読める', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
  });

  it('人間がファイルを手で書き換えると次の読み出しに反映される（受け入れ基準3）', async () => {
    const BEFORE_CONTENT = '# 価値観\n\nもとの内容\n';
    await stores.persona.write('values', BEFORE_CONTENT);

    await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n\n人間が書き換えた\n', 'utf8');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    const cardBefore = renderMemoryDocuments([{ slug: 'values', content: BEFORE_CONTENT }]);
    const cardAfter = renderMemoryDocuments(await stores.persona.documents());
    expect(cardAfter).not.toBe(cardBefore);
    expect(cardAfter).toContain('# 価値観');
    expect(cardAfter).not.toContain('人間が書き換えた');
    expect(cardAfter).not.toContain('もとの内容');
  });

  it('write した本文は、末尾の改行が正規化されて読み戻る', async () => {
    const written = await stores.persona.write('values', '# 価値観');

    expect(written.content).toBe('# 価値観\n');
    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n');
  });

  it('append は末尾に足す', async () => {
    await stores.persona.write('log', '# ログ\n');
    await stores.persona.append('log', '- 追記された学び\n');

    expect((await stores.persona.read('log'))?.content).toBe('# ログ\n\n- 追記された学び\n');
  });

  it('末尾の行が見出しの文書へ追記しても、その見出しの行が壊れない', async () => {
    await stores.persona.write('log', '# ログ\n\n## 最後の節');
    const doc = await stores.persona.append('log', '追記した1行');

    expect(doc.content.split('\n')).toContain('## 最後の節');
    expect(doc.content).toContain('追記した1行');
  });

  it('同時に追記しても取りこぼさない（蒸留は並行して同じ文書に書く）', async () => {
    await stores.persona.write('log', '# ログ\n');

    await Promise.all([
      stores.persona.append('log', '- AAA'),
      stores.persona.append('log', '- BBB'),
      stores.persona.append('log', '- CCC'),
    ]);

    const content = (await stores.persona.read('log'))?.content ?? '';
    expect(content).toContain('AAA');
    expect(content).toContain('BBB');
    expect(content).toContain('CCC');
  });

  it('書き込みは一時ファイル経由（人間に壊れた途中経過を読ませない）', async () => {
    await stores.persona.write('values', '# 価値観\n');

    expect((await readdir(join(root, 'memory'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await stores.persona.list()).toHaveLength(1);
  });

  it('存在しない記憶は null', async () => {
    expect(await stores.persona.read('nope')).toBeNull();
  });

  it('経路をまたぐスラッグを拒む', async () => {
    await expect(stores.persona.write('../escape', 'x')).rejects.toThrow(/スラッグ/);
  });

  it('documents は全文書を本文つき・slug 昇順で返す（載せ方は core が決める）', async () => {
    // 書いた順を slug の昇順とわざと逆にする: 挿入順で通ってしまわないため
    await stores.persona.write('b', '# B\n\nい\n');
    await stores.persona.write('a', '# A\n\nあ\n');

    const docs = await stores.persona.documents();

    expect(docs.map((d) => d.slug)).toEqual(['a', 'b']);
    expect(docs.map((d) => d.content)).toEqual(['# A\n\nあ\n', '# B\n\nい\n']);

    const all = renderMemoryDocuments(docs);

    expect(all).toContain('memory: a.md');
    expect(all).toContain('memory: b.md');
  });

  describe('protectionStatus（保護状態の派生値）', () => {
    it('索引ファイルが無ければ unknown（守る側の既定）', async () => {
      await stores.persona.write('values', '# 価値観\n');

      expect(await stores.persona.protectionStatus('nope')).toEqual({ kind: 'unknown' });
    });

    it('markHumanTouched を呼んだ文書は human になる', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('write() だけの文書は clone-only になる（human 印が無い）', async () => {
      await stores.persona.write('values', '# 価値観\n');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
    });

    it('append 経路でもハッシュが更新される（誤検出しない）', async () => {
      await stores.persona.write('log', '# ログ\n');
      await stores.persona.append('log', '- 追記');

      expect(await stores.persona.protectionStatus('log')).toEqual({ kind: 'clone-only' });
    });

    it('索引が確定した後の write でも、ハッシュ更新は組み直しに頼らない', async () => {
      await stores.persona.write('values', '# 版1\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      await stores.persona.write('values', '# 版2\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
    });

    it('索引が確定した後の append でも、ハッシュ更新は組み直しに頼らない', async () => {
      await stores.persona.write('log2', '# ログ\n');
      expect(await stores.persona.protectionStatus('log2')).toEqual({ kind: 'clone-only' });

      await stores.persona.append('log2', '- 追記');
      expect(await stores.persona.protectionStatus('log2')).toEqual({ kind: 'clone-only' });
    });

    it('道具経由（write）の直後は unknown にならない', async () => {
      await stores.persona.write('values', '# 価値観\n\n本文\n');

      const status = await stores.persona.protectionStatus('values');

      expect(status).not.toEqual({ kind: 'unknown' });
      expect(status).toEqual({ kind: 'clone-only' });
    });

    it('外部から本文が変わったとき、保護状態が古いまま返らない（unknown になる）', async () => {
      await stores.persona.write('values', '# 価値観\n\nもとの内容\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n\n外から書き換えた\n', 'utf8');

      expect((await stores.persona.read('values'))?.content).toContain('外から書き換えた');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'unknown' });
    });

    it('human 印は外部編集があっても降りない（human が unknown より優先）', async () => {
      await stores.persona.write('values', '# 価値観\n\n人間が書いた\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n\n外から書き換えた\n', 'utf8');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('markHumanTouched は降ろさない（古い時刻を渡しても human のまま）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', '2026-01-02T00:00:00.000Z');
      await stores.persona.markHumanTouched('values', '2020-01-01T00:00:00.000Z');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('list() は .index.json を拾わない（*.md しか見ない）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      const list = await stores.persona.list();

      expect(list.map((doc) => doc.slug)).toEqual(['values']);
    });

    it('remove() で保護状態も一緒に消える（実体の無い印を残さない）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      await stores.persona.remove('values');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'unknown' });
    });
  });

  describe('索引の組み直し（保護状態の派生値を失ったとき）', () => {
    it('索引を消してから読むと、humanTouchedAt が日誌から復元される', async () => {
      await stores.persona.write('values', '# 価値観\n\n人間が書いた\n');
      const entry = await stores.journal.append({
        type: 'memory_update',
        slug: 'values',
        cause: 'human',
        action: 'write',
        summary: '過去の PUT を模す',
      });
      await stores.persona.markHumanTouched('values', entry.at);
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });

      await rm(join(root, 'memory', '.index.json'), { force: true });

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('索引を消してから読んでも、クローンが clone-only の文書を畳める（＝凍らない）', async () => {
      await stores.persona.write('notes', '# ノート\n\n最初の版\n');
      expect(await stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });

      await rm(join(root, 'memory', '.index.json'), { force: true });

      expect(await stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });
    });

    it('組み直しが日誌に残る', async () => {
      // store を経由せず直接 `.md` を置く: write() 自体が最初の索引の組み直しを起こし、確かめたい組み直しと数が混ざるため
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'notes.md'), '# ノート\n', 'utf8');

      await stores.persona.protectionStatus('notes');

      const entries = await stores.journal.list({ types: ['decision'] });
      const rebuilds = entries.filter(
        (entry) => 'decision' in entry && entry.decision.includes('組み直した'),
      );
      expect(rebuilds).toHaveLength(1);
      expect(await stores.journal.list({ types: ['memory_update'] })).toHaveLength(0);
    });

    it('組み直しは1回だけで、次の読み出しでは走らない', async () => {
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'notes.md'), '# ノート\n', 'utf8');

      await stores.persona.protectionStatus('notes');
      await stores.persona.protectionStatus('notes');
      await stores.persona.read('notes');
      await stores.persona.list();

      const entries = await stores.journal.list({ types: ['decision'] });
      const rebuilds = entries.filter(
        (entry) => 'decision' in entry && entry.decision.includes('組み直した'),
      );
      expect(rebuilds).toHaveLength(1);
    });
  });

  describe('createdAt（作成時刻の派生値）', () => {
    it('write() は新規作成のとき、backfill を通さずその場で createdAt を known にする（updatedAt と一致）', async () => {
      const doc = await stores.persona.write('values', '# 価値観\n');

      const read = await stores.persona.read('values');

      expect(read?.createdAt).toEqual({ kind: 'known', at: doc.updatedAt });
      expect(read?.createdAt).toEqual({ kind: 'known', at: read?.updatedAt });
    });

    it('既存の文書を更新しても createdAt は変わらない（updatedAt は進む）', async () => {
      const first = await stores.persona.write('values', '# 価値観\n');
      // ファイルシステムの mtime 分解能に負けないよう、確実に時刻を進める
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await stores.persona.write('values', '# 価値観\n\n書き直した\n');

      expect(second.createdAt).toEqual(first.createdAt);
      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect((await stores.persona.read('values'))?.createdAt).toEqual(first.createdAt);
    });

    it('append() が文書を新規作成したときも createdAt が付く', async () => {
      const doc = await stores.persona.append('notes', '最初のメモ');

      expect(doc.createdAt).toEqual({ kind: 'known', at: doc.updatedAt });
      expect((await stores.persona.read('notes'))?.createdAt).toEqual(doc.createdAt);
    });

    it('append() が既存の文書へ追記したときは createdAt が変わらない', async () => {
      const first = await stores.persona.write('notes', '# ノート\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await stores.persona.append('notes', '追記した行');

      expect(second.createdAt).toEqual(first.createdAt);
      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect((await stores.persona.read('notes'))?.createdAt).toEqual(first.createdAt);
    });

    it('markCreatedAt を呼んだ文書は known になる（read() にも list() にも出る）', async () => {
      // write() ではなく索引の無い生ファイルを置く: write() が createdAt を立てて markCreatedAt 単体の効果が隠れるため
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n', 'utf8');

      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
      const meta = (await stores.persona.list()).find((entry) => entry.slug === 'values');
      expect(meta?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });

    it('markCreatedAt は一度きりの確定——2回目は無視される（冪等・絶対条件2）', async () => {
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n', 'utf8');

      const first = await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');
      const second = await stores.persona.markCreatedAt('values', '2020-01-01T00:00:00.000Z');

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
    });

    it('同じ引数で2回走らせても結果は変わらない（backfill の再実行を模す）', async () => {
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n', 'utf8');

      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');
      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
    });

    it('実体の無い slug には新しく行を作らない（削除済み記憶が復活しない）', async () => {
      const wrote = await stores.persona.markCreatedAt('ghost', '2026-01-02T03:04:05.000Z');

      expect(wrote).toBe(false);
      expect(await stores.persona.read('ghost')).toBeNull();
      expect(await stores.persona.list()).toEqual([]);
    });

    it('削除して同じ slug を作り直すと、新しい createdAt になる', async () => {
      const first = await stores.persona.write('values', '# 価値観\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      await stores.persona.remove('values');
      const second = await stores.persona.write('values', '# 価値観\n\n書き直した\n');

      expect(second.createdAt.kind).toBe('known');
      expect(second.createdAt).not.toEqual(first.createdAt);
      expect((await stores.persona.read('values'))?.createdAt).toEqual(second.createdAt);
    });

    it('markCreatedAt は createdAt 以外を1つも書き換えない', async () => {
      // write() ではなく索引の無い生ファイルを置く: write() に createdAt を先に立てさせないため
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(
        join(root, 'memory', 'runbook.md'),
        ['---', 'description: 手順', '---', '# 手順書', '', '本文', ''].join('\n'),
        'utf8',
      );
      await stores.persona.markHumanTouched('runbook', '2020-01-01T00:00:00.000Z');
      const before = await stores.persona.read('runbook');
      const beforeProtection = await stores.persona.protectionStatus('runbook');

      await stores.persona.markCreatedAt('runbook', '2026-01-02T03:04:05.000Z');

      const after = await stores.persona.read('runbook');
      const afterProtection = await stores.persona.protectionStatus('runbook');
      expect(after?.content).toBe(before?.content);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.description).toBe(before?.description);
      expect(after?.kind).toBe(before?.kind);
      expect(after?.parent).toBe(before?.parent);
      expect(afterProtection).toEqual(beforeProtection);
      expect(before?.createdAt).toEqual({ kind: 'unknown' });
      expect(after?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });

    it('markCreatedAt は（human 印を経由しない場合でも）contentSha256 と describedAt を書き換えない', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文', ''].join('\n'),
      );

      const indexPath = join(root, 'memory', '.index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      delete index.runbook.createdAt;
      await writeFile(indexPath, JSON.stringify(index), 'utf8');

      const before = await stores.persona.read('runbook');
      const beforeProtection = await stores.persona.protectionStatus('runbook');
      expect(beforeProtection).toEqual({ kind: 'clone-only' });
      expect(before?.descriptionFreshness).toEqual({ kind: 'fresh' });
      expect(before?.createdAt).toEqual({ kind: 'unknown' });

      const wrote = await stores.persona.markCreatedAt('runbook', '2026-01-02T03:04:05.000Z');

      const after = await stores.persona.read('runbook');
      const afterProtection = await stores.persona.protectionStatus('runbook');
      expect(wrote).toBe(true);
      expect(after?.content).toBe(before?.content);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.description).toBe(before?.description);
      expect(afterProtection).toEqual(beforeProtection);
      expect(after?.descriptionFreshness).toEqual(before?.descriptionFreshness);
      expect(after?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });
  });

  describe('describedAt（要旨の鮮度の派生値）', () => {
    it('description を書いた直後は fresh になる（describedAt === updatedAt）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'fresh' });
      expect(doc?.description).toBe('費用の推移');
      expect(doc?.kind).toBe('fact');
    });

    it('同じ書き込みで本文と description を両方変えても fresh のまま（同じ writtenAt で確定するため）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n旧本文\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移（改訂）\ntype: fact\n---\n# 定点観測\n新本文\n',
      );

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'fresh' });
      expect(doc?.description).toBe('費用の推移（改訂）');
    });

    it('本文だけを書き直すと stale になる（description は本文の変更に追従しない）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const doc = await stores.persona.read('runbook');
      // `staleForMs` は実時計・mtime 分解能に依存するので厳密値で固定せず、正であることだけを見る
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.staleForMs).toBeGreaterThan(0);
      }
      expect(doc?.description).toBe('費用の推移');
    });

    it('stale になった後、description を書き直すと fresh に戻る', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );
      const staleDoc = await stores.persona.read('runbook');
      expect(staleDoc?.descriptionFreshness.kind).toBe('stale');
      if (staleDoc?.descriptionFreshness.kind === 'stale') {
        expect(staleDoc.descriptionFreshness.staleForMs).toBeGreaterThan(0);
      }

      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移（書き直した）\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      expect((await stores.persona.read('runbook'))?.descriptionFreshness).toEqual({
        kind: 'fresh',
      });
    });

    it('description を書かなければ absent のまま（premise の既定と同じ安全側）', async () => {
      await stores.persona.write('about-me', '# 私\n\n前提の本文\n');

      const doc = await stores.persona.read('about-me');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'absent' });
      expect(doc?.kind).toBe('premise');
    });
  });

  describe('describedBytes（本文の変化量の派生値、#913）', () => {
    it('要旨を書いた直後は drift の deltaBytes が厳密に0（describedBytes と bytes の測り方が揃っている）', async () => {
      const written = await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'fresh' });
      expect(doc?.bytes).toBe(written.bytes);
    });

    it('append の後、describedAt/describedBytes は据え置きで、deltaBytes は追記したバイト数と一致する', async () => {
      const before = await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const appended = '追記した1行\n';
      await stores.persona.append('runbook', appended);

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.drift).toEqual({
          kind: 'measured',
          describedBytes: before.bytes,
          currentBytes: doc.bytes,
          deltaBytes: doc.bytes - before.bytes,
        });
        // 範囲で比べる: `ensureTrailingNewline` が足す改行を別に数えないため
        expect(doc.descriptionFreshness.drift.kind === 'measured').toBe(true);
        if (doc.descriptionFreshness.drift.kind === 'measured') {
          expect(doc.descriptionFreshness.drift.deltaBytes).toBeGreaterThanOrEqual(
            Buffer.byteLength(appended, 'utf8'),
          );
        }
      }
    });

    it('describedAt を持つが describedBytes を持たない既存の行は unrecorded になり、deltaBytes: 0 にならない', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const indexPath = join(stores.paths.memory, '.index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<
        string,
        { describedBytes?: number }
      >;
      expect(index.runbook?.describedBytes).toBeGreaterThan(0);
      delete index.runbook?.describedBytes;
      await writeFile(indexPath, JSON.stringify(index), 'utf8');

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.drift).toEqual({ kind: 'unrecorded' });
      }
    });

    it('describedBytes を持たない既存の行へ append すると、その場で基準点が立ち drift が at-least になる（deltaBytes は0にならない、#821 残課題）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const indexPath = join(stores.paths.memory, '.index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<
        string,
        { describedBytes?: number; describedBytesAt?: string }
      >;
      delete index.runbook?.describedBytes;
      delete index.runbook?.describedBytesAt;
      await writeFile(indexPath, JSON.stringify(index), 'utf8');

      const before = await stores.persona.read('runbook');
      expect(before?.descriptionFreshness.kind).toBe('stale');
      if (before?.descriptionFreshness.kind === 'stale') {
        expect(before.descriptionFreshness.drift).toEqual({ kind: 'unrecorded' });
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      const appended = '基準点を立てるための追記\n';
      await stores.persona.append('runbook', appended);

      const after = await stores.persona.read('runbook');
      expect(after?.descriptionFreshness.kind).toBe('stale');
      if (after?.descriptionFreshness.kind === 'stale') {
        expect(after.descriptionFreshness.drift.kind).toBe('at-least');
        if (after.descriptionFreshness.drift.kind === 'at-least') {
          expect(after.descriptionFreshness.drift.deltaBytes).not.toBe(0);
          expect(after.descriptionFreshness.drift.deltaBytes).toBeGreaterThanOrEqual(
            Buffer.byteLength(appended, 'utf8'),
          );
        }
      }
    });

    it('一度立った基準点は、2回目の append で動かない（#821 残課題）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const indexPath = join(stores.paths.memory, '.index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<
        string,
        { describedBytes?: number; describedBytesAt?: string }
      >;
      delete index.runbook?.describedBytes;
      delete index.runbook?.describedBytesAt;
      await writeFile(indexPath, JSON.stringify(index), 'utf8');

      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.append('runbook', '1回目の追記\n');
      const afterFirst = await stores.persona.read('runbook');
      expect(afterFirst?.descriptionFreshness.kind).toBe('stale');
      if (afterFirst?.descriptionFreshness.kind !== 'stale') throw new Error('unreachable');
      expect(afterFirst.descriptionFreshness.drift.kind).toBe('at-least');
      if (afterFirst.descriptionFreshness.drift.kind !== 'at-least') throw new Error('unreachable');
      const firstBaselineBytes = afterFirst.descriptionFreshness.drift.baselineBytes;
      const firstBaselineAt = afterFirst.descriptionFreshness.drift.baselineAt;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.append('runbook', '2回目の追記\n');
      const afterSecond = await stores.persona.read('runbook');
      expect(afterSecond?.descriptionFreshness.kind).toBe('stale');
      if (afterSecond?.descriptionFreshness.kind !== 'stale') throw new Error('unreachable');
      expect(afterSecond.descriptionFreshness.drift.kind).toBe('at-least');
      if (afterSecond.descriptionFreshness.drift.kind !== 'at-least')
        throw new Error('unreachable');
      expect(afterSecond.descriptionFreshness.drift.baselineBytes).toBe(firstBaselineBytes);
      expect(afterSecond.descriptionFreshness.drift.baselineAt).toBe(firstBaselineAt);
      expect(afterSecond.descriptionFreshness.drift.deltaBytes).toBeGreaterThan(
        afterFirst.descriptionFreshness.drift.deltaBytes,
      );
    });
  });
});

describe('FsJournalStore', () => {
  it('追記して新しい順に読める', async () => {
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '最初',
    });
    await stores.journal.append({
      type: 'decision',
      decision: '自分で答えた',
      grounds: 'about-me.md にそう書いてある',
    });

    const entries = await stores.journal.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe('decision');
    expect(entries[1]?.type).toBe('exchange');
  });

  it('type と limit で絞れる', async () => {
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'a' });
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'outbound', text: 'b' });
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(1);
    expect(await stores.journal.list({ limit: 2 })).toHaveLength(2);
  });

  it('JSONL として人間が読める形で残る', async () => {
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    const files = await readdir(join(root, 'journal'));
    const raw = await readFile(join(root, 'journal', files[0] as string), 'utf8');

    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(JSON.parse(raw.trim())).toMatchObject({ type: 'decision', decision: 'd' });
  });

  it('since より古い日のファイルは読まない（日報・要約が毎回全部を読まないため）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    const journalDir = join(root, 'journal');
    // 過去の日誌を手で置く: 読まれてしまうなら壊れた行で気づけるため
    await writeFile(join(journalDir, '2020-01-01.jsonl'), 'これは JSON ではない\n', 'utf8');
    const old = join(journalDir, '2020-01-02.jsonl');
    await writeFile(
      old,
      `${JSON.stringify({
        type: 'decision',
        id: 'old',
        at: '2020-01-02T00:00:00.000Z',
        decision: '昔の分',
        grounds: 'g',
      })}\n`,
      'utf8',
    );

    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const entries = await stores.journal.list({ since });
    expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual(['今日の分']);

    expect(await stores.journal.list()).toHaveLength(2);
  });

  it('同時追記でも行が壊れない', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: `t${i}` }),
      ),
    );

    expect(await stores.journal.list()).toHaveLength(20);
  });

  it('until で窓の終端を閉じられる（新しい日のファイルを跨いで過去へ届く）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    // `until` で走査を打ち切らない: 新しい日から走査するので、打ち切るとこの過去の日へ辿り着けない
    const journalDir = join(root, 'journal');
    await writeFile(
      join(journalDir, '2020-01-02.jsonl'),
      `${JSON.stringify({
        type: 'decision',
        id: 'old',
        at: '2020-01-02T00:00:00.000Z',
        decision: '昔の分',
        grounds: 'g',
      })}\n`,
      'utf8',
    );

    const entries = await stores.journal.list({ until: '2020-01-03T00:00:00.000Z' });
    expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual(['昔の分']);
  });

  it('asc: since より古い日のファイルは読み飛ばして続きを読む（早期打ち切りの向きが反転する。#432）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    // asc では sinceDay より古いファイルを break で打ち切らない: 窓の中の今日の分へ辿り着けず結果が黙って空になるため
    const journalDir = join(root, 'journal');
    await writeFile(
      join(journalDir, '2020-01-01.jsonl'),
      `${JSON.stringify({
        type: 'decision',
        id: 'old',
        at: '2020-01-01T00:00:00.000Z',
        decision: '古すぎる分',
        grounds: 'g',
      })}\n`,
      'utf8',
    );

    const since = '2020-06-01T00:00:00.000Z';
    const entries = await stores.journal.list({ order: 'asc', since });
    expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual(['今日の分']);
  });

  it('asc: until より新しい日のファイルに当たったら打ち切る（早期打ち切りの向きが反転する。#432）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    const journalDir = join(root, 'journal');
    await writeFile(
      join(journalDir, '2020-01-01.jsonl'),
      `${JSON.stringify({
        type: 'decision',
        id: 'old',
        at: '2020-01-01T00:00:00.000Z',
        decision: '古い分',
        grounds: 'g',
      })}\n`,
      'utf8',
    );

    const until = '2020-01-02T00:00:00.000Z';
    const entries = await stores.journal.list({ order: 'asc', until });
    expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual(['古い分']);
  });

  it('id で1件引ける（一覧を抜粋にした先の全文の行き先）', async () => {
    const entry = await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.get(entry.id)).toMatchObject({ id: entry.id, decision: 'd' });
    expect(await stores.journal.get('no-such-id')).toBeNull();
  });

  it('input の無い tool_use エントリが、直列化を挟んでも読み出せる（回帰）', async () => {
    const written = await stores.journal.append({
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Bash',
    });

    const entries = await stores.journal.list({ types: ['tool_use'] });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: written.id, actor: 'manager:mgr-1', tool: 'Bash' });
    expect((entries[0] as { input?: unknown }).input).toBeUndefined();
  });

  it('input のキーが在って値が undefined でも、直列化を挟んで読み出せる（回帰・静かなほう）', async () => {
    const written = await stores.journal.append({
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Bash',
      input: undefined,
    });

    const entries = await stores.journal.list({ types: ['tool_use'] });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: written.id, actor: 'manager:mgr-1', tool: 'Bash' });
  });

  describe('スキーマに合わない行の跡（Issue #224）', () => {
    const secret = 'ghp_000000000000000000000000000000000000';

    it('型は知っているが値だけ知らない行も、その行だけ飛ばす（版のずれ）', async () => {
      // デーモンは複数の版が同時に走り、新しい enum の値の行を古い版が読む窓が必ず在る。一覧が読めなくなるなら値は足せない
      await stores.journal.append({ type: 'decision', decision: '健全な行', grounds: 'g' });

      const journalDir = join(root, 'journal');
      const today = new Date().toISOString().slice(0, 10);
      await writeFile(
        join(journalDir, `${today}.jsonl`),
        `${JSON.stringify({
          type: 'token_rotation',
          id: 'from-newer-daemon',
          at: `${today}T00:00:00.000Z`,
          event: 'a_value_this_version_does_not_know',
          text: '新しい版が書いた行',
        })}\n`,
        { flag: 'a' },
      );

      let entries: Awaited<ReturnType<typeof stores.journal.list>> = [];
      const lines = await captureStderr(async () => {
        entries = await stores.journal.list();
      });

      expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual([
        '健全な行',
      ]);
      const trace = lines.join('\n');
      expect(trace).toContain('こちらのスキーマに合わなかった');
      expect(trace).toContain('type=token_rotation');
      expect(trace).not.toContain('新しい版が書いた行');
    });

    it('list(): スキーマに合わない行を跡に残しつつ、読めた行はそのまま返す', async () => {
      await stores.journal.append({ type: 'decision', decision: '健全な行', grounds: 'g' });

      const journalDir = join(root, 'journal');
      const today = new Date().toISOString().slice(0, 10);
      await writeFile(
        join(journalDir, `${today}.jsonl`),
        `${JSON.stringify({
          type: 'future-type',
          id: 'broken-1',
          at: `${today}T00:00:00.000Z`,
          leakedBody: `秘密は ${secret} だった`,
        })}\n` + `これは JSON ではない ${secret}\n`,
        { flag: 'a' },
      );

      let entries: Awaited<ReturnType<typeof stores.journal.list>> = [];
      const lines = await captureStderr(async () => {
        entries = await stores.journal.list();
      });

      expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual([
        '健全な行',
      ]);

      expect(lines.length).toBeGreaterThan(0);
      const joined = lines.join('');
      expect(joined).toContain('日誌の行を読み出せずに飛ばした');
      expect(joined).toContain('type=future-type');
      expect(joined).toContain('（type も読めない）');

      expect(joined).not.toContain(secret);
    });

    it('get(): スキーマに合わない行を跡に残しつつ、探している行が読めれば返す', async () => {
      const written = await stores.journal.append({
        type: 'decision',
        decision: '探している行',
        grounds: 'g',
      });

      const journalDir = join(root, 'journal');
      const today = new Date().toISOString().slice(0, 10);
      await writeFile(
        join(journalDir, `${today}.jsonl`),
        `${JSON.stringify({
          type: 'future-type',
          id: 'broken-1',
          at: `${today}T00:00:01.000Z`,
          leakedBody: `秘密は ${secret} だった`,
        })}\n`,
        { flag: 'a' },
      );

      let found: JournalEntry | null = null;
      const lines = await captureStderr(async () => {
        found = await stores.journal.get(written.id);
      });

      expect(found).toMatchObject({ id: written.id, decision: '探している行' });
      const joined = lines.join('');
      expect(joined).toContain('日誌の行を読み出せずに飛ばした');
      expect(joined).toContain('type=future-type');
      expect(joined).not.toContain(secret);
    });

    it('get(): 見つからない id でも、途中で飛ばした行の跡は残る', async () => {
      const journalDir = join(root, 'journal');
      const today = new Date().toISOString().slice(0, 10);
      await mkdir(journalDir, { recursive: true });
      await writeFile(
        join(journalDir, `${today}.jsonl`),
        `${JSON.stringify({
          type: 'future-type',
          id: 'broken-1',
          at: `${today}T00:00:00.000Z`,
        })}\n`,
        'utf8',
      );

      let found: JournalEntry | null = null;
      const lines = await captureStderr(async () => {
        found = await stores.journal.get('no-such-id');
      });

      expect(found).toBeNull();
      expect(lines.join('')).toContain('type=future-type');
    });

    it('同じ種別の行が大量にあっても、初出は1行だけ・量は呼び出しの終わりに1行でまとまる', async () => {
      const journalDir = join(root, 'journal');
      const today = new Date().toISOString().slice(0, 10);
      await mkdir(journalDir, { recursive: true });
      const brokenLines = Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({
          type: 'future-type',
          id: `broken-${i}`,
          at: `${today}T00:00:00.000Z`,
        }),
      ).join('\n');
      await writeFile(join(journalDir, `${today}.jsonl`), `${brokenLines}\n`, 'utf8');

      const lines = await captureStderr(async () => {
        await stores.journal.list();
      });

      const firstLines = lines.filter((line) => line.includes('初出'));
      expect(firstLines).toHaveLength(1);
      const summaryLines = lines.filter((line) => line.includes('合計'));
      expect(summaryLines).toHaveLength(1);
      expect(summaryLines[0]).toContain('unknown-shape:future-type×20');
      expect(lines).toHaveLength(2);
    });
  });

  describe('取り下げの印の契約（issue #3990）', () => {
    it('印の行が書き戻せ、同じ会話の印だけが集まり、since より前は外れ、頁をまたいでも読み落とさない', async () => {
      await verifyJournalStoreWithdrawnContract(stores.journal);
    });
  });

  describe('墓標の契約（issue #4218）', () => {
    it('墓標の後は list/listPage/get/q/with から外れる／別の会話と墓標は外れない／limit より前に効く／墓標の後の行も外れる', async () => {
      await verifyJournalStoreDeletedConversationContract(stores.journal);
    });

    it('開き直したストアも、ファイルに残った墓標から消した会話を外す（初回の読み出しで集める）', async () => {
      const gone = await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: '消す会話の発言',
        conversationId: 'c-gone',
      });
      await stores.journal.append({
        type: 'conversation_deleted',
        deletedConversationId: 'c-gone',
        deletedBy: 'operator',
        hiddenCount: 1,
      });

      const reopened = createFsStores(root);
      expect(await reopened.journal.get(gone.id)).toBeNull();
      expect((await reopened.journal.list({ types: ['exchange'] })).map((e) => e.id)).not.toContain(
        gone.id,
      );
    });

    it('集合を読み込んだあとに積んだ墓標も、その場で効く', async () => {
      const row = await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: 'あとで消す会話の発言',
        conversationId: 'c-later',
      });
      expect((await stores.journal.get(row.id))?.id).toBe(row.id);
      await stores.journal.append({
        type: 'conversation_deleted',
        deletedConversationId: 'c-later',
        deletedBy: 'account:a1',
        hiddenCount: 1,
      });
      expect(await stores.journal.get(row.id)).toBeNull();
    });
  });

  describe('with 契約（issue #418）', () => {
    it('未指定=絞らない／指定=その with だけ／[]=0件／limit より前に効く', async () => {
      await verifyJournalStoreWithContract(stores.journal);
    });

    it('manager の往復を scan より多く積んでも、human の発言は窓に食われない', async () => {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: '人間の質問',
        conversationId: 'conv-1',
      });
      for (let i = 0; i < 10; i += 1) {
        await stores.journal.append({
          type: 'exchange',
          with: i % 2 === 0 ? 'manager' : 'self',
          role: 'inbound',
          text: `noise-${i}`,
        });
      }

      const entries = await stores.journal.list({
        limit: 3,
        types: ['exchange'],
        with: ['human'],
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ with: 'human', text: '人間の質問' });
    });
  });

  describe('order/after 契約（issue #432 の2本目）', () => {
    it('order 未指定=desc／asc は正確な逆順／after は絞り・limit より前に効く／同着を飛ばさない', async () => {
      await verifyJournalStoreOrderContract(stores.journal);
    });

    it('会話の一覧の頁送り（日誌の継続点の上の組み立て）が、頁の連結=全件・窓より小さい頁・同着・使えない継続点で揃う', async () => {
      await verifyConversationPageContract(stores.journal);
    });

    it('畳み込みの契約（#1041。3実装で同じことを測る。⚠ 名乗れるのはプロセス内で原子であることまで）', async () => {
      await verifyCommitmentFoldContract(stores.commitments);
    });

    it('同じ at の未了の並びの契約（#3285。3実装で同じことを測る。入れた順のまま、editBody・close・closeMany の後も）', async () => {
      await verifyCommitmentTieOrderContract(stores.commitments);
    });

    it('editBody の ifMatch の契約（#3786。3実装で同じことを測る）', async () => {
      await verifyCommitmentEditIfMatchContract(stores.commitments);
    });

    it('removeForConversation の契約（#4218。3実装で同じことを測る。human かつ source 一致の行だけを未了・片付いたとも物理的に消す）', async () => {
      await verifyCommitmentRemoveForConversationContract(stores.commitments);
    });

    it('読めない行への editBody の契約（#4064。fs と pg で同じことを測る。インメモリは読めない行を持てない）', async () => {
      const path = join(stores.paths.jobs, 'commitments.json');
      await captureStderr(async () => {
        await verifyCommitmentEditUnreadableContract(stores.commitments, async (id) => {
          // `open` は形を断るので、`commitments.json` へ直に足す
          const file = JSON.parse(await readFile(path, 'utf8')) as { commitments: unknown[] };
          file.commitments.push({
            id,
            at: '2026-01-01T00:00:00.000Z',
            origin: 'future-origin',
            body: '壊れた行',
          });
          await writeFile(path, JSON.stringify(file), 'utf8');
        });
      });
    });

    it('ストアが返す値は書いた側の握りと別物である（#1072。3実装で同じことを測る）', async () => {
      await verifyStoreIsolationContract(stores);
    });

    it('やり方の器の契約（#1055 段3。3実装で同じことを測る）', async () => {
      await verifyPracticeStoreContract(stores.practices, { verifyClear: true });
    });

    it('旧い bytes 欄が残る JSON も読める（#1340。改名前の値は読み時に無視する）', async () => {
      const dir = join(root, 'jobs');
      await mkdir(dir, { recursive: true });
      const now = new Date().toISOString();
      const legacyContent = '古いやり方\n';
      await writeFile(
        join(dir, 'practices.json'),
        JSON.stringify({
          practices: [
            {
              slug: 'legacy',
              kind: '調査',
              title: '改名前のやり方',
              content: legacyContent,
              // chars とは明らかに違う値にする: 誤って読まれたら検出できるように
              bytes: 999999,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      );

      const list = (await stores.practices.list()).entries;
      expect(list).toHaveLength(1);
      expect(list[0]?.chars).toBe([...legacyContent].length);

      const read = await stores.practices.read('legacy');
      expect(read?.content).toBe(legacyContent);
      expect(read?.chars).toBe([...legacyContent].length);
    });

    it('after はファイルをまたいでも正しく枝刈りする（錨より新しい日を desc で、古い日を asc で丸ごと落とす）', async () => {
      const journalDir = join(root, 'journal');
      await mkdir(journalDir, { recursive: true });

      const day1 = {
        type: 'decision' as const,
        id: 'day1',
        at: '2020-01-01T00:00:00.000Z',
        decision: 'day1',
        grounds: 'g',
      };
      const day2a = {
        type: 'decision' as const,
        id: 'day2a',
        at: '2020-01-02T00:00:00.000Z',
        decision: 'day2a',
        grounds: 'g',
      };
      const day2b = {
        type: 'decision' as const,
        id: 'day2b',
        at: '2020-01-02T12:00:00.000Z',
        decision: 'day2b',
        grounds: 'g',
      };
      const day3 = {
        type: 'decision' as const,
        id: 'day3',
        at: '2020-01-03T00:00:00.000Z',
        decision: 'day3',
        grounds: 'g',
      };

      await writeFile(join(journalDir, '2020-01-01.jsonl'), `${JSON.stringify(day1)}\n`, 'utf8');
      await writeFile(
        join(journalDir, '2020-01-02.jsonl'),
        `${JSON.stringify(day2a)}\n${JSON.stringify(day2b)}\n`,
        'utf8',
      );
      await writeFile(join(journalDir, '2020-01-03.jsonl'), `${JSON.stringify(day3)}\n`, 'utf8');

      const afterDay2bDesc = await stores.journal.list({
        order: 'desc',
        after: { id: day2b.id, at: day2b.at },
        limit: 10,
      });
      expect(afterDay2bDesc.map((e) => e.id)).toEqual(['day2a', 'day1']);

      const afterDay2aAsc = await stores.journal.list({
        order: 'asc',
        after: { id: day2a.id, at: day2a.at },
        limit: 10,
      });
      expect(afterDay2aAsc.map((e) => e.id)).toEqual(['day2b', 'day3']);
    });
  });

  describe('listPage 契約（Issue #2604 / #2605）', () => {
    it('entries は list() と同じ／next は本当に先が在るときだけ／next で全件を過不足なく読める', async () => {
      await verifyJournalStorePageContract(stores.journal);
    });
  });

  describe('query edge 契約（issue #425）', () => {
    it('types: []=0件／limit: 0=0件／types 未指定=絞らない／指定=その種別だけ／limit:N(N>=1)はN件で切る／同時指定でも0件', async () => {
      await verifyJournalStoreQueryEdgeContract(stores.journal);
    });
  });

  describe('get の「在るが読めない」契約（issue #3288）', () => {
    it('読めない行の get は UnreadableJournalEntryError／無い id は null／読める行と list は巻き込まれない', async () => {
      const journalDir = join(root, 'journal');
      await mkdir(journalDir, { recursive: true });
      await verifyJournalStoreUnreadableGetContract(stores.journal, async () => {
        const id = 'unreadable-contract-1';
        const today = new Date().toISOString().slice(0, 10);
        await writeFile(
          join(journalDir, `${today}.jsonl`),
          `${JSON.stringify({ id, at: `${today}T00:00:00.000Z`, type: 'no-such-type' })}\n`,
          { flag: 'a' },
        );
        return id;
      });
    });
  });

  describe('日誌の地平（issue #1510）', () => {
    it('空なら null／1件ならその at／複数件でも最古のまま', async () => {
      await verifyJournalStoreHorizonContract(stores.journal);
    });
  });

  describe('q 契約（issue #250）', () => {
    it('未指定=絞らない／部分一致／大文字小文字を区別しない／%_ はワイルドカードでない／""=絞らない／limit より前に効く', async () => {
      await verifyJournalStoreSearchContract(stores.journal);
    });
  });
});

describe('FsJobStore', () => {
  it('NUL の契約（issue #3011。3実装で同じことを測る）', async () => {
    await verifyJobNulContract(stores.jobs);
  });

  it('承認待ちを積んで回答できる', async () => {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これをやってよいか',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-1');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      answeredAt: new Date().toISOString(),
      answer: 'よい',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
  });

  it('取り下げた承認待ちは pendingOnly から消えるが、getApproval では理由ごと読める', async () => {
    await stores.jobs.putApproval({
      id: 'ap-withdraw',
      createdAt: new Date().toISOString(),
      question: 'これをやってよいか',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-withdraw');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '自分で答えを見つけた',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    expect((await stores.jobs.listApprovals()).entries).toHaveLength(1);
    const after = await stores.jobs.getApproval('ap-withdraw');
    expect(after?.withdrawnReason).toBe('自分で答えを見つけた');
  });

  it('同じ id は上書きされる', async () => {
    const base = { id: 'j-1', createdAt: '2026-01-01T00:00:00.000Z', question: 'q' };
    await stores.jobs.putApproval(base);
    await stores.jobs.putApproval({ ...base, question: 'q2' });

    expect((await stores.jobs.listApprovals()).entries).toHaveLength(1);
  });

  // listApprovals の並びを createdAt 昇順とみなさない: putApproval は既存 id を除いてから push するので、答えた行は末尾へ動く
  it('既存の id へ書くと配列の末尾へ移動する（並びに意味は無いことの記録）', async () => {
    await stores.jobs.putApproval({
      id: 'ap-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '先に作った方',
    });
    await stores.jobs.putApproval({
      id: 'ap-new',
      createdAt: '2026-01-02T00:00:00.000Z',
      question: '後に作った方',
    });

    expect((await stores.jobs.listApprovals()).entries.map((a) => a.id)).toEqual([
      'ap-old',
      'ap-new',
    ]);

    await stores.jobs.putApproval({
      id: 'ap-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '先に作った方',
      answeredAt: '2026-01-03T00:00:00.000Z',
      answer: 'よい',
    });

    expect((await stores.jobs.listApprovals()).entries.map((a) => a.id)).toEqual([
      'ap-new',
      'ap-old',
    ]);
  });
});

describe('FsPermissionGrantStore（issue #863）', () => {
  const GRANT = {
    id: 'grant-1',
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit'],
    denies: ['gh release edit; rm -rf /'],
    approvalId: 'ap-1',
    answer: '許可します',
    grantedAt: '2026-01-01T00:00:00.000Z',
    route: { principalKind: 'account' as const, accountId: 'acc-1' },
  };

  it('put した許可を list / get で読み戻せる', async () => {
    await stores.permissionGrants.put(GRANT);

    expect(await stores.permissionGrants.list()).toEqual([GRANT]);
    expect(await stores.permissionGrants.get('grant-1')).toEqual(GRANT);
  });

  it('器の契約（Issue #863。3実装で同じことを測る）', async () => {
    await verifyPermissionGrantStoreContract(stores.permissionGrants);
  });

  it('無い id の get は null', async () => {
    expect(await stores.permissionGrants.get('no-such-id')).toBeNull();
  });

  it('同じ id への put は置き換える（revoke の実装がこれに乗る）', async () => {
    await stores.permissionGrants.put(GRANT);
    await stores.permissionGrants.put({ ...GRANT, revokedAt: '2026-01-02T00:00:00.000Z' });

    const list = await stores.permissionGrants.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.revokedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('list は grantedAt 昇順で返る', async () => {
    await stores.permissionGrants.put({
      ...GRANT,
      id: 'grant-2',
      grantedAt: '2026-02-01T00:00:00.000Z',
    });
    await stores.permissionGrants.put({
      ...GRANT,
      id: 'grant-1',
      grantedAt: '2026-01-01T00:00:00.000Z',
    });

    expect((await stores.permissionGrants.list()).map((g) => g.id)).toEqual(['grant-1', 'grant-2']);
  });

  it('器を作り直しても読み戻せる（永続化。ジョブと同じ paths.jobs 配下）', async () => {
    await stores.permissionGrants.put(GRANT);

    const reopened = createFsStores(root);
    expect(await reopened.permissionGrants.list()).toEqual([GRANT]);
  });
});

describe('FsScheduleStore', () => {
  it('NUL の契約（issue #3011。3実装で同じことを測る）', async () => {
    await verifyScheduleNulContract(stores.schedules);
  });

  it('ifMatch の契約（Issue #3821。3実装で同じことを測る）', async () => {
    await verifyScheduleIfMatchContract(stores.schedules);
  });

  it('読めない行の契約（Issue #3859。fs と pg で同じことを測る。インメモリは読めない行を持てない）', async () => {
    const path = join(root, 'jobs', 'schedules.json');
    await captureStderr(async () => {
      await verifyScheduleUnreadableContract(stores.schedules, async (kind) => {
        // `put` は形を断るので、`schedules.json` へ直に足す
        const file = JSON.parse(await readFile(path, 'utf8')) as {
          schedules: { kind?: string }[];
        };
        file.schedules = file.schedules.filter((row) => row.kind !== kind);
        file.schedules.push({
          kind,
          spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
          request: '壊れた行',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as never);
        await writeFile(path, JSON.stringify(file), 'utf8');
      });
    });
  });

  const plan = {
    kind: 'issue-round',
    spec: { type: 'daily' as const, at: '09:00' },
    request: 'open issue を見て実装を進める',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };

  it('既定の仕込みの位相は読み戻せる（器を作り直しても発意 tick の位相が残る）', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastRunAt: '2026-08-12T01:00:00.000Z',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });

    expect(await stores.schedules.getPhase('self_initiative')).toEqual({
      kind: 'self_initiative',
      lastRunAt: '2026-08-12T01:00:00.000Z',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });
    expect(await stores.schedules.getPhase('daily_report')).toBeNull();
  });

  it('位相は継続中の依頼の一覧に現れない（クローンから消せる依頼に化けない）', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });

    // 既定の日報・発意 tick を list() に混ぜない: 混ざると `schedule_remove` で消せてしまうため
    expect((await stores.schedules.list()).entries).toEqual([]);
    expect(await stores.schedules.get('self_initiative')).toBeNull();
  });

  it('依頼を足しても外しても位相は消えない（同じファイルに同居している）', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });
    await stores.schedules.put(plan);
    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );
    await stores.schedules.completeRun('issue-round', '2026-08-13T00:00:00.000Z', 'schedule');
    await stores.schedules.remove('issue-round');

    expect((await stores.schedules.getPhase('self_initiative'))?.lastScheduledRunAt).toBe(
      '2026-08-12T01:00:00.000Z',
    );
  });

  it('同じ kind の位相は置き換わる', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T02:00:00.000Z',
    });

    expect((await stores.schedules.getPhase('self_initiative'))?.lastScheduledRunAt).toBe(
      '2026-08-12T02:00:00.000Z',
    );
  });

  it('仕込んだ依頼は読み戻せる（デーモンを作り直しても残る）', async () => {
    await stores.schedules.put(plan);

    expect((await stores.schedules.list()).entries).toEqual([plan]);
    expect((await stores.schedules.get('issue-round'))?.request).toContain('open issue');
    expect(await stores.schedules.get('しらない')).toBeNull();
  });

  it('同じ kind は置き換わる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.put({ ...plan, request: '直した依頼' });

    const plans = (await stores.schedules.list()).entries;
    expect(plans).toHaveLength(1);
    expect(plans[0]?.request).toBe('直した依頼');
  });

  it('発火を確定できる。返るのは更新前の姿（前回いつ動いたかが分かる）', async () => {
    await stores.schedules.put(plan);

    const claimed = await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );

    expect(claimed?.request).toBe(plan.request);
    expect(claimed?.lastRunAt).toBeUndefined();
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
    expect((await stores.schedules.get('issue-round'))?.updatedAt).toBe(plan.updatedAt);
  });

  it('引き受けた印は完了で消える。印が残っていれば配り直せる', async () => {
    await stores.schedules.put(plan);

    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );

    // claim だけでは定期の基準を進めない（ここで進めると、直後に落ちた回が消える）
    const claimed = await stores.schedules.get('issue-round');
    expect(claimed?.pendingRun).toEqual({ at: '2026-08-13T00:00:00.000Z', cause: 'schedule' });
    expect(claimed?.lastScheduledRunAt).toBeUndefined();

    await stores.schedules.completeRun('issue-round', '2026-08-13T00:00:00.000Z', 'schedule');

    const done = await stores.schedules.get('issue-round');
    expect(done?.pendingRun).toBeUndefined();
    expect(done?.lastScheduledRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('別の発火の完了で、いま引き受けている印を消さない', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );

    await stores.schedules.completeRun('issue-round', '2026-08-12T00:00:00.000Z', 'schedule');

    const held = await stores.schedules.get('issue-round');
    expect(held?.pendingRun?.at).toBe('2026-08-13T00:00:00.000Z');
    expect(held?.lastScheduledRunAt).toBeUndefined();
  });

  it('手で起こした分は観測用の前回時刻だけを進める（定期の基準は動かさない）', async () => {
    await stores.schedules.put(plan);

    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'manual',
    );
    await stores.schedules.completeRun('issue-round', '2026-08-13T00:00:00.000Z', 'manual');

    const after = await stores.schedules.get('issue-round');
    expect(after?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
    // これを動かすと、再起動した瞬間に定期の予定が手動実行の時刻へずれる
    expect(after?.lastScheduledRunAt).toBeUndefined();
  });

  it('消された・書き換わった依頼は確定できない（古い本文で走らせない）', async () => {
    expect(
      await stores.schedules.claimRun(
        'しらない',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();

    await stores.schedules.put(plan);
    await stores.schedules.remove('issue-round');
    expect(
      await stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();

    await stores.schedules.put(plan);
    await stores.schedules.put({
      ...plan,
      request: '人間が直した依頼',
      updatedAt: '2026-08-12T10:00:00.000Z',
    });
    expect(
      await stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBeUndefined();
  });

  it('読んでから確定するまでに remove / put が割り込んでも、古い版では確定しない', async () => {
    await stores.schedules.put(plan);

    const [claimedAfterRemove] = await Promise.all([
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
      stores.schedules.remove('issue-round'),
    ]);
    if (claimedAfterRemove !== null) {
      expect(await stores.schedules.get('issue-round')).toBeNull();
    }

    await stores.schedules.put(plan);
    const edited = { ...plan, request: '直した依頼', updatedAt: '2026-08-12T10:00:00.000Z' };
    await Promise.all([
      stores.schedules.put(edited),
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ]);
    const after = await stores.schedules.get('issue-round');
    expect(after?.request).toBe('直した依頼');
    expect(after?.lastRunAt).toBeUndefined();
  });

  it('同時に書いても取りこぼさない（人間の書き換えと発火の確定は並行して来る）', async () => {
    await stores.schedules.put(plan);

    await Promise.all([
      stores.schedules.put({ ...plan, kind: 'a', request: 'A の依頼' }),
      stores.schedules.put({ ...plan, kind: 'b', request: 'B の依頼' }),
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
      stores.schedules.remove('しらない'),
    ]);

    const plans = (await stores.schedules.list()).entries;
    expect(plans.map((entry) => entry.kind)).toEqual(['a', 'b', 'issue-round']);
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('外せる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.remove('issue-round');

    expect((await stores.schedules.list()).entries).toEqual([]);
  });

  it('読めない中身を「消された」に潰さない（pg 版と同じ振る舞い）', async () => {
    await initWorkspace(root);
    await writeFile(
      join(root, 'jobs', 'schedules.json'),
      JSON.stringify({ schedules: [{ kind: 'broken' }] }),
      'utf8',
    );

    // null に潰さない: クローンから見て「消された依頼」と区別が付かず、本文なしの曖昧なターンが走るため
    await expect(stores.schedules.get('broken')).rejects.toThrow();

    expect((await stores.schedules.list()).entries).toEqual([]);
  });
});

describe('FsCommitmentStore', () => {
  const commitment = (id: string, at: string, body: string): Commitment => ({
    id,
    at,
    origin: 'human',
    source: 'conv-1',
    body,
  });

  it('開いた仕事は未了として読み戻せる（デーモンを作り直しても残る）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(await stores.commitments.list()).toEqual({
      entries: [commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す')],
      unreadable: [],
      trimmedClosed: 0,
    });
    expect((await stores.commitments.get('c-1'))?.body).toBe('PR を出す');
    expect(await stores.commitments.get('しらない')).toBeNull();
  });

  it('閉じたものは未了から外れ、includeClosed でだけ読める（行は消さない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(
      await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した', 'clone'),
    ).toBe(true);

    expect(await stores.commitments.list()).toEqual({
      entries: [],
      unreadable: [],
      trimmedClosed: 0,
    });
    const all = (await stores.commitments.list({ includeClosed: true })).entries;
    expect(all).toHaveLength(1);
    // 「閉じた」だけを残さない（何をもって終わりとしたかが無いと人間が否定できない）
    expect(all[0]?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(all[0]?.closedReason).toBe('#99 で出した');
    expect(all[0]?.closedBy).toBe('clone');
  });

  it('close は closedBy を記録し、既存の（closedBy の無い）行は undefined のままで既定へ倒れない', async () => {
    await stores.commitments.open({
      id: 'c-legacy',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '導入前に片付いた仕事',
      closedAt: '2026-08-02T00:00:00.000Z',
      closedReason: '当時は書き手を記録していなかった',
    });
    const legacy = await stores.commitments.get('c-legacy');
    expect(legacy?.closedBy).toBeUndefined();

    await stores.commitments.open(commitment('c-new', '2026-08-13T00:00:00.000Z', '新しい依頼'));
    await stores.commitments.close('c-new', '2026-08-14T00:00:00.000Z', '片付けた', 'human');
    const fresh = await stores.commitments.get('c-new');
    expect(fresh?.closedBy).toBe('human');

    const stillLegacy = await stores.commitments.get('c-legacy');
    expect(stillLegacy?.closedBy).toBeUndefined();
  });

  describe('editBody（本文を後から直す）', () => {
    it('未了の行は書き換えられる（body/editedAt/editedBy が入り、他の欄は壊れない）', async () => {
      await stores.commitments.open({
        id: 'c-1',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'human',
        source: 'conv-1',
        body: 'もとの依頼',
      });

      expect(
        await stores.commitments.editBody('c-1', '直した依頼', '2026-08-13T00:00:00.000Z', 'human'),
      ).toBe(true);

      const entry = await stores.commitments.get('c-1');
      expect(entry?.body).toBe('直した依頼');
      expect(entry?.editedAt).toBe('2026-08-13T00:00:00.000Z');
      expect(entry?.editedBy).toBe('human');
      expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
      expect(entry?.origin).toBe('human');
      expect(entry?.source).toBe('conv-1');
      expect(entry?.closedAt).toBeUndefined();
    });

    it('片付いた行は書き換えられない（false を返し、body はそのまま）', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'もとの依頼'));
      await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '片付けた', 'human');

      expect(
        await stores.commitments.editBody(
          'c-1',
          '後から直したい',
          '2026-08-14T00:00:00.000Z',
          'human',
        ),
      ).toBe(false);

      const entry = await stores.commitments.get('c-1');
      expect(entry?.body).toBe('もとの依頼');
      expect(entry?.editedAt).toBeUndefined();
      expect(entry?.editedBy).toBeUndefined();
      expect(entry?.closedAt).toBe('2026-08-13T00:00:00.000Z');
      expect(entry?.closedReason).toBe('片付けた');
    });

    it('存在しない id は false（勝手に行を作らない）', async () => {
      expect(
        await stores.commitments.editBody(
          'しらない',
          '直したい',
          '2026-08-13T00:00:00.000Z',
          'human',
        ),
      ).toBe(false);

      expect(await stores.commitments.list({ includeClosed: true })).toEqual({
        entries: [],
        unreadable: [],
        trimmedClosed: 0,
      });
    });
  });

  it('未知の closedBy を持つ行があっても list() は落ちない（closedBy は台帳の完全性を担わない）', async () => {
    // open() を使わず台帳ファイルへ直接書く: open() 経由だと変異で setup が先に落ち、list() が読めなくなる害が再現されないため
    await mkdir(stores.paths.jobs, { recursive: true });
    await writeFile(
      join(stores.paths.jobs, 'commitments.json'),
      JSON.stringify({
        commitments: [
          {
            id: 'c-unknown-closedby',
            at: '2026-08-01T00:00:00.000Z',
            origin: 'human',
            body: '未知の closedBy を持つ行',
            closedAt: '2026-08-02T00:00:00.000Z',
            closedReason: '将来の書き手を模す',
            closedBy: 'manager',
          },
        ],
      }),
      'utf8',
    );

    const listed = await stores.commitments.list({ includeClosed: true });
    expect(listed.entries).toHaveLength(1);
    expect(listed.unreadable).toEqual([]);

    const all = listed.entries;
    expect(all[0]?.closedBy).toBe('manager');

    const single = await stores.commitments.get('c-unknown-closedby');
    expect(single?.closedBy).toBe('manager');
  });

  it('未知の origin を1行混ぜても list() は落ちず、健全な行は全部返る（未知の1行は unreadable へ、id 付きで）', async () => {
    await stores.commitments.open(commitment('c-ok-1', '2026-08-10T00:00:00.000Z', '健全な行1'));
    await stores.commitments.open(commitment('c-ok-2', '2026-08-11T00:00:00.000Z', '健全な行2'));

    // open() 経由では commitmentSchema.parse を通って作れないので直接書き込む
    const path = join(stores.paths.jobs, 'commitments.json');
    const before = JSON.parse(await readFile(path, 'utf8')) as { commitments: unknown[] };
    await writeFile(
      path,
      JSON.stringify({
        commitments: [
          ...before.commitments,
          {
            id: 'c-unknown-origin',
            at: '2026-08-12T00:00:00.000Z',
            origin: 'future-origin',
            body: '未知の origin を持つ行',
          },
        ],
      }),
      'utf8',
    );

    // 素の `await` だけにしない: 変異が例外でテストを殺し、測っている性質を名指ししないため。`.resolves` なら assertion として落ちる
    await expect(stores.commitments.list()).resolves.toBeDefined();

    const listed = await stores.commitments.list();
    expect(listed.entries.map((entry) => entry.id)).toEqual(['c-ok-1', 'c-ok-2']);

    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]?.id).toBe('c-unknown-origin');
    expect(listed.unreadable[0]?.at).toBe('2026-08-12T00:00:00.000Z');
    expect(listed.unreadable[0]?.reason).not.toContain('未知の origin を持つ行');

    await expect(stores.commitments.get('c-unknown-origin')).rejects.toThrow(/読めない形/);
  });

  it('読めない行が在る状態で open() / close() を走らせても、読めない行がファイルから消えない（書き戻しで生の値が残る）', async () => {
    const path = join(stores.paths.jobs, 'commitments.json');
    const brokenRow = {
      id: 'c-broken',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'future-origin',
      body: '読めない行の生の値そのもの',
    };
    await mkdir(stores.paths.jobs, { recursive: true });
    await writeFile(path, JSON.stringify({ commitments: [brokenRow] }), 'utf8');

    const before = await stores.commitments.list();
    expect(before.unreadable).toHaveLength(1);
    expect(before.unreadable[0]?.id).toBe('c-broken');

    await stores.commitments.open(commitment('c-new', '2026-08-13T00:00:00.000Z', '新しい依頼'));
    await stores.commitments.close('c-new', '2026-08-14T00:00:00.000Z', '片付けた', 'clone');

    // ファイルを読み直して実体を見る: list() の返り値だけでは書き戻しで消えていないことを確認できないため
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { commitments: unknown[] };
    expect(onDisk.commitments).toContainEqual(brokenRow);

    const after = await stores.commitments.list({ includeClosed: true });
    expect(after.unreadable).toHaveLength(1);
    expect(after.unreadable[0]?.id).toBe('c-broken');
    expect(after.entries.map((entry) => entry.id)).toContain('c-new');
  });

  it('trimmedClosedCount はディスクへ持ち回り、デーモンを作り直しても残る', async () => {
    const path = join(stores.paths.jobs, 'commitments.json');
    await mkdir(stores.paths.jobs, { recursive: true });
    await writeFile(path, JSON.stringify({ commitments: [], trimmedClosedCount: 42 }), 'utf8');

    expect((await stores.commitments.list()).trimmedClosed).toBe(42);

    const restarted = createFsStores(root);
    expect((await restarted.commitments.list()).trimmedClosed).toBe(42);

    await restarted.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', '新しい依頼'));
    expect((await restarted.commitments.list()).trimmedClosed).toBe(42);
  });

  it('trimmedClosedCount の無い旧い形式のファイルは、0件として読める', async () => {
    const path = join(stores.paths.jobs, 'commitments.json');
    await mkdir(stores.paths.jobs, { recursive: true });
    await writeFile(path, JSON.stringify({ commitments: [] }), 'utf8');

    expect((await stores.commitments.list()).trimmedClosed).toBe(0);
  });

  it('同じ id で二度 open しても上書きされない（1回目の本文が残る）', async () => {
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', '最初の依頼')),
    ).toEqual({ opened: true, folded: false });

    // 受信箱の合図は配り直されうるので、同じ id の自動 open は普通に二度来る
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-14T00:00:00.000Z', '別の本文')),
    ).toEqual({ opened: false, folded: false });

    const entry = await stores.commitments.get('c-1');
    expect(entry?.body).toBe('最初の依頼');
    expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
    expect((await stores.commitments.list()).entries).toHaveLength(1);
  });

  it('閉じた id を open し直しても開き直らない（片付いた仕事が蘇らない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));
    await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した', 'clone');

    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す')),
    ).toEqual({ opened: false, folded: false });

    expect(await stores.commitments.list()).toEqual({
      entries: [],
      unreadable: [],
      trimmedClosed: 0,
    });
    expect((await stores.commitments.get('c-1'))?.closedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('close は二度目に false を返す（二重に「いま片付けた」と報告させない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(
      await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '出した', 'clone'),
    ).toBe(true);
    expect(
      await stores.commitments.close('c-1', '2026-08-14T00:00:00.000Z', 'また出した', 'clone'),
    ).toBe(false);

    const entry = await stores.commitments.get('c-1');
    expect(entry?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(entry?.closedReason).toBe('出した');
  });

  it('存在しない id の close は false（勝手に行を作らない）', async () => {
    expect(
      await stores.commitments.close('しらない', '2026-08-13T00:00:00.000Z', '片付けた', 'clone'),
    ).toBe(false);

    expect(await stores.commitments.list({ includeClosed: true })).toEqual({
      entries: [],
      unreadable: [],
      trimmedClosed: 0,
    });
  });

  it('未了は古い順に返る（齢が判断の材料なので放置されているものから見せる）', async () => {
    await stores.commitments.open(commitment('c-new', '2026-08-14T00:00:00.000Z', '新しい'));
    await stores.commitments.open(commitment('c-old', '2026-08-10T00:00:00.000Z', '古い'));
    await stores.commitments.open(commitment('c-mid', '2026-08-12T00:00:00.000Z', '中'));

    expect((await stores.commitments.list()).entries.map((entry) => entry.id)).toEqual([
      'c-old',
      'c-mid',
      'c-new',
    ]);
  });

  it('閉じたものは未了の後ろに、新しく片付いた順で続く', async () => {
    await stores.commitments.open(commitment('c-open', '2026-08-14T00:00:00.000Z', 'まだ'));
    await stores.commitments.open(commitment('c-a', '2026-08-10T00:00:00.000Z', 'A'));
    await stores.commitments.open(commitment('c-b', '2026-08-11T00:00:00.000Z', 'B'));
    await stores.commitments.close('c-a', '2026-08-12T00:00:00.000Z', 'A を片付けた', 'clone');
    await stores.commitments.close('c-b', '2026-08-13T00:00:00.000Z', 'B を片付けた', 'clone');

    expect(
      (await stores.commitments.list({ includeClosed: true })).entries.map((entry) => entry.id),
    ).toEqual(['c-open', 'c-b', 'c-a']);
  });

  // 第3引数の待ち時間（`60_000`）を上げない: 既定の 5000ms は器の混み具合で緑と赤が入れ替わる位置に在り、上げるとこの1件が遅くなっている実態を隠すため
  it('閉じた行は上限で切られるが、未了は件数によらず1件も落ちない', async () => {
    const overflow = 5;
    for (let index = 0; index < 3; index += 1) {
      await stores.commitments.open(
        commitment(`open-${index}`, `2026-08-01T00:00:0${index}.000Z`, `未了 ${index}`),
      );
    }

    for (let index = 0; index < CLOSED_HISTORY_LIMIT + overflow; index += 1) {
      const id = `closed-${String(index).padStart(4, '0')}`;
      await stores.commitments.open(
        commitment(id, '2026-08-02T00:00:00.000Z', `片付ける ${index}`),
      );
      await stores.commitments.close(
        id,
        new Date(Date.UTC(2026, 7, 3, 0, 0, 0) + index * 1000).toISOString(),
        `片付けた ${index}`,
        'clone',
      );
    }

    const all = (await stores.commitments.list({ includeClosed: true })).entries;
    const open = all.filter((entry) => entry.closedAt === undefined);
    const closed = all.filter((entry) => entry.closedAt !== undefined);

    expect(open.map((entry) => entry.id)).toEqual(['open-0', 'open-1', 'open-2']);
    expect(closed).toHaveLength(CLOSED_HISTORY_LIMIT);
    expect(closed.at(0)?.id).toBe(
      `closed-${String(CLOSED_HISTORY_LIMIT + overflow - 1).padStart(4, '0')}`,
    );
    expect(closed.at(-1)?.id).toBe(`closed-${String(overflow).padStart(4, '0')}`);
    expect(await stores.commitments.get('closed-0000')).toBeNull();
    expect((await stores.commitments.list({ includeClosed: true })).trimmedClosed).toBe(overflow);
  }, 60_000);

  describe('closeMany（複数件を1回でまとめて閉じる）', () => {
    it('実際に閉じた id だけを返す（存在しない id・既に閉じた id を混ぜても、新たに閉じた分だけ）', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));
      await stores.commitments.open(commitment('c-2', '2026-08-11T00:00:00.000Z', '2'));
      await stores.commitments.open(commitment('c-3', '2026-08-12T00:00:00.000Z', '3'));
      await stores.commitments.close('c-2', '2026-08-13T00:00:00.000Z', '先に片付けた', 'human');

      const closed = await stores.commitments.closeMany(
        ['c-1', 'c-2', 'c-3', 'しらない'],
        '2026-08-14T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );

      expect([...closed].sort()).toEqual(['c-1', 'c-3']);
    });

    it('空配列を渡すと何も書かずに [] を返す（ファイルの中身が1文字も変わらないことで測る）', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));
      const path = join(stores.paths.jobs, 'commitments.json');
      const before = await readFile(path, 'utf8');

      const closed = await stores.commitments.closeMany(
        [],
        '2026-08-14T00:00:00.000Z',
        '対象なし',
        'clone',
      );

      expect(closed).toEqual([]);
      const after = await readFile(path, 'utf8');
      expect(after).toBe(before);
    });

    it('closeMany の後、includeClosed で closedAt/closedReason/closedBy が正しく入る', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));
      await stores.commitments.open(commitment('c-2', '2026-08-11T00:00:00.000Z', '2'));

      await stores.commitments.closeMany(
        ['c-1', 'c-2'],
        '2026-08-14T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );

      const all = (await stores.commitments.list({ includeClosed: true })).entries;
      for (const id of ['c-1', 'c-2']) {
        const entry = all.find((e) => e.id === id);
        expect(entry?.closedAt).toBe('2026-08-14T00:00:00.000Z');
        expect(entry?.closedReason).toBe('まとめて片付けた');
        expect(entry?.closedBy).toBe('clone');
      }
    });

    it('同じ id を重複して渡しても、返る id は重複せず二重に閉じない', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));

      const closed = await stores.commitments.closeMany(
        ['c-1', 'c-1', 'c-1'],
        '2026-08-14T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );

      expect(closed).toEqual(['c-1']);
      const entry = await stores.commitments.get('c-1');
      expect(entry?.closedReason).toBe('まとめて片付けた');
    });

    it('未了の行は1件も消えず、保持上限の挙動も close() のときと同じ（trimmedClosed も揃う）', async () => {
      const overflow = 5;
      for (let index = 0; index < 3; index += 1) {
        await stores.commitments.open(
          commitment(`open-${index}`, `2026-08-01T00:00:0${index}.000Z`, `未了 ${index}`),
        );
      }
      const ids: string[] = [];
      for (let index = 0; index < CLOSED_HISTORY_LIMIT + overflow; index += 1) {
        const id = `closed-${String(index).padStart(4, '0')}`;
        await stores.commitments.open(
          commitment(id, '2026-08-02T00:00:00.000Z', `片付ける ${index}`),
        );
        ids.push(id);
      }

      const closedIds = await stores.commitments.closeMany(
        ids,
        '2026-08-03T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );
      expect(closedIds).toHaveLength(CLOSED_HISTORY_LIMIT + overflow);

      const all = (await stores.commitments.list({ includeClosed: true })).entries;
      const open = all.filter((entry) => entry.closedAt === undefined);
      const closed = all.filter((entry) => entry.closedAt !== undefined);

      expect(open.map((entry) => entry.id)).toEqual(['open-0', 'open-1', 'open-2']);
      expect(closed).toHaveLength(CLOSED_HISTORY_LIMIT);
      expect((await stores.commitments.list({ includeClosed: true })).trimmedClosed).toBe(overflow);
    }, 20_000);
  });
});

describe('FsInboxStore', () => {
  const human = (id: string, at: string, text: string): InboxEvent => ({
    type: 'human_message',
    id,
    at,
    text,
    conversationId: 'conv-1',
  });

  it('put したものが claimPending で古い順に返る', async () => {
    await stores.inbox.put(
      human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
      '2026-08-11T00:00:00.000Z',
    );
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
      '2026-08-10T00:00:00.000Z',
    );

    const pending = await stores.inbox.claimPending();

    expect(pending.map((entry) => entry.event.id)).toEqual(['evt-1', 'evt-2']);
    expect(pending.every((entry) => entry.deliveries === 1)).toBe(true);
  });

  it('remove したものは返らない。無い id の remove は落ちない', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.remove('evt-1');

    expect(await stores.inbox.claimPending()).toEqual([]);
    await expect(stores.inbox.remove('しらない')).resolves.toBeUndefined();
  });

  it('claimPending を2回呼ぶと deliveries が 1 → 2 と進む（消していないものは何度でも返る）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
      '2026-08-10T00:00:00.000Z',
    );

    const first = await stores.inbox.claimPending();
    const second = await stores.inbox.claimPending();

    expect(first[0]?.deliveries).toBe(1);
    expect(second[0]?.deliveries).toBe(2);
  });

  it('同じ id で put し直しても deliveries が 0 に戻らない（本文だけ差し替わる）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', 'もとの本文'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.claimPending();

    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '直した本文'),
      '2026-08-10T00:00:00.000Z',
    );
    const pending = await stores.inbox.claimPending();

    expect(pending[0]?.deliveries).toBe(2);
    expect((pending[0]?.event as { text: string }).text).toBe('直した本文');
  });

  describe('pending（#358。読むだけで配達回数を進めない）', () => {
    it('件数といちばん古い時刻を返す（0件のときは oldestAt を作らない）', async () => {
      expect(await stores.inbox.pending()).toEqual({ count: 0 });

      await stores.inbox.put(
        human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
        '2026-08-11T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
        '2026-08-10T00:00:00.000Z',
      );

      expect(await stores.inbox.pending()).toEqual({
        count: 2,
        oldestAt: '2026-08-10T00:00:00.000Z',
      });
    });

    it('pending() を何度呼んでも claimPending() の deliveries は動かない', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      await stores.inbox.pending();
      await stores.inbox.pending();
      await stores.inbox.pending();

      const claimed = await stores.inbox.claimPending();
      expect(claimed[0]?.deliveries).toBe(1);
    });
  });

  describe('peekPending（#783。本文まで返すが、配達回数は進めない）', () => {
    it('claimPending と同じ並び（古い順）で、本文まで返す', async () => {
      await stores.inbox.put(
        human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
        '2026-08-11T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
        '2026-08-10T00:00:00.000Z',
      );

      const { entries: rows } = await stores.inbox.peekPending();

      expect(rows.map((r) => r.event.id)).toEqual(['evt-1', 'evt-2']);
      expect((rows[0]?.event as { text: string }).text).toBe('1件目');
      expect(rows.every((r) => r.deliveries === 0)).toBe(true);
    });

    it('0件なら空配列を返す（読めない行も無い）', async () => {
      expect(await stores.inbox.peekPending()).toEqual({ entries: [], unreadable: [] });
    });

    it('peekPending() を2回呼んでも、その後の claimPending() の deliveries は1のまま', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      await stores.inbox.peekPending();
      await stores.inbox.peekPending();

      const claimed = await stores.inbox.claimPending();
      expect(claimed[0]?.deliveries).toBe(1);
    });
  });

  it('本文が欠けずに往復する（human_message の text、external の payload）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '人間の発言'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.put(
      {
        type: 'external',
        id: 'evt-2',
        at: '2026-08-11T00:00:00.000Z',
        source: 'webhook',
        payload: { deep: { nested: [1, 2, 3] }, note: '日本語も' },
      },
      '2026-08-11T00:00:00.000Z',
    );

    const pending = await stores.inbox.claimPending();
    const humanEntry = pending.find((entry) => entry.event.id === 'evt-1');
    const externalEntry = pending.find((entry) => entry.event.id === 'evt-2');

    expect((humanEntry?.event as { text: string }).text).toBe('人間の発言');
    expect((externalEntry?.event as { payload: unknown }).payload).toEqual({
      deep: { nested: [1, 2, 3] },
      note: '日本語も',
    });
  });

  describe('removeMany（issue #972。絞り込んで一括で畳む口）', () => {
    it('渡した id をまとめて消し、実際に消えた id を返す', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
        '2026-08-10T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
        '2026-08-11T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-3', '2026-08-12T00:00:00.000Z', '3件目'),
        '2026-08-12T00:00:00.000Z',
      );

      const removed = await stores.inbox.removeMany(['evt-1', 'evt-3']);

      expect([...removed].sort()).toEqual(['evt-1', 'evt-3']);
      const rest = (await stores.inbox.peekPending()).entries;
      expect(rest.map((r) => r.event.id)).toEqual(['evt-2']);
    });

    it('存在しない id は戻り値に含めない', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      const removed = await stores.inbox.removeMany(['evt-1', '居ない']);

      expect(removed).toEqual(['evt-1']);
    });

    it('重複した id を渡しても二重に数えない（戻り値にも1回しか現れない）', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      const removed = await stores.inbox.removeMany(['evt-1', 'evt-1']);

      expect(removed).toEqual(['evt-1']);
    });

    it('空配列を渡すと何も消さずに空配列を返す（ファイルへ書かない）', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      expect(await stores.inbox.removeMany([])).toEqual([]);
      expect(await stores.inbox.pending()).toEqual({
        count: 1,
        oldestAt: '2026-08-10T00:00:00.000Z',
      });
    });

    it('消えた行は claimPending でも peekPending でも二度と返らない', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );
      await stores.inbox.removeMany(['evt-1']);

      expect(await stores.inbox.claimPending()).toEqual([]);
      expect((await stores.inbox.peekPending()).entries).toEqual([]);
    });
  });
});

describe('FsTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = (await stores.archive.archive('session-1', '{"a":1}\n')).id;

    expect((await stores.archive.list()).map((entry) => entry.id)).toContain(id);
    expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: '{"a":1}\n' });
  });

  it('ディレクトリ外は読ませない（missing）', async () => {
    expect(await stores.archive.read('../../etc/passwd')).toEqual({ kind: 'missing' });
  });

  it('ディレクトリ外への remove() も missing', async () => {
    expect(await stores.archive.remove('../../etc/passwd')).toEqual({ kind: 'missing' });
  });

  it('id === "." / ".." も missing になる（issue #1635）', async () => {
    await stores.archive.archive('session-unrelated', 'x\n');

    expect(await stores.archive.read('.')).toEqual({ kind: 'missing' });
    expect(await stores.archive.read('..')).toEqual({ kind: 'missing' });
    expect(await stores.archive.readTail('.', 10)).toEqual({ kind: 'missing' });
    expect(await stores.archive.readTail('..', 10)).toEqual({ kind: 'missing' });
  });

  it('remove("..") は missing を返し、archive/ 配下に何も書き込まない（副作用なし。issue #1635）', async () => {
    await stores.archive.archive('session-unrelated', 'x\n');
    const before = await readdir(join(root, 'archive'));

    expect(await stores.archive.remove('..')).toEqual({ kind: 'missing' });

    const after = await readdir(join(root, 'archive'));
    expect(after).toEqual(before);
  });

  it('TranscriptArchive の契約を満たす', async () => {
    await verifyTranscriptArchiveContract(stores.archive, {
      seedFingerprintlessRow: async (sessionId, body) => {
        const dir = join(root, 'archive');
        await mkdir(dir, { recursive: true });
        const at = new Date();
        const id = `${sessionId}-fingerprintless-${at.toISOString().replace(/[:.]/g, '-')}.jsonl`;
        await writeFile(join(dir, id), body, 'utf8');
        await writeFile(
          join(dir, `${id}.meta.json`),
          JSON.stringify({ sessionId, at: at.toISOString() }),
          'utf8',
        );
        return id;
      },
    });
  });

  it('remove() は本体の .jsonl を消さない（空へ切り詰め、脇に印を置く）', async () => {
    const id = (await stores.archive.archive('session-remove', 'BODY\n')).id;

    const removed = await stores.archive.remove(id);
    expect(removed).toEqual({ kind: 'removed', bytes: Buffer.byteLength('BODY\n', 'utf8') });

    expect(await readFile(join(root, 'archive', id), 'utf8')).toBe('');
    const marker = JSON.parse(await readFile(join(root, 'archive', `${id}.removed`), 'utf8')) as {
      removedAt: string;
      bytes: number;
    };
    expect(marker.bytes).toBe(Buffer.byteLength('BODY\n', 'utf8'));

    const listedIds = (await stores.archive.list()).map((entry) => entry.id);
    expect(listedIds).toContain(id);
    expect(listedIds).not.toContain(`${id}.removed`);
  });

  it('存在しない id への remove() は黙って成功しない（missing）', async () => {
    expect(await stores.archive.remove('居ない')).toEqual({ kind: 'missing' });
  });

  it('id A を消しても id B は読める（巻き添えが無い）', async () => {
    const idA = (await stores.archive.archive('session-a', 'A\n')).id;
    const idB = (await stores.archive.archive('session-b', 'B\n')).id;

    await stores.archive.remove(idA);

    expect(await stores.archive.read(idA)).toMatchObject({ kind: 'removed' });
    expect(await stores.archive.read(idB)).toEqual({ kind: 'body', body: 'B\n' });
  });

  it('空の生ログを退避しただけの行は removed にならない（本体が空文字であることを判定に使わない）', async () => {
    const id = (await stores.archive.archive('session-empty', '')).id;

    await expect(
      stat(join(root, 'archive', `${id}.removed`)).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
    expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: '' });
  });

  it('二重の remove() は冪等（removed → already。バイト数・removedAt は変わらない）', async () => {
    const id = (await stores.archive.archive('session-twice', 'TWICE\n')).id;

    const first = await stores.archive.remove(id);
    expect(first).toEqual({ kind: 'removed', bytes: Buffer.byteLength('TWICE\n', 'utf8') });

    const readAfterFirst = await stores.archive.read(id);
    if (readAfterFirst.kind !== 'removed') throw new Error('removed のはず');

    const second = await stores.archive.remove(id);
    expect(second).toEqual({
      kind: 'already',
      removedAt: readAfterFirst.removedAt,
      bytes: Buffer.byteLength('TWICE\n', 'utf8'),
    });
  });

  it('list()のstoredBytesは実ファイルのstat().sizeと一致する（fs固有）', async () => {
    const id = (await stores.archive.archive('session-stat', 'HELLO WORLD\n')).id;

    const entry = (await stores.archive.list()).find((e) => e.id === id);
    expect(entry).toBeDefined();
    const fileSize = (await stat(join(root, 'archive', id))).size;
    expect(entry?.storedBytes).toBe(fileSize);

    await stores.archive.remove(id);
    const entryAfterRemove = (await stores.archive.list()).find((e) => e.id === id);
    expect(entryAfterRemove?.storedBytes).toBe(0);
  });

  it('meta.jsonが無い(拡張前に作られた)アーカイブでもlist()は落ちない', async () => {
    const id = (await stores.archive.archive('session-legacy', 'LEGACY\n')).id;
    await rm(join(root, 'archive', `${id}.meta.json`));

    const entry = (await stores.archive.list()).find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(typeof entry?.sessionId).toBe('string');
    expect(Number.isNaN(Date.parse(entry?.at ?? ''))).toBe(false);
  });

  // 呼び出しの間に `tick()` を挟む: `#findPreviousArchiveForSession` は同じミリ秒の行を id の辞書順で決めるため、挟まないと「直前の行」が変わる
  it('sessions()のcontinuityはfirst/continues/diverged/unknown/absentを正しく数える', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
    const sessionId = 'session-continuity-tally';

    const writeFirst = await stores.archive.archive(sessionId, 'A\n');
    expect(writeFirst.continuity).toBe('first');
    await tick();
    const writeContinues = await stores.archive.archive(sessionId, 'A\nB\n');
    expect(writeContinues.continuity).toBe('continues');
    await tick();
    const writeDiverged = await stores.archive.archive(sessionId, 'X\n');
    expect(writeDiverged.continuity).toBe('diverged');
    await tick();

    const absentWrite = await stores.archive.archive(sessionId, 'ABSENT\n');
    await rm(join(root, 'archive', `${absentWrite.id}.meta.json`));
    await tick();

    const writeAfterAbsent = await stores.archive.archive(sessionId, 'ANYTHING\n');
    expect(writeAfterAbsent.continuity).toBe('unknown');

    const summaries = await stores.archive.sessions();
    const summary = summaries.find((s) => s.sessionId === sessionId);
    expect(summary?.rows).toBe(5);
    expect(summary?.continuity).toEqual({
      first: 1,
      continues: 1,
      diverged: 1,
      unknown: 1,
      absent: 1,
    });
  });

  // 時計は `toFake: ['Date']` に絞って固定する: `setTimeout` まで偽物にすると `writeFile` の待ちが止まるため
  it('同じミリ秒に2回積むと2本目が <base>-2.jsonl になり、1本目の中身は元のまま（#905）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-12T03:04:05.678Z'));
      const first = (await stores.archive.archive('session-collision', 'FIRST\n')).id;
      const second = (await stores.archive.archive('session-collision', 'SECOND\n')).id;

      expect(first).toBe('session-collision-2026-09-12T03-04-05-678Z.jsonl');
      expect(second).toBe('session-collision-2026-09-12T03-04-05-678Z-2.jsonl');

      expect(await readFile(join(root, 'archive', first), 'utf8')).toBe('FIRST\n');
      expect(await readFile(join(root, 'archive', second), 'utf8')).toBe('SECOND\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('枝番付きのidでも、meta.jsonが無ければファイル名からsessionId/atを復元する（#905）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let second: string;
    try {
      vi.setSystemTime(new Date('2026-09-12T03:04:05.678Z'));
      await stores.archive.archive('session-fallback', 'FIRST\n');
      second = (await stores.archive.archive('session-fallback', 'SECOND\n')).id;
    } finally {
      vi.useRealTimers();
    }
    expect(second).toBe('session-fallback-2026-09-12T03-04-05-678Z-2.jsonl');

    await rm(join(root, 'archive', `${second}.meta.json`));

    const entry = (await stores.archive.list()).find((e) => e.id === second);
    expect(entry).toBeDefined();
    expect(entry?.sessionId).toBe('session-fallback');
    expect(entry?.at).toBe('2026-09-12T03:04:05.678Z');
  });
});

describe('FsProfileStore', () => {
  const dirOf = () => join(root, 'profile.d');
  const legacyPath = () => join(root, 'profile.sh');

  it('器の契約（並び順・撒く先・巻き戻し。3実装で同じことを測る）', async () => {
    await verifyProfileStoreContract(stores.profile);
  });

  it('1行 = profile.d/<name>.sh（0600、本文そのまま）。撒く先は隣の <name>.scope', async () => {
    await stores.profile.set('rust', 'export A=1\n', 'runner');
    await stores.profile.set('base', 'export B=1\n', 'all');

    expect(await readFile(join(dirOf(), 'rust.sh'), 'utf8')).toBe('export A=1\n');
    expect(((await stat(join(dirOf(), 'rust.sh'))).mode & 0o777).toString(8)).toBe('600');
    expect((await readFile(join(dirOf(), 'rust.scope'), 'utf8')).trim()).toBe('runner');
    await expect(stat(join(dirOf(), 'base.scope'))).rejects.toThrow();
  });

  it('人間が vi で直した本文を読む。scope ファイルが壊れていても all として読み、次の set が直す', async () => {
    await stores.profile.set('a', 'export A=1\n', 'runner');
    await writeFile(join(dirOf(), 'a.sh'), 'export A=hand-edited\n');
    await writeFile(join(dirOf(), 'a.scope'), 'runer\n');

    const [row] = await stores.profile.list();
    expect(row).toMatchObject({ name: 'a', script: 'export A=hand-edited\n', scope: 'all' });

    await stores.profile.set('a', 'export A=2\n', 'runner');
    expect((await stores.profile.list())[0]?.scope).toBe('runner');
  });

  it('名前の形が不正なファイル・空のファイル・.sh でないファイルは行として読まない', async () => {
    await stores.profile.set('ok', 'export OK=1\n', 'all');
    await writeFile(join(dirOf(), 'bad name.sh'), 'export BAD=1\n');
    await writeFile(join(dirOf(), '.hidden.sh'), 'export HIDDEN=1\n');
    await writeFile(join(dirOf(), 'empty.sh'), '  \n');
    await writeFile(join(dirOf(), 'note.txt'), 'export TXT=1\n');

    expect((await stores.profile.list()).map((row) => row.name)).toEqual(['ok']);
  });

  it('行を外すと隣の scope ファイルも消え、同じ名前で置き直した行へ古い撒く先が残らない', async () => {
    await stores.profile.set('a', 'export A=1\n', 'runner');
    await stores.profile.remove('a');
    await expect(stat(join(dirOf(), 'a.scope'))).rejects.toThrow();

    await stores.profile.set('a', 'export A=2\n', 'all');
    expect((await stores.profile.list())[0]?.scope).toBe('all');
  });

  describe('旧 profile.sh（1本の時代）の扱い', () => {
    it('あれば default 行へ移す（本文・更新日時そのまま、撒く先 all）。旧ファイルは消える', async () => {
      await writeFile(legacyPath(), 'export OLD=1\n');
      const at = new Date('2026-09-01T00:00:00.000Z');
      await utimes(legacyPath(), at, at);

      expect(await stores.profile.list()).toEqual([
        {
          name: 'default',
          script: 'export OLD=1\n',
          scope: 'all',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]);
      await expect(stat(legacyPath())).rejects.toThrow();
      expect(await readFile(join(dirOf(), 'default.sh'), 'utf8')).toBe('export OLD=1\n');
    });

    it('2回読んでも、移したあとに人間が直した default を旧ファイルで巻き戻さない', async () => {
      await writeFile(legacyPath(), 'export OLD=1\n');
      await stores.profile.list();
      await stores.profile.set('default', 'export NEW=1\n', 'runner');
      await writeFile(legacyPath(), 'export OLD=again\n');

      expect(await stores.profile.list()).toMatchObject([
        { name: 'default', script: 'export NEW=1\n', scope: 'runner' },
      ]);
      await expect(stat(legacyPath())).rejects.toThrow();
    });

    it('旧ファイルが空白だけなら行を作らず、旧ファイルだけ消す', async () => {
      await writeFile(legacyPath(), '  \n');

      expect(await stores.profile.list()).toEqual([]);
      await expect(stat(legacyPath())).rejects.toThrow();
    });

    it('clear は旧ファイルも消す（全部外したものが旧形式から蘇らない）', async () => {
      await writeFile(legacyPath(), 'export OLD=1\n');

      await stores.profile.clear();

      await expect(stat(legacyPath())).rejects.toThrow();
      expect(await stores.profile.list()).toEqual([]);
    });
  });
});

describe('FsMcpServerStore', () => {
  it('器の契約（#325 段1。3実装で同じことを測る）', async () => {
    await verifyMcpServerStoreContract(stores.mcpServers);
  });

  it('ifMatch の契約（Issue #3984。3実装で同じことを測る）', async () => {
    await verifyMcpServersIfMatchContract(stores.mcpServers);
  });

  it('.mcp.json と同じ形で 0600 のファイルに置く', async () => {
    await stores.mcpServers.write({ github: { command: 'gh-mcp', env: { TOKEN: 'dummy' } } });
    const path = join(root, 'mcp-servers.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: 'dummy' } } },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  // 手で書き換えたファイルも読むときに検査し、投げる文言に値を載せない: `env` に鍵が入りうるし、JSON.parse の SyntaxError は本文の断片を含むため
  it('手で壊したファイルは読むときに投げ、文言に値を載せない', async () => {
    const path = join(root, 'mcp-servers.json');
    await writeFile(path, '{"mcpServers": {"alteroid": {"command": "SECRET-VALUE-1"}}}');
    await expect(stores.mcpServers.read()).rejects.toThrow(/alteroid/);
    await expect(stores.mcpServers.read()).rejects.not.toThrow(/SECRET-VALUE-1/);

    await writeFile(path, '{"mcpServers": {"x": {"command": "SECRET-VALUE-2"');
    await expect(stores.mcpServers.read()).rejects.toThrow(/JSON として読めない/);
    await expect(stores.mcpServers.read()).rejects.not.toThrow(/SECRET-VALUE-2/);
  });
});

describe('FsTokenPoolStore', () => {
  it('入口の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyTokenPoolContract(stores.tokens);
  });

  it('往復（replace → list）で値まで戻る', async () => {
    expect(await stores.tokens.list()).toEqual([]);

    const written = await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'tok-aaa', order: 1 },
      { id: 'tok-b', label: 'b', value: 'tok-bbb', order: 0 },
    ]);
    expect(written.map((t) => t.id)).toEqual(['tok-b', 'tok-a']);

    const read = await stores.tokens.list();
    expect(read).toEqual([
      { id: 'tok-b', label: 'b', value: 'tok-bbb', order: 0 },
      { id: 'tok-a', label: 'a', value: 'tok-aaa', order: 1 },
    ]);
  });

  it('全文置換——入力に無い行は消える', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    await stores.tokens.replace([{ id: 'tok-b', label: 'b', value: 'tok-bbb', order: 0 }]);
    expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-b']);
  });

  it('書かれたファイルのモードが 0600（中身がトークン本体そのもの）', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    const info = await stat(stores.paths.tokens);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('設定は置かれていなければ core の既定を返す', async () => {
    const settings = await stores.tokens.readSettings();
    expect(settings).toEqual({ rotateOn: 'free_exhausted', cooldownMs: 5 * 60 * 60 * 1000 });
  });

  it('設定を書いて読み直せる', async () => {
    const written = await stores.tokens.writeSettings({
      rotateOn: 'overage_exhausted',
      cooldownMs: 1_000,
      updatedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(written).toEqual({
      rotateOn: 'overage_exhausted',
      cooldownMs: 1_000,
      updatedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(await stores.tokens.readSettings()).toEqual(written);
  });

  it('invalidatedAt / invalidatedReason も往復する（3つ目の状態を落とさない）', async () => {
    await stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'a',
        value: 'tok-aaa',
        order: 0,
        invalidatedAt: '2026-08-02T00:00:00.000Z',
        invalidatedReason: 'account_on_hold',
      },
    ]);
    const [row] = await stores.tokens.list();
    expect(row).toMatchObject({
      invalidatedAt: '2026-08-02T00:00:00.000Z',
      invalidatedReason: 'account_on_hold',
    });
  });

  it('createdAt / updatedAt も往復する（Issue #393）', async () => {
    await stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'a',
        value: 'tok-aaa',
        order: 0,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T03:04:05.000Z',
      },
    ]);
    const [row] = await stores.tokens.list();
    expect(row).toMatchObject({
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T03:04:05.000Z',
    });
  });

  it('現役の指名は、まだ無ければ null（1本目で埋めない）', async () => {
    // 器の側で埋めない: 埋めると、撒いていないものを撒いたことになるため
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    expect(await stores.tokens.readActive()).toBeNull();
  });

  it('現役の指名は世代ごと往復する', async () => {
    const written = await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 7,
      rotatedAt: '2026-08-25T03:00:00.000Z',
    });
    expect(await stores.tokens.readActive()).toEqual(written);
  });

  it('指名し直しても高々1つのまま（2つが同時に現役だと主張しない）', async () => {
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T03:00:00.000Z',
    });
    await stores.tokens.writeActive({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: '2026-08-25T04:00:00.000Z',
    });
    expect(await stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-b', generation: 2 });
  });
  it('createdAt / updatedAt が無い行は無いまま往復する', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    const [row] = await stores.tokens.list();
    expect(row).not.toHaveProperty('createdAt');
    expect(row).not.toHaveProperty('updatedAt');
  });

  it('過去に書かれた source: "env" の行は list() で静かに読み捨てる（クラッシュしない）', async () => {
    // `replace()` は正規化された `AgentToken` しか受けないので、直接ファイルへ書く
    await writeFile(
      stores.paths.tokens,
      JSON.stringify({
        tokens: [
          { id: 'env-1', label: '器の環境変数', source: 'env', order: -1 },
          { id: 'tok-a', label: 'spare', value: 'tok-aaa', order: 0 },
        ],
      }),
      'utf8',
    );

    const rows = await stores.tokens.list();

    expect(rows.map((row) => row.id)).toEqual(['tok-a']);
    expect(rows[0]).not.toHaveProperty('source');
  });
});

describe('FsCredentialVaultStore', () => {
  it('入口の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyCredentialVaultContract(stores.credentials);
  });

  it('seedOnce の契約（印つきの1度だけの書き込み。3実装で同じことを測る）', async () => {
    await verifyCredentialSeedOnceContract(stores.credentials);
  });

  it('往復（put → list）で値まで戻り、name 昇順で並ぶ', async () => {
    expect(await stores.credentials.list()).toEqual([]);

    const written = await stores.credentials.put([
      { name: 'NPM_TOKEN', value: 'npm_x' },
      { name: 'GIT_AUTHOR_NAME', value: 'takecchi' },
    ]);
    expect(written.map((row) => row.name)).toEqual(['GIT_AUTHOR_NAME', 'NPM_TOKEN']);
    expect(written.map((row) => row.value)).toEqual(['takecchi', 'npm_x']);

    expect(await stores.credentials.list()).toEqual(written);
  });

  it('部分更新——入力に無い名前は触らない', async () => {
    await stores.credentials.put([{ name: 'GH_TOKEN', value: 'ghp_1' }]);
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    expect((await stores.credentials.list()).map((row) => row.name)).toEqual([
      'GH_TOKEN',
      'NPM_TOKEN',
    ]);
  });

  it('空文字で外れる（器の側の「外す」と同じ約束）', async () => {
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: '' }]);

    expect(await stores.credentials.list()).toEqual([]);
  });

  it('書かれたファイルのモードが 0600（中身が鍵そのもの）', async () => {
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    const info = await stat(stores.paths.credentials);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('手で書いた壊れた名前の行は読みで飛ばす（器の外を指す名前を降ろさない）', async () => {
    // 入口の検査だけに頼らない: 手で書いた `../../x` がそのまま runner へ降りて器の外を指すため
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    await writeFile(
      stores.paths.credentials,
      JSON.stringify({
        credentials: [
          { name: '../../../etc/cron.d/x', value: 'boom', updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
      'utf8',
    );

    await expect(stores.credentials.list()).resolves.toEqual([]);
  });

  it('scope・secret を指定して put すると、list にそのまま戻る', async () => {
    await stores.credentials.put([
      { name: 'TZ', value: 'Asia/Tokyo', scope: 'app', secret: false },
      { name: 'MANAGER_ONLY', value: 'x', scope: 'runner', secret: true },
    ]);

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'MANAGER_ONLY', scope: 'runner', secret: true }),
      expect.objectContaining({ name: 'TZ', scope: 'app', secret: false }),
    ]);
  });

  it('scope・secret を省略すると all / true になる（列が無かった頃の全行と同じ既定）', async () => {
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'NPM_TOKEN', scope: 'all', secret: true }),
    ]);
  });

  it('scope・secret の列を持たない旧形式のファイルも既定で読める', async () => {
    await writeFile(
      stores.paths.credentials,
      JSON.stringify({
        credentials: [{ name: 'LEGACY_ROW', value: 'v', updatedAt: '2026-01-01T00:00:00.000Z' }],
      }),
      'utf8',
    );

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'LEGACY_ROW', scope: 'all', secret: true }),
    ]);
  });
});

describe('FsSessionRegistry', () => {
  it('NUL の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifySessionRegistryNulContract(stores.sessions);
  });

  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });

  it('墓標を覚えて忘れられる。そして resume 素材を捨てても消えない', async () => {
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setTranscriptGrave({ archiveId: 'sess-1-2026.jsonl' });
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });

    await stores.sessions.setTranscriptGrave(null);
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
  });

  it('2つの墓標は互いを消さない。そして resume 素材を捨てても両方残る', async () => {
    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setTranscriptGrave({ archiveId: 'sess-1-2026.jsonl' });
    await stores.sessions.setLostSessionGrave({
      projectKey: '-workspace',
      sessionId: 'sess-old',
    });

    await stores.sessions.setCloneSessionId(null);

    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });
    expect(await stores.sessions.getLostSessionGrave()).toEqual({
      projectKey: '-workspace',
      sessionId: 'sess-old',
    });

    await stores.sessions.setLostSessionGrave(null);
    expect(await stores.sessions.getLostSessionGrave()).toBeNull();
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });
    await stores.sessions.setTranscriptGrave(null);
  });

  it('生ログの scope を覚える。resume 素材を捨てても消えない', async () => {
    expect(await stores.sessions.getProjectKey()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setProjectKey('-workspace');
    expect(await stores.sessions.getProjectKey()).toBe('-workspace');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getProjectKey()).toBe('-workspace');
  });
});

describe('AuthStore', () => {
  const account = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  it('listAccounts は createdAt の実時刻順（オフセット表記が違っても崩れない）', async () => {
    const early = {
      ...account,
      id: 'account-early-utc',
      email: 'early@example.test',
      createdAt: '2024-01-01T23:00:00+09:00',
    };
    const late = {
      ...account,
      id: 'account-late-utc',
      email: 'late@example.test',
      createdAt: '2024-01-01T15:00:00+00:00',
    };
    await stores.auth.putAccount(early);
    await stores.auth.putAccount(late);

    const ids = (await stores.auth.listAccounts()).map((it) => it.id);
    expect(ids).toEqual(['account-early-utc', 'account-late-utc']);
  });

  it('listIdentities は createdAt の実時刻順（後から lastLoginAt を更新しても順が動かない）', async () => {
    await stores.auth.putAccount(account);
    const first = {
      provider: 'google',
      subject: 'sub-first',
      accountId: 'account-1',
      email: 'first@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    const second = {
      provider: 'google',
      subject: 'sub-second',
      accountId: 'account-1',
      email: 'second@example.test',
      emailVerified: true,
      createdAt: '2026-01-02T00:00:00.000Z',
      lastLoginAt: '2026-01-02T00:00:00.000Z',
    };
    await stores.auth.putIdentity(first);
    await stores.auth.putIdentity(second);
    await stores.auth.putIdentity({ ...first, lastLoginAt: '2026-01-03T00:00:00.000Z' });

    const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
    expect(subjects).toEqual(['sub-first', 'sub-second']);
  });

  it('listAccessTokens は createdAt の実時刻順（後から lastUsedAt を更新しても順が動かない）', async () => {
    await stores.auth.putAccount(account);
    const first = {
      id: 'token-first',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'first',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    const second = {
      id: 'token-second',
      accountId: 'account-1',
      sha256: 'b'.repeat(64),
      label: 'second',
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await stores.auth.putAccessToken(first);
    await stores.auth.putAccessToken(second);
    await stores.auth.putAccessToken({ ...first, lastUsedAt: '2026-01-03T00:00:00.000Z' });

    const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
    expect(ids).toEqual(['token-first', 'token-second']);
  });

  describe('同着（createdAt が同一）の並び（issue #1688）', () => {
    const TIE = '2026-01-05T00:00:00.000Z';

    it('listAccounts: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
      const first = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
      const second = { ...account, id: 'account-b', email: 'b@example.test', createdAt: TIE };
      await stores.auth.putAccount(first);
      await stores.auth.putAccount(second);
      await stores.auth.putAccount({ ...first, displayName: 'Owner (renamed)' });

      const ids = (await stores.auth.listAccounts()).map((it) => it.id);
      expect(ids).toEqual(['account-a', 'account-b']);
    });

    it('listAccounts: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
      const first = { ...account, id: 'account-z', email: 'z@example.test', createdAt: TIE };
      const second = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
      await stores.auth.putAccount(first);
      await stores.auth.putAccount(second);

      const ids = (await stores.auth.listAccounts()).map((it) => it.id);
      expect(ids).toEqual(['account-a', 'account-z']);
    });

    it('listIdentities: 同着の2行のうち先に作ったほうだけ後から更新すると、(provider, subject) 昇順のまま動かない', async () => {
      await stores.auth.putAccount(account);
      const first = {
        provider: 'google',
        subject: 'sub-first',
        accountId: 'account-1',
        email: 'first@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      const second = {
        provider: 'google',
        subject: 'sub-second',
        accountId: 'account-1',
        email: 'second@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      await stores.auth.putIdentity(first);
      await stores.auth.putIdentity(second);
      await stores.auth.putIdentity({ ...first, lastLoginAt: '2026-01-06T00:00:00.000Z' });

      const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
      expect(subjects).toEqual(['sub-first', 'sub-second']);
    });

    it('listIdentities: 同着2行を2次キー（subject）と逆順に挿入しても、subject 昇順で返る', async () => {
      await stores.auth.putAccount(account);
      const first = {
        provider: 'google',
        subject: 'sub-z',
        accountId: 'account-1',
        email: 'z@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      const second = {
        provider: 'google',
        subject: 'sub-a',
        accountId: 'account-1',
        email: 'a@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      await stores.auth.putIdentity(first);
      await stores.auth.putIdentity(second);

      const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
      expect(subjects).toEqual(['sub-a', 'sub-z']);
    });

    it('listAccessTokens: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
      await stores.auth.putAccount(account);
      const first = {
        id: 'token-first',
        accountId: 'account-1',
        sha256: 'a'.repeat(64),
        label: 'first',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      const second = {
        id: 'token-second',
        accountId: 'account-1',
        sha256: 'b'.repeat(64),
        label: 'second',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      await stores.auth.putAccessToken(first);
      await stores.auth.putAccessToken(second);
      await stores.auth.putAccessToken({ ...first, lastUsedAt: '2026-01-06T00:00:00.000Z' });

      const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
      expect(ids).toEqual(['token-first', 'token-second']);
    });

    it('listAccessTokens: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
      await stores.auth.putAccount(account);
      const first = {
        id: 'token-z',
        accountId: 'account-1',
        sha256: 'a'.repeat(64),
        label: 'z',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      const second = {
        id: 'token-a',
        accountId: 'account-1',
        sha256: 'b'.repeat(64),
        label: 'a',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      await stores.auth.putAccessToken(first);
      await stores.auth.putAccessToken(second);

      const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
      expect(ids).toEqual(['token-a', 'token-z']);
    });
  });

  it('アカウントを保存して読み戻せる', async () => {
    await stores.auth.putAccount(account);

    expect(await stores.auth.getAccount('account-1')).toEqual(account);
    expect(await stores.auth.listAccounts()).toEqual([account]);
    expect(await stores.auth.getAccount('居ない')).toBeNull();
  });

  it('許可の2値を書き換えられる（alteroid access grant の実体）', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putAccount({
      ...account,
      grantedAt: '2026-01-02T00:00:00.000Z',
      grantedBy: 'operator',
    });

    const stored = await stores.auth.getAccount('account-1');
    expect(stored?.grantedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(stored?.grantedBy).toBe('operator');
    expect(await stores.auth.listAccounts()).toHaveLength(1);
  });

  it('検証済みメールからアカウントを引ける（相乗りの検査に使う）', async () => {
    await stores.auth.putAccount(account);

    expect((await stores.auth.findAccountByEmail('owner@example.test'))?.id).toBe('account-1');
    expect(await stores.auth.findAccountByEmail('別人@example.test')).toBeNull();
  });

  it('identity は (provider, subject) で一意（同じ人の入り直しで増えない）', async () => {
    await stores.auth.putAccount(account);
    const identity = {
      provider: 'google',
      subject: 'sub-1',
      accountId: 'account-1',
      email: 'owner@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    await stores.auth.putIdentity(identity);
    await stores.auth.putIdentity({ ...identity, lastLoginAt: '2026-01-05T00:00:00.000Z' });

    const identities = await stores.auth.listIdentities('account-1');
    expect(identities).toHaveLength(1);
    expect(identities[0]?.lastLoginAt).toBe('2026-01-05T00:00:00.000Z');
    expect((await stores.auth.findIdentity('google', 'sub-1'))?.accountId).toBe('account-1');
    expect(await stores.auth.findIdentity('google', '別の sub')).toBeNull();
  });

  it('アクセストークンは sha256 で引ける（素の値は持たない）', async () => {
    await stores.auth.putAccount(account);
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    await stores.auth.putAccessToken(token);

    expect(await stores.auth.findAccessTokenBySha256('a'.repeat(64))).toEqual(token);
    expect(await stores.auth.findAccessTokenBySha256('b'.repeat(64))).toBeNull();
    expect(await stores.auth.listAccessTokens('account-1')).toEqual([token]);
  });

  describe('revokeAccessToken', () => {
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };

    it('失効させる（revokedAt が立ち、他のトークンは影響を受けない）', async () => {
      await stores.auth.putAccount(account);
      await stores.auth.putAccessToken(token);
      const other = { ...token, id: 'token-2', sha256: 'b'.repeat(64) };
      await stores.auth.putAccessToken(other);

      const result = await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
      expect(result).toEqual({
        status: 'revoked',
        token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
      });
      expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
        '2026-01-02T00:00:00.000Z',
      );
      expect((await stores.auth.findAccessTokenBySha256('b'.repeat(64)))?.revokedAt).toBeNull();
    });

    it('もう一度呼んでも、先に立った時刻を動かさない（冪等）', async () => {
      await stores.auth.putAccount(account);
      await stores.auth.putAccessToken(token);

      await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
      const second = await stores.auth.revokeAccessToken('token-1', '2026-01-03T00:00:00.000Z');

      expect(second).toEqual({
        status: 'already_revoked',
        token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
      });
      expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
        '2026-01-02T00:00:00.000Z',
      );
    });

    it('無い id は not_found', async () => {
      expect(await stores.auth.revokeAccessToken('居ない', '2026-01-02T00:00:00.000Z')).toEqual({
        status: 'not_found',
      });
    });
  });

  it('ログイン要求を保存して読み戻せる（ブラウザ往復の突き合わせ）', async () => {
    const request = {
      id: 'login-1',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'c'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending' as const,
      accountId: null,
      error: null,
    };
    await stores.auth.putLoginRequest(request);
    expect(await stores.auth.getLoginRequest('login-1')).toEqual(request);

    await stores.auth.putLoginRequest({ ...request, status: 'consumed' as const });
    expect((await stores.auth.getLoginRequest('login-1'))?.status).toBe('consumed');
    expect(await stores.auth.getLoginRequest('居ない')).toBeNull();
  });
  it('ログイン要求の引き取りは1回だけ成功する（並行でも二重発行させない）', async () => {
    const request = {
      id: 'login-2',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'd'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated' as const,
      accountId: 'account-1',
      error: null,
    };
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest(request);

    // 読んでから書く形だと、ここで全部が authenticated を掴んでしまう。
    let issued = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        stores.auth.claimLoginRequest('login-2', (request) => ({
          id: `token-race-${++issued}`,
          accountId: request.accountId ?? '',
          sha256: String(issued).repeat(64).slice(0, 64),
          label: request.label,
          createdAt: '2026-01-02T00:00:00.000Z',
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        })),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-2'))?.status).toBe('consumed');
    // 保存されたトークンも1本だけ見る: 応答が1件でも器に2本あれば通ってしまうため
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
    expect(await stores.auth.claimLoginRequest('login-2', () => neverIssued())).toBeNull();
  });

  it('pending のログイン要求は引き取れない（ブラウザ側が終わる前に発行しない）', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-3',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'e'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    expect(await stores.auth.claimLoginRequest('login-3', () => neverIssued())).toBeNull();
    expect((await stores.auth.getLoginRequest('login-3'))?.status).toBe('pending');
    expect(await stores.auth.claimLoginRequest('居ない', () => neverIssued())).toBeNull();
  });
  it('別々のアカウントへ同時に grant すると、両方通る（上限が無い）', async () => {
    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantAccess('account-1', at, 'operator'),
      stores.auth.grantAccess('account-2', at, 'operator'),
    ]);

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(2);
    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(2);
  });

  it('同じアカウントへ同時に grant しても、grantedBy は先に書いた側のまま', async () => {
    await stores.auth.putAccount(account);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantAccess('account-1', at, 'operator'),
      stores.auth.grantAccess('account-1', at, 'account-9'),
    ]);

    expect(results.every((result) => result.status === 'granted')).toBe(true);
    const stored = (await stores.auth.listAccounts()).find((it) => it.id === 'account-1');
    // 2つの応答が器の中身と一致すること。片方が自分の書いた値を返すと、
    // 呼び出し側は「自分が通した」と読んで日誌にそう書く。
    expect(
      results.map((result) => (result.status === 'granted' ? result.account.grantedBy : null)),
    ).toEqual([stored?.grantedBy, stored?.grantedBy]);
  });

  it('createAccountWithIdentity を同じ identity で並行に呼んでも、1つだけ作られる', async () => {
    const makeInput = (accountId: string) => ({
      account: {
        id: accountId,
        displayName: 'Someone',
        email: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
      },
      identity: {
        provider: 'google',
        subject: 'sub-race',
        accountId,
        email: 'race@example.test',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const results = await Promise.all([
      stores.auth.createAccountWithIdentity(makeInput('account-race-a')),
      stores.auth.createAccountWithIdentity(makeInput('account-race-b')),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const loser = results.find((result) => !result.created);
    expect(loser).toBeDefined();
    if (loser !== undefined && !loser.created) {
      expect(loser.existing.subject).toBe('sub-race');
    }

    const identities = await stores.auth.listIdentities('account-race-a');
    const identitiesB = await stores.auth.listIdentities('account-race-b');
    expect(identities.length + identitiesB.length).toBe(1);

    const accounts = (await stores.auth.listAccounts()).filter((it) =>
      it.id.startsWith('account-race-'),
    );
    expect(accounts).toHaveLength(1);
  });

  it('createAccountWithIdentity を別々の identity・同じ候補メールで並行に呼んでも、投げずにメールが載るのは1つだけ', async () => {
    const makeInput = (accountId: string, subject: string) => ({
      account: {
        id: accountId,
        displayName: 'Someone',
        email: 'shared@example.test',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
      },
      identity: {
        provider: 'google',
        subject,
        accountId,
        email: 'shared@example.test',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const results = await Promise.all([
      stores.auth.createAccountWithIdentity(makeInput('account-diff-identity-a', 'sub-diff-a')),
      stores.auth.createAccountWithIdentity(makeInput('account-diff-identity-b', 'sub-diff-b')),
    ]);

    expect(results.every((result) => result.created)).toBe(true);
    const emails = results.map((result) => (result.created ? result.account.email : null));
    expect(emails.filter((email) => email !== null)).toHaveLength(1);

    const accounts = (await stores.auth.listAccounts()).filter((it) =>
      it.id.startsWith('account-diff-identity-'),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.filter((it) => it.email !== null)).toHaveLength(1);
  });

  it('トークンの保存が落ちたら、ログイン要求は authenticated のまま残る', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest({
      id: 'login-4',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'f'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated',
      accountId: 'account-1',
      error: null,
    });

    // 消費だけ先に確定してしまうと、トークンは返らないのに二度と引き取れなくなる。
    await expect(
      stores.auth.claimLoginRequest('login-4', () => {
        throw new Error('トークンを作れなかった');
      }),
    ).rejects.toThrow();
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('authenticated');

    const claimed = await stores.auth.claimLoginRequest('login-4', (request) => ({
      id: 'token-4',
      accountId: request.accountId ?? '',
      sha256: 'b'.repeat(64),
      label: request.label,
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    }));
    expect(claimed?.token.id).toBe('token-4');
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('consumed');
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
  });
  it('交換へ進む権利は1つのリクエストしか取れない', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-5',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'a'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    // 読んでから書く形だと、全部が pending を通過して全部が交換へ進む。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => stores.auth.beginLoginExchange('login-5')),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-5'))?.status).toBe('processing');
    expect(await stores.auth.beginLoginExchange('login-5')).toBeNull();
    expect(await stores.auth.beginLoginExchange('居ない')).toBeNull();
  });

  describe('setAccountOwner（実行環境の持ち主としての宣言）', () => {
    it('許可済みの行には宣言を立てられる', async () => {
      await stores.auth.putAccount({
        ...account,
        grantedAt: '2026-01-02T00:00:00.000Z',
        grantedBy: 'operator',
      });

      const result = await stores.auth.setAccountOwner('account-1', '2026-01-03T00:00:00.000Z');
      expect(result).toEqual({
        status: 'ok',
        account: {
          ...account,
          grantedAt: '2026-01-02T00:00:00.000Z',
          grantedBy: 'operator',
          ownerDeclaredAt: '2026-01-03T00:00:00.000Z',
        },
      });
      expect((await stores.auth.getAccount('account-1'))?.ownerDeclaredAt).toBe(
        '2026-01-03T00:00:00.000Z',
      );
    });

    it('未許可の行へ宣言しようとすると not_granted（不変条件「宣言 ⟹ 許可済み」）', async () => {
      await stores.auth.putAccount(account);

      const result = await stores.auth.setAccountOwner('account-1', '2026-01-03T00:00:00.000Z');
      expect(result).toEqual({ status: 'not_granted' });
      expect((await stores.auth.getAccount('account-1'))?.ownerDeclaredAt).toBeNull();
    });

    it('存在しないアカウントへの宣言は not_found', async () => {
      expect(await stores.auth.setAccountOwner('居ない', '2026-01-03T00:00:00.000Z')).toEqual({
        status: 'not_found',
      });
    });

    it('取り消し（null）は許可の有無を問わず常に通る', async () => {
      await stores.auth.putAccount(account);

      const result = await stores.auth.setAccountOwner('account-1', null);
      expect(result).toEqual({ status: 'ok', account });
    });

    it('存在しないアカウントの取り消しは not_found', async () => {
      expect(await stores.auth.setAccountOwner('居ない', null)).toEqual({ status: 'not_found' });
    });
  });

  describe('大小文字だけが違う検証済みメール（#1702）', () => {
    function fakeProvider(profiles: Record<string, OAuthProfile>): OAuthProvider {
      return {
        kind: 'oauth2',
        id: 'fake',
        label: 'Fake',
        authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
        exchange: async ({ code }) => {
          const profile = profiles[code];
          if (profile === undefined) throw new Error(`未知の code: ${code}`);
          return profile;
        },
      };
    }

    it('大小文字だけが違う検証済みメールも衝突として検出し、2つ目のアカウントには乗せない', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-case': {
              subject: 'sub-impostor-case',
              email: 'ALICE@EXAMPLE.TEST',
              emailVerified: true,
              displayName: 'Not Alice (case)',
            },
          }),
        ]),
      });

      async function login(code: string): Promise<{ requestId: string; claimSecret: string }> {
        const started = await service.startLogin({
          provider: 'fake',
          redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
        });
        const state = decodeState(
          new URL(started.authorizationUrl).searchParams.get('state') ?? '',
        );
        expect(state).not.toBeNull();
        const completed = await service.completeLogin({
          state: `${state?.requestId}.${state?.nonce}`,
          code,
        });
        expect(completed.status).toBe('ok');
        return { requestId: started.requestId, claimSecret: started.claimSecret };
      }

      const alice = await login('code-alice');
      const claimedAlice = await service.claim(alice);
      if (claimedAlice.status !== 'ready') throw new Error('ログインできていない');
      expect(claimedAlice.account.email).toBe('alice@example.test');

      const impostorCase = await login('code-impostor-case');
      const claimedImpostorCase = await service.claim(impostorCase);
      if (claimedImpostorCase.status !== 'ready') throw new Error('ログインできていない');

      expect(claimedImpostorCase.account.id).not.toBe(claimedAlice.account.id);
      expect(claimedImpostorCase.account.email).toBeNull();
    });

    it('r2: 別々の identity が大小文字だけ違う検証済みメールで同時にログインしても、検証済みメールを持つアカウントは1つだけ', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-case': {
              subject: 'sub-impostor-case',
              email: 'ALICE@EXAMPLE.TEST',
              emailVerified: true,
              displayName: 'Not Alice (case)',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
      const stateSecond = decodeState(
        new URL(second.authorizationUrl).searchParams.get('state') ?? '',
      );
      expect(stateFirst).not.toBeNull();
      expect(stateSecond).not.toBeNull();

      const [resultA, resultB] = await Promise.all([
        service.completeLogin({
          state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
          code: 'code-alice',
        }),
        service.completeLogin({
          state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
          code: 'code-impostor-case',
        }),
      ]);

      expect(resultA.status).toBe('ok');
      expect(resultB.status).toBe('ok');
      if (resultA.status !== 'ok' || resultB.status !== 'ok') {
        throw new Error('ログインできていない');
      }
      expect(resultA.accountId).not.toBe(resultB.accountId);

      const accounts = await stores.auth.listAccounts();
      expect(accounts).toHaveLength(2);
      const withVerifiedEmail = accounts.filter((account) => account.email !== null);
      expect(withVerifiedEmail).toHaveLength(1);
    });

    it('#1741: 別々の identity が大小文字まで同じ検証済みメールで同時にログインしても、検証済みメールを持つアカウントは1つだけ', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-samecase': {
              subject: 'sub-impostor-samecase',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Not Alice (same case)',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
      const stateSecond = decodeState(
        new URL(second.authorizationUrl).searchParams.get('state') ?? '',
      );
      expect(stateFirst).not.toBeNull();
      expect(stateSecond).not.toBeNull();

      const [resultA, resultB] = await Promise.all([
        service.completeLogin({
          state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
          code: 'code-alice',
        }),
        service.completeLogin({
          state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
          code: 'code-impostor-samecase',
        }),
      ]);

      expect(resultA.status).toBe('ok');
      expect(resultB.status).toBe('ok');
      if (resultA.status !== 'ok' || resultB.status !== 'ok') {
        throw new Error('ログインできていない');
      }
      expect(resultA.accountId).not.toBe(resultB.accountId);

      const accounts = await stores.auth.listAccounts();
      expect(accounts).toHaveLength(2);
      const withVerifiedEmail = accounts.filter((account) => account.email !== null);
      expect(withVerifiedEmail).toHaveLength(1);
    });
  });
});

function neverIssued(): never {
  throw new Error('引き取れないはずの要求でトークンを作ろうとした');
}

describe('FsConversationReadStore', () => {
  it('器の契約（3実装で同じことを測る）', async () => {
    await verifyConversationReadStoreContract(stores.conversationReads);
  });

  it('器を作り直しても基準時刻と位置が残る', async () => {
    await stores.conversationReads.ensureBaseline('2026-10-01T00:00:00.000Z');
    await stores.conversationReads.advance('c1', '2026-10-01T00:00:01.000Z');
    const reopened = createFsStores(root);
    expect(await reopened.conversationReads.read()).toMatchObject({
      state: 'ok',
      baseline: '2026-10-01T00:00:00.000Z',
      positions: { c1: { readThrough: '2026-10-01T00:00:01.000Z' } },
    });
  });

  it('壊れたファイルは「無い」ではなく「読めない」。基準時刻は書き換えず、進めれば書き直す', async () => {
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(join(root, 'jobs', 'conversation-reads.json'), '{ not json', 'utf8');
    expect((await stores.conversationReads.read()).state).toBe('unreadable');
    expect((await stores.conversationReads.ensureBaseline('2026-10-01T00:00:00.000Z')).state).toBe(
      'unreadable',
    );
    expect(await readFile(join(root, 'jobs', 'conversation-reads.json'), 'utf8')).toBe(
      '{ not json',
    );

    await stores.conversationReads.advance('c1', '2026-10-01T00:00:01.000Z');
    expect(await stores.conversationReads.read()).toMatchObject({
      state: 'ok',
      positions: { c1: { readThrough: '2026-10-01T00:00:01.000Z' } },
    });
  });
});
