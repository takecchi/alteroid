import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createCloneWakeGate,
  describeReopenedTokenNotice,
  reopenedTokenOf,
  tokenRotationStream,
} from './index.js';

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
 * **クローンへ配るか畳むかの判定**（Issue #783。`CloneWakeGate` の doc）。
 *
 * ## なぜここを測るのか
 *
 * クローンが枠で止まっていなければ、「認証トークンが通る状態に戻った」の合図は
 * `clone.ts` の `post()` の `if (this.#usageBlocked !== null) this.#releaseRequested
 * = true;` を1文字も動かさない——ターンを1本焼くだけで何もしない。だから止まって
 * いないときは配らず畳む。**⛔ 譲れない不変条件はこの逆**: クローンが止まって
 * いるときは、畳んだ回数によらず必ず配る（`kind: 'wake'`）。
 */
describe('createCloneWakeGate', () => {
  it('クローンが枠で止まっているなら配る（畳んでいなければ folded は0）', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 0 });
  });

  it('クローンが枠で止まっていないなら畳む（配らない）', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide('tok-a', false)).toEqual({ kind: 'fold' });
  });

  it('畳んだ回数を数え、配る回にその数を渡す', () => {
    const gate = createCloneWakeGate();

    expect(gate.decide('tok-a', false)).toEqual({ kind: 'fold' });
    expect(gate.decide('tok-a', false)).toEqual({ kind: 'fold' });
    expect(gate.decide('tok-a', false)).toEqual({ kind: 'fold' });
    // 3回畳んだ後に配ると、畳んだ数（3）を持って `wake` が返る。
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 3 });
  });

  it('配ったら0へ戻る（次に畳み始めたら1から数え直す）', () => {
    const gate = createCloneWakeGate();

    gate.decide('tok-a', false);
    gate.decide('tok-a', false);
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 2 });

    // リセット後、畳んでいない状態で配れば folded は0に戻っている。
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 0 });
    // 改めて1回畳めば1から数え直す。
    gate.decide('tok-a', false);
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 1 });
  });

  it('トークンごとに独立して数える', () => {
    const gate = createCloneWakeGate();

    gate.decide('tok-a', false);
    gate.decide('tok-a', false);
    // tok-b は tok-a の畳み込みに影響されない。
    expect(gate.decide('tok-b', true)).toEqual({ kind: 'wake', folded: 0 });
    // tok-a のカウントはそのまま残っている。
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 2 });
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
   */
  it('🔴 不変条件3: 落ちる→戻る→また落ちる→また戻る で2本目の「戻った」も必ず届く', () => {
    const gate = createCloneWakeGate();

    // 1回目: クローンは枠で止まっている（落ちている）→ 戻ったら配る。
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 0 });

    // 配った直後、クローンはまだ枠で止まっていない状態が続く（この間に届いた
    // 「戻った」はすべて畳む——まだ本物の再起動が要る状態ではない）。
    expect(gate.decide('tok-a', false)).toEqual({ kind: 'fold' });

    // また枠に当たって落ちた。その後もう一度「戻った」が観測された
    // ——ここが2本目の「戻った」である。畳み込みの結果として消えてはいけない。
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 1 });

    // 3本目も同様に届く（何回繰り返しても、止まっているときは必ず配る）。
    expect(gate.decide('tok-a', false)).toEqual({ kind: 'fold' });
    expect(gate.decide('tok-a', false)).toEqual({ kind: 'fold' });
    expect(gate.decide('tok-a', true)).toEqual({ kind: 'wake', folded: 2 });
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
describe('クローンの門は clone.post だけを絞る（restore / resumeStoppedByUsage は無条件）', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const wakeStart = source.indexOf('const wake = () => {');
  const wakeEnd = source.indexOf('\n      if (recycled === ', wakeStart);
  const wakeBody = source.slice(wakeStart, wakeEnd);

  it('clone.post は cloneWakeGate.decide の判定の中にある', () => {
    const decideAt = wakeBody.indexOf('cloneWakeGate.decide(');
    const postAt = wakeBody.indexOf('clone.post(');
    const ifFoldAt = wakeBody.indexOf("decision.kind === 'fold'");

    expect(decideAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(-1);
    expect(ifFoldAt).toBeGreaterThan(-1);
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

    expect(restoreAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeGreaterThan(-1);
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

    expect(entryAt).toBeGreaterThan(-1);
    expect(reopenedAt).toBeGreaterThan(-1);
    expect(entryAt).toBeLessThan(reopenedAt);
  });

  it('journal への追記は settleTokenOutcome の中に1箇所だけで、クローンの門の分岐に複製されていない', () => {
    const occurrences = fnBody.split('stores.journal.append(entry)').length - 1;
    expect(occurrences).toBe(1);

    // その1箇所は `reopened` のブロック（`if (reopened !== undefined) { ... }`）
    // を閉じた後に在る ⟹ 畳んだ（配らなかった）回でも実行される。
    const reopenedBlockStart = fnBody.indexOf('if (reopened !== undefined) {');
    const appendAt = fnBody.indexOf('stores.journal.append(entry)');
    const closeAt = fnBody.indexOf('\n    }\n\n    if (entry === null) return;');

    expect(reopenedBlockStart).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(-1);
    expect(closeAt).toBeLessThan(appendAt);
    expect(reopenedBlockStart).toBeLessThan(closeAt);
  });
});
