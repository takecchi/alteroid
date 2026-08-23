import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderMemoryDocuments } from '@alteroid/core';
import type { Commitment, InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { CLOSED_HISTORY_LIMIT, createFsStores, initWorkspace } from './index.js';

let root: string;
let stores: ReturnType<typeof createFsStores>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'alteroid-test-'));
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
  it('書いて読める', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
  });

  it('人間がファイルを手で書き換えると次の読み出しに反映される（受け入れ基準3）', async () => {
    await stores.persona.write('values', '# 価値観\n\nもとの内容\n');

    // クローンを介さずエディタで直接書き換える、を模す
    await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n\n人間が書き換えた\n', 'utf8');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    // クローンの文脈へ載る形（documents → renderMemoryDocuments）にも反映されること。
    // かつては concat() がこの連結まで持っていたが、載せ方は core へ移った。
    expect(renderMemoryDocuments(await stores.persona.documents())).toContain('人間が書き換えた');
  });

  it('append は末尾に足す', async () => {
    await stores.persona.write('log', '# ログ\n');
    await stores.persona.append('log', '- 追記された学び\n');

    expect((await stores.persona.read('log'))?.content).toBe('# ログ\n\n- 追記された学び\n');
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

    // .tmp が残っていない = rename で置き換わっている
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
    // 書いた順を slug の昇順とわざと逆にする。挿入順で通ってしまわないため。
    await stores.persona.write('b', '# B\n\nい\n');
    await stores.persona.write('a', '# A\n\nあ\n');

    const docs = await stores.persona.documents();

    // 順序と本文の有無は上の層が依存する点である（クローンは走行中に
    // 「どの文書が変わったか」を見出しで指す）。
    expect(docs.map((d) => d.slug)).toEqual(['a', 'b']);
    expect(docs.map((d) => d.content)).toEqual(['# A\n\nあ\n', '# B\n\nい\n']);

    const all = renderMemoryDocuments(docs);

    expect(all).toContain('memory: a.md');
    expect(all).toContain('memory: b.md');
  });

  /**
   * 保護状態（human guard）の派生値。実体は日誌にあり、ここは fs 側の置き場
   * （`.index.json`）が正しく振る舞うかを確かめる。「断ることを測る」歯そのもの
   * （distill が断られる／通る）は `tools.test.ts` が持つ——ここは `PersonaStore`
   * が返す `protectionStatus` の正しさだけを見る。
   */
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

    // 歯7: append の経路でもハッシュが更新される（write だけ直して append を
    // 忘れる穴を塞ぐ）。
    it('append 経路でもハッシュが更新される（誤検出しない）', async () => {
      await stores.persona.write('log', '# ログ\n');
      await stores.persona.append('log', '- 追記');

      expect(await stores.persona.protectionStatus('log')).toEqual({ kind: 'clone-only' });
    });

    /**
     * 歯7の対照（変異試験で見つかった穴を塞ぐ）。
     *
     * **上の2つのテストだけでは、`#writeNow` のハッシュ更新を丸ごと削っても
     * 落ちない。** `.index.json` が無い状態から読むと「索引の組み直し」が
     * 現在の本文を直接読んで基準化するため、write()/append() 自身がハッシュを
     * 更新していなくても、初回の組み直しに救われて正しい値が返ってしまう
     * （実際に変異試験でこれを確認した——`#writeNow` のハッシュ更新をまるごと
     * 消しても上の79件は1件も落ちなかった）。
     *
     * ここでは、いったん `protectionStatus` を呼んで索引ファイルを確定させて
     * から2回目の書き込みを行う。索引が既に存在する状態での書き込みなら、
     * write()/append() 自身が更新していない限り、古いハッシュが残って
     * 次の本文と食い違い、unknown に落ちる——組み直しには救われない。
     */
    it('索引が確定した後の write でも、ハッシュ更新は組み直しに頼らない', async () => {
      await stores.persona.write('values', '# 版1\n');
      // ここで一度確定させる（.index.json を作る）。
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

    // 歯6: 道具経由の書き込み直後は unknown にならない（誤検出しない）。
    // 歯5（次のテスト）とは別の it() で測る——片方が通ってももう片方の保証にはならない。
    it('道具経由（write）の直後は unknown にならない', async () => {
      await stores.persona.write('values', '# 価値観\n\n本文\n');

      const status = await stores.persona.protectionStatus('values');

      expect(status).not.toEqual({ kind: 'unknown' });
      expect(status).toEqual({ kind: 'clone-only' });
    });

    /**
     * 歯5:「導出値と外部編集検出はセット」であること。
     *
     * `PersonaStore` は本文をキャッシュしない（受け入れ基準3。人間が直接書き換えた
     * 本文は次に読んだとき必ず反映される）。**保護状態だけが古いまま返ると、
     * 本文と保護状態の足並みが揃わない**——それが設計上の欠陥として指摘された点
     * である。ここでは、本文が新しい値に反映されるのと同じ読み出しで、保護状態も
     * 古いまま返らないこと（unknown に落ちること）を確かめる。
     */
    it('外部から本文が変わったとき、保護状態が古いまま返らない（unknown になる）', async () => {
      await stores.persona.write('values', '# 価値観\n\nもとの内容\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      // クローンを介さずエディタで直接書き換える、を模す（受け入れ基準3のテスト
      // と同じ手口）。store を通さないので、この書き換えは write() / append() の
      // ハッシュ更新を一切経由しない。
      await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n\n外から書き換えた\n', 'utf8');

      // 本文はキャッシュされていないので新しい値が読める（既存テストで固定済み）
      // ——ここではその同じ読み出しの上で、保護状態も古いまま（clone-only）
      // 返らないことを確かめる。
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

  /**
   * 索引の組み直し（`.index.json` を走行中に失ったときの自己修復）。
   *
   * **`unknown` は守る側へ倒す約束のせいで、索引を失うと全文書が保護されたまま
   * 動かせなくなる**（distill が何も畳めず、クローンには「守られている」としか
   * 見えない——静かに凍る）。起動時の backfill だけでは、走行中に消えた場合に
   * 次の再起動まで凍ったままになるので、読み出しのその場で日誌から組み直す。
   */
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

      // 索引ファイルが走行中に消えた、を模す。
      await rm(join(root, 'memory', '.index.json'), { force: true });

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('索引を消してから読んでも、クローンが clone-only の文書を畳める（＝凍らない）', async () => {
      await stores.persona.write('notes', '# ノート\n\n最初の版\n');
      expect(await stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });

      await rm(join(root, 'memory', '.index.json'), { force: true });

      // 組み直し後も clone-only のまま——unknown に落ちて凍らない。
      // これが無いと、この歯を入れた意味が無い。
      expect(await stores.persona.protectionStatus('notes')).toEqual({ kind: 'clone-only' });
    });

    it('組み直しが日誌に残る', async () => {
      // **store を経由せず直接 `.md` を置く。** `stores.persona.write()` を使うと
      // その呼び出し自体が（この試験用の器では索引がまだ一度も無い）最初の
      // 索引の組み直しを引き起こしてしまい、これから確かめたい「消してからの
      // 組み直し」と数が混ざる。ここでは「索引が一度も存在しない状態」を
      // そのまま使う。
      // 記憶ディレクトリは store が最初の書き込みで作る。ここは store を通さないので、
      // 先に自分で作る（作らないと ENOENT で、確かめたい組み直しに届かない）。
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'notes.md'), '# ノート\n', 'utf8');

      await stores.persona.protectionStatus('notes');

      const entries = await stores.journal.list({ types: ['decision'] });
      const rebuilds = entries.filter(
        (entry) => 'decision' in entry && entry.decision.includes('組み直した'),
      );
      expect(rebuilds).toHaveLength(1);
      // memory_update ではないこと（記憶の本文は変わっていない）。
      expect(await stores.journal.list({ types: ['memory_update'] })).toHaveLength(0);
    });

    it('組み直しは1回だけで、次の読み出しでは走らない', async () => {
      // 上のテストと同じ理由で、store を経由せず直接 `.md` を置く。
      // 記憶ディレクトリは store が最初の書き込みで作る。ここは store を通さないので、
      // 先に自分で作る（作らないと ENOENT で、確かめたい組み直しに届かない）。
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'notes.md'), '# ノート\n', 'utf8');

      // 複数回・複数の経路から読む。
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

  /**
   * `createdAt`（記憶の絶対条件）。
   *
   * **この配線（記憶の `createdAt` 対応）より前は、索引の値は `markCreatedAt`
   * からしか動かなかった**——journal からの導出
   * （`deriveMemoryCreatedAtFromJournal`）は `apps/daemon/src/storage.ts` の
   * 起動時 backfill の仕事で、ここは `PersonaStore` 単体の振る舞いだけを
   * 見ていた。**いまは違う。** `write()` / `append()` 自身が、その書き込みが
   * 文書を作った瞬間（`before === null`）を観測して `createdAt` を直接
   * 立てる（`#writeNow` の doc）。`markCreatedAt` はこの配線より前に作られた
   * 行を埋める後始末に降格しており、**このファイルの下のほうのテスト
   * （`markCreatedAt` 単体の振る舞い）は、write() が既に createdAt を
   * 立ててしまわないよう、索引の無い生ファイル（backfill 前の昔の記憶を
   * 模す）を直接置いて確かめる。**
   */
  describe('createdAt（作成時刻の派生値）', () => {
    it('write() は新規作成のとき、backfill を通さずその場で createdAt を known にする（updatedAt と一致）', async () => {
      // **この it() はこの PR で反転した。** 以前はここで「markCreatedAt を
      // 呼んでいなければ unknown（mtime を使わない）」を確かめていた——write()
      // は createdAt に一切触れず、backfill だけが埋める、という旧仕様の
      // 裏返しである。**いまは write() 自身が作成そのものを観測する経路に
      // なったので、新規作成した文書は markCreatedAt を待たずその場で known
      // になる。** mtime を使わない、という主張自体は変わっていない——
      // ここで使っているのは「この書き込みが刻んだ `updatedAt`」であって、
      // ファイルシステムの `stat().mtime` を後から読み直したものではない
      // （`memoryDocumentMetaSchema.createdAt` の doc）。
      const doc = await stores.persona.write('values', '# 価値観\n');

      const read = await stores.persona.read('values');

      expect(read?.createdAt).toEqual({ kind: 'known', at: doc.updatedAt });
      expect(read?.createdAt).toEqual({ kind: 'known', at: read?.updatedAt });
    });

    it('既存の文書を更新しても createdAt は変わらない（updatedAt は進む）', async () => {
      const first = await stores.persona.write('values', '# 価値観\n');
      // ファイルシステムの mtime 分解能に負けないよう、確実に時刻を進める
      // （このファイルの describedAt のテストと同じ手口）。
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
      // **write() ではなく、索引の無い生ファイルとして用意する。** write() 自身が
      // 新規作成時に createdAt を立てるようになったため、persona.write() で
      // 作ると markCreatedAt を待たずに既に known になってしまい、ここで
      // 確かめたい「markCreatedAt 単体の効果」が隠れる。索引の無い生ファイル
      // （backfill 前の昔の記憶を模す。「組み直しが日誌に残る」と同じ手口）を
      // 直接置くことで、markCreatedAt が実際に反映を作る場面を再現する。
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
      // 上のテストと同じ理由で、write() ではなく索引の無い生ファイルを直接置く。
      await mkdir(join(root, 'memory'), { recursive: true });
      await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n', 'utf8');

      const first = await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');
      const second = await stores.persona.markCreatedAt('values', '2020-01-01T00:00:00.000Z');

      expect(first).toBe(true);
      expect(second).toBe(false);
      // 後から呼んだほうにも、より新しいほうにも動かない——最初の値のまま。
      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
    });

    it('同じ引数で2回走らせても結果は変わらない（backfill の再実行を模す）', async () => {
      // 上のテストと同じ理由で、write() ではなく索引の無い生ファイルを直接置く。
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
      // **この it() はこの PR で反転した。** 以前はここで「remove() で
      // createdAt も一緒に消える」——削除後に同じ slug へ書き直しても
      // markCreatedAt を呼ばない限り unknown のまま、を確かめていた。
      // **いまは write() 自身が作成を観測するので、削除後の書き直しは
      // それ自体が新しい作成であり、その場で新しい known な createdAt が付く**
      // ——`remove()` が索引エントリ（＝古い createdAt）ごと消すことの帰結が、
      // 「印が蘇らない」から「新しい印が生まれる」に変わった。
      const first = await stores.persona.write('values', '# 価値観\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      await stores.persona.remove('values');
      const second = await stores.persona.write('values', '# 価値観\n\n書き直した\n');

      expect(second.createdAt.kind).toBe('known');
      expect(second.createdAt).not.toEqual(first.createdAt);
      expect((await stores.persona.read('values'))?.createdAt).toEqual(second.createdAt);
    });

    /**
     * **絶対条件5「バックフィルは created_at を埋める以外のことを一切しない」**
     * を `markCreatedAt` 単体で確かめる——本文・`updatedAt`・保護状態
     * （`humanTouchedAt` 由来）・`description` を走行前後で突き合わせる。
     */
    it('markCreatedAt は createdAt 以外を1つも書き換えない', async () => {
      // 上と同じ理由で、write() ではなく索引の無い生ファイルを直接置く
      // （markCreatedAt 単体の効果を確かめたいので、write() に createdAt を
      // 先に立てさせない）。
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
      // createdAt だけが動いたことも合わせて見る（before は unknown のまま）。
      expect(before?.createdAt).toEqual({ kind: 'unknown' });
      expect(after?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });

    /**
     * 上のテストは先に `markHumanTouched` を呼ぶ。そのせいで `protectionStatus`
     * は `humanTouchedAt` の分岐で即 `{ kind: 'human' }` を返し、`contentSha256`
     * を一度も見ない（`persona.ts` の `protectionStatus`）。`descriptionFreshness`
     * も before/after を比べてはいるが、両方とも `human` という結果に吸収され、
     * `contentSha256` / `describedAt` が消えても差が出ない構造になっている。
     * 実際、`markCreatedAt` が `contentSha256` と `describedAt` を巻き添えで
     * 消す変異を当てても、上のテストを含む全117ファイル2154本は1本も赤くならない
     * （変異試験で確認済み）。
     *
     * ここでは `markHumanTouched` を呼ばずに、`contentSha256` と `describedAt`
     * の両方を実際に観測できる形を作る。**この2つは `write()` を通さないと
     * 立たない**（上のテストのように索引の無い生ファイルを直接置くだけでは
     * 立たない）。ところが `write()` は同時に `createdAt` も立ててしまい、
     * `markCreatedAt` は「既に値が在れば触らない」ので、そのままでは変異が
     * 発火する前に `false` を返して終わる。
     *
     * そこで `write()` の直後に、索引ファイル（`.index.json`）から `createdAt`
     * のキーだけを取り除く。**これは小細工ではなく現実の再現である** ——
     * `contentSha256` / `describedAt` は #173 / #170 から `write()` が立てて
     * きたのに対し、`createdAt` は #220 でこの配線が入るまで存在しなかった
     * 列である。つまり配線より前に書かれた行はまさに「`contentSha256` /
     * `describedAt` は在るが `createdAt` は無い」状態にある。
     */
    it('markCreatedAt は（human 印を経由しない場合でも）contentSha256 と describedAt を書き換えない', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文', ''].join('\n'),
      );

      // #220 の配線より前に作られた行を模す: contentSha256 / describedAt は
      // 在るが createdAt は無い。
      const indexPath = join(root, 'memory', '.index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      delete index.runbook.createdAt;
      await writeFile(indexPath, JSON.stringify(index), 'utf8');

      const before = await stores.persona.read('runbook');
      const beforeProtection = await stores.persona.protectionStatus('runbook');
      // 前提を確かめる: markHumanTouched を経由していないので、
      // protectionStatus は contentSha256 を実際に比較して clone-only を返す
      // （human の一言で吸収されない）。describedAt も生きているので fresh。
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
      // contentSha256 / describedAt は直接読めない派生値なので、
      // protectionStatus / descriptionFreshness を経由して確かめる。
      expect(afterProtection).toEqual(beforeProtection);
      expect(after?.descriptionFreshness).toEqual(before?.descriptionFreshness);
      expect(after?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });
  });

  /**
   * `describedAt`（#170「記憶の目次化」の派生値）。書き手は書けない——
   * `write()` / `append()` が新旧の `description`（frontmatter）を比べて
   * 進めるか据え置くかを決める（4-3）。
   */
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
      // ファイルシステムの mtime 分解能に負けないよう、確実に時刻を進める。
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const doc = await stores.persona.read('runbook');
      // description は変わっていないので describedAt は最初の書き込み時刻の
      // まま据え置かれ、updatedAt はこの2回目の書き込みで進んだ——結果、
      // describedAt < updatedAt になり stale になる。
      expect(doc?.descriptionFreshness).toEqual({ kind: 'stale' });
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
      expect((await stores.persona.read('runbook'))?.descriptionFreshness).toEqual({
        kind: 'stale',
      });

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
    // 過去の日誌を手で置く。読まれてしまうなら壊れた行で気づける。
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

    // since を外せば古い分まで見える（打ち切りは読み飛ばしであって欠落ではない）
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

    // 過去の1日を手で置く。**新しい日から走査が始まる**ので、`until` で
    // 打ち切る実装だとここへ辿り着けない（読み飛ばしでなければならない）。
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

  it('id で1件引ける（一覧を抜粋にした先の全文の行き先）', async () => {
    const entry = await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.get(entry.id)).toMatchObject({ id: entry.id, decision: 'd' });
    expect(await stores.journal.get('no-such-id')).toBeNull();
  });

  /**
   * **回帰: `input` を持たない `tool_use` エントリが、直列化を挟むと跡形もなく
   * 消える（#223 と同じ形。日誌エントリ版。Issue #224）。**
   *
   * `append()` に渡すオブジェクトは `input` というキーを値 `undefined` として
   * 持つ（キーは在る）ので、書き込み時の `journalEntrySchema.parse` は通る。
   * しかし fs 版はこのエントリを `JSON.stringify` して `.jsonl` へ書く
   * （`journal.ts` の `append`）——値が `undefined` のキーはここで丸ごと落ちる。
   * 読み出し時は `JSON.parse` した後に `journalEntrySchema.safeParse` を通す
   * （`parseLine`）ので、`input` が必須のままだと zod 4 の「キーの不在を許さ
   * ない」規則に引っかかって落ち、**この行が `list()` の結果から丸ごと消える**
   * （`createMemoryStores` は直列化しないので、この壊れ方を再現できない）。
   */
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

  /**
   * **回帰（静かなほう）: `input` というキーが在って値が `undefined` の形。**
   *
   * これが実機で通る形である —— `manager.ts` の `case 'tool_use'` は
   * `input: event.input` と**必ずキーを書く**ので、`event.input` が
   * `undefined` でも「キーは在る」状態で `append()` へ来る。
   *
   * **上のテストとは壊れ方が違う。** キー自体を書かない形は、`input` が必須の
   * ままだと `append()` の `journalEntrySchema.parse` がその場で投げる（大きな
   * 音がする）。こちらは**書き込みが通ってしまう** —— zod は「キーが在って値が
   * `undefined`」を通すからである。fs 版は JSON 行として `.jsonl` へ書くので、直列化でキーが落ち、
   * **読み出しで初めて落ちて、その行が `list()` から黙って消える。**
   * 跡は残らない（Issue #224）。**silent なのはこちらだけなので、この歯を
   * 消さないこと。**
   */
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
});

describe('FsJobStore', () => {
  it('承認待ちを積んで回答できる', async () => {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これをやってよいか',
    });

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-1');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      answeredAt: new Date().toISOString(),
      answer: 'よい',
    });

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(0);
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
  });

  it('同じ id は上書きされる', async () => {
    const base = { id: 'j-1', createdAt: '2026-01-01T00:00:00.000Z', question: 'q' };
    await stores.jobs.putApproval(base);
    await stores.jobs.putApproval({ ...base, question: 'q2' });

    expect(await stores.jobs.listApprovals()).toHaveLength(1);
  });
});

