import type { PracticeStore } from './store.js';

/**
 * `PracticeStore` の契約を、**実装1つに対して**測る（#1055 段3）。
 *
 * ## なぜ共有の契約にするか
 *
 * `PersonaStore.write` の doc が逐語で理由を持っている:
 *
 * > **4つ目を足すときは、その歯も4つ目にする。** 1つで測って3つとも測ったことに
 * > しないのが、この Issue の主題そのものである。
 *
 * `grep -Fn -- '4つ目を足すときは、その歯も4つ目にする' packages/core/src/store.ts`
 *
 * 記憶では、末尾改行の正規化が `storage-fs` と `storage-pg` に逐語で複製されて
 * いて、3つ目（インメモリ）だけがそれを持たなかった。**そして `packages/core` の
 * 単体テストが当たるのは、乖離しているほうだけだった**（#370）。⟹ やり方の器は
 * 最初から、3実装が同じ関数を呼ぶ形にしておく。
 *
 * **vitest に依存しない素の非同期関数にしてある**理由は
 * `store-isolation-contract.ts` / `journal-order-with-contract.ts` と同じ
 * （`storage-fs` / `storage-pg` へ vitest を持ち込まないため）。
 *
 * ⚠️ **この関数は器を空にしてから測らない。** 呼ぶ側が用意した器に、専用の
 * 接頭辞（`contract-`）の slug だけを足し引きする。最後に `clear()` を測る枝だけは
 * 器全体を空にするので、**`clear()` を測る呼び出しは他の行が消えて困らない
 * 場面でだけ渡すこと**（既定は測らない）。
 */
export async function verifyPracticeStoreContract(
  practices: PracticeStore,
  options: { readonly verifyClear?: boolean } = {},
): Promise<void> {
  // **関数宣言にしてあるのは型の都合である** —— `never` を返す関数宣言なら、
  // TypeScript が `fail()` の後を到達不能として扱う（const の矢印関数だと
  // 絞り込みが効かず、呼び出しのたびに `null` の再確認が要る）。
  function fail(message: string): never {
    throw new Error(`やり方の器の契約違反: ${message}`);
  }

  // --- 1. 空の器は正常な状態である（段3 の受け入れ基準） ---
  // **`list()` が空でも throw しない**こと。ここが落ちる器は「やり方が書かれて
  // いない仕事も普通に進む」を満たせない。
  const before = await practices.list();
  if (!Array.isArray(before)) fail('list() が配列を返さない');
  if ((await practices.read('contract-missing')) !== null) {
    fail('read() は無い slug に対して null を返すこと');
  }

  // --- 2. 末尾改行の正規化（記憶が3実装で食い違った穴。#370 と同じ形） ---
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
  // 既に改行で終わっているなら足さない
  const already = await practices.write({
    slug: 'contract-b',
    kind: '調査',
    title: '調べもののやり方',
    content: '# 調べもの\n',
  });
  if (already.content !== '# 調べもの\n') {
    fail(`既に改行で終わる本文に改行を足している: ${JSON.stringify(already.content)}`);
  }

  // --- 3. 一覧は slug の昇順（続きを取る口が依拠する契約） ---
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
  const listed = (await practices.list())
    .map((entry) => entry.slug)
    .filter((slug) => slug.startsWith('contract-'));
  if (listed.join(',') !== 'contract-a,contract-b,contract-c') {
    fail(`list() が slug の昇順になっていない: ${listed.join(',')}`);
  }

  // --- 4. `kind` は自由文字列である（列挙で弾かないこと） ---
  // **ここが落ちる器は、知らない種類のやり方を人間が書けない。** 列挙にしない
  // 判断の理由は `practiceKindSchema` の doc（north_star「実装専用に狭めるな」）。
  const exotic = await practices.write({
    slug: 'contract-d',
    kind: '外部サービスの確認',
    title: '確認のやり方',
    content: 'う',
  });
  if (exotic.kind !== '外部サービスの確認') {
    fail(`kind を自由文字列として保てていない: ${exotic.kind}`);
  }

  // --- 5. 上書きしても createdAt は引き継ぐ（作成時刻を捏造しない） ---
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

  // --- 6. 参照が漏れていない（#1072 と同じ穴。インメモリだけが踏む） ---
  // `store-isolation-contract.ts` の doc にある形をそのまま持ち込む——
  // **読んだ値を書き換えても器が汚れないこと**は、この器でも同じ性質である。
  const held = await practices.read('contract-a');
  if (held !== null) held.content = '読んだ側で書き換えた';
  if ((await practices.read('contract-a'))?.content !== 'あああ\n') {
    fail('read() が返した参照を書き換えたら、器の中身まで動いた');
  }
  const meta = (await practices.list()).find((entry) => entry.slug === 'contract-a');
  if (meta !== undefined) meta.title = '一覧の側で書き換えた';
  if ((await practices.read('contract-a'))?.title !== '実装のやり方（改）') {
    fail('list() が返した参照を書き換えたら、器の中身まで動いた');
  }

  // --- 7. chars はコードポイント数であって、UTF-16 のコード単位数でも UTF-8 の
  // バイト数でもない（#1340）。サロゲートペアで書かれる絵文字（1コードポイント）と
  // 結合文字（基底文字と分かれた別コードポイント）を両方含む本文で、
  // 実装（fs は `[...content].length`、pg は `char_length(content)`）が同じ数を
  // 返すこと。**期待値は本文そのものから独立に導く**（ストアの実装を信用しない）。
  const unicodeSource = '😀 é'; // 絵文字（サロゲートペア）+ 結合文字（e + 結合アキュート）
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
  const unicodeListed = (await practices.list()).find((entry) => entry.slug === 'contract-unicode');
  if (unicodeListed === undefined || unicodeListed.chars !== expectedChars) {
    fail(`list() の chars がコードポイント数になっていない: ${unicodeListed?.chars}`);
  }
  await practices.remove('contract-unicode');

  // --- 8. remove ---
  await practices.remove('contract-d');
  if ((await practices.read('contract-d')) !== null) fail('remove() の後も read() が返る');
  await practices.remove('contract-d'); // 二度目が落ちないこと（冪等）

  if (options.verifyClear !== true) {
    for (const slug of ['contract-a', 'contract-b', 'contract-c']) {
      await practices.remove(slug);
    }
    return;
  }

  // --- 9. clear（件数を返し、あとで空になる） ---
  const removed = await practices.clear();
  if (removed < 3) fail(`clear() が消した件数を返していない: ${removed}`);
  if ((await practices.list()).length !== 0) fail('clear() の後も list() が空にならない');
}
