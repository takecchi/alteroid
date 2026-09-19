import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { InboxEvent } from '@alteroid/core';

import {
  createCloneWakeGate,
  describeReopenedTokenNotice,
  isTokenPoolReopenedNotice,
  reopenedTokenOf,
  tokenRotationStream,
  TOKEN_POOL_REOPENED_SOURCE,
  worthDeliveringNow,
} from './index.js';
import type { CloneWakeGate } from './index.js';

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
    ['reopened', 'stdout'],
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
describe('index.ts の原文で測る配線（onSwap の引き取り / 枠の観測の振り分け）', () => {
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

  it('⚠️ 成功の観測は observe へ落ちない（#681 (1)。2本目の生産者へ振る）', () => {
    // **`observe` は枠の観測しか扱わない。** 成功がそこへ落ちると、記録を
    // `usable` へ戻す経路（`reconsider` の `turn_success`）が呼ばれないまま
    // 「何も起きない」——#681 が直そうとしている症状そのものへ戻る。
    // **見えない側の壊れ方なので、配線そのものを測る**（この describe の趣旨）。
    const body = code(blockOf(/^\s*onUsageObservation:\s*async\s*\(/));

    const branch = body.findIndex((line) => line.includes('observation.succeeded === true'));
    const handoff = body.findIndex((line) => line.includes('observeTurnSuccess('));
    const escape = body.findIndex((line) => /^\s*return;\s*$/.test(line));
    const observe = body.findIndex((line) => line.includes('tokenRotator.observe('));

    // 4つとも在ること。どれか1つでも消えると、成功が `observe` へ落ちる。
    expect([branch, handoff, escape, observe].filter((i) => i < 0)).toEqual([]);
    // **順番が意味を持つ。** 振り分け → 2本目の生産者 → 抜ける → その後で
    // `observe`。`return` が `observe` より後ろへ回ると、成功が両方を通る。
    expect(branch).toBeLessThan(handoff);
    expect(handoff).toBeLessThan(escape);
    expect(escape).toBeLessThan(observe);
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
        recovered: { tokenId: 'tok-a', label: '本命', source: 'account_probe' },
        why: 'probe で通ることを観測できた',
      }),
    ).toEqual({ tokenId: 'tok-a', label: '本命', how: 'また通るようになった' });
  });

  it('現役の冷却が明けた回も戻ったと数える（#833）', () => {
    // **これが無かったせいで、鍵が通るのに誰も動かない時間ができた**（実測
    // 2026-09-11 の本番で約38分）。**`recovered` とは `how` で言い分ける** ——
    // あちらは観測、こちらは時計である。
    expect(
      reopenedTokenOf({
        kind: 'ignored',
        signal: 'none',
        reason: 'tick',
        reopened: {
          tokenId: 'tok-a',
          label: '本命',
          cooldownUntil: '2026-09-11T13:20:00.000Z',
        },
        why: '現役の冷却が明けた',
      }),
    ).toEqual({ tokenId: 'tok-a', label: '本命', how: '冷却が明けた' });
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
    //
    // **1行では見ない**（`clone.managers.restore(` の literal で見ていたが、
    // 2本を繋いだ時点で prettier が `clone.managers` と `.restore()` を別の行へ
    // 割った）。守りたいのは「どの口を呼ぶか」であって、書き方ではない
    // ——すぐ下の `recycled` の歯が同じ理由で同じ形にしてある。
    expect(block).toContain('clone.managers');
    expect(block).toContain('.restore(');
    // **枠で止まった委譲も起こす。** `restore()` はプロセス内の像に無い委譲しか
    // 拾わず（`#restoreJobs` の先頭の `#records.has`）、resume するのも台帳が
    // `running` / `waiting_human` の分だけである ⟹ 枠で終わったターン
    // （`done` / `failed` / `lost`）は**どちらの条件からも外れる**。ここを外すと、
    // 鍵が戻っても走っていた委譲が止まったまま残る。
    expect(block).toContain('.resumeStoppedByUsage(');
  });

  it('指名が変わったらクローンのセッションを作り直す（parked も含む）', () => {
    // env は起動時に凍るので、作り直さないと古い鍵のまま再挑戦して同じところで
    // 止まる。**`parked` を外すと、冷却が明けた後に古い鍵のまま挑む形が残る。**
    // **1行では見ない**（2026-09-07 に複数行の三項へ変わった）。守りたいのは
    // 「どちらの `kind` でも作り直す」ことであって、書き方ではない。
    const at = source.indexOf('const recycled =');
    expect(at).toBeGreaterThan(-1);
    const decl = source.slice(
      at,
      source.indexOf(';', source.indexOf('recycleSessionForToken()', at)),
    );

    expect(decl).toContain("outcome.kind === 'rotated'");
    expect(decl).toContain("outcome.kind === 'parked'");
    expect(decl).toContain('clone.recycleSessionForToken()');
  });
});

