/**
 * ## なぜ余白ゼロか
 *
 * `check-web-bundle-size.mjs` の予算が余白を持つのは、ビルド生成物のバイト数が測定のたびに揺らぐため。
 * `AGENTS.md` のバイト数は編集したときにしか動かず、揺らぎが無い。余白を持たせると、その分は無審査で
 * 増やせてラチェットの意味が薄れるので、`BUDGET_HISTORY` の最新の実測値をそのまま予算にする。
 *
 * ## 予算を `BUDGET_HISTORY` への理由付き追記から導出する理由
 *
 * 予算を上げる逃げ道は要るが、数字だけを書き換える経路を作らないため。
 * 機械が見るのは `why` が非空であることだけで、内容の妥当性は人のレビューが見る。
 *
 * ## この歯の弱さ
 *
 * - バイト数は「判断基準を取り出す負担」の代理変数にすぎない。`.claude/skills/` へ移せば緑になるが、
 *   読む側の負担が減ったかは見ていない
 * - 一方向のラチェットで、縮んでも予算は自動で下がらない。下げるのは人の仕事なので、
 *   緑のときも余白（`slackBytes`）を出力する
 * - 内容の質を見ない（正しい訂正の追記も無駄な追記も同じに数える）
 */

/**
 * 予算は必ずここへ1件追記してから導出する。
 * `bytes` / `lines` は、そのとき実測した `AGENTS.md` の大きさ。
 */
