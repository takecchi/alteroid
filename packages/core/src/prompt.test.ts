import { describe, expect, it } from 'vitest';

import { renderMemoryDocuments } from './memory.js';
import {
  buildCloneSystemPrompt,
  buildDistillPrompt,
  buildManagerSystemPrompt,
  buildWorkerPrompt,
} from './prompt.js';

/**
 * マネージャーのシステムプロンプトに書く「委譲の指針」を守るテスト。
 *
 * **なぜ文字列の中身をテストするのか。** ここは `docs/architecture.md`
 * 「プロセスモデル」が「作業者層の本体は `agents` 定義1個と**マネージャーの
 * システムプロンプトに書く委譲の指針**のみ」と名指ししている場所で、方針を
 * 削っても型は通り、`agents` 定義も残るので**どのテストも落ちない**。実際に
 * 本番で6日間 $386 を使い、58本のマネージャーのうち35本が作業者を一度も
 * 起こしていなかった（支出の73%が Opus 側）。そのとき本文にあったのは
 * 「使える」「任せてよい」という許可の文体だけだった。
 *
 * だから**方針が書かれていること自体**に歯を当てる。文言そのものではなく、
 * PRD が両側から挟んでいる3つの性質を見る。
 */
describe('マネージャーのシステムプロンプト — 委譲の指針', () => {
  const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });

  it('「原則として作業者へ委ねる」を方針として書いている（許可の文体で終わらせない）', () => {
    // PRD「層ごとの能力」: 重い実作業を Opus の値段でやるのは無駄なので、
    // 原則として作業者へ委ねる。
    expect(prompt).toContain('原則として作業者へ出す');
  });

  it('能力の制限として書いていない — 自分でやってよいことが本文にある', () => {
    // north_star 禁止2。方針で表すのであって、能力を削るのではない。
    // ここが消えると「委譲を強制した」＝能力の削除になる。
    expect(prompt).toContain('能力の制限ではない');
    expect(prompt).toContain('自分で実装できる');
  });

  it('「全部を下へ投げろ」になっていない — 作業者が立たないのも正しい動作だと書いてある', () => {
    // PRD「層ごとの能力」: 全部を下へ投げることは要件ではない。簡単な調査依頼が
    // マネージャーで完結し、作業者が1体も立たないのは正しい動作である。
    // 片側だけ強めると、簡単な調査までサブエージェント越しになって遅くなる。
    expect(prompt).toContain('全部を下へ投げることも求めていない');
    expect(prompt).toContain('1体も立たないのは正しい動作');
  });

  it('作業者の名前と このセッションの識別子 が差し込まれる', () => {
    const other = buildManagerSystemPrompt({ managerId: 'mgr-abc', workerName: 'w2' });
    expect(other).toContain('mgr-abc');
    expect(other).toContain('`w2` サブエージェント');
    // 取り違えていないこと（両方が同じ穴に入っていないか）
    expect(other).not.toContain('mgr-test');
    expect(other).not.toContain('`worker` サブエージェント');
  });

  it('委譲の対象を実装だけに狭めていない（AGENTS.md 地雷8）', () => {
    for (const kind of ['調査', 'レビュー']) {
      expect(prompt).toContain(kind);
    }
    expect(prompt).toContain('実装に限らず');
  });

  it('ユーザーがクローンであることは残っている（この改修で落としていない）', () => {
    expect(prompt).toContain('価値観をコピーしたクローン');
  });
});

/**
 * クローンのシステムプロンプトに書く「委譲の方針」を守るテスト。
 *
 * **マネージャー側と同じ理由でここに歯を当てる**（上の describe のコメント）。
 * 加えてクローン側にはもう1つの失敗の形がある — **道具を渡したのにプロンプトで
 * 取り上げる**ことである。実際に #32 の前は `tools: []` と揃えて「あなたには
 * 組み込みのツールが無い」と書いてあり、実装だけを直して本文を直さなければ、
 * 道具はあるのに使わないクローンが残る（north_star「適用範囲」が名指しで否定して
 * いる推論が、プロンプトの中で生き延びる）。
 *
 * だから**両側**を見る。「委譲が原則である」と「それは能力の制限ではない」の
 * どちらが落ちても落ちるようにしてある。
 */