/**
 * **再開の合図を入れる時機**（人間の決定 2026-09-07）。
 *
 * ## この歯が固定している事故
 *
 * 実運用（2026-09-07、Railway の本番。デプロイは `2fb8177a`）で観測した形:
 *
 * | 時刻 (UTC) | 何が起きたか |
 * | --- | --- |
 * | `07:33:12` | 回した（世代41 `production` → 世代42 `staging`）。**合図もここで入れた** |
 * | `07:33:18`〜`50` | クローンはターンの最中（`tool_use` が続く）⟹ セッションは畳まれない |
 * | `07:33:51` | そのターンが**古い鍵**で `success/429`（`You've hit your session limit`） |
 * | `07:33:51.697`〜`.759` | 保持していた合図21件が**また保持へ戻った** |
 * | 以降26分 | **沈黙。** 合図はもう使われていて、再投函する者が居ない |
 *
 * ⟹ **合図は「セッションが実際に畳まれた後」に入れなければならない。**
 *
 * `settleTokenOutcome` は `main()` の中に在って型でも実行時でも触れないので、
 * **原文を読んで配線だけを固定する**（隣の `takeOverOnSwap` の歯と同じ理由）。
 */
describe('再開の合図は、セッションが畳まれた後に入れる', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const reopened = reopenedTokenOf(outcome);'));
  const block = body.slice(0, body.indexOf('\n    if (entry === null) return;'));

  it('recycleSessionForToken の返り値を捨てていない', () => {
    // **捨てると時機を決められない。** `'deferred'` の回に先に入れると、合図は
    // 古い鍵のターンに消費される（上の実測）。
    expect(source).toContain('clone.recycleSessionForToken()');
    expect(source).toMatch(/const recycled =[\s\S]*clone\.recycleSessionForToken\(\)/);
  });

  it("'now' のときだけ即座に入れ、'deferred' なら保留する", () => {
    expect(block).toContain("if (recycled === 'now') wake();");
    expect(block).toContain('else pendingTokenWake = wake;');
  });

  it('保留した合図は onTokenSessionRecycled で入る（取り出してから呼ぶ）', () => {
    // **取り出してから呼ぶ。** 呼んだ後に消すと、合図の中で例外が出た回だけ
    // 残り続け、次に畳まれたときにもう一度入る。
    const hook = source.slice(source.indexOf('onTokenSessionRecycled: () => {'));
    const hookBody = hook.slice(0, hook.indexOf('\n    },'));
    expect(hookBody).toContain('const wake = pendingTokenWake;');
    expect(hookBody).toContain('pendingTokenWake = undefined;');
    expect(hookBody).toContain('wake?.();');
    // 消す前に呼ぶ形になっていない。
    expect(hookBody.indexOf('pendingTokenWake = undefined;')).toBeLessThan(
      hookBody.indexOf('wake?.();'),
    );
  });

  it('保留は高々1つしか持たない（後の1回だけが要る）', () => {
    // 配列で溜めると、畳むより先に2回回った回に「もう古い鍵の話」の合図まで入る。
    expect(source).toContain('let pendingTokenWake: (() => void) | undefined = undefined;');
  });
});

/**
 * `CloneWakeGate.decide` の第1引数を作る（Issue #1223 で `tokenId` の生文字列
 * から `{ tokenId, label, how }` へ変わった）。
 *
 * **`ReopenedHow` を import しない。** `index.ts` 側でこの型を export していない
 * ため（`ReopenedToken` / `ReopenedHow` はファイル内部だけの型）、ここでは
 * 同じ3値を持つローカルの型を宣言する——リテラル文字列の集合が一致していれば、
 * 構造的部分型で `decide` の引数として渡せる（名前ではなく値の集合で見る）。
 */
type ReopenedHowFixture = 'また通るようになった' | '回した' | '冷却が明けた';

function reopened(
  tokenId: string,
  how: ReopenedHowFixture = 'また通るようになった',
): { tokenId: string; label: string; how: ReopenedHowFixture } {
  return { tokenId, label: tokenId, how };
}

