import { describe, expect, it } from 'vitest';

import { renderMemoryDocuments } from './memory.js';
import {
  buildCloneSystemPrompt,
  buildDailyReportPrompt,
  buildDistillPrompt,
  buildManagerSystemPrompt,
  buildSelfInitiativePrompt,
  buildTimerPrompt,
  buildWorkerPrompt,
  PROMPT_CHARACTER_BUDGET,
} from './prompt.js';
import { matchesManagerScratchDirName } from './unpushed-work.js';

describe('マネージャーのシステムプロンプト — 委譲の指針', () => {
  const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });

  it('「原則として作業者へ委ねる」を方針として書いている（許可の文体で終わらせない）', () => {
    expect(prompt).toContain('原則として作業者へ出す');
  });

  it('能力の制限として書いていない — 自分でやってよいことが本文にある', () => {
    expect(prompt).toContain('能力の制限ではない');
    expect(prompt).toContain('自分で実装できる');
  });

  it('「全部を下へ投げろ」になっていない — 作業者が立たないのも正しい動作だと書いてある', () => {
    expect(prompt).toContain('全部を下へ投げることも求めていない');
    expect(prompt).toContain('1体も立たないのは正しい動作');
  });

  it('品質の判定が仕事の中身であるものは自分で持つ — 線を「重さ」だけで引いていない', () => {
    expect(prompt).toContain('出力の良し悪しをあなたが後から安く確かめられる仕事');
    expect(prompt).toContain('判定と仕上げはあなたが持つ');
    expect(prompt).not.toContain('成果は変わらない');
  });

  it('作業者の名前と このセッションの識別子 が差し込まれる', () => {
    const other = buildManagerSystemPrompt({ managerId: 'mgr-abc', workerName: 'w2' });
    expect(other).toContain('mgr-abc');
    expect(other).toContain('`w2` サブエージェント');
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

describe('クローンのシステムプロンプト — 道具と委譲', () => {
  const prompt = buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) });

  it('委譲が原則であることを方針として書いている', () => {
    expect(prompt).toContain('原則としてマネージャーへ委ねる');
  });

  it('道具を取り上げていない — 自分でやってよいことが本文にある', () => {
    expect(prompt).toContain('能力の制限ではない');
    expect(prompt).toContain('自分で見てよい');
  });

  it('「組み込みのツールが無い」と書いていない（#32 で反転させた説明）', () => {
    expect(prompt).not.toContain('組み込みのツールが無い');
    expect(prompt).not.toContain('ツールが無い');
  });

  it('自分を監査している器に直接手を入れない方針が書いてある（塞ぐのではなく方針で）', () => {
    expect(prompt).toContain('専用の道具か人間を通す');
    expect(prompt).toContain('人間が後から追う手段');
  });

  it('自分で手を動かしたときの記録と、記憶の更新経路を方針として書いている', () => {
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

describe('作業ツリーの指示文書への到達経路', () => {
  it('マネージャーに、作業ツリー直下の指示文書の所在を告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain('そのリポジトリの指示である');
  });

  it('作業者にも同じことを告げている（こちらは他に到達経路が無い）', () => {
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain('そのリポジトリの指示である');
  });
});

describe('器が共有であることの告知', () => {
  it('マネージャーに、`cwd` が自分専用ではないという事実を告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('他のマネージャーと共有');
    expect(prompt).toContain('あなた専用のディレクトリではない');
  });

  it('事実の隣に「`cwd` そのものを作業ツリーにしない」という行動を書いている', () => {
    // 長い一文の丸ごと一致で見ない: 1文字直すだけで壊れ、Markdown の折り返しを跨ぐと当たらない。
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('そのものを使わない');
    expect(prompt).toContain('自分専用のディレクトリ');
  });

  it('`cwd` の下へ作ると入れ子になることと、落ちるのが相手側であることを告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('入れ子');
    expect(prompt).toContain('あなたの側は最後まで緑');
  });

  const REAL_ID = 'mgr-7305184d-0a1b-4c2d-8e3f-123456789abc';

  function scratchNamesIn(prompt: string): string[] {
    const filled = prompt.replaceAll('<何か>', 'x');
    return [...filled.matchAll(/\/tmp\/([^\s`)/]+)/g)].map((m) => m[1] ?? '');
  }

  it('置き場所を `/tmp/mgr-<自分の委譲 id の先頭8桁>` と名指しし、複数なら `-<何か>` を付けると書いている（#1266）', () => {
    const prompt = buildManagerSystemPrompt({ managerId: REAL_ID, workerName: 'worker' });
    expect(prompt).toContain('/tmp/mgr-7305184d');
    expect(prompt).toContain('/tmp/mgr-7305184d-<何か>');
    expect(prompt).toContain('デーモンが成果を探せる');
    expect(prompt).toContain('区切りごとに外へ保存');
    expect(prompt).toContain('git なら push');
  });

  it('⭐ プロンプトが例として書く置き場所は、未 push 観測の探索の規則に実際に当たる（#1266）', () => {
    const prompt = buildManagerSystemPrompt({ managerId: REAL_ID, workerName: 'worker' });
    const names = scratchNamesIn(prompt);
    // 空振りで緑にならないよう、素の名前・`-<何か>` 付き・例の3つ以上を要求する。
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      expect(matchesManagerScratchDirName(name, REAL_ID), name).toBe(true);
    }
  });

  it('陰性対照: 実際に使われていた `/tmp/b-96878531-1834` の形や、別の委譲の名前は規則に当たらない', () => {
    expect(matchesManagerScratchDirName('b-96878531-1834', REAL_ID)).toBe(false);
    const prompt = buildManagerSystemPrompt({ managerId: REAL_ID, workerName: 'worker' });
    for (const name of scratchNamesIn(prompt)) {
      expect(matchesManagerScratchDirName(name, 'mgr-1cbff9a2-0000')).toBe(false);
    }
  });

  it('置き場所の指図は `/tmp/mgr-<id の先頭>` の1つだけで、他の具体のパスは書かない', () => {
    const prompt = buildManagerSystemPrompt({ managerId: REAL_ID, workerName: 'worker' });
    expect(prompt).not.toContain('/workspace');
  });

  it('具体のパスが、置き場所の1つを除いて現れない（`/tmp` 以外の根も含めて）', () => {
    // 列挙した接頭辞しか拾えない。列挙外（別の根・相対パス・`~` 展開）は通る。
    const prompt = buildManagerSystemPrompt({ managerId: REAL_ID, workerName: 'worker' });
    const withoutScratch = prompt.replaceAll(/\/tmp\/mgr-[0-9a-f]{8}(?:-[^\s`)]*)?/g, '');
    const paths =
      withoutScratch.match(/\/(?:tmp|workspace|home|root|var|usr|opt|mnt|srv|Users|data)\b/g) ?? [];
    expect(paths).toEqual([]);
  });
});