describe('クローンのシステムプロンプト — 道具と委譲', () => {
  const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });

  it('委譲が原則であることを方針として書いている', () => {
    // PRD「層ごとの能力」: 重い調査と実作業は方針として下へ委ねる。
    expect(prompt).toContain('原則としてマネージャーへ委ねる');
  });

  it('道具を取り上げていない — 自分でやってよいことが本文にある', () => {
    // north_star「適用範囲」: 人間が自分の手でできることは、クローンも自分でできる。
    // 「道具を取り上げて委譲を強制してはいけない」。
    expect(prompt).toContain('能力の制限ではない');
    expect(prompt).toContain('自分で見てよい');
  });

  it('「組み込みのツールが無い」と書いていない（#32 で反転させた説明）', () => {
    // ここが復活すると、実装が直っていてもデグレードがプロンプトで戻る。
    expect(prompt).not.toContain('組み込みのツールが無い');
    expect(prompt).not.toContain('ツールが無い');
  });

  /**
   * 道具を持つと、クローンの手は**自分を監査している器**にも届く（デーモンと
   * 同じプロセスに居るので、記憶の実体・日誌のファイル・HTTP API・入口の資格）。
   * 正典はこれを塞ぐことを禁じている（architecture.md「これは境界の破れではない」）
   * ので、**方針として**書いてあることを確かめる。書いていなければ、方針で扱うと
   * 言いながら何も言っていないことになる。
   */
  it('自分を監査している器に直接手を入れない方針が書いてある（塞ぐのではなく方針で）', () => {
    expect(prompt).toContain('専用の道具か人間を通す');
    // 「なぜ」まで書く（禁止の一覧ではなく理由で判断させる）
    expect(prompt).toContain('人間が後から追う手段');
  });

  it('自分で手を動かしたときの記録と、記憶の更新経路を方針として書いている', () => {
    // docs/architecture.md「非対称な可視性」:「どちらで見たかは日誌に残す」。
    // 記憶を直接書き換えられる立場になったので、`memory_*` を通すのも方針で表す
    // （塞ぐのではなく — 同文書「クローンが自分の手を持つことの帰結」）。
    expect(prompt).toContain('自分で手を動かしたなら');
    expect(prompt).toContain('記憶の更新は');
  });
});

describe('作業者のシステムプロンプト', () => {
  it('仕事の型を実装専用に狭めていない（AGENTS.md 地雷8）', () => {
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('実装に限らない');
  });

  it('握り潰さずに上へ返す経路があることを書いている', () => {
    expect(buildWorkerPrompt()).toContain('握り潰さず');
  });
});

/**
 * 作業ツリーの指示文書（`AGENTS.md` / `CLAUDE.md`）への到達経路を守るテスト。
 *
 * **委譲の指針と同じ理由で、文字列の中身に歯を当てる。** この1行を消しても型は
 * 通り、`agents` 定義も `Options` も何一つ変わらないので、**どのテストも落ちない。**
 *
 * そして消えたことは実行時にも見えない。マネージャーの cwd は
 * `ALTEROID_WORKSPACE`（workspace の根）で、リポジトリはその1階層下なので、
 * `settingSources` の `'project'` が解決する先に `CLAUDE.md` は無い。**後から
 * 載ることはあるが、それはハーネス側の挙動で alteroid が制御していない**
 * （実測4例が4例とも形が違う。`AGENTS.md`「書く先を決める」）。だから
 * この1行が消えても、たまたま載った回は今までどおり動いてしまう —
 * **壊れたことが赤くならない形である。**
 *
 * 文言そのものではなく、**所在を告げていること**に歯を当てる。
 */
describe('作業ツリーの指示文書への到達経路', () => {
  it('マネージャーに、作業ツリー直下の指示文書の所在を告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain('そのリポジトリの指示である');
  });

  it('作業者にも同じことを告げている（こちらは他に到達経路が無い）', () => {
    // `AgentDefinition.skills` は `'all'` を受けないので、作業者には
    // `.claude/skills/` の一覧が1つも載らない（`claude-provider.ts`）。
    // ここが消えると、作業者はリポジトリの規則へ到達する経路を1つも持たない。
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain('そのリポジトリの指示である');
  });
});

