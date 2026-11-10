import { describe, expect, it } from 'vitest';
import {
  buildDenialAllowedButDeniedNote,
  buildDenialAllowedByCloneNote,
  buildDenialAskSummary,
  buildDenialDeniedByCloneNote,
  buildDenialEntryNote,
  buildDenialNoMatchKeyNote,
  buildDenialNoToolNameNote,
  buildDenialStreakNote,
  buildDenialTimedOutNote,
} from './runner-permission-denied-text.js';

// 純関数の文面を値で固定する（`runner-permission-denied-pin.test.ts` の全文と同じ文字列。切り出し前の実装の出力）
describe('buildDenialStreakNote', () => {
  it('連続拒否あり・担当', () => {
    expect(
      buildDenialStreakNote('担当', 'manager', {
        consecutive: 3,
        total: 5,
        firstReason: '最初の理由',
      }),
    ).toMatchInlineSnapshot(
      `"分類器の拒否が 担当 で続けて 3 回になった（累計 5 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 最初の理由"`,
    );
  });
  it('作業者・view が無いと既定値', () => {
    expect(buildDenialStreakNote('作業者 w1', 'agent-1', undefined)).toMatchInlineSnapshot(
      `"分類器の拒否が 作業者 w1 で続けて 0 回になった（累計 0 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。この作業者には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: (取れなかった)"`,
    );
  });
  it('firstReason が undefined', () => {
    expect(
      buildDenialStreakNote('作業者 w1', 'agent-1', {
        consecutive: 2,
        total: 2,
        firstReason: undefined,
      }),
    ).toMatchInlineSnapshot(
      `"分類器の拒否が 作業者 w1 で続けて 2 回になった（累計 2 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。この作業者には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: (取れなかった)"`,
    );
  });
});

describe('buildDenialEntryNote', () => {
  it('通常の理由', () => {
    expect(buildDenialEntryNote('担当', 'Bash', 'tu-1', '危険な操作')).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・Bash・tool_use_id=tu-1）。理由の先頭: 危険な操作（issue #1766）"`,
    );
  });
  it('理由が undefined・空・空白のみ・toolName / toolUseId なし', () => {
    expect(buildDenialEntryNote('担当', undefined, undefined, undefined)).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・道具名なし・tool_use_id=無し）。理由の先頭: (無し)（issue #1766）"`,
    );
    expect(buildDenialEntryNote('担当', 'Bash', 'tu-1', '')).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・Bash・tool_use_id=tu-1）。理由の先頭: (無し)（issue #1766）"`,
    );
    expect(buildDenialEntryNote('担当', 'Bash', 'tu-1', ' \n\t ')).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・Bash・tool_use_id=tu-1）。理由の先頭: (無し)（issue #1766）"`,
    );
  });
  it('空白は畳まれ前後は削られる', () => {
    expect(buildDenialEntryNote('担当', 'Bash', 'tu-1', '  a \n\n b\t c  ')).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・Bash・tool_use_id=tu-1）。理由の先頭: a b c（issue #1766）"`,
    );
  });
  it('ちょうど80コードポイントは省略なし・81で省略（サロゲートペアは1字）', () => {
    expect(buildDenialEntryNote('担当', 'Bash', 'tu-1', '𠮷'.repeat(80))).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・Bash・tool_use_id=tu-1）。理由の先頭: 𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷（issue #1766）"`,
    );
    expect(buildDenialEntryNote('担当', 'Bash', 'tu-1', '𠮷'.repeat(81))).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・Bash・tool_use_id=tu-1）。理由の先頭: 𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷…（issue #1766）"`,
    );
    expect(buildDenialEntryNote('担当', 'Bash', 'tu-1', 'あ'.repeat(200))).toMatchInlineSnapshot(
      `"分類器の拒否のフックが届いた（担当・Bash・tool_use_id=tu-1）。理由の先頭: ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ…（issue #1766）"`,
    );
  });
});

