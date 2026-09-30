import { renderMemoryDocuments } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { memory } from './schema.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * pg ドライバの受け入れ確認。
 *
 * **偽物の DB では確かめたことにならない。** PGlite はインプロセスで動く実
 * PostgreSQL なので、SQL・索引・冪等性まで本番と同じ経路で通る（CI に外部 DB を
 * 要求せずに済む）。fs ドライバのテストと同じ振る舞いを、同じ IF に対して問う。
 *
 * **このファイルは `index.test.ts` から移した（分割元は git blame で辿れる）。**
 * 元の1本（5588行・262テスト）は単独で走らせると 564.75s かかり、作業者の
 * Bash の既定タイムアウト（300s）に収まらなかった（2026-09-29 実測、
 * `.claude/skills/test-in-chunks/SKILL.md`）。`vitest --shard` はファイル数で
 * 等分するので、1本のままでは分割にならない——だから最上位の `describe`
 * 単位でファイルを分けた。ここは `PgPersonaStore`（記憶ファイルの派生値、
 * `protectionStatus` / `createdAt` / `describedAt` / `describedBytes` を含む）
 * だけを持つ。**`describe` / `it` の本文・順序は1文字も変えていない**——
 * 元ファイルの対応する範囲とこのファイルを突き合わせれば同一であることが
 * 確認できる。冒頭の足場（`beforeEach` で PGlite を都度立てて `migrate` する
 * 形、`afterEach` で閉じる形）も元ファイルと同じものを複製している（分岐は
 * 生まない——共有モジュールへ切り出すほどの複雑さが無かったため、各ファイルへ
 * 同じ短い足場を複製する側を選んだ）。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('PgPersonaStore', () => {
  it('書いて読める（記憶は Markdown のまま）', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
    expect(doc?.bytes).toBeGreaterThan(0);
  });

  it('外から書き換えられた記憶が次の読み出しに反映される（受け入れ基準3）', async () => {
    const BEFORE_CONTENT = '# 価値観\n\nもとの内容\n';
    await stores.persona.write('values', BEFORE_CONTENT);

    // CLI / HTTP API 経由で人間が書き換える、を模す（キャッシュしていれば落ちる）
    await stores.persona.write('values', '# 価値観\n\n人間が書き換えた\n');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    // クローンの文脈へ載る形（documents → renderMemoryDocuments）にも反映されること。
    // かつては concat() がこの連結まで持っていたが、載せ方は core へ移った。
    //
    // **⚠️ かつてここは本文（`人間が書き換えた`）が焼き込みに出ることを測っていた。**
    // premise の載り方が全文からカード（要旨＋節の目次）へ変わったので（人間の決定
    // 2026-09-08。`memory.ts` の `renderPremiseCard`）、本文はもうどの経路にも載らない。
    //
    // **受け入れ基準3（外の書き換えが次の読み出しに反映される）は1ミリも弱まって
    // いない。** 節id は `<見出しの8桁>-<sha256(見出し行＋中身)の先頭8桁>` なので
    // （`memorySectionId`）、**本文を1文字直せばカードの行が変わる** —— 書き換え前後の
    // カードを実際に突き合わせ、**変わったこと**と、変わったのが節id の側であることを
    // 測る。**「載っているか」ではなく「反映されるか」を直接見る形になったので、
    // むしろ強くなっている**（旧い歯は、キャッシュが効いていても本文がたまたま
    // 一致すれば通りえた）。
    const cardBefore = renderMemoryDocuments([{ slug: 'values', content: BEFORE_CONTENT }]);
    const cardAfter = renderMemoryDocuments(await stores.persona.documents());
    expect(cardAfter).not.toBe(cardBefore);
    expect(cardAfter).toContain('# 価値観');
    // 本文は載らない（カードにしたことの本体）。
    expect(cardAfter).not.toContain('人間が書き換えた');
    expect(cardAfter).not.toContain('もとの内容');
  });

  /**
   * `PersonaStore.write` の契約（`packages/core/src/store.ts`）を pg 側で測る。
   *
   * **同じ形の歯が3つ在る**（#370。1つで測って3つとも測ったことにしない）:
   * fs（`packages/storage-fs/src/index.test.ts`）/ pg（ここ）/ インメモリ
   * （`packages/core/src/persona-contract.test.ts`）。
   */
  it('write した本文は、末尾の改行が正規化されて読み戻る', async () => {
    // 末尾に改行を持たない形で渡す（呼び手の側では正規化しない）。
    const written = await stores.persona.write('values', '# 価値観');

    expect(written.content).toBe('# 価値観\n');
    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n');
  });

  it('append は末尾に足す（fs 版と同じ形）', async () => {
    await stores.persona.write('log', '# ログ\n');
    await stores.persona.append('log', '- 追記された学び\n');

    expect((await stores.persona.read('log'))?.content).toBe('# ログ\n\n- 追記された学び\n');
  });

  /**
   * fs 版と同じ性質を pg 側でも測る（#354）。`memory_append` の説明文
   * （`packages/core/src/tools.ts`）が言い切っている「消えた見出しは常に
   * 0 件のはずである」は、**追記が `before` を行の境界を保ったまま前置き
   * すること**にしか依っていない。
   *
   * **pg もこれを二重に守っている**（`persona.ts`）: `write` / `append` の
   * どちらも本文を `ensureTrailingNewline` に通してから保存することと、
   * `append` の SQL が `right(content, 1) = E'\n'` で場合分けすること。
   * **片方だけ外してもこの歯は落ちない**——落ちないことは「守られていない」
   * ではなく、もう片方が効いているという意味である（#354 の変異試験で実測
   * した。単独で殺すには、既存の改行を落としたうえで連結する必要がある）。
   */
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

  it('存在しない記憶は null / 経路をまたぐスラッグは拒む', async () => {
    expect(await stores.persona.read('nope')).toBeNull();
    await expect(stores.persona.write('../escape', 'x')).rejects.toThrow(/スラッグ/);
  });

  it('documents は全文書を本文つき・slug 昇順で返す（fs 版と同じ形）', async () => {
    // 書いた順を slug の昇順とわざと逆にする。挿入順（＝物理的な行順）で
    // 通ってしまわないため。
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

  it('消せる', async () => {
    await stores.persona.write('tmp', '# 一時\n');
    await stores.persona.remove('tmp');

    expect(await stores.persona.read('tmp')).toBeNull();
  });

  /**
   * 保護状態（human guard）の派生値。実体は日誌にあり、ここは pg 側の置き場
   * （`memory` テーブルの2列）が正しく振る舞うかを確かめる。「断ることを測る」歯
   * そのもの（distill が断られる／通る）は `packages/core` の `tools.test.ts` が
   * 持つ——ここは `PersonaStore` が返す `protectionStatus` の正しさだけを見る。
   */
  describe('protectionStatus（保護状態の派生値）', () => {
    it('行そのものが無ければ unknown（守る側の既定）', async () => {
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

    /**
     * 歯7の対照（変異試験で見つかった穴を塞ぐ）。
     *
     * **`write()` だけの文書が `clone-only` になる、という上のテストだけでは、
     * `write()` 内の `#updateHash` 呼び出しをまるごと削っても落ちない。**
     * `content_sha256` は insert 時に設定されないので、削ると null のままになり、
     * 次の `protectionStatus` 呼び出しが「行単位の自己修復」（`#healRow`）を
     * 誘発して現在の本文からその場でハッシュを基準化してしまう
     * （実際に変異試験でこれを確認した——`write()` の `#updateHash` 呼び出しを
     * 消しても、上の84件は1件も落ちなかった）。
     *
     * ここでは、いったん `protectionStatus` を呼んで `content_sha256` を
     * 非 null に確定させてから2回目の `write()` を行う。既に非 null なら
     * `#healRow` は誘発されないので、`write()` 自身が更新していない限り
     * 古いハッシュが残り、2回目の本文と食い違って unknown に落ちる。
     */
    it('索引（content_sha256）が確定した後の write でも、ハッシュ更新は heal に頼らない', async () => {
      await stores.persona.write('values', '# 版1\n');
      // ここで一度確定させる（content_sha256 を非 null にする）。
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      await stores.persona.write('values', '# 版2\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
    });

    // 歯7: write() と append() は独立した2メソッドなので、append 経路でも
    // content_sha256 が更新されることを個別に確かめる（片方だけ直す穴を塞ぐ）。
    it('append 経路でもハッシュが更新される（誤検出しない）', async () => {
      await stores.persona.write('log', '# ログ\n');
      await stores.persona.append('log', '- 追記');

      expect(await stores.persona.protectionStatus('log')).toEqual({ kind: 'clone-only' });
    });

    // 歯6: 道具経由の書き込み直後は unknown にならない（誤検出しない）。
    // 歯5（次のテスト）とは別の it() で測る。
    it('道具経由（write）の直後は unknown にならない', async () => {
      await stores.persona.write('values', '# 価値観\n\n本文\n');

      const status = await stores.persona.protectionStatus('values');

      expect(status).not.toEqual({ kind: 'unknown' });
      expect(status).toEqual({ kind: 'clone-only' });
    });

    /**
     * 歯5:「導出値と外部編集検出はセット」であること（pg 版）。
     *
     * `PersonaStore` は本文をキャッシュしない（受け入れ基準3）。**保護状態だけが
     * 古いまま返ると、本文と保護状態の足並みが揃わない**——それが設計上の欠陥
     * として指摘された点である。pg には mtime 相当が無いので、store を経由しない
     * 直接 UPDATE（`psql` 相当）で外部編集を模す。
     */
    it('外部から本文が変わったとき、保護状態が古いまま返らない（unknown になる）', async () => {
      await stores.persona.write('values', '# 価値観\n\nもとの内容\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      await db.execute(
        sql`update memory set content = '# 価値観\n\n外から書き換えた\n' where slug = 'values'`,
      );

      // 本文はキャッシュされていないので新しい値が読める——その同じ読み出しの
      // 上で、保護状態も古いまま（clone-only）返らないことを確かめる。
      expect((await stores.persona.read('values'))?.content).toContain('外から書き換えた');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'unknown' });
    });

    it('human 印は外部編集があっても降りない（human が unknown より優先）', async () => {
      await stores.persona.write('values', '# 価値観\n\n人間が書いた\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      await db.execute(
        sql`update memory set content = '# 価値観\n\n外から書き換えた\n' where slug = 'values'`,
      );

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('markHumanTouched は降ろさない（古い時刻を渡しても human のまま）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', '2026-01-02T00:00:00.000Z');
      await stores.persona.markHumanTouched('values', '2020-01-01T00:00:00.000Z');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('remove() で保護状態も一緒に消える（実体の無い印を残さない）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      await stores.persona.remove('values');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'unknown' });
    });

    it('markHumanTouched は削除済みの slug に行を作らない（空文字の「文書」を生まない）', async () => {
      await stores.persona.markHumanTouched('ghost', new Date().toISOString());

      expect(await stores.persona.read('ghost')).toBeNull();
      expect(await stores.persona.protectionStatus('ghost')).toEqual({ kind: 'unknown' });
    });
  });

  /**
   * `createdAt`（`created_at` 列。記憶の絶対条件）。
   *
   * **この配線（記憶の `createdAt` 対応）より前は、列の値は `markCreatedAt`
   * からしか動かなかった**——journal からの導出は `apps/daemon/src/storage.ts`
   * の起動時 backfill の仕事で、ここは `PersonaStore` 単体の振る舞いだけを
   * 見ていた。**いまは違う。** `write()` / `append()` 自身が、insert（＝新規
   * 作成）のときだけ `created_at` を入れる（`onConflictDoUpdate` の `set` には
   * 含めないので、更新では既存の値が保たれる）。`markCreatedAt` はこの配線
   * より前に作られた行を埋める後始末に降格しており、**このファイルの下の
   * ほうのテスト（`markCreatedAt` 単体の振る舞い）は、write() が既に
   * `created_at` を入れてしまわないよう、書いた直後に生 SQL で列を null に
   * 戻して backfill 前の昔の行を模す**（`db.execute(sql\`update memory set
   * created_at = null ...\`)`、上の protectionStatus の外部編集テストと
   * 同じ「store を経由しない直接 UPDATE」の手口）。fs 版と同じ契約を、
   * pg（PGlite）に対しても確かめる。
   */
  describe('createdAt（作成時刻の派生値）', () => {
    it('write() は新規作成のとき、backfill を通さずその場で created_at を known にする（updatedAt と一致）', async () => {
      // **この it() はこの PR で反転した。** 以前はここで「markCreatedAt を
      // 呼んでいなければ unknown（mtime を使わない——pg にそもそも mtime は
      // 無い）」を確かめていた——write() は created_at に一切触れず、
      // backfill だけが埋める、という旧仕様の裏返しである。**いまは write()
      // 自身が insert のときだけ created_at を入れるので、新規作成した文書は
      // markCreatedAt を待たずその場で known になる。**
      const doc = await stores.persona.write('values', '# 価値観\n');

      const read = await stores.persona.read('values');

      expect(read?.createdAt).toEqual({ kind: 'known', at: doc.updatedAt });
      expect(read?.createdAt).toEqual({ kind: 'known', at: read?.updatedAt });
    });

    it('既存の文書を更新しても created_at は変わらない（updatedAt は進む）', async () => {
      const first = await stores.persona.write('values', '# 価値観\n');
      // 同一ミリ秒で2回書くと updatedAt が区別できないことがあるので、
      // 確実に時刻を進める（fs 版と同じ手口）。
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await stores.persona.write('values', '# 価値観\n\n書き直した\n');

      expect(second.createdAt).toEqual(first.createdAt);
      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect((await stores.persona.read('values'))?.createdAt).toEqual(first.createdAt);
    });

    it('append() が文書を新規作成したときも created_at が付く', async () => {
      const doc = await stores.persona.append('notes', '最初のメモ');

      expect(doc.createdAt).toEqual({ kind: 'known', at: doc.updatedAt });
      expect((await stores.persona.read('notes'))?.createdAt).toEqual(doc.createdAt);
    });

    it('append() が既存の文書へ追記したときは created_at が変わらない', async () => {
      const first = await stores.persona.write('notes', '# ノート\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await stores.persona.append('notes', '追記した行');

      expect(second.createdAt).toEqual(first.createdAt);
      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect((await stores.persona.read('notes'))?.createdAt).toEqual(first.createdAt);
    });

    it('削除して同じ slug を作り直すと、新しい created_at になる', async () => {
      const first = await stores.persona.write('values', '# 価値観\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      await stores.persona.remove('values');
      const second = await stores.persona.write('values', '# 価値観\n\n書き直した\n');

      expect(second.createdAt.kind).toBe('known');
      expect(second.createdAt).not.toEqual(first.createdAt);
      expect((await stores.persona.read('values'))?.createdAt).toEqual(second.createdAt);
    });

    it('markCreatedAt を呼んだ文書は known になる（read() にも list() にも出る）', async () => {
      // write() ではなく、created_at を null に戻した行として用意する。
      // write() 自身が新規作成時に created_at を入れるようになったため、
      // そのままだと markCreatedAt を待たずに既に known になってしまい、
      // ここで確かめたい「markCreatedAt 単体の効果」が隠れる。
      await stores.persona.write('values', '# 価値観\n');
      await db.execute(sql`update memory set created_at = null where slug = 'values'`);

      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
      const meta = (await stores.persona.list()).find((entry) => entry.slug === 'values');
      expect(meta?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });

    it('markCreatedAt は一度きりの確定——2回目は無視される（冪等・絶対条件2）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await db.execute(sql`update memory set created_at = null where slug = 'values'`);

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
      await stores.persona.write('values', '# 価値観\n');
      await db.execute(sql`update memory set created_at = null where slug = 'values'`);

      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');
      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
    });

    it('markCreatedAt は削除済みの slug に行を作らない（空文字の「文書」を生まない）', async () => {
      const wrote = await stores.persona.markCreatedAt('ghost', new Date().toISOString());

      expect(wrote).toBe(false);
      expect(await stores.persona.read('ghost')).toBeNull();
    });

    /**
     * **絶対条件5「バックフィルは created_at を埋める以外のことを一切しない」**
     * を `markCreatedAt` 単体で確かめる——本文・`updatedAt`・保護状態
     * （`humanTouchedAt` 由来）・`description` を走行前後で突き合わせる。
     */
    it('markCreatedAt は createdAt 以外を1つも書き換えない', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'),
      );
      // write() が入れた created_at を null に戻し、markCreatedAt 単体の
      // 効果を確かめられる状態にする（上のテストと同じ理由）。
      await db.execute(sql`update memory set created_at = null where slug = 'runbook'`);
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

    /**
     * 上のテストは先に `markHumanTouched` を呼ぶ。そのせいで `protectionStatus`
     * は `humanTouchedAt` の分岐で即 `{ kind: 'human' }` を返し、`contentSha256`
     * を一度も見ない。しかも `description` を突き合わせているだけで
     * `descriptionFreshness`（`describedAt` 由来）は一度も比べていない——
     * `described_at` を巻き添えで消す変異（`.set({ createdAt: when })` →
     * `.set({ createdAt: when, describedAt: null })`）を当てても、上のテストは
     * 赤くならない（変異試験で確認済み。fs 版の同じ構造の穴と対になる）。
     *
     * ここでは `markHumanTouched` を呼ばずに `protectionStatus` を
     * `contentSha256` の比較まで通し、かつ `descriptionFreshness` も
     * 突き合わせる。**ただし `content_sha256` の巻き添え消失は、`protectionStatus`
     * を計器にしている限りこの歯でも捕まえられない**——`protectionStatus` は
     * `content_sha256 IS NULL` の行を読むと `#healRow` でその場から本文の
     * ハッシュを組み直してしまう（fs の `.index.json` 全体の組み直しとは違い、
     * pg は行単位の自己修復を持つ）。実測（`.set({ createdAt: when,
     * contentSha256: null })` を当てて確認）: `protectionStatus` が読み出しの
     * その場で `content_sha256` を再計算して埋め直すため、この歯を含む130本
     * すべて緑のまま通過する——`markCreatedAt` 単体の変異ではなく `#healRow`
     * が隠している。**`describedAt` には同じ自己修復が無い**ので、そちら側は
     * この歯（`protectionStatus` 経由）でも観測できる。
     *
     * **`content_sha256` 自体は別の計器（`content_sha256` 列の直接読み出し）
     * で観測できる**——下の別の `it()` を見ること。`protectionStatus` を
     * 経由しない限り `#healRow` は挟まらない。
     */
    it('markCreatedAt は human 印を経由しない場合でも created_at 以外を書き換えない（describedAt 側）', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'),
      );
      await db.execute(sql`update memory set created_at = null where slug = 'runbook'`);

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

    /**
     * `content_sha256` は `protectionStatus` を計器にしている限り観測できない
     * ——`content_sha256 IS NULL` の行を読むと `#healRow` がその場で本文から
     * ハッシュを組み直してしまう（pg 特有の行単位の自己修復。上のテストの
     * doc コメントにも書いた）。**しかし計器は `protectionStatus` だけでは
     * ない。** `content_sha256` は `memory` テーブルの列そのものなので、
     * `#healRow` を経由せずに列を直接読める——それだけで自己修復を回避できる。
     *
     * **順序が要る。** `before` を取るのは `write()` 直後（`content_sha256`
     * は `write()` 自身が埋めるので、ここではまだ何も治す必要が無い）。
     * `after` は `markCreatedAt` の直後、`protectionStatus` を一度も呼ばずに
     * 直接列を読む——`read()` は `human_touched_at` / `content_sha256` に
     * 触れないので、間に挟んでも安全（`persona.ts` の `read()` 参照）。
     *
     * **⚠️ この順序は読みやすさの問題ではない。歯の成立条件そのものである。**
     * 実測（2026-08-23）: 下の `markCreatedAt` と `afterRows` の `select` の
     * **間**へ `await stores.persona.protectionStatus('runbook');` を1行だけ
     * 挟み、`.set({ createdAt: when })` →
     * `.set({ createdAt: when, contentSha256: null })` の変異を当てたところ、
     * **この歯を含む pg の 131 本すべてが緑のまま通った**（全体走行でも
     * `Test Files 121 passed (121)` / `Tests 2205 passed (2205)`）。
     * `#healRow` が `select` より先に列を埋め直してしまうためである。
     *
     * **だから `protectionStatus()` をこの `it()` の中へ持ち込まないこと。**
     * 「上の2本と揃えて `afterProtection` も見よう」も「呼びをまとめて
     * 読みやすくしよう」も、この歯を**黙って**殺す——殺した側へ倒れると
     * 変異が生存する、つまりテストは緑のままなので、出力には何も現れない。
     */
    it('markCreatedAt は content_sha256 の列を直接読んでも書き換えない（healRow を経由しない計器）', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'),
      );
      await db.execute(sql`update memory set created_at = null where slug = 'runbook'`);

      const beforeRows = await db
        .select({ contentSha256: memory.contentSha256 })
        .from(memory)
        .where(eq(memory.slug, 'runbook'));
      const beforeSha256 = beforeRows[0]?.contentSha256;
      expect(beforeSha256).not.toBeNull();

      const wrote = await stores.persona.markCreatedAt('runbook', '2026-01-02T03:04:05.000Z');

      // protectionStatus() を一度も呼ばずに列を直接読む——healRow を経由しない。
      // **ここより前に protectionStatus() を差し込まないこと**（上の doc の実測。
      // 差し込むと変異が生存し、この歯は緑のまま何も測らなくなる）。
      const afterRows = await db
        .select({ contentSha256: memory.contentSha256 })
        .from(memory)
        .where(eq(memory.slug, 'runbook'));
      const afterSha256 = afterRows[0]?.contentSha256;

      expect(wrote).toBe(true);
      expect(afterSha256).toBe(beforeSha256);
    });
  });

  /**
   * `describedAt`（`described_at` 列。#170「記憶の目次化」の派生値）。
   * 書き手は書けない——`write()` / `append()` が新旧の `description`
   * （frontmatter）を比べて進めるか据え置くかを決める（4-3）。fs 版と
   * 同じ契約を、pg（PGlite）に対しても確かめる。
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

    it('本文だけを書き直すと stale になる（description は本文の変更に追従しない）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const doc = await stores.persona.read('runbook');
      // **`staleForMs` の厳密な値はここでは固定できない**（実時計に依存する、
      // #821）。`kind` は固定値で確かめ、`staleForMs` は「正の値である」
      // ことだけを確かめる——0 や負の値なら引き算の向きが壊れている。
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
      await new Promise((resolve) => setTimeout(resolve, 5));
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

    it('append でも describedAt が更新される（write と同じ通り道を通る）', async () => {
      await stores.persona.write(
        'log',
        '---\ndescription: 学びの記録\ntype: fact\n---\n# ログ\n最初の行\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.append('log', '追記した行');

      // description は append の対象外（末尾に足すだけ）なので変わらず、
      // updatedAt だけが進む——stale になる。
      const doc = await stores.persona.read('log');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.staleForMs).toBeGreaterThan(0);
      }
    });
  });

  /**
   * #913: `describedBytes`（要旨を立てた時点の本文サイズ）の往復。fs 版と
   * 同じ契約を pg（PGlite）に対しても確かめる。
   */
  describe('describedBytes（本文の変化量の派生値、#913）', () => {
    it('要旨を書いた直後は drift の deltaBytes が厳密に0（describedBytes と bytes の測り方が揃っている）', async () => {
      const written = await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'fresh' });
      // fresh は drift を持たないので、bytes 自体の一致を別途確かめる
      // （`described_bytes` 列と `toDocument` の bytes が同じ測り方である
      // ことの直接証拠）。
      expect(doc?.bytes).toBe(written.bytes);
    });

    it('append の後、describedAt/describedBytes は据え置きで、deltaBytes は追記したバイト数と一致する', async () => {
      const before = await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const appended = '追記した1行';
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
        if (doc.descriptionFreshness.drift.kind === 'measured') {
          expect(doc.descriptionFreshness.drift.deltaBytes).toBeGreaterThanOrEqual(
            Buffer.byteLength(appended, 'utf8'),
          );
        }
      }
    });

    /**
     * この仕組みより前に書かれた記憶（`described_at` はあるが
     * `described_bytes` が NULL の行）は `unrecorded` になる——`0`
     * （変化なし）に化けさせない（#821 条件1と同じ形）。列を直接 NULL に
     * 戻し、その状態を再現する（`created_at` を null に戻す既存の歯と
     * 同じ手法）。
     */
    it('described_at はあるが described_bytes が無い既存の行は unrecorded になり、deltaBytes: 0 にならない', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const before = await stores.persona.read('runbook');
      expect(before?.descriptionFreshness.kind).toBe('stale');
      if (before?.descriptionFreshness.kind === 'stale') {
        expect(before.descriptionFreshness.drift.kind).toBe('measured');
      }

      await db.execute(sql`update memory set described_bytes = null where slug = 'runbook'`);

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.drift).toEqual({ kind: 'unrecorded' });
      }
    });

    /**
     * ⭐⭐ #821 残課題のいちばん重要な歯（pg 側）。「本文だけの書き込み
     * （`append`）で基準点が立つ」——`described_bytes` / `described_bytes_at`
     * を直接 NULL に戻した行へ append を1回当て、`drift` が `unrecorded` から
     * `at-least` へ変わり、**`deltaBytes` がその append のバイト数と一致する**
     * （0 ではない）ことを見る。fs 版と同じ契約を pg（PGlite）に対しても確かめる。
     */
    it('described_bytes が無い既存の行へ append すると、その場で基準点が立ち drift が at-least になる（deltaBytes は0にならない、#821 残課題）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      await db.execute(
        sql`update memory set described_bytes = null, described_bytes_at = null where slug = 'runbook'`,
      );

      const before = await stores.persona.read('runbook');
      expect(before?.descriptionFreshness.kind).toBe('stale');
      if (before?.descriptionFreshness.kind === 'stale') {
        expect(before.descriptionFreshness.drift).toEqual({ kind: 'unrecorded' });
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
      const appended = '基準点を立てるための追記';
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

    /**
     * ⭐ 「弾いていないことを測る歯」（pg 側）。一度立った基準点は、2回目の
     * append で動かない——動けば「直前の1回ぶん」しか測れない道具に戻る
     * （#821 残課題）。
     */
    it('一度立った基準点は、2回目の append で動かない（#821 残課題、pg）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );
      await db.execute(
        sql`update memory set described_bytes = null, described_bytes_at = null where slug = 'runbook'`,
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.append('runbook', '1回目の追記');
      const afterFirst = await stores.persona.read('runbook');
      expect(afterFirst?.descriptionFreshness.kind).toBe('stale');
      if (afterFirst?.descriptionFreshness.kind !== 'stale') throw new Error('unreachable');
      expect(afterFirst.descriptionFreshness.drift.kind).toBe('at-least');
      if (afterFirst.descriptionFreshness.drift.kind !== 'at-least') throw new Error('unreachable');
      const firstBaselineBytes = afterFirst.descriptionFreshness.drift.baselineBytes;
      const firstBaselineAt = afterFirst.descriptionFreshness.drift.baselineAt;

      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.append('runbook', '2回目の追記');
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
