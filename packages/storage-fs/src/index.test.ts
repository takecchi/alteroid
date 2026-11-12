import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  renderMemoryDocuments,
  verifyAuthRecordsContract,
  verifyAuthListOrderContract,
  verifyAuthTieByteOrderContract,
  verifyAuthRevokeAccessTokenContract,
  verifyAuthAccountFieldsContract,
  verifyAuthLoginRequestContract,
  verifyAuthConcurrentWritesContract,
  verifyAuthVerifiedEmailContract,
  verifyAuthLogoutRaceContract,
  verifyAuthWriteValidationContract,
  verifyConversationReadStoreContract,
  verifyMcpServerStoreContract,
  verifyMcpServersIfMatchContract,
  verifyCredentialVaultContract,
  verifyTokenPoolContract,
  verifyPersonaNulContract,
  verifyPersonaWriteContract,
  verifyPersonaIfMatchContract,
  verifyPersonaProtectionStatusContract,
  verifyPersonaCreatedAtContract,
  verifyPersonaDescribedAtContract,
  verifyPersonaDescribedBytesContract,
  verifyJobNulContract,
  verifyScheduleNulContract,
  verifyScheduleIfMatchContract,
  verifyScheduleRunContract,
  verifyScheduleUnreadableContract,
  verifySessionRegistryGraveQueueContract,
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
  verifyJournalStoreConversationIdContract,
  verifyJournalStoreDeletedConversationContract,
  verifyJournalStoreToolUseCountContract,
  verifyJournalStoreConversationIdsAfterContract,
  verifyJournalStoreConversationPrefixContract,
  verifyJournalStoreWithdrawnContract,
  verifyJournalStoreWithContract,
  verifyTranscriptArchiveContract,
} from '@alteroid/core';
import type { JournalEntry } from '@alteroid/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores, initWorkspace } from './index.js';

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
  // 索引（`.index.json`）を器の外から直す: 派生値だけを失った行を作るため。契約が器の裏側を知らずに済むよう、フックで渡す。
  const editIndex = async (edit: (index: Record<string, Record<string, unknown>>) => void) => {
    const indexPath = join(root, 'memory', '.index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    edit(index);
    await writeFile(indexPath, JSON.stringify(index), 'utf8');
  };

  it('本文の NUL の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyPersonaNulContract(stores.persona);
  });

  it('書き込みの正規化と追記の契約（fs・pg・インメモリで同じ挙動）', async () => {
    await verifyPersonaWriteContract(stores.persona);
  });

  it('write / remove の前提の版 ifMatch の契約（Issue #2743・#2881。fs・pg・インメモリで同じ挙動）', async () => {
    await verifyPersonaIfMatchContract(stores.persona);
  });

  it('protectionStatus（保護状態の派生値）の契約', async () => {
    await verifyPersonaProtectionStatusContract(stores.persona, {
      rewriteBehindStore: (slug, content) =>
        writeFile(join(root, 'memory', `${slug}.md`), content, 'utf8'),
    });
  });

  it('createdAt（作成時刻の派生値）の契約', async () => {
    await verifyPersonaCreatedAtContract(stores.persona, {
      forgetCreatedAt: (slug) =>
        editIndex((index) => {
          delete index[slug]?.createdAt;
        }),
    });
  });

  it('describedAt（要旨の鮮度の派生値）の契約', async () => {
    await verifyPersonaDescribedAtContract(stores.persona);
  });

  it('describedBytes（本文の変化量の派生値、#913）の契約', async () => {
    await verifyPersonaDescribedBytesContract(stores.persona, {
      forgetDescribedBytes: (slug, { withAt }) =>
        editIndex((index) => {
          delete index[slug]?.describedBytes;
          if (withAt) delete index[slug]?.describedBytesAt;
        }),
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

  it('list() は .index.json を拾わない（*.md しか見ない）', async () => {
    await stores.persona.write('values', '# 価値観\n');
    await stores.persona.markHumanTouched('values', new Date().toISOString());

    const list = await stores.persona.list();

    expect(list.map((doc) => doc.slug)).toEqual(['values']);
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
      // 記憶ディレクトリは store が最初の書き込みで作る: store を通さないので先に自分で作る（作らないと ENOENT で確かめたい組み直しに届かない）
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

  describe('索引の無い生ファイルの createdAt（契約は write() で作った文書から派生値だけを失わせて測る）', () => {
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

  // 消さない: 書き込みは通り、読み出しで初めて落ちて行が `list()` から黙って消えるのはこの形だけだから。
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

    it('退役した種別（inbox_flow・worker_wait）の古い行は、落とさず・跡も出さずに黙って飛ばす', async () => {
      const kept = await stores.journal.append({
        type: 'decision',
        decision: '健全な行',
        grounds: 'g',
      });

      const journalDir = join(root, 'journal');
      const today = new Date().toISOString().slice(0, 10);
      await writeFile(
        join(journalDir, `${today}.jsonl`),
        ['inbox_flow', 'worker_wait']
          .map(
            (type, i) =>
              `${JSON.stringify({ type, id: `retired-${i}`, at: `${today}T00:00:0${i}.000Z` })}\n`,
          )
          .join(''),
        { flag: 'a' },
      );

      let entries: Awaited<ReturnType<typeof stores.journal.list>> = [];
      let found: JournalEntry | null = null;
      const lines = await captureStderr(async () => {
        entries = await stores.journal.list();
        found = await stores.journal.get(kept.id);
      });

      expect(entries.map((entry) => entry.id)).toEqual([kept.id]);
      expect(found).toMatchObject({ id: kept.id });
      expect(lines).toEqual([]);
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

  describe('tool_use の件数の契約', () => {
    it('窓の内の tool_use だけが actor ごとに数えられ、両端を含み、他の種別と墓標が名指しした行は数えない', async () => {
      await verifyJournalStoreToolUseCountContract(stores.journal);
    });
  });

  describe('継続点より後ろの会話 id の契約', () => {
    it('錨より後ろの人間との往復の会話 id だけが重複なく返り、until で切れ、錨の行・他の相手・消した会話は含まず、錨が無ければ例外を投げる', async () => {
      await verifyJournalStoreConversationIdsAfterContract(stores.journal);
    });
  });

  describe('会話 id の前方一致の契約', () => {
    it('前方一致する会話 id が最新の発言の新しい順に重複なく上限まで返り、消した会話・他の相手の会話は含まない', async () => {
      await verifyJournalStoreConversationPrefixContract(stores.journal);
    });
  });

  describe('墓標の契約（issue #4218）', () => {
    it('墓標の後は list/listPage/get/q/with から外れる／別の会話と墓標は外れない／limit より前に効く／墓標の後の行も外れる／墓標が名指しした行も外れる（#4355）', async () => {
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

  describe('conversationId 契約', () => {
    it('その会話の行だけ／limit より前／with・after と併用／墓標は外れる／空文字は絞らないへ倒さない', async () => {
      await verifyJournalStoreConversationIdContract(stores.journal);
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

  it('発火の印と編集の契約（claimRun・completeRun・editRequest。3実装で同じことを測る）', async () => {
    await verifyScheduleRunContract(stores.schedules);
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
    await stores.schedules.removeIfPresent('issue-round');

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

  it('読んでから確定するまでに removeIfPresent / put が割り込んでも、古い版では確定しない', async () => {
    await stores.schedules.put(plan);

    const [claimedAfterRemove] = await Promise.all([
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
      stores.schedules.removeIfPresent('issue-round'),
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
      stores.schedules.removeIfPresent('しらない'),
    ]);

    const plans = (await stores.schedules.list()).entries;
    expect(plans.map((entry) => entry.kind)).toEqual(['a', 'b', 'issue-round']);
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('外せる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.removeIfPresent('issue-round');

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

  it('配り方（distribution）も設定の往復で落ちない。未設定ならキーを持たない', async () => {
    const unset = await stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 1_000 });
    expect('distribution' in (await stores.tokens.readSettings())).toBe(false);
    expect(await stores.tokens.readSettings()).toEqual(unset);

    const balanced = await stores.tokens.writeSettings({
      rotateOn: 'off',
      cooldownMs: 1_000,
      distribution: 'balanced',
    });
    expect(await stores.tokens.readSettings()).toEqual(balanced);
  });

  it('週の枠のリセット（weeklyReset）も往復する。控えていない行は欄を持たない（#6651）', async () => {
    await stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'a',
        value: 'tok-aaa',
        order: 0,
        weeklyReset: {
          at: 1794402000000,
          zone: 'Asia/Tokyo',
          observedAt: '2026-11-09T12:00:00.000Z',
        },
      },
      { id: 'tok-b', label: 'b', value: 'tok-bbb', order: 1 },
    ]);
    const [a, b] = await stores.tokens.list();
    expect(a?.weeklyReset).toEqual({
      at: 1794402000000,
      zone: 'Asia/Tokyo',
      observedAt: '2026-11-09T12:00:00.000Z',
    });
    expect(b).not.toHaveProperty('weeklyReset');
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

  it('墓標は上書きされず複数持てる（#4884。3実装で同じことを測る）', async () => {
    await verifySessionRegistryGraveQueueContract(stores.sessions);
  });

  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });

  it('墓標を覚えて忘れられる。そして resume 素材を捨てても消えない', async () => {
    expect(await stores.sessions.listTranscriptGraves()).toEqual([]);

    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.addTranscriptGrave({ archiveId: 'sess-1-2026.jsonl' });
    expect(await stores.sessions.listTranscriptGraves()).toEqual([
      { archiveId: 'sess-1-2026.jsonl' },
    ]);

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.sessions.listTranscriptGraves()).toEqual([
      { archiveId: 'sess-1-2026.jsonl' },
    ]);

    await stores.sessions.clearTranscriptGraveIf('sess-1-2026.jsonl');
    expect(await stores.sessions.listTranscriptGraves()).toEqual([]);
  });

  it('2つの墓標は互いを消さない。そして resume 素材を捨てても両方残る', async () => {
    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.addTranscriptGrave({ archiveId: 'sess-1-2026.jsonl' });
    await stores.sessions.addLostSessionGrave({
      projectKey: '-workspace',
      sessionId: 'sess-old',
    });

    await stores.sessions.setCloneSessionId(null);

    expect(await stores.sessions.listTranscriptGraves()).toEqual([
      { archiveId: 'sess-1-2026.jsonl' },
    ]);
    expect(await stores.sessions.listLostSessionGraves()).toEqual([
      { projectKey: '-workspace', sessionId: 'sess-old' },
    ]);

    await stores.sessions.clearLostSessionGraveIf('sess-old');
    expect(await stores.sessions.listLostSessionGraves()).toEqual([]);
    expect(await stores.sessions.listTranscriptGraves()).toEqual([
      { archiveId: 'sess-1-2026.jsonl' },
    ]);
    await stores.sessions.clearTranscriptGraveIf('sess-1-2026.jsonl');
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
  // ケースごとに空の器を立てる（契約は固定の id で始めるので、器を使い回さない）
  const makeAuth = async () => createFsStores(await makeTempDir('alteroid-test-')).auth;

  it('保存と読み戻しの契約（fs・pg・インメモリで同じ挙動）', async () => {
    await verifyAuthRecordsContract(makeAuth);
  });

  it('一覧の並びの契約（createdAt の実時刻順・同着の2次キー、issue #1688）', async () => {
    await verifyAuthListOrderContract(makeAuth);
  });

  it('同着の2次キーはバイト順の契約（issue #2458）', async () => {
    await verifyAuthTieByteOrderContract(makeAuth);
  });

  it('revokeAccessToken と markAccessTokenUsed の契約', async () => {
    await verifyAuthRevokeAccessTokenContract(makeAuth);
  });

  it('markAccountLoggedIn と revokeAccountAccess の契約（issue #1870・#1915）', async () => {
    await verifyAuthAccountFieldsContract(makeAuth);
  });

  it('ログイン要求の引き取りと交換への着手の契約', async () => {
    await verifyAuthLoginRequestContract(makeAuth);
  });

  it('同時の許可と同時のアカウント作成の契約', async () => {
    await verifyAuthConcurrentWritesContract(makeAuth);
  });

  it('同じ検証済みメール（大小文字だけの違いを含む）の契約（#1702・#1741・#1714）', async () => {
    await verifyAuthVerifiedEmailContract(makeAuth);
  });

  it('ログアウトと同時の authenticate が失効を巻き戻さない契約（issue #1782）', async () => {
    await verifyAuthLogoutRaceContract(makeAuth);
  });

  it('書き込みの形式検査の契約', async () => {
    await verifyAuthWriteValidationContract(makeAuth);
  });
});

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