/**
 * `cwd` が自分専用ではないという事実を告げていることを守るテスト。
 *
 * **上の「所在」と同じ理由で、消えても赤くならない形である。** この1行を消しても
 * 型は通り、`Options` も `agents` 定義も変わらない。そして実行時にも見えない —
 * 器に自分しか居ない回は今までどおり動くので、**壊れたことは「他人の器を壊した」
 * 側にしか出ない**（しかも壊した本人ではなく、相手の `eslint` / `format:check` が
 * 落ちる形で出る。`AGENTS.md`「自分が走っている器」）。
 *
 * **告げる先はここしか無い。** マネージャーの `cwd` は `ALTEROID_WORKSPACE` で、
 * 器の共有という事実は `AGENTS.md` に書いてあるが、**それを読めるのは作業ツリーを
 * 作った後**である。置き場所を決める時点では到達経路が1つも無い。
 *
 * 文言そのものではなく、**事実を告げていること**と、**そこから何をするか（`cwd` そのものを
 * 作業ツリーにしない）を告げていること**と、**置き場所を指図していないこと**の3つに歯を当てる。
 * 最後のひとつが消えると、alteroid 専用の運用スタイルがプロンプトへ入る。
 */
describe('器が共有であることの告知', () => {
  it('マネージャーに、`cwd` が自分専用ではないという事実を告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('他のマネージャーと共有');
    expect(prompt).toContain('あなた専用のディレクトリではない');
  });

  it('事実の隣に「`cwd` そのものを作業ツリーにしない」という行動を書いている', () => {
    // 状態（共有である）だけでは、置き場所を決める側が `cwd` の下へ作る形を排除できない。
    // ⚠️ 長い一文の丸ごと一致では見ない — 1文字直すだけで壊れるうえ、Markdown の折り返しを
    // 跨ぐと当たらない（`AGENTS.md`「静かに失敗する道具」の grep の罠4と同じ形）。
    // 性質を名指しする短い断片で見る。
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('そのものを作業ツリーにしない');
    expect(prompt).toContain('自分専用のディレクトリ');
  });

  it('`cwd` の下へ作ると入れ子になることと、落ちるのが相手側であることを告げている', () => {
    // 入れ子は自分の側では観測できない（相手の整形・静的検査が落ちる形でしか出ない）。
    // 「自分は緑のままである」まで書いていないと、読み手は自分の緑を根拠にしてしまう。
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('入れ子');
    expect(prompt).toContain('あなたの側は最後まで緑');
  });

  it('置き場所は指図していない（alteroid 専用の記述にしない）', () => {
    // マネージャーは人間の任意のプロジェクトを触るので、`/tmp` や `/workspace` の
    // ような具体のパスは書けない。書くのは事実だけで、どこへ clone するかの判断は
    // 読み手に残す（north_star の「一運用スタイルを要件のように書かない」）。
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).not.toContain('/tmp');
    expect(prompt).not.toContain('/workspace');
  });

  it('具体のパスが1つも現れない（`/tmp` `/workspace` 以外も含めて）', () => {
    // 直上の歯は `/tmp` と `/workspace` の2語しか見ていないので、親切心で別の絶対パス
    // （`/home/...` や `/var/...`）を書き足す形は止まらない。#191 の線は「置き場所を
    // 名指ししない」であって「この2語を書かない」ではないため、語ではなく形で見る。
    //
    // ⚠️ **この歯が拾えない範囲を明示しておく。** 測っているのは「下に列挙した接頭辞が
    // 現れないこと」であって、「具体のパスが1つも現れないこと」ではない。**列挙外の形は
    // 通る** — 別の根（`/srv2` のような列挙漏れ）・相対パス（`../repo`）・`~` 展開
    // （`~/work`）・文の中に埋め込まれた断片などである。**#191 の線は「置き場所を
    // 名指ししない」であって「この列挙に当たらない」ではない。** 新しい形で置き場所を
    // 書いた人は、この歯に当たらなくても線を破っている — 網が全部を覆っていると
    // 読まれるほうが、覆っていないと分かっているより悪い。
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const paths =
      prompt.match(/\/(?:tmp|workspace|home|root|var|usr|opt|mnt|srv|Users|data)\b/g) ?? [];
    expect(paths).toEqual([]);
  });
});