/**
 * **クローンへ配るか畳むかの判定**（Issue #783 / #1223。`CloneWakeGate` の doc）。
 *
 * ## なぜここを測るのか
 *
 * クローンが枠で止まっていなければ、「認証トークンが通る状態に戻った」の合図は
 * `clone.ts` の `post()` の `if (this.#usageBlocked !== null) this.#releaseRequested
 * = true;` を1文字も動かさない——ターンを1本焼くだけで何もしない。だから止まって
 * いないときは配らず畳む。**⛔ 譲れない不変条件はこの逆**: クローンが止まって
 * いて、かつ**前と違う知らせ**（別トークン／別の `how`／`observeUnusable` の
 * あとの同じ知らせ）なら、畳んだ回数によらず必ず配る（`kind: 'wake'`）。
 */
describe('createCloneWakeGate', () => {
  it('クローンが枠で止まっているなら配る（畳んでいなければ folded は0）', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });
  });

  it('クローンが枠で止まっていないなら畳む（配らない）', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
  });

  it('畳んだ回数を数え、配る回にその数を渡す', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    // 3回畳んだ後に配ると、畳んだ数（3）を持って `wake` が返る。
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 3 });
  });

  it('配ったら0へ戻る（次に畳み始めたら1から数え直す）', () => {
    const gate = createCloneWakeGate();

    gate.decide(reopened('tok-a'), false, false);
    gate.decide(reopened('tok-a'), false, false);
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 2 });

    // **Issue #1223 の歯**: 配った直後、何も変わっていなければ同じ身元
    // （同じトークン・同じ `how`）を続けて呼んでも配らない——ここが実運用の
    // 「2分半に60回」を止めている本体である。
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'fold' });

    // 鍵が通らなくなったことを観測すれば（`parked` / `exhausted`）、同じ身元でも
    // 次は「新しい知らせ」として配り直せる。
    gate.observeUnusable();
    // 折り返して配れば、直前の1回ぶんの畳み込み（folded: 1）を持って配られる。
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 1 });
    // 改めて blocked=false で1回畳めば（`!cloneBlocked` も身元を一緒に忘れる）、
    // 次は1から数え直して配れる。
    gate.decide(reopened('tok-a'), false, false);
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 1 });
  });

  it('トークンごとに独立して数える', () => {
    const gate = createCloneWakeGate();

    gate.decide(reopened('tok-a'), false, false);
    gate.decide(reopened('tok-a'), false, false);
    // tok-b は tok-a の畳み込みに影響されない。
    expect(gate.decide(reopened('tok-b'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    // tok-a のカウントはそのまま残っている。
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 2 });
  });

  /**
   * **🔴 不変条件3（最重要）**: 「落ちる→戻る→また落ちる→また戻る」で、
   * **2本目の「戻った」も必ず届く**。
   *
   * 畳み込みは「本当に新しい回復」を消してはいけない。1回目の `wake` で配った
   * 直後にクローンがまた枠で止まり、再び通るようになった2回目の観測が届いた
   * ときも、`cloneBlocked` がそのつど `true` である限り `decide` は必ず
   * `kind: 'wake'` を返す——`folded` の値（内部状態）に依存して `wake` が
   * `fold` に化けることは無い。
   *
   * **この不変条件は #1223 の歯と両立する** —— ここでは毎回
   * `cloneBlocked=false` の回を挟んでいる（本物の `#pump` が保持分を戻して
   * 再試行する回に対応する）。`false` の回が `told` を捨てるので、次の
   * `true` の回は必ず「新しい知らせ」として届く。**間を挟まずに `true` を
   * 2回連続で呼ぶ形は、この不変条件が指す状況ではない**——それは「まだ
   * 何も変わっていないのに同じ知らせが2回来た」という #1223 の症状そのもの
   * で、直上のテストが指すとおり2回目は畳む。
   */
  it('🔴 不変条件3: 落ちる→戻る→また落ちる→また戻る で2本目の「戻った」も必ず届く', () => {
    const gate = createCloneWakeGate();

    // 1回目: クローンは枠で止まっている（落ちている）→ 戻ったら配る。
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });

    // 配った直後、クローンはまだ枠で止まっていない状態が続く（この間に届いた
    // 「戻った」はすべて畳む——まだ本物の再起動が要る状態ではない）。
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });

    // また枠に当たって落ちた。その後もう一度「戻った」が観測された
    // ——ここが2本目の「戻った」である。畳み込みの結果として消えてはいけない。
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 1 });

    // 3本目も同様に届く（何回繰り返しても、止まっているときは必ず配る）。
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), false, false)).toEqual({ kind: 'fold' });
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 2 });
  });

  /**
   * **🔴 Issue #1223 の本体**: 何も変わっていない（`cloneBlocked` も
   * `releasePending` も動かず、`observeUnusable` も呼ばれない）まま同じ身元が
   * 何十回来ても、配るのは最初の1回だけ。
   *
   * 実運用（2026-09-18〜19）の実測は「2分半に60回以上」——ここでは同じ形を
   * 60回で固定する。**この歯は、この branch のコミット
   * （`f6665a0664060435c7d38e19c8af48c883265f2f`）より前の `main`
   * （引数が `tokenId: string` だけで `told` を持たない版）に当てると
   * 全件 `wake` を返して赤くなる**（このコミットで初めて `told` の判定が入った）。
   */
  it('🔴 #1223: 同じ身元が60回続けて来ても、配るのは最初の1回だけ', () => {
    const gate = createCloneWakeGate();

    const kinds = Array.from(
      { length: 60 },
      () => gate.decide(reopened('tok-a'), true, false).kind,
    );

    expect(kinds[0]).toBe('wake');
    expect(kinds.slice(1)).toEqual(Array.from({ length: 59 }, () => 'fold'));
  });

  /**
   * **複数トークンが混在しても、他のトークンの配達に巻き込まれて畳み損ねない**
   * （Issue #1223 の3つ目の歯の実装 — `told` を単一の値ではなくトークンごとの
   * `Map` にした理由そのもの）。
   *
   * 単一の変数（最初の実装）だと、A を配って `told=A`、次に B を配って
   * `told=B`（A の記録を上書き）、その直後に A の**同じ**身元が
   * （新しい観測なしに）もう一度来ると `told !== A の身元` になり、
   * 畳むべきものが配られてしまう。ここではその順で並べ、A の2回目が
   * `fold` のままであることを固定する。
   */
  it('別のトークンの配達に挟まれても、先のトークンの重複は畳まれ続ける', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    // tok-b は別の身元なので、`releasePending` を経由せずここへ来ても配られる
    // （枠がトークンごとではなくクローン全体のものだとしても、`told` の識別は
    // トークンごとに独立している）。
    expect(gate.decide(reopened('tok-b'), true, false)).toEqual({ kind: 'wake', folded: 0 });
    // tok-a の同じ身元がもう一度来ても、tok-b の配達には巻き込まれず畳む。
    expect(gate.decide(reopened('tok-a'), true, false)).toEqual({ kind: 'fold' });
  });
});