describe('バックグラウンドの完了を待つときの事実の告知（#357）', () => {
  it('マネージャーに、層が2つ在ることと、追えない側は前景で見ることを告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('層が2つ在り');
    expect(prompt).toContain('器が追っている処理の完了は、通知として届く');
    expect(prompt).toContain('器が追えない形へ逃した処理は、通知の対象ではない');
    expect(prompt).toContain('成果物が在るかを見て回る');
  });

  it('作業者にも、層が2つ在ることを告げている', () => {
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('層が2つ在る');
    expect(prompt).toContain('通知として届く');
    expect(prompt).toContain('通知の対象ではない');
  });

  it('「通知は無い」という層を畳んだ全否定へ戻っていない', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const worker = buildWorkerPrompt();
    for (const prompt of [manager, worker]) {
      expect(prompt).not.toContain('完了を知らせる通知は、この実行環境には無い');
      expect(prompt).not.toContain('完了を知らせる通知は無い');
    }
  });

  it('通知が来ないことを環境の性質として読ませない（追える形で起こしたかを先に見させる）', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const worker = buildWorkerPrompt();
    for (const prompt of [manager, worker]) {
      expect(prompt).toContain('追える形で起こしたか');
    }
  });

  it('「閉じてよい」の許可に、終了条件と「対象が消えた」の抜け道が付いている', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const worker = buildWorkerPrompt();
    for (const prompt of [manager, worker]) {
      expect(prompt).toContain('何の完了を待っているか');
      expect(prompt).toContain('抜ける条件に入れ');
    }
  });

  it('マネージャーに、通知が実処理の完了と一致しないことがあるという事実を告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('実処理の完了と一致しないことがある');
  });

  it('作業者にも同じ事実を告げている', () => {
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('実処理の完了と一致しないことがある');
  });

  it('マネージャーに、プロセス一覧の0本が「まだ見えていない」ことがあるという事実を告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('まだ見えていない');
    expect(prompt).toContain('同じ場所で2本走る');
  });

  it('作業者にも同じ事実を告げている', () => {
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('まだ見えていない');
  });

  it('検証コマンドの具体の書式を書いていない（運用スタイルにしない）', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const worker = buildWorkerPrompt();
    for (const prompt of [manager, worker]) {
      expect(prompt).not.toContain('grep');
      expect(prompt).not.toContain('timeout');
      expect(prompt).not.toContain('run.log');
    }
  });

  it('通知が前後する原因の機構を断定していない（#357 コメント2の留保どおり）', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const worker = buildWorkerPrompt();
    for (const prompt of [manager, worker]) {
      expect(prompt).not.toContain('二重');
    }
  });

  it('`Monitor` という道具名を名指しで禁じていない（repo からは挙動を確かめられない道具）', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const worker = buildWorkerPrompt();
    expect(manager).not.toContain('Monitor');
    expect(worker).not.toContain('Monitor');
  });

  it('回数を書いていない（固定した数は固定した瞬間から腐るため）', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    // 見出しが消えると slice(-1) が末尾1文字になり、下の not.toMatch は空振りする。
    expect(manager).toContain('# バックグラウンドの完了を待つとき');
    const addedSection = manager.slice(manager.indexOf('# バックグラウンドの完了を待つとき'));
    expect(addedSection).not.toMatch(/\d+\s*(回|体)/);

    const worker = buildWorkerPrompt();
    expect(worker).not.toMatch(/\d+\s*(回|体)/);
  });
});

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

  it('目次の1行が「開かなかったことが判断になる」水準で書かれることを要求している', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('欠落');
    expect(prompt).toContain('判断');
    expect(prompt).toContain('コードベースについて');
  });

  it('「畳まないもの」の一覧が、畳む指示と同じ場所（この返り値）に書いてある', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('畳まないもの');
    expect(prompt).toContain('人間が一度でも書いた文書');
    expect(prompt).toContain('格下げ');
  });

  it('conversation_end / pre_compact のどちらでも統合の指示が同じ内容で載る', () => {
    const a = buildDistillPrompt('conversation_end');
    const b = buildDistillPrompt('pre_compact');
    expect(a).toContain('新しく書く前に、既存の記憶を');
    expect(b).toContain('新しく書く前に、既存の記憶を');
  });
});