describe('FsScheduleStore', () => {
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

    // `schedule_list` はこの `list()` を直に読み、「既定の日報・発意 tick はここには
    // 出ない」と約束している。混ざると `schedule_remove` で消せてしまう。
    expect(await stores.schedules.list()).toEqual([]);
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

    expect(await stores.schedules.list()).toEqual([plan]);
    expect((await stores.schedules.get('issue-round'))?.request).toContain('open issue');
    expect(await stores.schedules.get('しらない')).toBeNull();
  });

  it('同じ kind は置き換わる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.put({ ...plan, request: '直した依頼' });

    const plans = await stores.schedules.list();
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
    // updatedAt は「依頼が書き換えられた時刻」＝版の識別子なので発火では動かない
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

    // 前の発火（別の時刻）の完了が遅れて届いた
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
    // 知らない kind
    expect(
      await stores.schedules.claimRun(
        'しらない',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();

    // 読んだ後に消された
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

    // 読んだ後に書き換えられた（版が違う）
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
    // 記録もされていない（新しい版に古い発火の跡を付けない）
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBeUndefined();
  });

  it('読んでから確定するまでに remove / put が割り込んでも、古い版では確定しない', async () => {
    await stores.schedules.put(plan);

    // 「読んだ直後に人間が消した」を、同じ排他区間へ同時に投げて作る
    const [claimedAfterRemove] = await Promise.all([
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
      stores.schedules.remove('issue-round'),
    ]);
    // どちらの順で直列化されても、「消えた後に確定した」ことにはならない
    if (claimedAfterRemove !== null) {
      expect(await stores.schedules.get('issue-round')).toBeNull();
    }

    // 「読んだ直後に人間が直した」も同様に、古い版では確定しない
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

    const plans = await stores.schedules.list();
    expect(plans.map((entry) => entry.kind)).toEqual(['a', 'b', 'issue-round']);
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('外せる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.remove('issue-round');

    expect(await stores.schedules.list()).toEqual([]);
  });

  it('読めない中身を「消された」に潰さない（pg 版と同じ振る舞い）', async () => {
    // 人間が手で直した・古い形が残っている、を模す
    await initWorkspace(root);
    await writeFile(
      join(root, 'jobs', 'schedules.json'),
      JSON.stringify({ schedules: [{ kind: 'broken' }] }),
      'utf8',
    );

    // null / 空配列に潰すと、クローンから見て「消された依頼」と区別が付かず、
    // 本文なしの曖昧なターンが走る（clone.ts が読取不能を分けている意味が消える）
    await expect(stores.schedules.get('broken')).rejects.toThrow();
    await expect(stores.schedules.list()).rejects.toThrow();
  });
});

