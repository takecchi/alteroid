import { excerptLine } from './excerpt.js';
import { renderMemoryDocuments } from './memory.js';
import { describeAnsweredVia } from './schema.js';
import { readAtLabel } from './situation.js';
import type { HumanAction, HumanActionKind, JournalEntry, MemoryDocument } from './schema.js';

// `clone.ts` の `Clone` にあった、ターンの入力へ載せる文面と判定のうち、状態を読まず書かない部分を、純関数として出したもの。
// 切り出した理由: `Clone` の private で直接呼べず、`clone-turn-input-text-pin.test.ts` が `createClone` 越しにしか縛れなかったため。
// `Clone` の状態は読まない: 記憶・日誌・待ち行列の読み出しと、「読むこと自体が遷移（印を下ろす）」になる呼びは `Clone` に残り、値だけを引数で受ける。
// 同期のまま保つ: 呼び元の `await` の並びと評価順を変えないため。
// 日誌の接頭辞（`EXCHANGE_KIND_*_PREFIX`）は持たない: `exchange-kind-coverage` が呼び元（`Clone`）の字面で見るため。

const CLONE_ID_LIST_EXCERPT = 400;

// 窓は `Clone` が日誌を引く件数でもある（`#humanActionSection`）: 描く側の「窓ちょうどなら窓の外を断る」と同じ値でなければ断りが嘘になるため
export const HUMAN_ACTION_WINDOW = 200;
const HUMAN_ACTION_SHOWN = 20;
const HUMAN_ACTION_DECISION_EXCERPT = 160;
// `Record` で全種を強いる: kind を足したときに言い方の追加を忘れると、型が落ちる前に英語の識別子が入力へ漏れるため
const HUMAN_ACTION_LABEL: Record<HumanActionKind, string> = {
  manager_message: '担当へ直接送った',
  commitment_close: '台帳の行を閉じた',
  commitment_reopen: '台帳の行を開き直した',
  task_close: 'task を閉じた',
  task_reopen: '閉じた task を開き直した',
  task_move: 'task を並べ替えた',
  schedule_remove: '定期の依頼を外した',
  practice_remove: 'やり方を消した',
  practice_write: 'やり方を書き直した',
};

export function renderHumanActionSection(
  marked: readonly { decision: string; action: HumanAction }[],
  rowCount: number,
): string[] {
  // 新しい順で返るので、新しい側を残して古い順に並べ直す
  const shown = marked.slice(0, HUMAN_ACTION_SHOWN).reverse();
  const hidden = marked.length - shown.length;
  const windowFull = rowCount === HUMAN_ACTION_WINDOW;
  return [
    '[system] 前回のターンの後に、人間が自分の手で直したことがある（日誌の decision に、人間が API から直接した操作の印が残っている）。',
    ...shown.map(
      ({ decision, action }) =>
        `- ${HUMAN_ACTION_LABEL[action.kind]}: ${action.target}` +
        `（${excerptLine(decision, HUMAN_ACTION_DECISION_EXCERPT)}）` +
        ` 経路: ${describeAnsweredVia(action.via)}`,
    ),
    ...(hidden > 0
      ? [`- ほか ${hidden} 件（\`journal_read\` の \`types: ["decision"]\` で読める）`]
      : []),
    ...(windowFull
      ? ['（日誌の直近の窓だけを見た。窓の外にもあるかもしれない。これで全部とは限らない）']
      : []),
    '人間が自分の手で直したのは、あなたの判断か進め方のどこかが人間の考えとずれていたからである。' +
      '何が変わったかを確かめ、そこから読み取れる基準があれば記憶に書くこと。' +
      '人間が取り消したものを、同じ形でやり直さないこと。' +
      'なぜそうしたのかが読み取れなければ、人間に聞いてよい。' +
      '経路は監査の記録であって、人間がした証拠ではない' +
      '（持ち主のトークンや認証を切った構成では、あなたの Bash からも同じ口を叩ける）。',
  ];
}

// 記憶更新の頭（#5301）。
const MEMORY_UPDATE_HEAD =
  '[system] 記憶が更新された（人間が直接書き換えたか、あなた自身が更新した）。' +
  '**変わった文書だけを載せる。ここに出ていない文書は変わっていない。**' +
  '載っている文書も、大きく変わっていなければ**変わった範囲だけ**が載る' +
  '（省いた側は行数と文字数で名乗ってある）。' +
  'システムプロンプトの「現在の記憶」は**このセッションを組んだ時点の索引**（要旨と節の目次）であり、' +
  'それに続けてこれらの差分を当てたものが現在の索引である。' +
  '**節の本文はどこにも載っていない——要るなら `memory_section_read` で開くこと。**';