describe('プロンプト全体の文字数上限（#414）', () => {
  const hugeDigest = 'あ'.repeat(PROMPT_CHARACTER_BUDGET * 2);

  it('digest が小さいときは切られない（合図も付かない）', () => {
    const prompt = buildDailyReportPrompt({ date: '2026-08-27', digest: '短い digest' });
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHARACTER_BUDGET);
    expect(prompt).not.toContain('文字省略');
  });

  it('buildDailyReportPrompt: digest だけで予算を超えても、本体は予算ちょうどに切られ、省略の合図が本文に付く', () => {
    const prompt = buildDailyReportPrompt({ date: '2026-08-27', digest: hugeDigest });
    expect(prompt.slice(0, PROMPT_CHARACTER_BUDGET).length).toBe(PROMPT_CHARACTER_BUDGET);
    expect(prompt).toContain('文字省略');
    expect(prompt).toContain('この日の日報をまとめよ');
    expect(prompt).toContain('daily_report_write');
  });

  it('buildSelfInitiativePrompt: 同様に本体は予算ちょうどに切られ、省略の合図が付く', () => {
    const prompt = buildSelfInitiativePrompt({ reason: 'timer', digest: hugeDigest });
    expect(prompt.slice(0, PROMPT_CHARACTER_BUDGET).length).toBe(PROMPT_CHARACTER_BUDGET);
    expect(prompt).toContain('文字省略');
    expect(prompt).toContain('次にやることがあるかを決めよ');
  });

  it('buildTimerPrompt: 継続中の依頼の本文（digest より前）は残り、digest 側だけが削られる', () => {
    const prompt = buildTimerPrompt({
      kind: 'custom',
      request: 'この継続中の依頼の本文は絶対に残ってほしい目印',
      digest: hugeDigest,
    });
    expect(prompt.slice(0, PROMPT_CHARACTER_BUDGET).length).toBe(PROMPT_CHARACTER_BUDGET);
    expect(prompt).toContain('文字省略');
    expect(prompt).toContain('この継続中の依頼の本文は絶対に残ってほしい目印');
  });

  it('切ったときの合図には、省いた文字数と全体の文字数の両方が出る（excerpt() の形式）', () => {
    const prompt = buildDailyReportPrompt({ date: '2026-08-27', digest: hugeDigest });
    expect(prompt).toMatch(/…（[\d,]+ 文字省略。全 [\d,]+ 文字）$/);
  });
});