/**
 * 引き受けたまま終わっていない仕事の台帳（`store.ts` の `CommitmentStore`）。
 *
 * fs / pg で同じ振る舞いになることを両方で問う（`store.ts`「省略可能にしないこと」）。
 */
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
    });
    expect((await stores.commitments.get('c-1'))?.body).toBe('PR を出す');
    expect(await stores.commitments.get('しらない')).toBeNull();
  });

  it('閉じたものは未了から外れ、includeClosed でだけ読める（行は消さない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(
      await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した', 'clone'),
    ).toBe(true);

    expect(await stores.commitments.list()).toEqual({ entries: [], unreadable: [] });
    const all = (await stores.commitments.list({ includeClosed: true })).entries;
    expect(all).toHaveLength(1);
    // 「閉じた」だけを残さない（何をもって終わりとしたかが無いと人間が否定できない）
    expect(all[0]?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(all[0]?.closedReason).toBe('#99 で出した');
    expect(all[0]?.closedBy).toBe('clone');
  });

  it('close は closedBy を記録し、既存の（closedBy の無い）行は undefined のままで既定へ倒れない', async () => {
    // 既に閉じているが closedBy を持たない行 = この欄が導入される前の記録を模す。
    // open() はどんな Commitment も受け付けるので、そのまま書き込める。
    await stores.commitments.open({
      id: 'c-legacy',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '導入前に片付いた仕事',
      closedAt: '2026-08-02T00:00:00.000Z',
      closedReason: '当時は書き手を記録していなかった',
    });
    const legacy = await stores.commitments.get('c-legacy');
    // **既定（'clone' でも 'human' でもない）へ倒れず、そもそも無いままである。**
    expect(legacy?.closedBy).toBeUndefined();

    await stores.commitments.open(commitment('c-new', '2026-08-13T00:00:00.000Z', '新しい依頼'));
    await stores.commitments.close('c-new', '2026-08-14T00:00:00.000Z', '片付けた', 'human');
    const fresh = await stores.commitments.get('c-new');
    expect(fresh?.closedBy).toBe('human');

    // 導入前の行は close() を経由していないので、closedBy はやはり無いまま。
    const stillLegacy = await stores.commitments.get('c-legacy');
    expect(stillLegacy?.closedBy).toBeUndefined();
  });

  /**
   * fs 版は `#read()` がファイル全体を `fileSchema.parse`（＝
   * `commitmentSchema` を要素に持つ配列）へ通す。`closedBy` が厳密な
   * enum だったら、未知の値を持つ行が1つでも在ると `#read()` 自体が
   * 例外を投げ、**その行だけでなく台帳全体が読めなくなる。** pg 版の
   * `index.test.ts` に同じ名前のテストがあり、そちらが本体（`packages/core/
   * src/schema.ts` の doc に理由がある）。fs / pg で能力差を作らないため、
   * ここでも同じ性質を問う。
   *
   * **追記（issue #296）: 上の段落はもう現物と合っていない。** `#read()` は
   * いまファイル全体を `commitmentSchema` の配列として一括 parse せず、
   * `rawFileSchema`（要素は `z.unknown()`）で読んでから行ごとに
   * `commitmentSchema.safeParse` する（`splitFileRows`）。だから未知の値を
   * 持つ行は「台帳全体」ではなく「その行」だけが読めなくなり、`entries` /
   * `unreadable` へ分かれる。この段落は直した経緯として残す
   * （AGENTS.md「元のコメントを消さず経緯を追記する」）。
   *
   * **なぜ `open()` を使わないのか。** この器が書く値は 'clone' | 'human'
   * の2つに限られる（`CommitmentStore.close` の `by` 引数の型で縛って
   * ある）ので、`open()`（`commitmentSchema.parse` を通す）経由では
   * `closedBy` が未知の値を持つ行をそもそも作れない。**測りたい場面は
   * 「新しい版のデーモンが書いた行を、古い版が読む」であり、そのとき行は
   * 既に保存層（ファイル）に在って `open()` は通っていない。** `open()`
   * 経由で作ると、厳密な enum へ戻す変異を当てたとき `open()`（setup）が
   * 先に落ち、`list()` が丸ごと読めなくなるという当の害が一度も再現され
   * ないままテストが赤くなる（変異には反応するが症状を伝えない）。だから
   * 行の作成は `commitments.json` へ直接 `writeFile` し、スキーマ検証
   * （`#read()` の `fileSchema.parse`）を経由しない。
   */
  it('未知の closedBy を持つ行があっても list() は落ちない（closedBy は台帳の完全性を担わない）', async () => {
    // スキーマ検証を経由せず、台帳ファイルへ直接書く（上の doc を見よ）。
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
            // 実際にこの器が書く値は 'clone' | 'human' の2つに限られる。
            // 'manager' は、将来書き手が増えた場合や外部から直接書かれた
            // 場合を模すためのものであって、この器自身がこの値を書くわけ
            // ではない。
            closedBy: 'manager',
          },
        ],
      }),
      'utf8',
    );

    // list() が例外を投げず、他の行も含めて読める。
    // **`list()` は `{ entries, unreadable }` を返すようになった（issue #296）ので、
    // 配列 matcher の `.resolves.toHaveLength` はもう使えない。** 直接 await して
    // `.entries` を確かめる形でも、同じ意図（厳密な enum へ戻す変異を当てると
    // `list()` 自身が例外を投げ、この await がそのまま失敗する）は保たれる。
    const listed = await stores.commitments.list({ includeClosed: true });
    expect(listed.entries).toHaveLength(1);
    // この行は既知の欄（closedBy）の話であって、行そのものは読める。
    // `unreadable` へは回らない。
    expect(listed.unreadable).toEqual([]);

    const all = listed.entries;
    expect(all[0]?.closedBy).toBe('manager');

    const single = await stores.commitments.get('c-unknown-closedby');
    expect(single?.closedBy).toBe('manager');
  });

  /**
   * **これが issue #296 の本体である（pg 版 `index.test.ts` の同名テストの対）。**
   * `closedBy` は由来の注記に過ぎず意図的に緩く持つ欄だが（直上のテスト）、
   * `origin`（`commitmentOriginSchema`。`z.enum(['human', 'manager', 'external',
   * 'self'])`）は厳密な enum のまま——直さなければ、未知の値を持つ1行が
   * `#read()`（＝ファイル全体の parse）を丸ごと落としていた。
   */
  it('未知の origin を1行混ぜても list() は落ちず、健全な行は全部返る（未知の1行は unreadable へ、id 付きで）', async () => {
    await stores.commitments.open(commitment('c-ok-1', '2026-08-10T00:00:00.000Z', '健全な行1'));
    await stores.commitments.open(commitment('c-ok-2', '2026-08-11T00:00:00.000Z', '健全な行2'));

    // 健全な行と並べて、未知の origin を持つ壊れた行を直接書き込む
    // （open() 経由では commitmentSchema.parse を通るので作れない。上の doc）。
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
            // **`commitmentOriginSchema` に無い値。**
            origin: 'future-origin',
            body: '未知の origin を持つ行',
          },
        ],
      }),
      'utf8',
    );

    // 0. **一覧そのものが落ちない。** ここを素の `await` だけで済ませると、
    //    行ごとの `safeParse` をやめる変異が**例外**でテストを殺す —— 例外は
    //    測っている性質を名指ししない。`.resolves` なら「reject した」という
    //    assertion として落ちる（issue #296）。
    await expect(stores.commitments.list()).resolves.toBeDefined();

    // 1. **健全な行は全部返る。** id を名指しして検査する。
    const listed = await stores.commitments.list();
    expect(listed.entries.map((entry) => entry.id)).toEqual(['c-ok-1', 'c-ok-2']);

    // 2. **未知の1行は `unreadable` に、id 付きで現れる（黙って消えていない）。**
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]?.id).toBe('c-unknown-origin');
    expect(listed.unreadable[0]?.at).toBe('2026-08-12T00:00:00.000Z');
    // reason に本文（body）が混ざっていないこと（dropped-record.ts と同じ制約）。
    expect(listed.unreadable[0]?.reason).not.toContain('未知の origin を持つ行');

    // 3. **`get()` はその id で throw する（「無い」と「読めない」の区別が消えていない）。**
    await expect(stores.commitments.get('c-unknown-origin')).rejects.toThrow(/読めない形/);
  });

  /**
   * **これが一番大事な歯である（issue #296、SPEC 4節）。** fs 版は
   * read-modify-write のたびにファイル全体を書き直す器なので、読めない行の
   * 生の値（`UnreadableRow.value`）を持ち回って書き戻さないと、`open()` /
   * `close()` が1回走っただけで読めない行が**ディスクから永久に消える**
   * ——これはこの issue が防ごうとしているもの（1行読めないだけで一覧が
   * 丸ごと落ちる）より重い事故である。
   *
   * ファイルを読み直して生の値が同一であることまで検査する
   * （`entries` / `unreadable` に分けて返す都合上、一覧の返り値だけを見ても
   * 書き戻しで消えていないことは確認できない——ディスク上の実体を見る）。
   */
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

    // 直後の list() で unreadable に現れることをまず確かめる（前提条件）。
    const before = await stores.commitments.list();
    expect(before.unreadable).toHaveLength(1);
    expect(before.unreadable[0]?.id).toBe('c-broken');

    // open() を1回走らせる（読めない行とは別の id）。
    await stores.commitments.open(commitment('c-new', '2026-08-13T00:00:00.000Z', '新しい依頼'));
    // close() も1回走らせる。
    await stores.commitments.close('c-new', '2026-08-14T00:00:00.000Z', '片付けた', 'clone');

    // **ファイルを読み直して、壊れた行の生の値が一切変わっていないことを見る。**
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { commitments: unknown[] };
    expect(onDisk.commitments).toContainEqual(brokenRow);

    // list() から見ても、読めない行は変わらず unreadable に残っている。
    const after = await stores.commitments.list({ includeClosed: true });
    expect(after.unreadable).toHaveLength(1);
    expect(after.unreadable[0]?.id).toBe('c-broken');
    // 健全な行（新規 open→close）も普通に読める。
    expect(after.entries.map((entry) => entry.id)).toContain('c-new');
  });

  it('同じ id で二度 open しても上書きされない（1回目の本文が残る）', async () => {
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', '最初の依頼')),
    ).toBe(true);

    // 受信箱の合図は配り直されうるので、同じ id の自動 open は普通に二度来る
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-14T00:00:00.000Z', '別の本文')),
    ).toBe(false);

    const entry = await stores.commitments.get('c-1');
    expect(entry?.body).toBe('最初の依頼');
    expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
    expect((await stores.commitments.list()).entries).toHaveLength(1);
  });

  it('閉じた id を open し直しても開き直らない（片付いた仕事が蘇らない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));
    await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した', 'clone');

    // 器が落ちて合図が配り直された、を模す
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す')),
    ).toBe(false);

    expect(await stores.commitments.list()).toEqual({ entries: [], unreadable: [] });
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

    // 二度目は記録も動かさない（最初に片付けた事実を書き換えない）
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

  /**
   * **この1件だけ待ち時間を明示する。既定の 5000ms は、器の混み具合で緑と赤が
   * 入れ替わる位置に在る。**
   *
   * このテストは `2 * (CLOSED_HISTORY_LIMIT + overflow)` = 1010 回、台帳を丸ごと
   * 書き直す（`FsCommitmentStore` は open / close のたびに JSON 全体を tmp へ書いて
   * rename する器で、`commitments.ts` の上限そのものが**その費用を有限に保つため**に
   * 在る）。所要は中身ではなく runner の I/O の混み方に比例するので、**同じ中身でも
   * 実行ごとに動く。**
   *
   * 実測（GitHub Actions の ubuntu-latest / `pnpm test` 全走。所要は vitest の
   * reporter が出した値。2026-08-21T21:17Z 観測）:
   *
   * - 通った実行 21 件のこの1件の所要 — 最小 1640ms / 中央 2287ms / **最大 4549ms**
   *   （5000ms まで残り 451ms ＝ 9%）
   * - 5000ms で落ちた実行は5件あり、**PR 側でも main 側でも起きている**（PR:
   *   32301918091 / 32351219785 / 32502342406、main: 32506180682 / 32526916554）。
   *   `pnpm test` へ到達した 24 件のうち3件が落ちた日もある（12.5%）
   *
   * **落ちた実行と通った実行で、このテストも `commitments.ts` も1文字も違わない。**
   * だから「どの commit で落ちたか」からは何も読めない。実際に PR #150 は自分の PR
   * 実行（32526353590。この1件は 2313ms）で通ったあと、**同じ内容の** main の実行
   * （32526916554）で落ちている。
   *
   * **`vitest.config.ts` の `testTimeout` を上げないこと。** 上げれば他の 1488 件が
   * 「帰ってこない」を検出する力まで一緒に落ちる。60_000 は上の最大値の 13 倍で、
   * `CLOSED_HISTORY_LIMIT` を増やさない限り混み方では届かない（増やすときは、
   * ここも一緒に見直す）。
   *
   * **アサーションは1つも変えていない。** 変えたのは待つ長さだけで、保証している
   * ことは前と同じである — 未了は1件も切らない / 閉じた行は上限で切られる /
   * 落ちるのは古く片付いたものから。
   */
  it('閉じた行は上限で切られるが、未了は件数によらず1件も落ちない', async () => {
    const overflow = 5;
    // 未了を先に置く（切り詰めの対象にならないことを、閉じた行が上限を超えた後で見る）
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
      // closedAt が切り詰めの並び順を決める（古く片付いたものから落ちる）
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

    // 未了は1件も切らない（切ったらこの器の目的そのものが消える）
    expect(open.map((entry) => entry.id)).toEqual(['open-0', 'open-1', 'open-2']);
    expect(closed).toHaveLength(CLOSED_HISTORY_LIMIT);
    // 落ちるのは古く片付いたものから。新しい側は残る
    expect(closed.at(0)?.id).toBe(
      `closed-${String(CLOSED_HISTORY_LIMIT + overflow - 1).padStart(4, '0')}`,
    );
    expect(closed.at(-1)?.id).toBe(`closed-${String(overflow).padStart(4, '0')}`);
    expect(await stores.commitments.get('closed-0000')).toBeNull();
  }, 60_000);
});