/**
 * 判定の的になる `external` の合図を1件作る。
 *
 * **`source` を引数で受けるのは、呼び出し側でスプレッドさせないためである。**
 * `{ ...tokenPoolEvent(), source: '別の値' }` と書くと `InboxEvent` は union
 * なので、スプレッドの結果も union になり、`source` を持たない枝
 * （`human_message` など）に対して余剰プロパティとみなされて `TS2322` で落ちる。
 * **引数で差し替えればスプレッドが要らず、型の細工も要らない。**
 */
function tokenPoolEvent(source: string = TOKEN_POOL_REOPENED_SOURCE): InboxEvent {
  return {
    type: 'external',
    id: 'evt-token-pool-1',
    at: '2026-09-07T00:00:00.000Z',
    source,
    payload: { text: 'ダミー' },
  };
}

/**
 * **`isTokenPoolReopenedNotice`**（Issue #783 続き）。
 *
 * 型と `source` だけを見る——他の欄（`payload` の中身）は判定に関わらない。
 */
describe('isTokenPoolReopenedNotice', () => {
  it('external かつ source が token-pool なら真', () => {
    expect(isTokenPoolReopenedNotice(tokenPoolEvent())).toBe(true);
  });

  it('external でも source が違えば偽', () => {
    const event = tokenPoolEvent('runner-registry');
    expect(isTokenPoolReopenedNotice(event)).toBe(false);
  });

  it('external 以外は真になりようがない（型で弾かれる）', () => {
    const event: InboxEvent = {
      type: 'human_message',
      id: 'evt-human-1',
      at: '2026-09-07T00:00:00.000Z',
      text: 'こんにちは',
      conversationId: 'conv-1',
    };
    expect(isTokenPoolReopenedNotice(event)).toBe(false);
  });
});

/**
 * **⭐⭐ 歯1（最重要）: `CloneWakeGate.decide` と `#restoreUnread` の門
 * （`redeliveryGate`）が同じ答えを返す**（Issue #783 続き）。
 *
 * ## なぜこの歯が要るか
 *
 * `wake()`（`clone.post(...)` 越しの経路）と `createClone(...)` の
 * `redeliveryGate`（`#restoreUnread` の経路）は、判定の実体を**同じ
 * `worthDeliveringNow` から呼ぶ**ことで揃えてある（`RedeliveryGate` の doc、
 * `worthDeliveringNow` の doc「呼び手は2つある」）。**コピーがあれば片方だけを
 * 直したときに黙ってずれる。** この歯は、その一致を関数として固定する——
 * どちらか片方だけを直した人は、ここで必ず赤にぶつかる。
 *
 * ## 何を測るか
 *
 * `blocked` × `releasePending` の**4通り全部**で、
 * `cloneWakeGate.decide(tokenId, blocked, releasePending).kind === 'wake'` と
 * `redeliveryGate(tokenPoolEvent, { usageBlocked, releasePending }) === true` が
 * 一致すること（**組を1つでも落とすと、片側だけが Issue #1051 の畳み込みを
 * 持っている状態が緑のまま通る**）。`redeliveryGate` は本番の配線（`index.ts` の `createClone(...)`）と
 * **同じ2つの部品**（`isTokenPoolReopenedNotice` / `worthDeliveringNow`）から
 * 組み立てる——配線そのものが同じ部品を呼んでいることは、直後の「本番の配線」
 * describe が原文で固定する。
 */
