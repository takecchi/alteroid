import { MemoryConflictError, memoryVersion } from './store.js';
import type { PersonaStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg が core を実行時に読むため（`vitest` が core の実行時の依存にならない）。
// どの関数も、渡された器へ自分だけの slug（`persona-contract-<領域>-<n>`）で書く: 空の器を1つ渡せば足り、ケースごとに器を立て直さない。
// 器の裏側を直に書き換える操作（fs の `.index.json`・pg の列）は器ごとに違うので、`*Hooks` で受ける。渡されなければ、それを要するケースは飛ばす（インメモリは裏側を持たない）。

function fail(area: string, message: string): never {
  throw new Error(`PersonaStore の契約違反（${area}）: ${message}`);
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

function expectEqual(area: string, label: string, actual: unknown, expected: unknown): void {
  if (stable(actual) !== stable(expected)) {
    fail(area, `${label}: 期待 ${stable(expected)} / 実際 ${stable(actual)}`);
  }
}

async function conflictOf(run: () => Promise<unknown>): Promise<MemoryConflictError | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof MemoryConflictError) return error;
    throw error;
  }
}

async function rejectedOf(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

// mtime の分解能（fs）や `updatedAt` の同値を避けるため、時刻を確実に進める。
const advanceClock = () => new Promise((resolve) => setTimeout(resolve, 10));

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const versionOf = async (persona: PersonaStore, slug: string): Promise<string> =>
  memoryVersion((await persona.read(slug))?.content ?? '');

const WITH_DESCRIPTION = (body: string, description = '費用の推移') =>
  `---\ndescription: ${description}\ntype: fact\n---\n# 定点観測\n${body}\n`;

/** 書き込みの正規化（末尾の改行・bytes）と追記。 */
export async function verifyPersonaWriteContract(persona: PersonaStore): Promise<void> {
  const area = '書き込みと追記';

  const written = await persona.write('persona-contract-write-1', '# 価値観');
  expectEqual(area, 'write の返り値の末尾の改行', written.content, '# 価値観\n');
  expectEqual(
    area,
    'write の読み戻しの末尾の改行',
    (await persona.read('persona-contract-write-1'))?.content,
    '# 価値観\n',
  );

  const already = await persona.write('persona-contract-write-2', '# 価値観\n');
  expectEqual(area, '既に改行で終わる本文へ改行を足さない', already.content, '# 価値観\n');

  await persona.write('persona-contract-write-3', '# X');
  expectEqual(
    area,
    'bytes は正規化した後の本文を数える',
    (await persona.read('persona-contract-write-3'))?.bytes,
    4,
  );

  await persona.write('persona-contract-write-4', '# ログ\n');
  await persona.append('persona-contract-write-4', '- 追記された学び\n');
  expectEqual(
    area,
    'append は末尾に足す',
    (await persona.read('persona-contract-write-4'))?.content,
    '# ログ\n\n- 追記された学び\n',
  );

  // `append` と `write` が二重に守っているので、片方だけ外してもこのケースは落ちない。
  await persona.write('persona-contract-write-5', '# ログ\n\n## 最後の節');
  const heading = await persona.append('persona-contract-write-5', '追記した1行');
  if (!heading.content.split('\n').includes('## 最後の節')) {
    fail(
      area,
      `末尾が見出しの文書へ追記すると見出しの行が壊れる: ${JSON.stringify(heading.content)}`,
    );
  }
  if (!heading.content.includes('追記した1行')) fail(area, '追記した行が無い');

  await persona.write('persona-contract-write-6', '# ログ');
  const blank = await persona.append('persona-contract-write-6', '- 追記された学び');
  expectEqual(
    area,
    'append は既存の本文との間に空行を1つ挟む（既存が改行で終わっていなくても）',
    blank.content,
    '# ログ\n\n- 追記された学び\n',
  );

  await persona.write('persona-contract-write-7', '# ログ\n');
  await Promise.all([
    persona.append('persona-contract-write-7', '- AAA'),
    persona.append('persona-contract-write-7', '- BBB'),
    persona.append('persona-contract-write-7', '- CCC'),
  ]);
  const concurrent = (await persona.read('persona-contract-write-7'))?.content ?? '';
  for (const mark of ['AAA', 'BBB', 'CCC']) {
    if (!concurrent.includes(mark)) fail(area, `同時の追記が ${mark} を取りこぼした`);
  }
}

/** write / remove の前提の版 `ifMatch`（Issue #2743・#2881）。 */
export async function verifyPersonaIfMatchContract(persona: PersonaStore): Promise<void> {
  const area = 'ifMatch';

  // write: 読んだ版と同じなら書ける。違えば書かずに MemoryConflictError（current は書かれている文書）
  {
    const slug = 'persona-contract-if-match-w1';
    await persona.write(slug, '# 価値観\n\nV1\n');
    const v1 = await versionOf(persona, slug);
    await persona.write(slug, '# 価値観\n\nV1\n\nクローンの判断\n');
    const error = await conflictOf(() =>
      persona.write(slug, '# 価値観\n\n人間の編集\n', { ifMatch: v1 }),
    );
    if (error === null) fail(area, '古い版を前提にした write が断られない');
    if (!error.current?.content.includes('クローンの判断')) {
      fail(area, 'write の衝突の current が、書かれている文書ではない');
    }
    if (!(await persona.read(slug))?.content.includes('クローンの判断')) {
      fail(area, '衝突したのに本文が書き換わった');
    }
    const ok = await persona.write(slug, '# 価値観\n\n人間の編集\n', {
      ifMatch: await versionOf(persona, slug),
    });
    expectEqual(
      area,
      'いまの版を前提にした write の返り値',
      ok.content,
      '# 価値観\n\n人間の編集\n',
    );
  }

  // write: null は「無かった」。無ければ作れ、在れば書かない
  {
    const slug = 'persona-contract-if-match-w2';
    await persona.write(slug, '# A\n', { ifMatch: null });
    if ((await conflictOf(() => persona.write(slug, '# B\n', { ifMatch: null }))) === null) {
      fail(area, 'ifMatch: null が、在る文書への write を断らない');
    }
    expectEqual(area, 'null 前提の衝突後の本文', (await persona.read(slug))?.content, '# A\n');
  }

  // write: 文書が無いのに版を指定したら衝突（current は null）。書かれない
  {
    const slug = 'persona-contract-if-match-w3';
    const error = await conflictOf(() =>
      persona.write(slug, '# B\n', { ifMatch: memoryVersion('# 昔あった\n') }),
    );
    if (error === null) fail(area, '無い文書への版つき write が断られない');
    if (error.current !== null) fail(area, '無い文書の衝突の current が null ではない');
    if ((await persona.read(slug)) !== null) fail(area, '衝突したのに文書ができている');
  }

  // write: 同じ版を前提にした2つの書き込みが重なっても、勝つのは1つだけ
  {
    const slug = 'persona-contract-if-match-w4';
    await persona.write(slug, '# 価値観\n');
    const v = await versionOf(persona, slug);
    const results = await Promise.allSettled([
      persona.write(slug, '# 一\n', { ifMatch: v }),
      persona.write(slug, '# 二\n', { ifMatch: v }),
    ]);
    expectEqual(
      area,
      '同じ版を前提にした2つの write の (成功, 失敗)',
      [
        results.filter((r) => r.status === 'fulfilled').length,
        results.filter((r) => r.status === 'rejected').length,
      ],
      [1, 1],
    );
  }

  // write: ifMatch を付けなければ従来どおり後勝ち（後方互換）
  {
    const slug = 'persona-contract-if-match-w5';
    await persona.write(slug, '# 価値観\n\nV1\n');
    await persona.write(slug, '# 価値観\n\nV2\n');
    await persona.write(slug, '# 価値観\n\nV3\n', {});
    expectEqual(
      area,
      'ifMatch 無しの後勝ち',
      (await persona.read(slug))?.content,
      '# 価値観\n\nV3\n',
    );
  }

  // remove: 読んだ後に別の書き手が書いたなら、消さずに衝突（current は書かれている文書）
  {
    const slug = 'persona-contract-if-match-r1';
    await persona.write(slug, '# 価値観\n\nV1\n');
    const v1 = await versionOf(persona, slug);
    await persona.write(slug, '# 価値観\n\nV1\n\nクローンの判断\n');
    const error = await conflictOf(() => persona.remove(slug, { ifMatch: v1 }));
    if (error === null) fail(area, '古い版を前提にした remove が断られない');
    if (!error.current?.content.includes('クローンの判断')) {
      fail(area, 'remove の衝突の current が、書かれている文書ではない');
    }
    if (!(await persona.read(slug))?.content.includes('クローンの判断')) {
      fail(area, '衝突したのに文書が消えた・書き換わった');
    }
  }

  // remove: 版が合えば消せる。無い文書に版を指定したら衝突（current は null）
  {
    const slug = 'persona-contract-if-match-r2';
    await persona.write(slug, '# 価値観\n\nV1\n');
    const v = await versionOf(persona, slug);
    await persona.remove(slug, { ifMatch: v });
    if ((await persona.read(slug)) !== null) fail(area, '版が合う remove で消えない');
    const error = await conflictOf(() => persona.remove(slug, { ifMatch: v }));
    if (error === null) fail(area, '無い文書への版つき remove が断られない');
    if (error.current !== null) fail(area, '無い文書への remove の衝突の current が null ではない');
  }

  // remove: 同じ版を前提にした書き込みと削除が重なっても、勝つのは1つだけ
  {
    const slug = 'persona-contract-if-match-r3';
    await persona.write(slug, '# 価値観\n');
    const v = await versionOf(persona, slug);
    const results = await Promise.allSettled([
      persona.write(slug, '# 一\n', { ifMatch: v }),
      persona.remove(slug, { ifMatch: v }),
    ]);
    expectEqual(
      area,
      '同じ版を前提にした write と remove の (成功, 失敗)',
      [
        results.filter((r) => r.status === 'fulfilled').length,
        results.filter((r) => r.status === 'rejected').length,
      ],
      [1, 1],
    );
  }

  // remove: ifMatch を付けなければ従来どおり無条件に消す（後方互換）
  {
    const slug = 'persona-contract-if-match-r4';
    await persona.write(slug, '# 価値観\n');
    await persona.remove(slug);
    if ((await persona.read(slug)) !== null) fail(area, 'ifMatch 無しの remove で消えない');
  }
}

export interface PersonaProtectionStatusHooks {
  /** 器を通さず、文書の本文を外から書き換える（fs: `.md` を直に書く / pg: 行を update する）。 */
  rewriteBehindStore?: (slug: string, content: string) => Promise<void>;
}

/** 保護状態（`human` / `clone-only` / `unknown`）の派生値。 */
export async function verifyPersonaProtectionStatusContract(
  persona: PersonaStore,
  hooks: PersonaProtectionStatusHooks = {},
): Promise<void> {
  const area = 'protectionStatus';
  const status = (slug: string) => persona.protectionStatus(slug);
  const UNKNOWN = { kind: 'unknown' };
  const HUMAN = { kind: 'human' };
  const CLONE_ONLY = { kind: 'clone-only' };
  const touchedAt = '2026-01-02T00:00:00.000Z';

  // 索引の無い・行の無い slug は unknown（守る側の既定）
  await persona.write('persona-contract-protection-base', '# 価値観\n');
  expectEqual(area, '無い slug', await status('persona-contract-protection-nope'), UNKNOWN);

  await persona.write('persona-contract-protection-1', '# 価値観\n');
  await persona.markHumanTouched('persona-contract-protection-1', new Date().toISOString());
  expectEqual(
    area,
    'markHumanTouched を呼んだ文書',
    await status('persona-contract-protection-1'),
    HUMAN,
  );

  await persona.write('persona-contract-protection-2', '# 価値観\n');
  expectEqual(
    area,
    'write() だけの文書',
    await status('persona-contract-protection-2'),
    CLONE_ONLY,
  );

  // append 経路でもハッシュが更新される（誤検出しない）
  await persona.write('persona-contract-protection-3', '# ログ\n');
  await persona.append('persona-contract-protection-3', '- 追記');
  expectEqual(area, 'append した文書', await status('persona-contract-protection-3'), CLONE_ONLY);

  // 索引が確定した後の write / append でも、ハッシュ更新は組み直し（heal）に頼らない:
  // 一度 protectionStatus を呼んで索引を確定させてから2回目を書く。索引が無い状態から読むと組み直しが現在の本文を基準化し、書き込み側のハッシュ更新を削っても救われて落ちないため。
  await persona.write('persona-contract-protection-4', '# 版1\n');
  expectEqual(
    area,
    '索引確定前の write',
    await status('persona-contract-protection-4'),
    CLONE_ONLY,
  );
  await persona.write('persona-contract-protection-4', '# 版2\n');
  expectEqual(
    area,
    '索引確定後の write',
    await status('persona-contract-protection-4'),
    CLONE_ONLY,
  );

  await persona.write('persona-contract-protection-5', '# ログ\n');
  expectEqual(
    area,
    '索引確定前の write（append 用）',
    await status('persona-contract-protection-5'),
    CLONE_ONLY,
  );
  await persona.append('persona-contract-protection-5', '- 追記');
  expectEqual(
    area,
    '索引確定後の append',
    await status('persona-contract-protection-5'),
    CLONE_ONLY,
  );

  // 道具経由（write）の直後は unknown にならない
  await persona.write('persona-contract-protection-6', '# 価値観\n\n本文\n');
  const afterTool = await status('persona-contract-protection-6');
  if (stable(afterTool) === stable(UNKNOWN)) fail(area, '道具経由の write の直後が unknown になる');
  expectEqual(area, '道具経由（write）の直後', afterTool, CLONE_ONLY);

  // 外部から本文が変わったとき、保護状態が古いまま返らない（unknown）。human 印は降りない（human が unknown より優先）
  if (hooks.rewriteBehindStore !== undefined) {
    const rewrite = hooks.rewriteBehindStore;
    await persona.write('persona-contract-protection-7', '# 価値観\n\nもとの内容\n');
    expectEqual(area, '外部編集の前', await status('persona-contract-protection-7'), CLONE_ONLY);
    await rewrite('persona-contract-protection-7', '# 価値観\n\n外から書き換えた\n');
    if (
      !(await persona.read('persona-contract-protection-7'))?.content.includes('外から書き換えた')
    ) {
      fail(area, '外部編集が次の読み出しに反映されない');
    }
    expectEqual(
      area,
      '外部から本文が変わった後',
      await status('persona-contract-protection-7'),
      UNKNOWN,
    );

    await persona.write('persona-contract-protection-8', '# 価値観\n\n人間が書いた\n');
    await persona.markHumanTouched('persona-contract-protection-8', new Date().toISOString());
    await rewrite('persona-contract-protection-8', '# 価値観\n\n外から書き換えた\n');
    expectEqual(
      area,
      'human 印は外部編集があっても降りない',
      await status('persona-contract-protection-8'),
      HUMAN,
    );
  }

  // markHumanTouched は降ろさない（古い時刻を渡しても human のまま）
  await persona.write('persona-contract-protection-9', '# 価値観\n');
  await persona.markHumanTouched('persona-contract-protection-9', touchedAt);
  await persona.markHumanTouched('persona-contract-protection-9', '2020-01-01T00:00:00.000Z');
  expectEqual(
    area,
    '古い時刻の markHumanTouched',
    await status('persona-contract-protection-9'),
    HUMAN,
  );

  // write の humanTouchedAt は本文と同時に human 印を立てる（新規作成・置換・ifMatch とも）
  await persona.write('persona-contract-protection-10-fresh', '# 新規\n', {
    ifMatch: null,
    humanTouchedAt: touchedAt,
  });
  expectEqual(
    area,
    'humanTouchedAt つきの新規作成',
    await status('persona-contract-protection-10-fresh'),
    HUMAN,
  );
  await persona.write('persona-contract-protection-10-replace', '# 版1\n');
  await persona.write('persona-contract-protection-10-replace', '# 版2\n', {
    humanTouchedAt: touchedAt,
  });
  expectEqual(
    area,
    'humanTouchedAt つきの置換',
    await status('persona-contract-protection-10-replace'),
    HUMAN,
  );
  await persona.write('persona-contract-protection-10-matched', '# 版1\n');
  await persona.write('persona-contract-protection-10-matched', '# 版2\n', {
    ifMatch: memoryVersion('# 版1\n'),
    humanTouchedAt: touchedAt,
  });
  expectEqual(
    area,
    'humanTouchedAt つきの版つき置換',
    await status('persona-contract-protection-10-matched'),
    HUMAN,
  );

  // write の humanTouchedAt は、書けなかった（版違い）回は印を立てない
  await persona.write('persona-contract-protection-11', '# 版1\n');
  const rejected = await rejectedOf(() =>
    persona.write('persona-contract-protection-11', '# 版2\n', {
      ifMatch: 'stale',
      humanTouchedAt: touchedAt,
    }),
  );
  if (!rejected) fail(area, '版違いの write が断られない');
  expectEqual(
    area,
    '書けなかった write の印',
    await status('persona-contract-protection-11'),
    CLONE_ONLY,
  );

  // humanTouchedAt の無い write は既存の human 印を降ろさない（古い humanTouchedAt でも巻き戻らない）
  await persona.write('persona-contract-protection-12', '# 版1\n', { humanTouchedAt: touchedAt });
  await persona.write('persona-contract-protection-12', '# 版2\n', {
    humanTouchedAt: '2020-01-01T00:00:00.000Z',
  });
  await persona.write('persona-contract-protection-12', '# 版3\n');
  expectEqual(
    area,
    'humanTouchedAt の無い write の後',
    await status('persona-contract-protection-12'),
    HUMAN,
  );

  // remove() で保護状態も一緒に消える（実体の無い印を残さない）
  await persona.write('persona-contract-protection-13', '# 価値観\n');
  await persona.markHumanTouched('persona-contract-protection-13', new Date().toISOString());
  await persona.remove('persona-contract-protection-13');
  expectEqual(area, 'remove 後', await status('persona-contract-protection-13'), UNKNOWN);

  // markHumanTouched は削除済みの slug に行を作らない（空文字の「文書」を生まない）
  await persona.markHumanTouched('persona-contract-protection-ghost', new Date().toISOString());
  if ((await persona.read('persona-contract-protection-ghost')) !== null) {
    fail(area, 'markHumanTouched が無い slug に文書を作った');
  }
  expectEqual(
    area,
    '無い slug への markHumanTouched',
    await status('persona-contract-protection-ghost'),
    UNKNOWN,
  );
}

export interface PersonaCreatedAtHooks {
  /** `write` で作った文書の `createdAt` の派生値だけを失わせる（fs: 索引からキーを消す / pg: 列を null にする）。 */
  forgetCreatedAt?: (slug: string) => Promise<void>;
}

/** 作成時刻の派生値 `createdAt` と、その確定（`markCreatedAt`）。 */
export async function verifyPersonaCreatedAtContract(
  persona: PersonaStore,
  hooks: PersonaCreatedAtHooks = {},
): Promise<void> {
  const area = 'createdAt';
  const stampedAt = '2026-01-02T03:04:05.000Z';
  const KNOWN = { kind: 'known', at: stampedAt };

  // write() は新規作成のとき、backfill を通さずその場で createdAt を known にする（updatedAt と一致）
  {
    const slug = 'persona-contract-created-at-1';
    const doc = await persona.write(slug, '# 価値観\n');
    const read = await persona.read(slug);
    expectEqual(area, '新規作成の返り値と読み戻し', read?.createdAt, {
      kind: 'known',
      at: doc.updatedAt,
    });
    expectEqual(area, '新規作成の createdAt と updatedAt', read?.createdAt, {
      kind: 'known',
      at: read?.updatedAt,
    });
  }

  // 既存の文書を更新しても createdAt は変わらない（updatedAt は進む）
  {
    const slug = 'persona-contract-created-at-2';
    const first = await persona.write(slug, '# 価値観\n');
    await advanceClock();
    const second = await persona.write(slug, '# 価値観\n\n書き直した\n');
    expectEqual(area, '更新後の返り値の createdAt', second.createdAt, first.createdAt);
    if (second.updatedAt === first.updatedAt) fail(area, '更新しても updatedAt が進まない');
    expectEqual(
      area,
      '更新後の読み戻しの createdAt',
      (await persona.read(slug))?.createdAt,
      first.createdAt,
    );
  }

  // append() が文書を新規作成したときも createdAt が付く
  {
    const slug = 'persona-contract-created-at-3';
    const doc = await persona.append(slug, '最初のメモ');
    expectEqual(area, 'append が作った文書の createdAt', doc.createdAt, {
      kind: 'known',
      at: doc.updatedAt,
    });
    expectEqual(
      area,
      'append が作った文書の読み戻し',
      (await persona.read(slug))?.createdAt,
      doc.createdAt,
    );
  }

  // append() が既存の文書へ追記したときは createdAt が変わらない
  {
    const slug = 'persona-contract-created-at-4';
    const first = await persona.write(slug, '# ノート\n');
    await advanceClock();
    const second = await persona.append(slug, '追記した行');
    expectEqual(area, '追記後の返り値の createdAt', second.createdAt, first.createdAt);
    if (second.updatedAt === first.updatedAt) fail(area, '追記しても updatedAt が進まない');
    expectEqual(
      area,
      '追記後の読み戻しの createdAt',
      (await persona.read(slug))?.createdAt,
      first.createdAt,
    );
  }

  // 削除して同じ slug を作り直すと、新しい createdAt になる
  {
    const slug = 'persona-contract-created-at-5';
    const first = await persona.write(slug, '# 価値観\n');
    await advanceClock();
    await persona.remove(slug);
    const second = await persona.write(slug, '# 価値観\n\n書き直した\n');
    if (second.createdAt.kind !== 'known') fail(area, '作り直した文書の createdAt が known でない');
    if (stable(second.createdAt) === stable(first.createdAt)) {
      fail(area, '作り直しても createdAt が前の文書のまま');
    }
    expectEqual(
      area,
      '作り直した文書の読み戻し',
      (await persona.read(slug))?.createdAt,
      second.createdAt,
    );
  }

  // 実体の無い slug には行を作らない（削除済み記憶が復活しない）
  {
    const slug = 'persona-contract-created-at-ghost';
    const wrote = await persona.markCreatedAt(slug, new Date().toISOString());
    if (wrote) fail(area, '実体の無い slug への markCreatedAt が true を返す');
    if ((await persona.read(slug)) !== null) fail(area, 'markCreatedAt が無い slug に文書を作った');
    if ((await persona.list()).some((entry) => entry.slug === slug)) {
      fail(area, 'markCreatedAt が無い slug を list に出した');
    }
  }

  const forget = hooks.forgetCreatedAt;
  if (forget === undefined) return;
  const written = async (slug: string, content = '# 価値観\n') => {
    await persona.write(slug, content);
    await forget(slug);
  };

  // markCreatedAt を呼んだ文書は known になる（read() にも list() にも出る）
  {
    const slug = 'persona-contract-created-at-6';
    await written(slug);
    await persona.markCreatedAt(slug, stampedAt);
    expectEqual(area, 'markCreatedAt 後の read', (await persona.read(slug))?.createdAt, KNOWN);
    const meta = (await persona.list()).find((entry) => entry.slug === slug);
    expectEqual(area, 'markCreatedAt 後の list', meta?.createdAt, KNOWN);
  }

  // markCreatedAt は一度きりの確定——2回目は無視される
  {
    const slug = 'persona-contract-created-at-7';
    await written(slug);
    const first = await persona.markCreatedAt(slug, stampedAt);
    const second = await persona.markCreatedAt(slug, '2020-01-01T00:00:00.000Z');
    expectEqual(area, '一度きりの確定の戻り値', [first, second], [true, false]);
    expectEqual(area, '2回目が無視される', (await persona.read(slug))?.createdAt, KNOWN);
  }

  // 同じ引数で2回走らせても結果は変わらない（backfill の再実行を模す）
  {
    const slug = 'persona-contract-created-at-8';
    await written(slug);
    await persona.markCreatedAt(slug, stampedAt);
    await persona.markCreatedAt(slug, stampedAt);
    expectEqual(area, '同じ引数で2回', (await persona.read(slug))?.createdAt, KNOWN);
  }

  // markCreatedAt は createdAt 以外を1つも書き換えない（human 印あり・description あり）
  {
    const slug = 'persona-contract-created-at-9';
    await written(slug, ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'));
    await persona.markHumanTouched(slug, '2020-01-01T00:00:00.000Z');
    const before = await persona.read(slug);
    const beforeProtection = await persona.protectionStatus(slug);
    expectEqual(area, '書き換え前の createdAt', before?.createdAt, { kind: 'unknown' });

    await persona.markCreatedAt(slug, stampedAt);

    const after = await persona.read(slug);
    const afterProtection = await persona.protectionStatus(slug);
    expectEqual(area, 'content', after?.content, before?.content);
    expectEqual(area, 'updatedAt', after?.updatedAt, before?.updatedAt);
    expectEqual(area, 'description', after?.description, before?.description);
    expectEqual(area, 'kind', after?.kind, before?.kind);
    expectEqual(area, 'parent', after?.parent, before?.parent);
    expectEqual(area, 'protectionStatus', afterProtection, beforeProtection);
    expectEqual(area, '書き換え後の createdAt', after?.createdAt, KNOWN);
  }

  // human 印を経由しない場合でも createdAt 以外を書き換えない（保護状態と describedAt 側）。
  // markHumanTouched を呼ばない: 呼ぶと protectionStatus が human の分岐で即返り、内容のハッシュを一度も見ないため。
  {
    const slug = 'persona-contract-created-at-10';
    await written(slug, ['---', 'description: 手順', '---', '# 手順書', '', '本文', ''].join('\n'));
    const before = await persona.read(slug);
    const beforeProtection = await persona.protectionStatus(slug);
    expectEqual(area, '書き換え前の保護状態', beforeProtection, { kind: 'clone-only' });
    expectEqual(area, '書き換え前の鮮度', before?.descriptionFreshness, { kind: 'fresh' });
    expectEqual(area, '書き換え前の createdAt（human 印なし）', before?.createdAt, {
      kind: 'unknown',
    });

    const wrote = await persona.markCreatedAt(slug, stampedAt);

    const after = await persona.read(slug);
    const afterProtection = await persona.protectionStatus(slug);
    if (!wrote) fail(area, 'createdAt の無い文書への markCreatedAt が false を返す');
    expectEqual(area, 'content（human 印なし）', after?.content, before?.content);
    expectEqual(area, 'updatedAt（human 印なし）', after?.updatedAt, before?.updatedAt);
    expectEqual(area, 'description（human 印なし）', after?.description, before?.description);
    expectEqual(area, 'protectionStatus（human 印なし）', afterProtection, beforeProtection);
    expectEqual(
      area,
      'descriptionFreshness（human 印なし）',
      after?.descriptionFreshness,
      before?.descriptionFreshness,
    );
    expectEqual(area, '書き換え後の createdAt（human 印なし）', after?.createdAt, KNOWN);
  }
}

/** 要旨の鮮度の派生値 `describedAt`（`descriptionFreshness`）。 */
export async function verifyPersonaDescribedAtContract(persona: PersonaStore): Promise<void> {
  const area = 'describedAt';
  const FRESH = { kind: 'fresh' };

  // description を書いた直後は fresh になる（describedAt === updatedAt）
  {
    const slug = 'persona-contract-described-at-1';
    await persona.write(slug, '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n');
    const doc = await persona.read(slug);
    expectEqual(area, '書いた直後の鮮度', doc?.descriptionFreshness, FRESH);
    expectEqual(area, 'description', doc?.description, '費用の推移');
    expectEqual(area, 'kind', doc?.kind, 'fact');
  }

  // 同じ書き込みで本文と description を両方変えても fresh のまま（同じ writtenAt で確定するため）
  {
    const slug = 'persona-contract-described-at-2';
    await persona.write(slug, WITH_DESCRIPTION('旧本文'));
    await advanceClock();
    await persona.write(slug, WITH_DESCRIPTION('新本文', '費用の推移（改訂）'));
    const doc = await persona.read(slug);
    expectEqual(area, '本文と description を両方変えた後の鮮度', doc?.descriptionFreshness, FRESH);
    expectEqual(area, '改訂した description', doc?.description, '費用の推移（改訂）');
  }

  // 本文だけを書き直すと stale になる（description は本文の変更に追従しない）
  // `staleForMs` は実時計・mtime 分解能に依存するので厳密値で固定せず、正であることだけを見る
  {
    const slug = 'persona-contract-described-at-3';
    await persona.write(slug, WITH_DESCRIPTION('版1'));
    await advanceClock();
    await persona.write(slug, WITH_DESCRIPTION('版2（本文だけ変えた）'));
    const doc = await persona.read(slug);
    if (doc?.descriptionFreshness.kind !== 'stale') {
      fail(area, `本文だけ書き直しても stale にならない: ${stable(doc?.descriptionFreshness)}`);
    }
    if (!(doc.descriptionFreshness.staleForMs > 0)) fail(area, 'staleForMs が正でない');
    expectEqual(area, '本文だけ書き直した後の description', doc.description, '費用の推移');
  }

  // stale になった後、description を書き直すと fresh に戻る
  {
    const slug = 'persona-contract-described-at-4';
    await persona.write(slug, WITH_DESCRIPTION('版1'));
    await advanceClock();
    await persona.write(slug, WITH_DESCRIPTION('版2（本文だけ変えた）'));
    const stale = await persona.read(slug);
    if (stale?.descriptionFreshness.kind !== 'stale') fail(area, 'stale にならない（前提）');
    if (!(stale.descriptionFreshness.staleForMs > 0)) fail(area, 'staleForMs が正でない（前提）');

    await persona.write(
      slug,
      WITH_DESCRIPTION('版2（本文だけ変えた）', '費用の推移（書き直した）'),
    );

    expectEqual(
      area,
      'description を書き直した後の鮮度',
      (await persona.read(slug))?.descriptionFreshness,
      FRESH,
    );
  }

  // description を書かなければ absent のまま（premise の既定と同じ安全側）
  {
    const slug = 'persona-contract-described-at-5';
    await persona.write(slug, '# 私\n\n前提の本文\n');
    const doc = await persona.read(slug);
    expectEqual(area, 'description 無しの鮮度', doc?.descriptionFreshness, { kind: 'absent' });
    expectEqual(area, 'description 無しの kind', doc?.kind, 'premise');
  }

  // append でも describedAt が更新される（write と同じ通り道を通る）
  {
    const slug = 'persona-contract-described-at-6';
    await persona.write(slug, '---\ndescription: 学びの記録\ntype: fact\n---\n# ログ\n最初の行\n');
    await advanceClock();
    await persona.append(slug, '追記した行');
    const doc = await persona.read(slug);
    if (doc?.descriptionFreshness.kind !== 'stale') {
      fail(area, `追記しても stale にならない: ${stable(doc?.descriptionFreshness)}`);
    }
    if (!(doc.descriptionFreshness.staleForMs > 0)) fail(area, '追記後の staleForMs が正でない');
  }
}

export interface PersonaDescribedBytesHooks {
  /**
   * 文書の `describedBytes` の派生値を失わせる（`describedBytesAt` は `withAt: true` のときだけ一緒に失わせる）。
   * fs: 索引のキーを消す / pg: 列を null にする。
   */
  forgetDescribedBytes?: (slug: string, options: { withAt: boolean }) => Promise<void>;
}

/** 要旨を書いた時点の本文の大きさ `describedBytes`（本文の変化量 drift、#913）。 */
export async function verifyPersonaDescribedBytesContract(
  persona: PersonaStore,
  hooks: PersonaDescribedBytesHooks = {},
): Promise<void> {
  const area = 'describedBytes';

  // 要旨を書いた直後は drift の deltaBytes が厳密に0（describedBytes と bytes の測り方が揃っている）
  {
    const slug = 'persona-contract-described-bytes-1';
    const written = await persona.write(slug, WITH_DESCRIPTION('本文'));
    const doc = await persona.read(slug);
    expectEqual(area, '書いた直後の鮮度', doc?.descriptionFreshness, { kind: 'fresh' });
    expectEqual(area, '書いた直後の bytes', doc?.bytes, written.bytes);
  }

  // append の後、describedAt/describedBytes は据え置きで、deltaBytes は追記したバイト数と一致する
  {
    const slug = 'persona-contract-described-bytes-2';
    const before = await persona.write(slug, WITH_DESCRIPTION('本文'));
    await advanceClock();
    const appended = '追記した1行\n';
    await persona.append(slug, appended);
    const doc = await persona.read(slug);
    if (doc?.descriptionFreshness.kind !== 'stale') fail(area, '追記しても stale にならない');
    expectEqual(area, '追記後の drift', doc.descriptionFreshness.drift, {
      kind: 'measured',
      describedBytes: before.bytes,
      currentBytes: doc.bytes,
      deltaBytes: doc.bytes - before.bytes,
    });
    // 範囲で比べる: `ensureTrailingNewline` が足す改行を別に数えないため
    if (
      doc.descriptionFreshness.drift.kind === 'measured' &&
      doc.descriptionFreshness.drift.deltaBytes < utf8Bytes(appended)
    ) {
      fail(area, 'deltaBytes が追記したバイト数に満たない');
    }
  }

  const forget = hooks.forgetDescribedBytes;
  if (forget === undefined) return;
  const staleRunbook = async (slug: string) => {
    await persona.write(slug, WITH_DESCRIPTION('版1'));
    await advanceClock();
    await persona.write(slug, WITH_DESCRIPTION('版2（本文だけ変えた）'));
  };

  // describedAt を持つが describedBytes を持たない既存の行は unrecorded になり、deltaBytes: 0 にならない
  {
    const slug = 'persona-contract-described-bytes-3';
    await staleRunbook(slug);
    const before = await persona.read(slug);
    if (before?.descriptionFreshness.kind !== 'stale') fail(area, 'stale にならない（前提）');
    expectEqual(area, '失わせる前の drift', before.descriptionFreshness.drift.kind, 'measured');

    await forget(slug, { withAt: false });

    const doc = await persona.read(slug);
    if (doc?.descriptionFreshness.kind !== 'stale') fail(area, '失わせた後に stale でなくなった');
    expectEqual(area, 'describedBytes の無い行の drift', doc.descriptionFreshness.drift, {
      kind: 'unrecorded',
    });
  }

  // describedBytes を持たない既存の行へ append すると、その場で基準点が立ち drift が at-least になる（deltaBytes は0にならない、#821 残課題）
  {
    const slug = 'persona-contract-described-bytes-4';
    await staleRunbook(slug);
    await forget(slug, { withAt: true });
    const before = await persona.read(slug);
    if (before?.descriptionFreshness.kind !== 'stale') fail(area, 'stale にならない（前提）');
    expectEqual(area, '基準点を立てる前の drift', before.descriptionFreshness.drift, {
      kind: 'unrecorded',
    });

    await advanceClock();
    const appended = '基準点を立てるための追記\n';
    await persona.append(slug, appended);

    const after = await persona.read(slug);
    if (after?.descriptionFreshness.kind !== 'stale') fail(area, '追記後に stale でなくなった');
    const drift = after.descriptionFreshness.drift;
    if (drift.kind !== 'at-least')
      fail(area, `追記後の drift が at-least でない: ${stable(drift)}`);
    if (drift.deltaBytes === 0) fail(area, 'at-least の deltaBytes が0');
    if (drift.deltaBytes < utf8Bytes(appended)) {
      fail(area, 'at-least の deltaBytes が追記したバイト数に満たない');
    }
  }

  // 一度立った基準点は、2回目の append で動かない（#821 残課題）
  {
    const slug = 'persona-contract-described-bytes-5';
    await staleRunbook(slug);
    await forget(slug, { withAt: true });

    await advanceClock();
    await persona.append(slug, '1回目の追記\n');
    const afterFirst = await persona.read(slug);
    if (afterFirst?.descriptionFreshness.kind !== 'stale')
      fail(area, '1回目の追記後に stale でない');
    const first = afterFirst.descriptionFreshness.drift;
    if (first.kind !== 'at-least')
      fail(area, `1回目の追記後の drift が at-least でない: ${stable(first)}`);

    await advanceClock();
    await persona.append(slug, '2回目の追記\n');
    const afterSecond = await persona.read(slug);
    if (afterSecond?.descriptionFreshness.kind !== 'stale')
      fail(area, '2回目の追記後に stale でない');
    const second = afterSecond.descriptionFreshness.drift;
    if (second.kind !== 'at-least')
      fail(area, `2回目の追記後の drift が at-least でない: ${stable(second)}`);
    expectEqual(area, '基準点の bytes が動いた', second.baselineBytes, first.baselineBytes);
    expectEqual(area, '基準点の at が動いた', second.baselineAt, first.baselineAt);
    if (!(second.deltaBytes > first.deltaBytes)) fail(area, '2回目の追記で deltaBytes が増えない');
  }
}
