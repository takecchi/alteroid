import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  evaluateIssueIntentHint,
  findIssueIntentHintSentences,
  formatIssueIntentHintEvaluation,
} from './issue-intent-hint-core.mjs';

/**
 * `issue-intent-hint` の歯（Issue #1134 の案3）。
 *
 * 本物の `gh pr view` は叩かない —— 合成したタイトル・本文で判定だけを確かめる
 * （`check-pr-closing-keywords.test.ts` / `issue-done-trailer.test.ts` と同じ
 * 理由）。**唯一の例外が PR #1073 の実物の本文**——この Issue が名指ししている
 * 唯一の実測の回帰なので、合成ではなく実物をそのまま埋め込む
 * （`gh pr view 1073 --repo takecchi/alteroid --json body` で取得、
 * 2026-09-17 観測）。
 *
 * この歯自身が fixture として日本語の閉じる意思の逐語を持つ。それ自体が
 * 対象になってはいけない——この门は repo のファイルも git の履歴も一切走査
 * しない（`check-pr-closing-keywords-core.mjs` の doc、#785 の族と同じ理由）
 * ので、この歯の中身がこの门自身に引っかかることは無い。
 */

const PR_1073_BODY =
  '**#1072 を閉じる。** インメモリのストアが `put` で受け取った参照をそのまま返していたのを、境界で写しを取る形へ直し、**3実装で契約として測る**ようにした。\n\n## ⭐ なぜこれがバグなのか —— 歯が緑のまま何も測っていなかった\n\n`createMemoryStores()` は**3実装の1つ**として扱われている（台帳の契約も日誌の契約群も「3実装すべてが同じものを呼ぶこと」と書いてある）。**その器が、参照の扱いだけ本物と違っていた。**\n\n- **fs / pg は JSON を経由するので必ず写しになる**（ファイルへ書いて読み直す / jsonb へ入れて取り出す）\n- **インメモリは `Map` に参照をそのまま入れていた** ⟹ 「台帳から読んで書き換える」形のコードが、**呼び出し元が握っている同じオブジェクトまで書き換える**\n\n⟹ **その差に依存するバグは、歯の上では起きない。本番でだけ壊れる。**\n\n**実際に殺していた（#1054 の作業中に発見）。** `ManagerPool.appraise` の踏み消しを測る歯へ、わざと壊す変異（像を見ずに台帳から読む形）を当てても**6件とも緑のまま**だった。気づいたのは変異を当てたからで、読み返したからではない。\n\n## 測ったら JobStore だけではなかった\n\n#1072 を立てた時点で確かめてあったのは `JobStore` だけだったが、**調べた5経路すべてが参照を返していた**:\n\n```\n⚠ 同一参照  jobs.putJob → listJobs\n⚠ 同一参照  jobs.putApproval → getApproval\n⚠ 同一参照  jobs.putApproval → listApprovals\n⚠ 同一参照  commitments.open → get\n⚠ 同一参照  commitments.open → list\n⚠ 同一参照  journal.append の戻り値 → list\n⚠ 同一参照  schedules.put → list\n```\n\n**5つとも直した。**\n\n## 直し方\n\n- **境界で `structuredClone` を取る**（`testing.ts` の `isolate`）。**`JSON.parse(JSON.stringify(...))` にしない** —— `undefined` の欄を落とすと「無い」と「`undefined` として在る」の区別が**偽物の側だけで**消える\n- **契約 `packages/core/src/store-isolation-contract.ts` を置いた。** 測るのは両方向 ——「書いた値をあとで書き換えても店が汚れない」と「読んだ値を書き換えても店が汚れない」。`journal-order-with-contract.ts` と同じ作法（vitest に依存しない素の関数）で、**3実装（in-memory / fs / pg）が呼ぶ**\n\n## 実測（3つとも生出力を取った）\n\n**1. 既存の歯は1本も壊れなかった**\n\n```\n Test Files  277 passed (277)\n      Tests  6876 passed (6876)      ← うち3本が新しい契約\n```\n\n⟹ #1072 の受け入れ基準が心配していた「直した瞬間に別の歯が赤くなる」は**起きなかった**（＝この差に依存していた既存の歯は無かった）。\n\n**2. 契約が実装ごとの違いを正しく測っている**（`isolate` を素通しへ変異させた）\n\n```\n     × ストアが返す値は書いた側の握りと別物である（#1072。3実装で同じことを測る）\n FAIL  packages/core/src/commitment.test.ts   ← in-memory だけ\n Test Files  1 failed | 2 passed (3)          ← fs / pg は緑のまま\n```\n\n**3. ⭐ #1054 に入れていた1本だけの回避策（`copyingJobStore`）を外しても、変異が死ぬ**\n\n```\n（回避策なし・素の createMemoryStores で、appraise を「像を見ずに台帳から読む」形へ変異）\n     × ⭐ 走行中に付けた評定は、その後プールが台帳へ書いても消えない\n     × ManagerSummary にも載る（載らないと評定が書き込み専用になる）\n Test Files  1 failed (1)\n```\n\n⟹ **族に対する仕掛けになったので、1本ぶんの手当てを撤去した。**\n\n## 検証（全部この PR の最終コミットの後で通した）\n\n```\n$ pnpm build / check:web-bundle-node-traces / check:web-bundle-size\n  / check:web-css-comment-classnames / check:sdk-quotes\n  / typecheck / lint / format:check        → すべて 0\n$ pnpm test  → 277 files / 6876 tests 全通過\n```\n\n`apps/daemon/openapi.json` に差分は出ていない（この PR は外向きの面を1バイトも変えない）。\n\n⚠️ **デプロイ後の実挙動は確認していない。** そもそも**本番のコードは1行も変わっていない** —— 変えたのはテストの器（`packages/core/src/testing.ts`）と、新しい契約とその呼び出しだけである。\n\n## ⚠️ 確かめていないこと（正直に）\n\n- **`InboxStore` / `SessionStore` / `TranscriptArchive` / `PersonaStore` は調べていない。** 上の5経路は「オブジェクトを `put` して読み返す」形のものを選んで測った結果であって、**全ストアを数え上げたわけではない**\n- **この差に依存する*将来の*コードが安全になったとは言えない。** 契約が測るのは上の5経路だけである\n';