/**
 * まだ処理し終えていない受信箱の合図（デーモンが死んでも消えないこと）。
 *
 * fs / pg で同じ振る舞いになることを両方で問う（`store.ts`「省略可能にしないこと」）。
 */
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

    // 同じ id で置き直す（例えばデーモン再起動直後にもう一度届いた、を模す）
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '直した本文'),
      '2026-08-10T00:00:00.000Z',
    );
    const pending = await stores.inbox.claimPending();

    expect(pending[0]?.deliveries).toBe(2);
    expect((pending[0]?.event as { text: string }).text).toBe('直した本文');
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
});

describe('FsTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = await stores.archive.archive('session-1', '{"a":1}\n');

    expect(await stores.archive.list()).toContain(id);
    expect(await stores.archive.read(id)).toBe('{"a":1}\n');
  });

  it('ディレクトリ外は読ませない', async () => {
    expect(await stores.archive.read('../../etc/passwd')).toBeNull();
  });
});

/**
 * 実行環境プロファイル。
 *
 * **`revert` は本文と更新日時を組で戻す。** ここは人間が `profile status` で見る
 * 「最後に本文を変えた時刻」であり、取り消された更新でそこが動くと、成功して
 * いない更新が最後の変更として表示される（デーモンを起こすたびに動いていたのと
 * 同じ意味の壊れ方）。**器が違っても同じ振る舞いになること**を fs / pg の両方で問う。
 */