describe('歯1: CloneWakeGate.decide と redeliveryGate は同じ答えを返す', () => {
  // **本番の `createClone(...)` に渡す `redeliveryGate` と同じ形。** 部品
  // （`isTokenPoolReopenedNotice` / `worthDeliveringNow`）が本番と同一の実体で
  // あることは import 経由で保証されている——コピーはしていない。
  const redeliveryGate = (
    event: InboxEvent,
    context: { usageBlocked: boolean; releasePending: boolean },
  ): boolean =>
    isTokenPoolReopenedNotice(event)
      ? worthDeliveringNow(context.usageBlocked, context.releasePending)
      : true;

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const)(
    'usageBlocked=%s / releasePending=%s のとき、wake の判定と一致する',
    (blocked, releasePending) => {
      const gate = createCloneWakeGate();

      const wakeSaysWake = gate.decide(reopened('tok-a'), blocked, releasePending).kind === 'wake';
      const gateSaysDeliver = redeliveryGate(tokenPoolEvent(), {
        usageBlocked: blocked,
        releasePending,
      });

      expect(gateSaysDeliver).toBe(wakeSaysWake);
    },
  );

  it('token-pool 以外の合図は usageBlocked / releasePending に関わらず常に配る（wake 側の対象外）', () => {
    const other = tokenPoolEvent('runner-registry');
    expect(redeliveryGate(other, { usageBlocked: true, releasePending: false })).toBe(true);
    expect(redeliveryGate(other, { usageBlocked: false, releasePending: false })).toBe(true);
    expect(redeliveryGate(other, { usageBlocked: true, releasePending: true })).toBe(true);
    expect(redeliveryGate(other, { usageBlocked: false, releasePending: true })).toBe(true);
  });
});

/**
 * **本番の配線が実際に `isTokenPoolReopenedNotice` / `worthDeliveringNow` を
 * 呼んでいること**（Issue #783 続き）。
 *
 * `createClone(...)` は `main()` の中に在り、型でも実行時でも触れない
 * （隣の `takeOverOnSwap` の歯と同じ理由）。**原文を読んで、配線が上の歯1と
 * 同じ部品を呼んでいることだけを固定する。**
 */
describe('本番の配線: redeliveryGate は wake() と同じ部品を呼ぶ', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('redeliveryGate が isTokenPoolReopenedNotice と worthDeliveringNow を呼ぶ', () => {
    const at = source.indexOf('redeliveryGate: (event, { usageBlocked, releasePending })');
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf('\n  });', at));

    expect(block).toContain('isTokenPoolReopenedNotice(event)');
    // **引数2つとも原文で見る（Issue #1051）。** `releasePending` を渡し忘れた
    // 配線は型では落ちない——落ちないまま、配り直しの側だけが往復を通し続ける。
    expect(block).toContain('worthDeliveringNow(usageBlocked, releasePending)');
  });
});

/**
 * **配る合図の本文に、畳んだ件数が出ること**（Issue #783）。
 *
 * 不変条件2（母数を落とさない）の裏付け——受信箱には1件しか入らなくても、
 * 本文を読めば何件を1件にまとめたかが分かる。
 */
describe('describeReopenedTokenNotice', () => {
  const reopened = { tokenId: 'tok-a', label: '本命', how: 'また通るようになった' as const };

  it('畳んでいなければ断り書きを付けない', () => {
    const text = describeReopenedTokenNotice(reopened, 0);

    expect(text).toContain('認証トークンが通る状態に戻った（また通るようになった）');
    expect(text).toContain('「本命」（id tok-a）');
    expect(text).not.toContain('まとめた');
  });

  it('畳んだ件数が本文に出る（届いた総数 ＝ 畳んだ数 + 配った1件）', () => {
    const text = describeReopenedTokenNotice(reopened, 3);

    // 3件畳んで1件配った ＝ この間に届いたのは4件。
    expect(text).toContain('4 件届き、1件にまとめた');
  });

  it('how が「回した」でも同じ形で本文に出る', () => {
    const text = describeReopenedTokenNotice({ ...reopened, how: '回した' }, 1);

    expect(text).toContain('認証トークンが通る状態に戻った（回した）');
    expect(text).toContain('2 件届き、1件にまとめた');
  });
});