describe('findIssueIntentHintSentences — PR #1073 の実物（唯一の実測の回帰）', () => {
  it('本文の冒頭 "**#1072 を閉じる。**" で発火する', () => {
    const result = findIssueIntentHintSentences(PR_1073_BODY);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toContain('#1072');
    expect(result[0]).toContain('閉じる');
  });

  it('evaluateIssueIntentHint も hint を返す（trailer が無いので）', () => {
    const result = evaluateIssueIntentHint({ title: 'fix: 何か', body: PR_1073_BODY });
    expect(result.verdict).toBe('hint');
    expect(result.reason).toBe('hint-found');
    expect(result.findings.some((f: { sentence: string }) => f.sentence.includes('#1072'))).toBe(
      true,
    );
  });

  it('この本文に Alteroid-Issue-Done trailer を足せば静かになる（trailer が優先する）', () => {
    const result = evaluateIssueIntentHint({
      title: 'fix: 何か',
      body: PR_1073_BODY + '\n\nAlteroid-Issue-Done: 1072\n',
    });
    expect(result.verdict).toBe('quiet');
    expect(result.reason).toBe('trailer-present');
    expect(result.findings).toEqual([]);
  });
});

describe('findIssueIntentHintSentences — 発火する形（真陽性。全部 main の実例）', () => {
  it('PR #1074 の実際の逐語（**#1058 を閉じる。**）', () => {
    const result = findIssueIntentHintSentences(
      '**#1058 を閉じる。** `PATCH /commitments/:id` は #512 から在るのに、Web UI と HTTP からしか叩けなかった。',
    );
    expect(result).toEqual(['**#1058 を閉じる。']);
  });

  it('PR #1106 の実際の逐語（Issue #1097 が指摘していた…を閉じる。参照と動詞のあいだに文字が挟まっても、同じ文の中で文末が動詞なら拾う）', () => {
    const result = findIssueIntentHintSentences(
      'Issue #1097 が指摘していた**規約の文面の欠落**を閉じる。門は #1099 で既に live で required だ。',
    );
    expect(result).toEqual(['Issue #1097 が指摘していた**規約の文面の欠落**を閉じる。']);
  });

  it('クローズ動詞（クローズする）でも拾う', () => {
    expect(findIssueIntentHintSentences('#42 をクローズする。')).toEqual(['#42 をクローズする。']);
  });

  it('参照の別表記（GH-42 / owner/repo#42 / issue の URL）でも拾う', () => {
    expect(findIssueIntentHintSentences('GH-42 を閉じる。')).toEqual(['GH-42 を閉じる。']);
    expect(findIssueIntentHintSentences('octo-org/octo-repo#42 を閉じる。')).toEqual([
      'octo-org/octo-repo#42 を閉じる。',
    ]);
    expect(
      findIssueIntentHintSentences('https://github.com/takecchi/alteroid/issues/42 を閉じる。'),
    ).toEqual(['https://github.com/takecchi/alteroid/issues/42 を閉じる。']);
  });
});