export const BUDGET_HISTORY = [
  {
    date: '2026-09-17',
    bytes: 150308,
    lines: 608,
    why:
      '最初の記録。main の 40dfab4 を実測した値（`git show 40dfab4:AGENTS.md | wc -l -c`）を' +
      'そのまま予算に据えた（余白ゼロ）。この値には測定のゆらぎが無い（人/AI が編集した' +
      'ときにしか動かない）ので、揺らぎを吸収するための余白を持つ理由も無い。' +
      '#1192（注意書きを増やす速度と歯へ移す速度が釣り合っていない）を受けて、' +
      'この文書自身の大きさにラチェットを置く1本目の歯として導入した。',
    ref: 'https://github.com/takecchi/alteroid/issues/1192',
  },
  {
    date: '2026-09-22',
    bytes: 151055,
    lines: 609,
    why:
      'PR #1271: `AGENTS.md`「自分が走っている器」節の ready の手順（逐語は' +
      "`grep -Fn -- 'タイミングは「CI が green であることを確認し、報告を出す直前」' AGENTS.md`）は、" +
      '`ci.yml` が draft の `pull_request` では `ci` / `image` / `base-overlap` を回さないことと' +
      '食い違っており、文字どおりには実行できなかった。実行できる順序（ready の前に自分で通すのは' +
      '手元の検証一式であって CI の緑ではない。CI の緑を確かめるのは `gh pr ready` の後、本物の run に' +
      '対してである）を1本足した。機構の説明（`skipped` のまま `completed` を返す形・' +
      '`mergeStateStatus: CLEAN` まで出る形・required の `skipped` が満たしたものとして扱われる形）は' +
      '既に `.claude/skills/pr-green/SKILL.md` が持っていたので、そちらは足さず参照1つに寄せて' +
      '増分を最小にした。',
    ref: 'https://github.com/takecchi/alteroid/pull/1271',
  },
  {
    date: '2026-09-23',
    bytes: 151963,
    lines: 611,
    why: 'Issue #1318 の (2)（消えた枝が抱えていた「なぜ main に在る sha を指すのか」の根拠）を「出典の引き方」の隣へ1本、`git clone --depth N` が母集合を静かに切る形を「静かに失敗する道具」へ1本、それぞれ足した。**どちらも (a) 常時必要な判断基準である** —— 前者は sha を出典として引くたび、後者は数えるたびに掛かり、場面で開く skill には置けない。**⛔ 枝の逐語はそのまま移していない** —— 同じ行が持つ事実の主張（「fa98bb2 以降1バイトも変わっていない」）は実測で偽だったので、使ったのは根拠の一文だけである。**実測記録の側は入れていない** —— (c) に当たるので、40桁 sha からの回収手順は既に持っている .claude/skills/branch-cleanup/SKILL.md への参照1つに寄せ、この文書には規則と復旧の1コマンドだけを置いた。',
    ref: 'https://github.com/takecchi/alteroid/issues/1318',
  },
  {
    date: '2026-09-27',
    bytes: 89868,
    lines: 350,
    why:
      '#1192 の再編 PR1: 道具の癖と部分系の手順を .claude/skills/ へ逐語で移した' +
      '（2026-09-27 のオーナー決定: 道具の癖は (a) に数えない）。' +
      '内容が失われていないことは移設前後のチャンク突き合わせで確かめた。',
    ref: 'https://github.com/takecchi/alteroid/issues/1192',
  },
  {
    date: '2026-09-27',
    bytes: 67193,
    lines: 355,
    why:
      '#1192 の再編 PR2: AGENTS.md に残った節から (c) 実測記録・実例を ' +
      '.claude/agents-md-records/ へ逐語で移した。規則は本体に残し、各節から1行で辿れる。' +
      '内容が失われていないことは移設前後のチャンク突き合わせで確かめた。',
    ref: 'https://github.com/takecchi/alteroid/issues/1192',
  },
  {
    date: '2026-09-27',
    bytes: 63699,
    lines: 360,
    why:
      '#1192 の再編 3/3: 本体を締めた。規則 Q（#1192 の 2026-09-23）で2人とも (a) 以外と付けたチャンクのうち、' +
      '経緯と実測（門の廃止の経緯・提案の諮り方・刻印の慣行・参照の歯の中身・止まった作業者の実測）を .claude/agents-md-records/ へ、' +
      '部分系の手順（OS の env 注入を測るテスト・生成物を触る PR の順序・デプロイで畳まれる範囲・postgres の立て方への参照）を .claude/skills/ へ逐語で移した。' +
      '2人とも (a) 以外でも、全員が守る規約（コミットの型・トレーラ・閉じるキーワード・Issue-Done・ブランチと PR・ready の時機）と' +
      '静かに失敗する形の原則（パイプの終了コード・trap・3値・外部へ書いたら引き直す）は残した（迷ったら残す側に倒す）。' +
      '書く先の線に3つ目の置き場（実測記録）と「道具の癖は数えない」を足した。',
    ref: 'https://github.com/takecchi/alteroid/issues/1192',
  },
  {
    date: '2026-10-07',
    bytes: 65500,
    lines: 395,
    why:
      'オーナーの #3832 で情報の置き場所のルールを足したため（実測 64,976 B / 395行、旧予算比 +1,277 B）。' +
      'この節は削らずに残す。予算は実測に 524 B の余白を足した値にした——余白ゼロの原則（上の「なぜ余白ゼロか」）から' +
      '外れるが、超過分に小さな余白を足す程度にとどめるのはオーナーの指示（#3849）。',
    ref: 'https://github.com/takecchi/alteroid/issues/3849',
  },
  {
    date: '2026-10-07',
    bytes: 63589,
    lines: 389,
    why:
      '#3850 で上げた予算を、本文を外へ移して下げ戻した。#3832 の「情報の置き場所」の節は (a) 常時必要な' +
      '判断基準なので残し、代わりに既存の節から理由と経緯の文を .claude/agents-md-records/ へ逐語で移した' +
      ' —— 「書く先を決める」の書く先を2つにする理由の2段落を where-to-write.md へ、「リポジトリの約束」の' +
      'トレーラを付けない理由と刻印をやめて追えなくなるものの2項を repo-conventions.md へ。規則の行' +
      '（#1192 の 3/3 で残すと決めた規約）は1行も動かしていない。移した4行が逐語で届いていることは、' +
      '削った行と足した行の突き合わせで確かめた。余白はゼロに戻した（上の「なぜ余白ゼロか」）。' +
      '#3849 の「小さな余白」は上げるときの上げ幅についての指示である。',
    ref: 'https://github.com/takecchi/alteroid/pull/3884',
  },
];

export const AGENTS_MD_MAX_BYTES = BUDGET_HISTORY[BUDGET_HISTORY.length - 1].bytes;

/** `cat` が一度に返す上限（バイト）。`.claude/skills/tool-quirks/SKILL.md` の実測。 */
export const CAT_WINDOW_BYTES = 30_000;

/** ファイル IO はしない（読むのは CLI 側）。 */
export function judgeAgentsMdSize({ bytes, lines }) {
  const budget = AGENTS_MD_MAX_BYTES;
  const over = bytes > budget;
  const overBytes = over ? bytes - budget : 0;
  const overPercent = over ? (overBytes / budget) * 100 : 0;
  const slackBytes = over ? 0 : budget - bytes;

  return {
    ok: !over,
    bytes,
    lines,
    budget,
    overBytes,
    overPercent,
    usedPercent: (bytes / budget) * 100,
    slackBytes,
    catWindows: Math.ceil(bytes / CAT_WINDOW_BYTES),
  };
}