/**
 * **クローンの門は `wake()` の中の `clone.post(...)` だけを絞る**（Issue #783）。
 *
 * `restore()` / `resumeStoppedByUsage()` はこの門と無関係に呼ぶ——マネージャーは
 * クローンと独立に枠で止まりうるので、一緒に絞ると「起こすべき委譲が起きない」
 * 壊し方になる。`wake()` は `main()` の中の閉包で型でも実行時でも触れないので、
 * 原文を読んで配線を固定する（隣の describe と同じ理由）。
 */
/**
 * 字面を見る歯（`wake()` が `main()` の中の閉包で実行時に触れないため）の
 * **失敗を読める形にするための小道具**（Issue #783）。
 *
 * `indexOf` の生の値を `toBeGreaterThan(-1)` で見ると、失敗が
 * `expected -1 to be greater than -1` になり、**どの目印が消えたのかが
 * 出力から読めない。** いちばん起きやすい壊れ方が「目印の字面を変えた／
 * 整形が入った」なので、そこを名指しできないと歯の値が半分になる。
 *
 * @returns `body` に見つからなかった目印だけを並べた配列（全部在れば空）。
 */
function missingAnchors(body: string, anchors: readonly string[]): string[] {
  return anchors.filter((anchor) => !body.includes(anchor));
}

describe('クローンの門は clone.post だけを絞る（restore / resumeStoppedByUsage は無条件）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const wakeStart = source.indexOf('const wake = () => {');
  const wakeEnd = source.indexOf('\n      if (recycled === ', wakeStart);
  const wakeBody = source.slice(wakeStart, wakeEnd);

  it('clone.post は cloneWakeGate.decide の判定の中にある', () => {
    const decideAt = wakeBody.indexOf('cloneWakeGate.decide(');
    const postAt = wakeBody.indexOf('clone.post(');
    const ifFoldAt = wakeBody.indexOf("decision.kind === 'fold'");

    // 目印が消えていたら、消えた目印そのものを出す（`missingAnchors` の doc）。
    expect(
      missingAnchors(wakeBody, [
        'cloneWakeGate.decide(',
        'clone.post(',
        "decision.kind === 'fold'",
      ]),
    ).toEqual([]);
    // 判定 → 畳む/配るの分岐 → clone.post の順で並んでいる
    // ⟹ clone.post は判定より後ろの、分岐の中にある。
    expect(decideAt).toBeLessThan(ifFoldAt);
    expect(ifFoldAt).toBeLessThan(postAt);
  });

  it('restore() / resumeStoppedByUsage() は判定の分岐（if/else）の外にある', () => {
    // 分岐（`if (decision.kind === 'fold') { ... } else { ... }`）の閉じを
    // 探し、その後ろで呼ばれていることを確かめる。
    const restoreAt = wakeBody.indexOf('clone.managers');
    const resumeAt = wakeBody.indexOf('.resumeStoppedByUsage(');
    const postAt = wakeBody.indexOf('clone.post(');

    expect(
      missingAnchors(wakeBody, ['clone.managers', '.resumeStoppedByUsage(', 'clone.post(']),
    ).toEqual([]);
    // clone.post（分岐の中）より後ろに在る ＝ 分岐を抜けてから呼んでいる。
    expect(postAt).toBeLessThan(restoreAt);
    expect(restoreAt).toBeLessThan(resumeAt);
  });
});

/**
 * **`recovered` の日誌行は、受信箱へ配ったかどうかと無関係に必ず出る**
 * （依頼者の明示的な決定）。
 *
 * `journal_read types=["token_rotation"]` で全数を読み戻す運用がこれに
 * 依存している——⛔ 日誌への記録を、配達（クローンの門）の条件の内側へ
 * 移してはいけない。
 *
 * `tokenRotationEntry`（`token-rotator.ts`）自体はクローンの状態を1つも
 * 受け取らない純関数なので、この性質は型のレベルで保たれている。ここで
 * 固定するのは呼び出し側（`settleTokenOutcome`）の配線——`entry` の計算と
 * `stores.journal.append` が、クローンの門（`reopened` ブロックの中の
 * `wake()`）より前後の別の場所にあり、分岐に巻き込まれていないこと。
 */