describe('findIssueIntentHintSentences — 否定形は拾わない（Issue #1134 / #1160 の本文自身がこの形を含む）', () => {
  it.each([
    '#1072 を閉じない。',
    '#1072 を閉じていない。',
    '#1072 を閉じられない。',
    '#1072 を閉じません。',
    '#1072 をクローズしない。',
  ])('%s は拾わない', (sentence) => {
    expect(findIssueIntentHintSentences(sentence)).toEqual([]);
  });
});

describe('findIssueIntentHintSentences — 誤爆の実例（調整前の候補が拾っていたが、拾わないよう直したもの）', () => {
  it('保留の言い回し（#907 の実際の逐語の型）は拾わない', () => {
    expect(findIssueIntentHintSentences('#905 を閉じるかどうかは人間が決める。')).toEqual([]);
  });

  it('明示的な保留宣言（#892 / #881 の実際の逐語の型）は拾わない', () => {
    expect(
      findIssueIntentHintSentences('#785（⛔ Closes にしていない — 閉じる判断は依頼者が持つ）'),
    ).toEqual([]);
  });

  it('願望の否定的な向き（〜たくない）は拾わない', () => {
    expect(findIssueIntentHintSentences('#123 を閉じたくない。')).toEqual([]);
  });

  it('婉曲な否定（〜のを避ける）は拾わない', () => {
    expect(findIssueIntentHintSentences('#123 を閉じるのを避ける。')).toEqual([]);
  });

  it('婉曲な否定（〜わけではない）は拾わない', () => {
    expect(findIssueIntentHintSentences('#123 を閉じるわけではない。')).toEqual([]);
  });

  it('台帳の状態語「未クローズ」は参照が同じ文に在っても拾わない（クローズが部分文字列に過ぎない）', () => {
    expect(
      findIssueIntentHintSentences(
        '段1（未着手 / 返答済み・未クローズ）は PR #1005 で本番に入っている。',
      ),
    ).toEqual([]);
  });

  it('条件文（書けば…閉じるし）は拾わない——文末が動詞で終わっていない', () => {
    expect(
      findIssueIntentHintSentences('書けばこの PR 自身が #1109 を閉じるし、门も赤くなる。'),
    ).toEqual([]);
  });

  it('PR #1045 の実際の逐語（PR #999 は、方針の選択の結果として閉じた。）は拾わない——「は」で受けた主語であって「を」で受けた目的語ではない', () => {
    // 「#999 を閉じた」ではなく「#999 は…閉じた」（自動詞的な言い方）なので、
    // 文末の直前に「を」が無い。この门が見るのは「を＋動詞」の直結だけ
    // （doc の「なぜ文末の述語に絞ったか」）なので、この形は最初から
    // SENTENCE_END_INTENT_PATTERN に届かない。200件の実測でもこの PR は
    // 発火しなかった（誤爆ゼロの理由の1つ）。
    expect(findIssueIntentHintSentences('PR #999 は、方針の選択の結果として閉じた。')).toEqual([]);
  });
});

describe('findIssueIntentHintSentences — 除外（コードフェンス・引用・インラインコード・HTML コメント）', () => {
  it('フェンスの中は見ない', () => {
    const text = ['```', '#123 を閉じる。', '```'].join('\n');
    expect(findIssueIntentHintSentences(text)).toEqual([]);
  });

  it('引用行（>）は見ない', () => {
    expect(findIssueIntentHintSentences('> #123 を閉じる。')).toEqual([]);
  });

  it('インラインコードスパンの中は見ない', () => {
    expect(findIssueIntentHintSentences('`#123 を閉じる。` という例。')).toEqual([]);
  });

  it('HTML コメントの中は見ない', () => {
    expect(findIssueIntentHintSentences('<!-- #123 を閉じる。 -->')).toEqual([]);
  });

  it('フェンスをまたいで文がつながらない（フェンスの中の。を文区切りとして数えない）', () => {
    const text = ['#123 の説明が続き、', '```', '断片。', '```', 'を閉じる。'].join('\n');
    // フェンスの中身が空白へマスクされるので、この全体は1つながりの文にはならず、
    // 少なくとも「#123」と「を閉じる。」は別の文として扱われ、参照は拾われない
    // （マスクされた領域を挟んで文が合成されることはない、という設計の確認）。
    expect(findIssueIntentHintSentences(text)).toEqual([]);
  });
});