/**
 * branded type（4-14）— `renderMemoryDocuments` を通さずに `buildCloneSystemPrompt`
 * へ記憶を渡す経路を `tsc` で塞ぐ。
 *
 * **これは型レベルの歯である。** `vitest` はトランスパイル済みの JS を実行する
 * だけなので、この `it()` 自体は実行時には常に通る（ブランドは実行時には
 * 消える）。守っているのは **`pnpm typecheck`（`tsc --noEmit`）がこのファイルを
 * 検査したときに、次の行が「型エラーである」ことを要求する** 側——
 * `@ts-expect-error` は「次の行は型エラーになるはずだ」という主張で、
 * **実際にエラーにならなければ `@ts-expect-error` 自身が「不要な抑制」として
 * `tsc` を落とす。** だから `RenderedMemory` のブランドが外れる・弱まる
 * リグレッションが起きると、`pnpm typecheck` が real に落ちる。
 */
/**
 * `buildDistillPrompt` — #170 で足した統合の指示（4-9 / F 章）。
 *
 * **蒸留は死んでいなかったが、畳んでいなかった**（`cause:'distill'` が
 * 極端に少ないという実測が起点）。「畳め」「重複を消せ」「要旨を直せ」
 * それぞれが1つの `it()` で別々に測る——どれか1つが欠けても、他の
 * 指示があるから通ったように見えるのを避けるため。
 */
describe('buildDistillPrompt — 統合の指示（畳む・重複を消す・要旨を直す・タイトルの水準）', () => {
  it('新しく書く前に既存を探すよう指示している（重複を作らない）', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('memory_list');
    expect(prompt).toContain('重複する文書を作らない');
  });

  it('相対日付を絶対日付へ直すよう指示している', () => {
    expect(buildDistillPrompt('conversation_end')).toContain('絶対日付');
  });

  it('矛盾する古い事実を消すよう指示している', () => {
    expect(buildDistillPrompt('conversation_end')).toContain('矛盾する古い事実');
  });

  it('要旨を本文に合わせて直すよう指示し、鮮度の印を優先するよう言っている', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('要旨');
    expect(prompt).toContain('鮮度');
  });

  it('既存文書へ frontmatter（description / type）を書くことを、移行後最初の仕事として指示している', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('frontmatter');
    expect(prompt).toContain('description');
    expect(prompt).toContain('type: premise');
    expect(prompt).toContain('type: fact');
  });

  /**
   * **タイトルの水準は機械には守れない。** `description`（要旨）の鮮度は
   * `describedAt` で機械的に検出できるが、`title` の「開くべきか判断できる
   * 水準か」は機械には判らない——だから指示文で明示的に要求するしかない
   * （`schema.ts` の `memoryDescriptionFreshnessSchema` の doc と対）。
   */
  it('目次の1行が「開かなかったことが判断になる」水準で書かれることを要求している', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('欠落');
    expect(prompt).toContain('判断');
    // 悪い例・良い例が具体的に書いてあること（「良い題を書け」だけでは
    // 判定できる形になっていない）。
    expect(prompt).toContain('コードベースについて');
  });

  it('「畳まないもの」の一覧が、畳む指示と同じ場所（この返り値）に書いてある', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('畳まないもの');
    expect(prompt).toContain('人間が一度でも書いた文書');
    // premise を費用のために fact へ格下げしない、という歯止め。
    expect(prompt).toContain('格下げ');
  });

  it('conversation_end / pre_compact のどちらでも統合の指示が同じ内容で載る', () => {
    const a = buildDistillPrompt('conversation_end');
    const b = buildDistillPrompt('pre_compact');
    // 理由の一文（why）だけが違うはずなので、統合の節はどちらにも同じ形で入る。
    expect(a).toContain('新しく書く前に、既存の記憶を');
    expect(b).toContain('新しく書く前に、既存の記憶を');
  });
});

describe('branded type — RenderedMemory を経由しない記憶は buildCloneSystemPrompt に渡せない', () => {
  it('renderMemoryDocuments を通さない生の文字列は型で拒否される', () => {
    // @ts-expect-error 生の string は RenderedMemory ではない。
    // renderMemoryDocuments（memory.ts）だけが作れる branded type にしてある
    // （4-14）。この行が本当に型エラーにならなくなったら、上の
    // `@ts-expect-error` 自体が「不要な抑制」として `pnpm typecheck` を落とす。
    buildCloneSystemPrompt({ memory: '生の文字列' });

    // renderMemoryDocuments を通した値は問題なく渡せる（対照）。
    expect(() => buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) })).not.toThrow();
  });
});