describe('固定文面の note', () => {
  it('道具名なし', () => {
    expect(buildDenialNoToolNameNote('担当')).toMatchInlineSnapshot(
      `"分類器の拒否（担当）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。"`,
    );
  });
  it('入力が鍵にならない', () => {
    expect(buildDenialNoMatchKeyNote('作業者 w1', 'Bash')).toMatchInlineSnapshot(
      `"分類器が 作業者 w1 の Bash 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳めなかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。"`,
    );
  });
  it('再拒否', () => {
    expect(buildDenialAllowedButDeniedNote('担当', 'Write')).toMatchInlineSnapshot(
      `"分類器が 担当 の Write 呼び出しを、allow を返した撃ち直しのあとでも再び止めた。同じ呼び出しの確認は重ねて上げない（allow しても通らなかった。人間が止められた中身を見て誤検知だと確かめるまで、同じ入力は通らないことがある。#4904）。"`,
    );
  });
  it('持ち時間切れ', () => {
    expect(buildDenialTimedOutNote('担当', 'Bash')).toMatchInlineSnapshot(
      `"分類器の拒否（担当・Bash）への1回だけの許可の確認が、フックの持ち時間切れで終わった。安全側で retry は返さない。答えが遅れて届いても、この確認は既に解決済みなので反映しない（issue #1105 P1）。"`,
    );
  });
  it('クローンが deny', () => {
    expect(buildDenialDeniedByCloneNote('作業者 w1', 'Bash', '許可しない')).toMatchInlineSnapshot(
      `"クローンが分類器の拒否（作業者 w1・Bash）への1回だけの許可を出さなかった: 許可しない"`,
    );
  });
});

describe('buildDenialAllowedByCloneNote', () => {
  it('ruleAdded が真', () => {
    expect(buildDenialAllowedByCloneNote('担当', 'Bash', 10, true)).toMatchInlineSnapshot(
      `"クローンが分類器の拒否（担当・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力の1回だけを10分通す一時規則をこのセッションに足した（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。"`,
    );
  });
  it('ruleAdded が偽', () => {
    expect(buildDenialAllowedByCloneNote('担当', 'Bash', 10, false)).toMatchInlineSnapshot(
      `"クローンが分類器の拒否（担当・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力で撃ち直しても、分類器にまた止められうる（迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさない）。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4904）。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。"`,
    );
  });
  it('ttlMinutes は文面の2か所に入る', () => {
    const text = buildDenialAllowedByCloneNote('担当', 'Bash', 7, true);
    expect(text.split('7分')).toHaveLength(3);
  });
});

describe('buildDenialAskSummary', () => {
  it('連続拒否の段落なし・ruleable 偽', () => {
    expect(buildDenialAskSummary(null, '担当', 'Bash', false, '理由です', 'ls -la'))
      .toMatchInlineSnapshot(`
      "分類器が 担当 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。allow は「同じ入力での撃ち直しを、10分以内に1回だけ通そうとする」許可で、撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。分類器が迂回・敵対の型で止めた場合は、allow しても撃ち直しは通らないことがある（分類器は、クローンの allow や担当からの伝言を人間の確認と見なさない）。通すには、人間が止められた中身を見て誤検知だと確かめる必要がある。allow の後は、担当・作業者へ「同じ入力で撃ち直しても、分類器にまた止められうる。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える（#4904）。この許可で通るかは確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 理由です
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: ls -la"
    `);
  });
  it('連続拒否の段落あり・ruleable 真', () => {
    expect(buildDenialAskSummary('連続の段落', '作業者 w1', 'Bash', true, '理由です', 'ls -la'))
      .toMatchInlineSnapshot(`
      "連続の段落

      分類器が 作業者 w1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 理由です
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: ls -la"
    `);
  });
  it('理由・入力の先頭が undefined', () => {
    expect(buildDenialAskSummary(null, '担当', 'Write', false, undefined, undefined))
      .toMatchInlineSnapshot(`
      "分類器が 担当 の Write 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。allow は「同じ入力での撃ち直しを、10分以内に1回だけ通そうとする」許可で、撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。分類器が迂回・敵対の型で止めた場合は、allow しても撃ち直しは通らないことがある（分類器は、クローンの allow や担当からの伝言を人間の確認と見なさない）。通すには、人間が止められた中身を見て誤検知だと確かめる必要がある。allow の後は、担当・作業者へ「同じ入力で撃ち直しても、分類器にまた止められうる。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える（#4904）。この許可で通るかは確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: (無し)
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: (取れなかった)"
    `);
  });
});