describe('FsProfileStore', () => {
  it('置いて読める。空文字で外れる', async () => {
    expect(await stores.profile.read()).toBeNull();

    await stores.profile.write('export A=1\n');
    expect((await stores.profile.read())?.script).toBe('export A=1\n');

    await stores.profile.write('');
    expect(await stores.profile.read()).toBeNull();
  });

  it('revert は本文だけでなく更新日時も戻す', async () => {
    await stores.profile.write('export WHICH=old\n');
    const before = await stores.profile.read();

    // 時刻が確実に進むまで待ってから、失敗する更新を模す。
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stores.profile.write('export WHICH=new\n');
    expect((await stores.profile.read())?.updatedAt).not.toBe(before?.updatedAt);

    await stores.profile.revert(before);

    // **まるごと一致すること。** 本文だけ戻して時刻が進むと監査情報が嘘になる。
    expect(await stores.profile.read()).toEqual(before);
  });

  it('置かれていなかった状態へも戻せる', async () => {
    await stores.profile.write('export WHICH=new\n');
    await stores.profile.revert(null);
    expect(await stores.profile.read()).toBeNull();
  });
});

describe('FsSessionRegistry', () => {
  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });
});

/**
 * ログインとアクセス許可。**fs と pg で同じ振る舞いになること**を両方で問う
 * （器が違うだけで上の層が見るものは同じ、が M4 の要件）。
 */
describe('AuthStore', () => {
  const account = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
  };

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
    // 上書きであって増殖ではない
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
    // 保存されたトークンも1本だけ（応答が1件でも器に2本あれば通ってしまう）。
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
    // 一度 consumed になったら、あとから何度呼んでも取れない。
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
  it('別々のアカウントへ同時に grant しても、持ち主は1人しかできない', async () => {
    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantExclusive('account-1', at, 'operator'),
      stores.auth.grantExclusive('account-2', at, 'operator'),
    ]);

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(1);
    // 器に2人残っていたら、応答が1件でも両方が通ってしまう。
    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(1);
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

    // 直れば、同じ要求をそのまま引き取れる。
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
    // 一度 processing になったら、あとから何度呼んでも取れない。
    expect(await stores.auth.beginLoginExchange('login-5')).toBeNull();
    expect(await stores.auth.beginLoginExchange('居ない')).toBeNull();
  });
});

/** 引き取れないはずの経路で呼ばれたら、テストとして落とす。 */
function neverIssued(): never {
  throw new Error('引き取れないはずの要求でトークンを作ろうとした');
}