describe('findIssueIntentHintSentences — タイトル側でも発火する', () => {
  it('evaluateIssueIntentHint はタイトルも見る', () => {
    const result = evaluateIssueIntentHint({ title: '#1072 を閉じる。', body: 'ふつうの本文。' });
    expect(result.verdict).toBe('hint');
    expect(result.findings).toEqual([{ source: 'PR のタイトル', sentence: '#1072 を閉じる。' }]);
  });
});

describe('evaluateIssueIntentHint — 降りる口（trailer が在れば値を問わず静か）', () => {
  it('close 相当（番号の並び）で静か', () => {
    const result = evaluateIssueIntentHint({
      title: 'fix: 何か',
      body: '#1072 を閉じる。\n\nAlteroid-Issue-Done: 1072\n',
    });
    expect(result.verdict).toBe('quiet');
    expect(result.reason).toBe('trailer-present');
  });

  it('none で静か', () => {
    const result = evaluateIssueIntentHint({
      title: 'fix: 何か',
      body: '#1072 を閉じる。\n\nAlteroid-Issue-Done: none\n',
    });
    expect(result.verdict).toBe('quiet');
    expect(result.reason).toBe('trailer-present');
  });

  it('unrecognized（番号の並びとして完全一致しない値）でも静か——trailer 行の存在だけを見る', () => {
    const result = evaluateIssueIntentHint({
      title: 'fix: 何か',
      body: '#1072 を閉じる。\n\nAlteroid-Issue-Done: 993 (段1 のみ)\n',
    });
    expect(result.verdict).toBe('quiet');
    expect(result.reason).toBe('trailer-present');
  });

  it('trailer が無く、ヒントも無ければ no-hint で静か', () => {
    const result = evaluateIssueIntentHint({ title: 'feat: 何か', body: 'ふつうの PR 本文。' });
    expect(result.verdict).toBe('quiet');
    expect(result.reason).toBe('no-hint');
  });

  it('title/body が null でも例外を投げず静かに倒れる', () => {
    const result = evaluateIssueIntentHint({ title: null, body: null });
    expect(result.verdict).toBe('quiet');
    expect(result.findings).toEqual([]);
  });
});

describe('formatIssueIntentHintEvaluation', () => {
  it('quiet(trailer-present) は「静か」を名乗り、trailer に触れる', () => {
    const text = formatIssueIntentHintEvaluation({
      verdict: 'quiet',
      reason: 'trailer-present',
      findings: [],
    });
    expect(text).toContain('静か');
    expect(text).toContain('Alteroid-Issue-Done');
  });

  it('quiet(no-hint) は「静か」を名乗る', () => {
    const text = formatIssueIntentHintEvaluation({
      verdict: 'quiet',
      reason: 'no-hint',
      findings: [],
    });
    expect(text).toContain('静か');
  });

  it('hint(hint-found) は見つかった文と、両方の降りる口（番号での close と none）を明記する', () => {
    const text = formatIssueIntentHintEvaluation({
      verdict: 'hint',
      reason: 'hint-found',
      findings: [{ source: 'PR 本文', sentence: '#1072 を閉じる。' }],
    });
    expect(text).toContain('#1072 を閉じる。');
    expect(text).toContain('Alteroid-Issue-Done: <番号>');
    expect(text).toContain('Alteroid-Issue-Done: none');
    expect(text).toContain('マージを止めない');
  });

  it('この门自身の出力（ファイル名・関数名・formatIssueIntentHintEvaluation の出力文）は閉じるキーワード9語を部分文字列として含まない', () => {
    const text = formatIssueIntentHintEvaluation({
      verdict: 'hint',
      reason: 'hint-found',
      findings: [{ source: 'PR 本文', sentence: '#1072 を閉じる。' }],
    });
    const keywords = [
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ];
    const lower = text.toLowerCase();
    for (const keyword of keywords) {
      expect(lower).not.toContain(keyword);
    }
  });
});
