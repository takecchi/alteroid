import { PracticeConflictError, practiceVersion } from './store.js';
import type { PracticeStore } from './store.js';

// `verifyClear` は器全体を空にするので、他の行が消えて困らない場面でだけ渡す。
export async function verifyPracticeStoreContract(
  practices: PracticeStore,
  options: { readonly verifyClear?: boolean } = {},
): Promise<void> {
  // 関数宣言にする: const の矢印関数だと `never` による絞り込みが効かない。
  function fail(message: string): never {
    throw new Error(`やり方の器の契約違反: ${message}`);
  }

  const before = await practices.list();
  if (!Array.isArray(before.entries)) fail('list() の entries が配列でない');
  if (!Array.isArray(before.unreadable)) fail('list() の unreadable が配列でない');
  if ((await practices.read('contract-missing')) !== null) {
    fail('read() は無い slug に対して null を返すこと');
  }

  const written = await practices.write({
    slug: 'contract-b',
    kind: '調査',
    title: '調べもののやり方',
    content: '# 調べもの',
  });
  if (written.content !== '# 調べもの\n') {
    fail(`write() の返り値の本文が正規化されていない: ${JSON.stringify(written.content)}`);
  }
  const reread = await practices.read('contract-b');
  if (reread === null || reread.content !== '# 調べもの\n') {
    fail(`read() の本文が正規化されていない: ${JSON.stringify(reread?.content)}`);
  }
  if (reread.chars !== [...'# 調べもの\n'].length) {
    fail(`chars は正規化後の本文で数えること: ${reread.chars}`);
  }
  const already = await practices.write({
    slug: 'contract-b',
    kind: '調査',
    title: '調べもののやり方',
    content: '# 調べもの\n',
  });
  if (already.content !== '# 調べもの\n') {
    fail(`既に改行で終わる本文に改行を足している: ${JSON.stringify(already.content)}`);
  }

  await practices.write({
    slug: 'contract-a',
    kind: '実装',
    title: '実装のやり方',
    content: 'あ',
  });
  await practices.write({
    slug: 'contract-c',
    kind: '日報',
    title: '日報のやり方',
    content: 'い',
  });
  const listed = (await practices.list()).entries
    .map((entry) => entry.slug)
    .filter((slug) => slug.startsWith('contract-'));
  if (listed.join(',') !== 'contract-a,contract-b,contract-c') {
    fail(`list() が slug の昇順になっていない: ${listed.join(',')}`);
  }

  const exotic = await practices.write({
    slug: 'contract-d',
    kind: '外部サービスの確認',
    title: '確認のやり方',
    content: 'う',
  });
  if (exotic.kind !== '外部サービスの確認') {
    fail(`kind を自由文字列として保てていない: ${exotic.kind}`);
  }

  const first = await practices.read('contract-a');
  await practices.write({
    slug: 'contract-a',
    kind: '実装',
    title: '実装のやり方（改）',
    content: 'あああ',
  });
  const second = await practices.read('contract-a');
  if (first === null || second === null) fail('上書きの前後で read() が null を返した');
  if (first.createdAt !== second.createdAt) {
    fail(`上書きで createdAt が動いた: ${first.createdAt} -> ${second.createdAt}`);
  }
  if (second.title !== '実装のやり方（改）') fail('上書きで title が反映されない');

  const held = await practices.read('contract-a');
  if (held !== null) held.content = '読んだ側で書き換えた';
  if ((await practices.read('contract-a'))?.content !== 'あああ\n') {
    fail('read() が返した参照を書き換えたら、器の中身まで動いた');
  }
  const meta = (await practices.list()).entries.find((entry) => entry.slug === 'contract-a');
  if (meta !== undefined) meta.title = '一覧の側で書き換えた';
  if ((await practices.read('contract-a'))?.title !== '実装のやり方（改）') {
    fail('list() が返した参照を書き換えたら、器の中身まで動いた');
  }

  const unicodeSource = '😀 é';
  const unicodeWritten = await practices.write({
    slug: 'contract-unicode',
    kind: '調査',
    title: 'コードポイントの数え方',
    content: unicodeSource,
  });
  const expectedChars = [...unicodeWritten.content].length;
  if (unicodeWritten.chars !== expectedChars) {
    fail(
      `write() の chars がコードポイント数になっていない: ${unicodeWritten.chars}（期待 ${expectedChars}）`,
    );
  }
  const unicodeReread = await practices.read('contract-unicode');
  if (unicodeReread === null || unicodeReread.chars !== expectedChars) {
    fail(`read() の chars がコードポイント数になっていない: ${unicodeReread?.chars}`);
  }
  const unicodeListed = (await practices.list()).entries.find(
    (entry) => entry.slug === 'contract-unicode',
  );
  if (unicodeListed === undefined || unicodeListed.chars !== expectedChars) {
    fail(`list() の chars がコードポイント数になっていない: ${unicodeListed?.chars}`);
  }
  await practices.remove('contract-unicode');

  await practices.remove('contract-d');
  if ((await practices.read('contract-d')) !== null) fail('remove() の後も read() が返る');
  await practices.remove('contract-d');

  {
    const noVersions = await practices.listVersions('contract-nothing-here');
    if (noVersions.length !== 0) fail('版が無い slug で listVersions() が空を返さない');
    if ((await practices.readVersion('contract-nothing-here', 1)) !== null) {
      fail('版が無い slug で readVersion() が null を返さない');
    }

    const v1 = await practices.write({
      slug: 'contract-v',
      kind: '実装',
      title: '版1',
      content: '本文1',
    });
    let versions = await practices.listVersions('contract-v');
    if (versions.length !== 1) fail(`write() 1回目で版が1つ増えていない: ${versions.length}`);
    if (versions[0]?.version !== 1) fail(`最初の版番号が1ではない: ${versions[0]?.version}`);
    if ('content' in versions[0]!) fail('listVersions() が本文（content）を含んでいる');
    if (versions[0]!.chars !== [...v1.content].length) {
      fail(`版の chars がコードポイント数になっていない: ${versions[0]!.chars}`);
    }

    const readV1 = await practices.readVersion('contract-v', 1);
    if (readV1 === null || readV1.content !== '本文1\n') {
      fail(`readVersion() が版の本文を返さない: ${JSON.stringify(readV1?.content)}`);
    }

    await practices.write({
      slug: 'contract-v',
      kind: '実装',
      title: '版2',
      content: '本文2',
    });
    versions = await practices.listVersions('contract-v');
    if (versions.length !== 2) fail(`write() 2回目で版が増えていない: ${versions.length}`);
    if (versions[1]?.version !== 2) fail(`2つ目の版番号が2ではない: ${versions[1]?.version}`);
    if ((await practices.readVersion('contract-v', 1))?.content !== '本文1\n') {
      fail('2回目の write() が1つ目の版を書き換えた（追記専用ではない）');
    }

    if ((await practices.readVersion('contract-v', 999)) !== null) {
      fail('readVersion() が無い版番号に対して null を返さない');
    }

    await practices.remove('contract-v');
    versions = await practices.listVersions('contract-v');
    if (versions.length !== 2) fail(`remove() が版を消した: ${versions.length}`);
    if ((await practices.readVersion('contract-v', 1)) === null) {
      fail('remove() の後、版1が readVersion() で読めなくなった');
    }

    await practices.write({
      slug: 'contract-v',
      kind: '実装',
      title: '版3（作り直し）',
      content: '本文3',
    });
    versions = await practices.listVersions('contract-v');
    if (versions.length !== 3) fail(`作り直しで版の履歴が引き継がれない: ${versions.length}`);
    if (versions[2]?.version !== 3) {
      fail(`作り直しの版番号が続きから振られていない: ${versions[2]?.version}`);
    }
  }

  {
    const slug = 'contract-m';
    const input = { slug, kind: '実装', title: '版の照合' };
    const attempt = async (content: string, ifMatch?: string | null) => {
      try {
        return { ok: await practices.write({ ...input, content }, { ifMatch }) };
      } catch (error) {
        if (error instanceof PracticeConflictError) return { conflict: error };
        throw error;
      }
    };

    const first = await attempt('最初', null);
    if (first.ok === undefined) fail('ifMatch: null が、無い slug への初回の書き込みで断られた');
    const second = await attempt('二番目', null);
    if (second.conflict === undefined) fail('ifMatch: null が、在る slug への書き込みを断らない');
    if (second.conflict.current?.content !== '最初\n') {
      fail('衝突の current が、いまの本文ではない');
    }
    let ghost: unknown;
    try {
      await practices.write(
        { slug: 'contract-ghost', kind: '実装', title: 'ゆうれい', content: 'ゆうれい' },
        { ifMatch: 'x'.repeat(64) },
      );
    } catch (error) {
      ghost = error;
    }
    if (!(ghost instanceof PracticeConflictError) || ghost.current !== null) {
      fail('無い slug への版つきの書き込みが、current: null の衝突にならない');
    }
    if ((await practices.read('contract-ghost')) !== null) fail('衝突したのに行ができている');

    const v1 = practiceVersion(first.ok);
    const third = await attempt('三番目', v1);
    if (third.ok === undefined) fail('いまの版を前提にした書き込みが断られた');
    const versionsBefore = (await practices.listVersions(slug)).length;
    const stale = await attempt('古い版からの書き込み', v1);
    if (stale.conflict === undefined) fail('古い版を前提にした書き込みが断られない');
    if (stale.conflict.current?.content !== '三番目\n') fail('衝突の current が最新でない');
    if ((await practices.read(slug))?.content !== '三番目\n')
      fail('衝突したのに本文が書き換わった');
    if ((await practices.listVersions(slug)).length !== versionsBefore) {
      fail('衝突したのに版の履歴が増えた');
    }
    const renamed = await practices.write({ ...input, title: '別の題', content: '三番目' });
    const titleStale = await attempt('四番目', practiceVersion(third.ok));
    if (titleStale.conflict === undefined || renamed.title !== '別の題') {
      fail('題名の変更が、版の照合に効いていない');
    }
    const last = await attempt('後勝ち');
    if (last.ok === undefined) fail('ifMatch 省略の書き込みが断られた（後勝ちでなくなった）');
    if ((await practices.read(slug))?.content !== '後勝ち\n') fail('後勝ちの本文が読めない');
  }

  {
    const slug = 'contract-r';
    const input = { slug, kind: '実装', title: '削除の版の照合' };
    const conflictOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return undefined;
      } catch (error) {
        if (error instanceof PracticeConflictError) return error;
        throw error;
      }
    };
    const v1 = practiceVersion(await practices.write({ ...input, content: '最初' }));
    await practices.write({ ...input, content: '人間の直し' });
    const stale = await conflictOf(() => practices.remove(slug, { ifMatch: v1 }));
    if (stale === undefined) fail('古い版を前提にした削除が断られない');
    if (stale.current?.content !== '人間の直し\n') fail('削除の衝突の current が最新でない');
    if ((await practices.read(slug))?.content !== '人間の直し\n') fail('衝突したのに消えた');
    const ghost = await conflictOf(() =>
      practices.remove('contract-ghost-r', { ifMatch: 'x'.repeat(64) }),
    );
    if (ghost === undefined || ghost.current !== null) {
      fail('無い slug への版つきの削除が、current: null の衝突にならない');
    }
    const v2 = practiceVersion((await practices.read(slug)) ?? fail('読めない'));
    const settled = await Promise.allSettled([
      practices.write({ ...input, content: '競合する書き込み' }, { ifMatch: v2 }),
      practices.remove(slug, { ifMatch: v2 }),
    ]);
    if (settled.filter((r) => r.status === 'fulfilled').length !== 1) {
      fail('同じ版を前提にした書き込みと削除が、勝つのが1つだけになっていない');
    }
    const loser = settled.find((r) => r.status === 'rejected');
    if (!(loser?.status === 'rejected' && loser.reason instanceof PracticeConflictError)) {
      fail('競合に負けた側が PracticeConflictError ではない');
    }
    await practices.write({ ...input, content: '消す前' });
    const v3 = practiceVersion((await practices.read(slug)) ?? fail('読めない'));
    await practices.remove(slug, { ifMatch: v3 });
    if ((await practices.read(slug)) !== null) fail('合う版を前提にした削除で消えない');
    if ((await practices.listVersions(slug)).length === 0) fail('削除で版の履歴が消えた');
    await practices.write({ ...input, content: '無条件' });
    await practices.remove(slug);
    if ((await practices.read(slug)) !== null) fail('ifMatch 省略の削除が消さない');
  }

  {
    const nulSlug = 'contract-n\u0000ul';
    const nulInput = {
      slug: 'contract-nul',
      kind: '調\u0000査',
      title: '題\u0000',
      content: '本\u0000文',
    };
    let writeThrown: unknown;
    try {
      await practices.write({ ...nulInput, slug: nulSlug });
    } catch (error) {
      writeThrown = error;
    }
    if (writeThrown === undefined)
      fail('write(NULを含むslug)が投げない（入口のスキーマが弾くこと）');
    const readOutcomes: Array<[string, () => Promise<unknown>, string]> = [
      ['read(NULを含むslug)はnull', () => practices.read(nulSlug), 'null'],
      ['readVersion(NULを含むslug)はnull', () => practices.readVersion(nulSlug, 1), 'null'],
      ['listVersions(NULを含むslug)は空', () => practices.listVersions(nulSlug), '[]'],
      ['remove(NULを含むslug)は何もしない', () => practices.remove(nulSlug), 'undefined'],
    ];
    for (const [label, call, expected] of readOutcomes) {
      let outcome: unknown;
      try {
        outcome = await call();
      } catch (error) {
        fail(`${label}（投げた: ${error instanceof Error ? error.name : typeof error}）`);
      }
      if ((JSON.stringify(outcome) ?? 'undefined') !== expected)
        fail(`${label}（実際: ${JSON.stringify(outcome)}）`);
    }
    const nulWritten = await practices.write(nulInput);
    if (
      nulWritten.kind !== '調査' ||
      nulWritten.title !== '題' ||
      nulWritten.content !== '本文\n'
    ) {
      fail(`writeの返り値に NUL が残る: ${JSON.stringify(nulWritten)}`);
    }
    const nulRead = await practices.read('contract-nul');
    if (nulRead?.kind !== '調査' || nulRead.title !== '題' || nulRead.content !== '本文\n') {
      fail(`読み戻しに NUL が残る: ${JSON.stringify(nulRead)}`);
    }
    let emptied: unknown;
    try {
      await practices.write({ ...nulInput, slug: 'contract-nul-empty', kind: '\u0000' });
    } catch (error) {
      emptied = error;
    }
    if (emptied === undefined && (await practices.read('contract-nul-empty')) !== null) {
      fail('NULだけの kind を、落とすと空になる kind を、そのまま受け付けた');
    }
    await practices.remove('contract-nul');
    await practices.remove('contract-nul-empty');
  }

  if (options.verifyClear !== true) {
    for (const slug of ['contract-a', 'contract-b', 'contract-c', 'contract-v', 'contract-m']) {
      await practices.remove(slug);
    }
    return;
  }

  const removed = await practices.clear();
  if (removed < 3) fail(`clear() が消した件数を返していない: ${removed}`);
  if ((await practices.list()).entries.length !== 0) {
    fail('clear() の後も list() が空にならない');
  }
  if ((await practices.listVersions('contract-v')).length !== 0) {
    fail('clear() の後も listVersions() が空にならない（版が残っている）');
  }
}