describe('発意 tick の結び — 「何もしないという結論でよい」の対（#1103）', () => {
  it('既存の文はそのまま残り、新しい1文がすぐ後に続く', () => {
    const prompt = buildSelfInitiativePrompt({ reason: 'timer', digest: '短い digest' });
    expect(prompt).toContain(
      '**何もしないという結論でよい。** そのときは何もせず「今回は動かない」とだけ答えよ。無理に仕事を作らないこと。',
    );
    expect(prompt).toContain(
      'ただし、動いている委譲が無い器があるなら、なぜ空いているのかを先に確かめること。',
    );
  });
});

describe('branded type — RenderedMemory を経由しない記憶は buildCloneSystemPrompt に渡せない', () => {
  it('renderMemoryDocuments を通さない生の文字列は型で拒否される', () => {
    // @ts-expect-error 生の string は RenderedMemory ではない。
    // 実行時には常に通る型レベルの歯: ブランドが外れると、この抑制が不要になり `pnpm typecheck` が落ちる。
    buildCloneSystemPrompt({ memory: '生の文字列' });

    expect(() => buildCloneSystemPrompt({ memory: renderMemoryDocuments([]) })).not.toThrow();
  });
});

describe('buildDistillPrompt — 定期の棚卸しと、引き直した2つの線', () => {
  // 節の見出しを語として探さない: 散文がその語を名指しすると、`not.toContain` は偽陽性、
  // `toContain` は偽陰性になる。tidyTargets の有無だけを変えた出力の差分と payload で測る。
  it('⭐ 的の一覧は payload ごと連続した1ブロックとして挿入され、渡さない呼び手の出力は1文字も変わらない', () => {
    const MARKER = 'TIDY-TARGET-PAYLOAD-MARKER';

    expect(buildDistillPrompt('conversation_end', {})).toBe(buildDistillPrompt('conversation_end'));

    const withoutTargets = buildDistillPrompt('scheduled');
    expect(buildDistillPrompt('scheduled', {})).toBe(withoutTargets);

    const withTargets = buildDistillPrompt('scheduled', { tidyTargets: MARKER });
    let prefix = 0;
    while (prefix < withoutTargets.length && withoutTargets[prefix] === withTargets[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < withoutTargets.length - prefix &&
      withoutTargets[withoutTargets.length - 1 - suffix] ===
        withTargets[withTargets.length - 1 - suffix]
    ) {
      suffix++;
    }
    const chunk = withTargets.slice(prefix, withTargets.length - suffix);

    expect(withTargets.replace(chunk, '')).toBe(withoutTargets);
    expect(chunk).toContain(MARKER);
    // payload だけの挿入なら、節の描画を丸ごと消す変異でもこの歯は赤くならない。
    expect(chunk.length).toBeGreaterThan(MARKER.length);
  });

  it('⭐ scheduled は「会話が終わったからではない」と名乗る（起点を取り違えさせない）', () => {
    const scheduled = buildDistillPrompt('scheduled');
    expect(scheduled).toContain('定期の棚卸しの刻みが来た');
    expect(scheduled).toContain('会話が終わったからではない');
    expect(scheduled).not.toContain('いまの会話が終わった');
  });

  it('⭐ 区分の線は「費用」ではなく「毎回の判断に要るか」になった', () => {
    const prompt = buildDistillPrompt('conversation_end');
    // 本文に経緯として同じ語が残るので、語ではなく指示の形（箇条書きの先頭）が消えたことを見る。
    expect(prompt).not.toContain('- **判断の前提（`premise`）を、費用のために');
    expect(prompt).toContain('かつてここには');
    expect(prompt).toContain('毎回の判断に要るか');
    expect(prompt).toContain('判断の前提そのものを削るな');
  });

  it('⭐ 節の移動は人間が書いた文書に対しても通る、と明言する', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain(
      '`memory_section_move`（節を別の文書へ移す）は、人間が書いた文書に対しても通る',
    );
    expect(prompt).toContain('全文置換・削除・frontmatter の更新ができない');
  });

  it('⭐ 畳むもの（棚卸しの本題）が仕事として書かれている', () => {
    const prompt = buildDistillPrompt('conversation_end');
    expect(prompt).toContain('畳むもの');
    expect(prompt).toContain('付録へ移せ');
    expect(prompt).toContain('付録が育ったら、付録を割れ');
    expect(prompt).toContain('主題が2つ以上在るなら割れ');
  });
});

