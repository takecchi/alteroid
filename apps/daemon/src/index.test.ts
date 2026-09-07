import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { reopenedTokenOf, tokenRotationStream } from './index.js';

/**
 * 認証トークン回りの日誌1行を stdout/stderr のどちらへ出すかの分類
 * （Issue #420 の残件）。
 *
 * **全値を当てる。数はここに書かない**（数のほうが先に腐る。5 → 6 → 8 と実際に
 * 増えている）。1つでも欠けると、次に分類を変える人（あるいは
 * `packages/core/src/schema.ts` の `token_rotation.event` へ新しい値を足す人）が
 * ここで気づけない。`tokenRotationStream` 自身は型で網羅性を守っている
 * （新しい event を足すと `pnpm typecheck` が落ちる）ので、この歯が測るのは
 * **いまの割り当てが正しいか**である。
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
    ['parked', 'stderr'],
    ['recovered', 'stdout'],
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

/**
 * **「認証トークンが通る状態に戻った」の判定**（人間の決定 2026-09-07）。
 *
 * 人間の逐語: 「limitが来て止まってトークン回して復活したら復活させたことを
 * cloneやmanagerに通知する必要があるのでは？なぜならlimit来て止まっているので
 * セッションを再開する必要があるでしょ」
 *
 * ## なぜここを測るのか —— 間違え方が非対称である
 *
 * | 間違え方 | 何が起きるか | 見えるか |
 * | --- | --- | --- |
 * | 起こすべき回に起こさない | **止まったまま。**「復活したのに何もしない」 | **見えない**（何も起きないので） |
 * | 起こすべきでない回に起こす | 保持していた合図を1件無駄に焼く | 見える（日誌に失敗が並ぶ） |
 *
 * **見えない側の壊れ方が、この改修そのものの症状と同じ**なので、判定は測れる
 * 形にしてある（`reopenedTokenOf` の doc）。
 */
describe('reopenedTokenOf', () => {
  it('回した回は戻ったと数える（いま通る鍵に移った）', () => {
    expect(
      reopenedTokenOf({
        kind: 'rotated',
        toTokenId: 'tok-b',
        toLabel: '予備1',
        generation: 2,
        signal: 'reached',
        spread: [],
        why: '枠',
      }),
    ).toEqual({ tokenId: 'tok-b', label: '予備1', how: '回した' });
  });

  it('止まっていた現役が開いた回も戻ったと数える', () => {
    expect(
      reopenedTokenOf({
        kind: 'ignored',
        signal: 'none',
        reason: 'account_probe',
        recovered: { tokenId: 'tok-a', label: '本命' },
        why: 'probe で通ることを観測できた',
      }),
    ).toEqual({ tokenId: 'tok-a', label: '本命', how: 'また通るようになった' });
  });

  it('parked は戻っていない（撒いた鍵はまだ通らない）', () => {
    // **ここを `rotated` と同じに扱うと、保持していた合図を1件焼いて同じ
    // ところで止まる。** 冷却が明ければ枠の probe が `usable` を観測し、
    // `recovered` として戻ってくる。
    expect(
      reopenedTokenOf({
        kind: 'parked',
        tokenId: 'tok-b',
        label: '予備1',
        generation: 2,
        cooldownUntil: Date.parse('2026-09-07T05:00:00.000Z'),
        signal: 'stranded',
        spread: [],
        why: 'いま通る候補は1本も無い',
      }),
    ).toBeUndefined();
  });

  it('何も起きていない回は戻っていない（目盛りが毎分ここへ来る）', () => {
    expect(
      reopenedTokenOf({
        kind: 'ignored',
        signal: 'none',
        reason: 'tick',
        why: '記録の上ではいまの現役が通る',
      }),
    ).toBeUndefined();
  });

  it('候補が無い回は戻っていない', () => {
    expect(
      reopenedTokenOf({
        kind: 'exhausted',
        signal: 'reached',
        why: '試せる候補を使い切った',
      }),
    ).toBeUndefined();
  });
});

/**
 * **通る鍵に戻ったら、止まっていた層を起こす配線**（人間の決定 2026-09-07）。
 *
 * `settleTokenOutcome` は `main()` の中に在り、型でも実行時でも触れない
 * （隣の `takeOverOnSwap` の歯と同じ理由）⟹ **原文を読んで、呼びが在ることだけを
 * 固定する。** 判定そのものは上の `reopenedTokenOf` の歯が測る。
 */
describe('通る鍵に戻ったときに起こす配線', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('クローンへ合図を1つ入れ、マネージャーの引き取りも起こす', () => {
    const body = source.slice(source.indexOf('const reopened = reopenedTokenOf(outcome);'));
    const block = body.slice(0, body.indexOf('\n    if (entry === null) return;'));

    // クローン: 受信箱へ合図。これが `#usageBlocked` の解除の契機になる
    // （`clone.ts` の `#releaseRequested`）。
    expect(block).toContain('clone.post(');
    // マネージャー: 台帳に残っている委譲を resume する。**片方だけにすると、
    // 片側の層が丸ごと止まったまま残る。**
    expect(block).toContain('clone.managers.restore(');
  });

  it('指名が変わったらクローンのセッションを作り直す（parked も含む）', () => {
    // env は起動時に凍るので、作り直さないと古い鍵のまま再挑戦して同じところで
    // 止まる。**`parked` を外すと、冷却が明けた後に古い鍵のまま挑む形が残る。**
    const line = source.split('\n').find((text) => text.includes('clone.recycleSessionForToken()'));

    expect(line).toContain("outcome.kind === 'rotated'");
    expect(line).toContain("outcome.kind === 'parked'");
  });
});