// 記憶の全文を載せ直さない: 二重載せになり、履歴の写しが resume のたびに増えるため
const RESUMED_MEMORY_NOTICE =
  '[system] このセッションは前のセッションを引き継いで（resume して）開いたものである。' +
  '**現在の記憶は、システムプロンプトの「現在の記憶」に載っているものである。** ' +
  'この下より前の会話に「記憶が更新された」として載っている塊は、それより古い可能性がある' +
  '（デーモンが落ちている間に人間が直していれば、正本のほうが新しい）。食い違ったら' +
  'システムプロンプト側を採ること。確かめたければ `memory_read` で読み直せる。';

// 載せ直すものが無い回の入力: resume 直後の断りだけを本文の前に置く（`resumed` が偽なら本文のまま）
export function prependResumedMemoryNotice(resumed: boolean, text: string): string {
  return resumed ? [RESUMED_MEMORY_NOTICE, '', '---', '', text].join('\n') : text;
}

// 載せ直すのは変わった文書の、変わった範囲だけにする: 全文を置くと、載せた塊が会話の履歴として残り、直すたびに写しが増えて resume でも運ばれる（1回の費用が「変えた量」でなく「文書の大きさ」で決まる）ため。
// 削除は名前だけで伝える: 本文を載せると「消したのに文脈には居る」状態になるため。
// `presentInMemory` に記憶の全体（`documents`）を渡す: 差分だけだと、親が今回変わっていないだけで「親が無い」と出て「ここに出ていない文書は変わっていない」と矛盾するため。
// `head` で「変わった範囲だけが載る」と「システムプロンプトの記憶はセッション構築時点のもの」を明言する: 省略が黙って行われると記憶の破損と読まれ、システムプロンプトは `#buildSessionSpec` が1回だけ焼くので「現在の内容」と言うのは嘘になるため。
export function composeFreshMemoryInput(input: {
  readonly resumed: boolean;
  /** 要約の後に索引を丸ごと載せ直す回（`head` が索引の載せ直しの文になる）。 */
  readonly refreshIndex: boolean;
  readonly attribution: readonly string[];
  /** 載せ直す索引の本文（`refreshIndex` の回だけ。それ以外は `null`）。 */
  readonly reinjectedIndex: string | null;
  readonly documents: readonly MemoryDocument[];
  readonly changed: readonly MemoryDocument[];
  readonly removed: readonly string[];
  readonly seenContent: ReadonlyMap<string, string>;
  readonly text: string;
}): string {
  const {
    resumed,
    refreshIndex,
    attribution,
    reinjectedIndex,
    documents,
    changed,
    removed,
    seenContent,
    text,
  } = input;
  const head = refreshIndex
    ? '[system] この会話の文脈が要約に潰された。**それまでに載せた記憶の差分も、その要約の中へ' +
      '畳まれている**（残っているとは限らない）。だから**いまの索引を丸ごと載せ直す** —— ' +
      '下に在るのが現在の記憶の全体（要旨と節の目次）であり、システムプロンプト側の' +
      '「現在の記憶」より新しい。食い違ったら下を採ること。' +
      '**節の本文はどこにも載っていない——要るなら `memory_section_read` で開くこと。**'
    : MEMORY_UPDATE_HEAD;

  return [
    ...(resumed ? [RESUMED_MEMORY_NOTICE, ''] : []),
    head,
    ...attribution,
    // 索引の載せ直しは `seenContent` を渡さない: 渡すと「変わった範囲だけ」に縮み、潰された分を埋められないため。
    ...(reinjectedIndex !== null
      ? reinjectedIndex === ''
        ? []
        : ['', reinjectedIndex]
      : changed.length === 0
        ? []
        : ['', renderMemoryDocuments(changed, { presentInMemory: documents, seenContent })]),
    ...(removed.length === 0
      ? []
      : [
          '',
          // 名前は切らない（抜粋にしない）: 省略に落ちた名前の文書は、システムプロンプトに記載が残るので「まだ在る」と読まれるため。
          // 長さの上限も置かない: 件数は消えた文書の数で有限（slug は 128 文字まで）で、上限を置くと省略の語が要り、同じ誤読を作るため
          `削除された記憶: ${removed.map((slug) => `${slug}.md`).join(' / ')}`,
        ]),
    ...(documents.length === 0 ? ['', '（記憶は空になった）'] : []),
    '',
    '---',
    '',
    text,
  ].join('\n');
}