describe('auto-memory についての事実の告知（#1189）', () => {
  it('マネージャーに、既定で閉じていることと、開いても届かないことを告げている', () => {
    const prompt = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    expect(prompt).toContain('auto-memory');
    expect(prompt).toContain('既定で閉じてある');
    expect(prompt).toContain(
      'ここで書いた記憶はクローンにも次の器にも届かない。学びは報告に書くこと。',
    );
  });

  it('作業者にも同じ事実を告げている', () => {
    const prompt = buildWorkerPrompt();
    expect(prompt).toContain('auto-memory');
    expect(prompt).toContain('既定で閉じてある');
    expect(prompt).toContain(
      'ここで書いた記憶はクローンにも次の器にも届かない。学びは報告に書くこと。',
    );
  });
});

describe('peer（Codex）に頼めることの案内（#4125）', () => {
  const base = { managerId: 'mgr-test', workerName: 'worker' };

  it('peer を出さないセッションのプロンプトは1文字も変わらない', () => {
    const plain = buildManagerSystemPrompt(base);
    expect(plain).not.toContain('Codex');
    expect(plain).not.toContain('peer_run');
  });

  it('peer を出したセッションでは、頼めること・探し方・作業者との違いを短く示す', () => {
    const plain = buildManagerSystemPrompt(base);
    const withPeer = buildManagerSystemPrompt({ ...base, peer: {} });
    expect(withPeer).toContain('Codex に作業を頼める');
    expect(withPeer).toContain('ToolSearch');
    expect(withPeer).toContain('peer_run');
    expect(withPeer).toContain('run_in_background');
    expect(withPeer).toContain('alteroid が知らせて');
    expect(withPeer).not.toContain('背後へ回せない');
    expect(withPeer).toContain('あなたが決める');
    const start = withPeer.indexOf('# Codex（peer）');
    const end = withPeer.indexOf('# 作業ディレクトリについて');
    expect(start).toBeGreaterThan(0);
    expect(withPeer.slice(0, start - 1) + withPeer.slice(end - 1)).toBe(plain);
    expect(end - start).toBeLessThan(600);
  });

  it('名指しできるモデルが開いていれば並べ、無ければモデルの行を出さない', () => {
    expect(
      buildManagerSystemPrompt({ ...base, peer: { models: ['gpt-5.5', 'gpt-5.5-codex'] } }),
    ).toContain('名指しできるモデル: gpt-5.5, gpt-5.5-codex');
    expect(buildManagerSystemPrompt({ ...base, peer: {} })).not.toContain('名指しできるモデル');
  });

  it('禁止・叱責の文体になっていない（読む側は次の担当であって、悪いことをした人ではない）', () => {
    const manager = buildManagerSystemPrompt({ managerId: 'mgr-test', workerName: 'worker' });
    const worker = buildWorkerPrompt();
    for (const prompt of [manager, worker]) {
      // 目印が消えると slice(-1) が末尾1文字になり、下の not.toContain は空振りする。
      expect(prompt).toContain('auto-memory');
      const section = prompt.slice(prompt.indexOf('auto-memory'));
      expect(section).not.toContain('禁止');
      expect(section).not.toContain('しないこと');
      expect(section).not.toContain('書くな');
    }
  });
});