describe('recovered の日誌行は、受信箱へ配ったかどうかと無関係に必ず出る', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  // **`settleTokenOutcome` の本体だけに絞る。** `stores.journal.append(` はこの
  // 関数の外にも在る（起動時の撒き直し・その他の配線）——そこまで数えると
  // 「1箇所だけ」が測れない。関数の始まりから、次の宣言（見張りを起こす配線）の
  // 手前までを本体とみなす。
  const fnStart = source.indexOf('async function settleTokenOutcome(');
  const fnEnd = source.indexOf('tokenWatch = startTokenRotationWatch({', fnStart);
  const fnBody = source.slice(fnStart, fnEnd);

  it('entry の計算は、クローンの門（reopened のブロック）より前で行う', () => {
    const entryAt = fnBody.indexOf('const entry = tokenRotationEntry(outcome, observed);');
    const reopenedAt = fnBody.indexOf('const reopened = reopenedTokenOf(outcome);');

    expect(
      missingAnchors(fnBody, [
        'const entry = tokenRotationEntry(outcome, observed);',
        'const reopened = reopenedTokenOf(outcome);',
      ]),
    ).toEqual([]);
    expect(entryAt).toBeLessThan(reopenedAt);
  });

  it('journal への追記は settleTokenOutcome の中に1箇所だけで、クローンの門の分岐に複製されていない', () => {
    // **件数そのものではなく「何を数えたか」を出す。** `expected 2 to be 1` では
    // 「門の分岐へ複製された」のか「別の追記が増えた」のかが読めない。
    const occurrences = fnBody.split('stores.journal.append(entry)').length - 1;
    expect({ 'settleTokenOutcome の中の stores.journal.append(entry) の数': occurrences }).toEqual({
      'settleTokenOutcome の中の stores.journal.append(entry) の数': 1,
    });

    // その1箇所は `reopened` のブロック（`if (reopened !== undefined) { ... }`）
    // を閉じた後に在る ⟹ 畳んだ（配らなかった）回でも実行される。
    const reopenedBlockStart = fnBody.indexOf('if (reopened !== undefined) {');
    const appendAt = fnBody.indexOf('stores.journal.append(entry)');
    const closeAt = fnBody.indexOf('\n    }\n\n    if (entry === null) return;');

    expect(
      missingAnchors(fnBody, [
        'if (reopened !== undefined) {',
        '\n    }\n\n    if (entry === null) return;',
      ]),
    ).toEqual([]);
    expect(closeAt).toBeLessThan(appendAt);
    expect(reopenedBlockStart).toBeLessThan(closeAt);
  });
});

/**
 * **🔴 Issue #1051: 1回の再開の機会につき、配る合図は1件**
 *
 * ## なぜ真偽表では足りないか
 *
 * 上の `createCloneWakeGate` の describe が測っているのは `decide` の**引数**で
 * ある。**引数が現実のどの状態に対応するかは、そこからは分からない** ——
 * 「常に `fold` を返す」実装も、引数の並べ方を間違えた歯なら通ってしまう。
 *
 * ⟹ **ここでは、クローンの状態のほうを本物と同じ順序で動かす。** 動かし方が
 * 本物と一致していることは `packages/core/src/clone.test.ts` の
 * 「usageReleasePending（…Issue #1051）」が実物の `Clone` で固定している
 * （1件目の `post` で印が立ち、2件目は何も動かさず、印は `#pump` が消費する）。
 *
 * | このファイルの歯 | 測るもの |
 * | --- | --- |
 * | `createCloneWakeGate` | `decide` の引数と返り値の対応 |
 * | **ここ** | **本物と同じ順序で状態を動かしたとき、配る件数がいくつになるか** |
 * | `clone.test.ts` の `usageReleasePending` | その順序が実物の `Clone` と一致すること |
 */