// 日誌が読めなければ（呼び元が行を渡せなければ）1行も返さない: 書き手を推測で名指しすると、人間の書き込みでないものを人間のものと言うため。
// 引いた行が `limit` 件ちょうどなら untraced を作らない: 窓の外に書き手の行があるかもしれず、「残っていない」と言えないため。
export function describeMemoryEditAttribution(
  rows: readonly JournalEntry[],
  slugs: readonly string[],
  limit: number,
): string[] {
  const human = new Set<string>();
  const self = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'memory_update') continue;
    if (row.cause === 'human' && row.action !== 'write_failed') human.add(row.slug);
    else if (row.cause === 'clone' || row.cause === 'distill') self.add(row.slug);
  }
  const humanSlugs = slugs.filter((slug) => human.has(slug));
  const untracedSlugs =
    rows.length === limit ? [] : slugs.filter((slug) => !human.has(slug) && !self.has(slug));
  const list = (names: readonly string[]): string =>
    excerptLine(names.join(' / '), CLONE_ID_LIST_EXCERPT);
  return [
    ...(humanSlugs.length === 0
      ? []
      : [
          `**人間が書き換えた記憶: ${list(humanSlugs)}**（日誌に人間の書き込みとして残っている）。` +
            '人間が直したのは、あなたの理解のどこかが人間の考えとずれていたからである。' +
            '何が変わったかを読み、同じずれが他の記憶や進行中の判断・委譲に残っていないかを確かめること。' +
            'なぜ直したのかが読み取れなければ、人間に聞いてよい。',
        ]),
    ...(untracedSlugs.length === 0
      ? []
      : [
          `日誌に書き手が残っていない変更: ${list(untracedSlugs)}` +
            '（人間が記憶のファイルを直接開いて直した可能性がある。あなた自身の更新なら日誌に残っている）。',
        ]),
  ];
}

// 読み直す口の名前（`conversation_read`）を書く: 「読み直せる」だけだと次のターンで口を探すところから始めるため。「読め」とは書かない: 読み直すかどうかはクローンの判断のため（`usage-limits.ts` の `describeUsageNotice`）。
// 開き直しの断りとの並びと、`takeContextWindowFoldNoticePending()`（呼ぶこと自体が pending を倒す遷移）は呼び元に残す。ここは固定文だけ
export function describeContextWindowFoldNotice(): string {
  return (
    '[system] 直前のターンが文脈窓（プロンプトの長さ）に当たって失敗したので、' +
    'このセッションは前の会話を引き継がずに開き直したものである。' +
    '**⟹ あなたはそれまでのやりとりを文脈として持っていない。**' +
    'ただし会話の記録そのものは消えていない（`conversation_read` で読み直せる。' +
    '生ログはアーカイブに退避してある）。' +
    '⚠️ 記憶（システムプロンプトの「現在の記憶」）はそのままである' +
    '——失われたのは会話の文脈だけである。\n\n---\n\n'
  );
}

// 待ち行列の断り書きの「積んだ／積めなかった」の行（#5469 P6c）。積んだ id と積めなかった id は呼び元が分けて渡す
export function describeTaskQueuePlacement(
  placedIds: readonly string[],
  failedIds: readonly string[],
): { placed: string[]; failed: string[] } {
  const idsOf = (ids: readonly string[]): string =>
    excerptLine(ids.map((id) => `\`${id}\``).join(', '), CLONE_ID_LIST_EXCERPT);
  const placed =
    placedIds.length === 0
      ? []
      : [
          (placedIds.length > 1
            ? `いま届いたこの ${placedIds.length} 件は task ${idsOf(placedIds)} として積んだ。`
            : `いま届いたこの一件は task ${idsOf(placedIds)} として積んだ。`) +
            '返事をしたターンの終わりに自動で done になる。続けるなら `task_keep`、委譲するなら `manager_start` に `taskId`。',
        ];
  const failed =
    failedIds.length === 0
      ? []
      : [
          `**⚠️ いま届いたこの ${failedIds.length} 件は Task として積めなかった（id: ${idsOf(failedIds)}）。** ` +
            '待ち行列には載っていない。必要なら `task_add` で載せ直すこと（理由は日誌に残してある）。',
        ];
  return { placed, failed };
}

// いつ数えた値かを名乗る: この節は `#pushInput` で会話履歴に溜まり、時刻が無いと後から読み返す側が「あと何件残っている」をどのターンのものか判定できないため
// `nowMs` は呼び元が `Date.now()` を評価して渡す（評価の位置と回数を変えないため）
export function describeMergedBatchTruncation(
  truncation: {
    readonly limit: number;
    readonly batchSize: number;
    readonly remainingHead: number;
  },
  nowMs: number,
): string {
  const { limit, batchSize, remainingHead } = truncation;
  return [
    `[system] **このターンへ束ねる合図は、上限（${String(limit)} 件）で切った束である` +
      `（この束は ${String(batchSize)} 件。${readAtLabel(nowMs)} 時点）。**` +
      `同じ束に入るはずの合図が、待ち行列の先頭にあと ${String(remainingHead)} 件連続して残っている。`,
    '**1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。',
    '',
    '---',
    '',
  ].join('\n');
}
