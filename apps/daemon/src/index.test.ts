import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { tokenRotationStream } from './index.js';

/**
 * 認証トークン回りの日誌1行を stdout/stderr のどちらへ出すかの分類
 * （Issue #420 の残件）。
 *
 * **6値すべてを当てる。** 1つでも欠けると、次に分類を変える人（あるいは
 * `packages/core/src/schema.ts` の `token_rotation.event` へ新しい値を足す人）が
 * ここで気づけない。`tokenRotationStream` 自身は型で網羅性を守っている
 * （新しい event を足すと `pnpm typecheck` が落ちる）ので、この歯が測るのは
 * **いまの6値の割り当てが正しいか**である。
 *
 * `.write()` は呼ばない——同一性（`toBe`）だけを見る。本物の stdout/stderr へ
 * 書くと `vitest.setup.ts` の歯（#314）に掛かるので、それを避ける形にしてある。
 */
describe('tokenRotationStream', () => {
  it.each([
    ['rotated', 'stdout'],
    ['not_rotated', 'stdout'],
    ['restored', 'stdout'],
    ['exhausted', 'stderr'],
    ['sweep_stopped', 'stderr'],
    ['restore_failed', 'stderr'],
  ] as const)('%s は %s へ出す', (event, expected) => {
    const stream = tokenRotationStream(event);

    expect(stream).toBe(expected === 'stdout' ? process.stdout : process.stderr);
  });
});

/**
 * 器の入れ替え（`onSwap`）を引き取りの契機へ繋ぐ配線を固定する（Issue #203 の項目2）。
 *
 * ## 何を固定したいのか
 *
 * **「器が入れ替わった」という知らせが、引き取りの口へ実際に繋がっていること。**
 * そして繋がる先が**2つとも**であること — 走行中だった委譲（`reattachRunner`）と、
 * 台帳にしか無い委譲（`takeOver` → `restore`）。`index.ts` の逐語がその理由を持つ:
 * `grep -Fn -- '`restore()` だけに繋いだ版は1本も拾えなかった' apps/daemon/src/index.ts`
 *
 * ## なぜ原文を読むのか
 *
 * この配線は `main()` の中の局所変数（`let takeOverOnSwap`）に載っていて、
 * **型でも実行時でも表せない** — `main()` を呼ばずに触れる口が無く、`main()` は
 * 台帳・HTTP の口・runner の名簿を丸ごと立ち上げる。同じ理由で原文を読む歯が
 * 既に隣に在る: `grep -Fn -- '原文を読むのは、型でも実行時でもこの不変条件を' apps/daemon/src/app.test.ts`
 *
 * ## 本文の一致では固定しない
 *
 * 守りたいのは**呼びが在るか無いか**であって、知らせの文言でも並び順でもない。
 * 文言で固定すると、無関係な言い回しの手直しで赤くなり、**守りたかったものと
 * 関係の無い理由で緩められる**。だから注釈行を落として、呼びの有無だけを見る。
 *
 * **この歯が測らないもの**: 実際に引き取りが成功すること（`ManagerPool` の関門が
 * 持つ判断で、`packages/core` 側の歯が見ている）。ここが約束するのは配線だけである。
 */
describe('onSwap から引き取りへの配線（index.ts の原文）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  /**
   * 字下げで閉じる1ブロックを取り出す。**Prettier が整形した形に乗っている**
   * （閉じ括弧は開いた行と同じ深さへ戻る）。`pnpm format:check` が同じ形を
   * 守っているので、この前提が崩れるときは先にそちらが赤くなる。
   */
  const blockOf = (opener: RegExp): string[] => {
    const lines = source.split('\n');
    const heads = lines.filter((line) => opener.test(line));
    // **1つに定まらないなら、以下の判定は別の場所を見ている。**
    expect(heads).toHaveLength(1);
    const start = lines.findIndex((line) => opener.test(line));
    const indent = (/^\s*/.exec(lines[start] ?? '')?.[0] ?? '').length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      if ((/^\s*/.exec(line)?.[0] ?? '').length <= indent) return lines.slice(start, i + 1);
    }
    throw new Error('ブロックの終わりが見つからない（字下げの前提が崩れている）');
  };

  /** 注釈の行は経路ではない。 */
  const code = (lines: string[]): string[] =>
    lines.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));

  it('入れ替えの知らせが、引き取りの口を宛先つきで起こす', () => {
    const calls = code(blockOf(/^\s*onSwap:\s*\(/)).filter((line) =>
      line.includes('takeOverOnSwap('),
    );

    // 知らせるだけに戻すと、受け入れ基準6 が誰にも起こされなくなる。
    expect(calls).not.toEqual([]);
    // **宛先を落とさない。** 引数無しで呼ぶと、走行中だった委譲を拾う側
    // （`reattachRunner`）が下の `runnerId !== undefined` で素通りする。
    expect(calls.filter((line) => /takeOverOnSwap\(\s*\)/.test(line))).toEqual([]);
  });

  it('その口は、走行中の委譲と台帳だけの委譲を両方とも起こす', () => {
    const body = code(blockOf(/^\s*takeOverOnSwap\s*=\s*\(/));

    // 走行中だった委譲（デーモンの像に載っている分）。
    expect(body.filter((line) => line.includes('reattachRunner('))).not.toEqual([]);
    // 台帳にしか無い委譲。片方だけにすると、片側が丸ごと落ちる。
    expect(body.filter((line) => line.includes('takeOver('))).not.toEqual([]);
  });
});