describe('🔴 #1051: 1回の再開の機会につき、配る合図は1件', () => {
  /**
   * クローンの2つの窓（`usageBlocked` / `usageReleasePending`）を、本物と同じ
   * 遷移だけで動かす最小の模型。
   *
   * **勝手な遷移を足さないこと。** ここに無い動き方をさせると、測っているのは
   * 本物ではなくこの模型になる。
   *
   * ## `gate` を受け取り、`hitUsageLimit()` で `observeUnusable()` も呼ぶ理由（Issue #1223）
   *
   * **本物の `clone.ts` では、この2つは対になっている。** `#reportUsageNotice`
   * は `await this.#observeForTokenRotation({ notice })`
   * （→ `apps/daemon/src/index.ts` の `onUsageObservation` → `tokenRotator.observe`
   * → `settleTokenOutcome`。`outcome.kind` が `parked` / `exhausted` なら
   * `cloneWakeGate.observeUnusable()` を呼ぶ）を**待ってから**
   * `this.#usageBlocked = notice;` を代入する（`grep -Fn -- 'this.#usageBlocked = notice;' packages/core/src/clone.ts`
   * の直前の行）。⟹ **クローンが「まだ止まっていない」状態から「また止まった」
   * 状態へ移るときは、必ずその直前に `observeUnusable()` が走っている。**
   *
   * ここでこの対を省くと、この模型だけが本物より「told を持ち越しやすい」形に
   * なり、#1223 の歯（同じ身元は畳む）が #1051 の不変条件3（起こし損ねを
   * 作らない）を壊しているように**見えてしまう**——実際には壊れていない。
   * 本物はこの2つを必ず対にして呼ぶので、輪はここで閉じる。
   */
  function fakeClone(gate: CloneWakeGate) {
    let blocked = false;
    let pending = false;
    return {
      get usageBlocked() {
        return blocked;
      },
      get usageReleasePending() {
        return pending;
      },
      /**
       * 枠で落ちた（`#usageBlocked` が立つ）。**止まっていない状態から止まる
       * ときだけ `observeUnusable()` を呼ぶ**（`fakeClone` の doc、上）。
       * 既に止まっている状態でもう一度呼んでも（このテストでは使わない形だが）、
       * 二重に「鍵が通らなくなった」を観測したことにはしない。
       */
      hitUsageLimit() {
        if (!blocked) gate.observeUnusable();
        blocked = true;
      },
      /** 合図が届いた（`post()` の中の1文。止まっているときだけ印が立つ）。 */
      receiveNotice() {
        if (blocked) pending = true;
      },
      /** `#pump` の先頭 —— 印を消費して枠を降ろし、再試行へ入る。 */
      consumeRelease() {
        pending = false;
        blocked = false;
      },
    };
  }

  /** 門を通して、配ったなら合図をクローンへ渡す（`wake()` と同じ並び）。 */
  function emit(gate: CloneWakeGate, clone: ReturnType<typeof fakeClone>, tokenId: string) {
    const decision = gate.decide(reopened(tokenId), clone.usageBlocked, clone.usageReleasePending);
    if (decision.kind === 'wake') clone.receiveNotice();
    return decision.kind;
  }

  it('回復が2回続けて検出されても、配るのは1件だけ（往復のぶんを畳む）', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);
    clone.hitUsageLimit();

    // 429 → 成功 → 429 → 成功 …の往復で、回し手は「戻った」を何度でも立てる
    // （`packages/core/src/token-rotator.test.ts` の #1051 の describe が実測）。
    const kinds = [emit(gate, clone, 'tok-a'), emit(gate, clone, 'tok-a')];

    expect(kinds).toEqual(['wake', 'fold']);
  });

  it('何十件届いても、再試行が始まるまでは1件しか配らない', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);
    clone.hitUsageLimit();

    const kinds = Array.from({ length: 30 }, () => emit(gate, clone, 'tok-a'));

    expect(kinds.filter((kind) => kind === 'wake')).toEqual(['wake']);
    expect(kinds.filter((kind) => kind === 'fold')).toHaveLength(29);
  });

  it('🔴 回復 → 枠に入る → また回復 なら2件とも配る（起こし損ねを作らない）', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);

    // 1回目: 枠で止まって、戻った。
    clone.hitUsageLimit();
    const first = emit(gate, clone, 'tok-a');

    // クローンが印を使って再試行に入り、また枠で落ちた
    // （本物では、ここで `observeUnusable()` が対になって走る——`fakeClone` の doc）。
    clone.consumeRelease();
    clone.hitUsageLimit();

    // 2回目の「戻った」。**畳んではいけない** —— 前の印はもう使われている。
    const second = emit(gate, clone, 'tok-a');

    expect([first, second]).toEqual(['wake', 'wake']);
  });

  it('別のトークンが戻った回は、前のトークンの印に巻き込まれない', () => {
    const gate = createCloneWakeGate();
    const clone = fakeClone(gate);
    clone.hitUsageLimit();

    expect(emit(gate, clone, 'tok-a')).toBe('wake');
    // **同じクローンの印（`releasePending`）が立っているので、これは畳む。**
    // トークンが違っても `releasePending` はクローン1体につき1つで、既に
    // 立っている ⟹ 2件目が動かすものは無い（#1223 の `told` の話ではなく、
    // #1051 の `releasePending` がここでは効いている）。
    expect(emit(gate, clone, 'tok-b')).toBe('fold');

    // 再試行が入って、また枠で落ちたなら配る。
    clone.consumeRelease();
    clone.hitUsageLimit();
    expect(emit(gate, clone, 'tok-b')).toBe('wake');
  });
});
