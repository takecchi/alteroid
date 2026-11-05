// 実行環境プロファイルと鍵・許可・アカウントの読み取り（profile_* / token_list / permission_grant_list / account_list）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { reasonOf } from './dropped-record.js';
import { encodeTokenCursor, resolveTokenCursor } from './token-cursor.js';
import {
  toAgentTokenView,
  tokenAvailabilityAt,
  type ActiveAgentToken,
  type AgentToken,
  type AgentTokenView,
  type CooldownSource,
} from './token-pool.js';
import { describePage, excerptLine, page, renderListing, renderListingEntry } from './excerpt.js';
import { redactProfileFailure } from './profile.js';
import { renderAccountList } from './account-list.js';
import { renderPermissionGrantList } from './permission-grant-list.js';
import {
  profileEntryVersionOf,
  ProfileInputError,
  ProfileRollbackFailedError,
  ProfileVersionMismatchError,
  type ApplyProfileResult,
  type ProfileService,
} from './profile-service.js';
import {
  UnreadableActiveTokenError,
  UnreadableTokenSettingsError,
  describeUnreadableTokens,
  PROFILE_ENTRY_NAME,
} from './store.js';
import { describeIntRangeViolation, formatIntRangeJa } from './tool-arg-checks.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import type { JournalEntryInput } from './schema.js';
import { tool, appendJournalOrDrop, text, appendJournalOrThrow } from './clone-tools-common.js';

const PROFILE_DISTRIBUTION_EXCERPT = 400;

// `APPROVAL_LIST_BUDGET` を使い回さない: 由来が違い、「ふつう数本だから溢れない」を根拠にすると外れたときに一覧が丸ごと使えなくなるため
const TOKEN_LIST_BUDGET = 6_000;

const TOKEN_REASON_EXCERPT = 200;

// `unrecorded` を鍵に持つ: 「出所が無い」は取れなかったことで、`default`（推測）に潰すと嘘になるため
const TOKEN_COOLDOWN_SOURCE_LABEL: Record<CooldownSource | 'unrecorded', string> = {
  quota_reset: '枠の resetsAt（権威ある値）',
  overage_reset: '課金枠の overageResetsAt（権威ある値。枠そのものではない）',
  notice_text: '**上限の文言に書かれていた時刻（推測。ただし既定よりは良い）**',
  default: '**設定の既定（ただの推測）**',
  unrecorded: '記録が無い',
};

const PROFILE_PAGE = 8_000;

// 本文は一覧に載せない: 鍵が入っているので、名前を指して取りに来たときだけ出す
const PROFILE_LIST_BUDGET = 6_000;

// `message` も `reasonOf` も使わない: `profile.apply` の例外は失敗したクエリの `params:` にスクリプト全文を添えうるため、クラス名だけを返す
function errorKindOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

type TokenListTokens = CloneToolsShared['stores']['tokens'];
type TokenListActive = ActiveAgentToken | null | undefined;

// `UnreadableTokenSettingsError` だけを文言にする: 器の障害まで飲み込むと「設定が壊れている」に化けるため
async function readTokenSettingsLine(tokens: TokenListTokens): Promise<string> {
  try {
    const settings = await tokens.readSettings();
    return `回す契機: ${settings.rotateOn} / 冷却 ${String(settings.cooldownMs)}ms`;
  } catch (error) {
    if (!(error instanceof UnreadableTokenSettingsError)) throw error;
    return (
      `回転の設定は読めない（${error.message}）。直すには回す契機と冷却の両方を指定して` +
      '設定し直す（`alteroid token policy <free_exhausted|overage_exhausted|off>' +
      ' --cooldown-ms <値>` / `PUT /tokens/policy`）。'
    );
  }
}

// 読めないときは `null` で偽装せず `undefined` にする: `null` は「まだ一度も指名していない」という別の意味で、潰すと「指名は無い」という嘘になるため
async function readTokenActiveLine(
  tokens: TokenListTokens,
): Promise<{ active: TokenListActive; line: string }> {
  try {
    const active = await tokens.readActive();
    const line =
      active === null
        ? // `null` を「1本目が現役」と書かない: まだ何も撒いていない状態と、1本目を撒いた後は別の状態のため（器の環境変数へは倒れない）
          '現役の指名: **まだ一度も無い**（プールからまだ一度も回していないので、鍵は撒かれていない）'
        : `現役の指名: ${active.tokenId}（世代 ${String(active.generation)}、${active.rotatedAt}）`;
    return { active, line };
  } catch (error) {
    if (!(error instanceof UnreadableActiveTokenError)) throw error;
    return { active: undefined, line: `現役の指名は読めない（${error.message}）。` };
  }
}

// 黙って先頭からへ倒さない
function renderTokenListMalformedCursor(): string {
  return (
    'この cursor は読めない（壊れているか、この道具のものではない）。' +
    'cursor は前回の応答の断り書きに出たものをそのまま渡すこと（自分で組み立てない）。' +
    '先頭から読み直すなら cursor を省いて呼ぶこと。'
  );
}

function renderTokenListLastPage(): string {
  return '（cursor より後ろのトークンは無い。これが最後の頁）';
}

function renderTokenListHead(
  settingsLine: string,
  activeLine: string,
  unreadableTokensNote: string | null,
): string[] {
  return [
    settingsLine,
    activeLine,
    ...(unreadableTokensNote === null ? [] : [unreadableTokensNote]),
  ];
}

// 「プールは空である」は読めない行が0件のときだけ言う: 在れば、読めた行が無いとしか言えないため
function renderTokenListEmpty(head: readonly string[], hasUnreadable: boolean): string {
  return [
    ...head,
    '',
    ...(hasUnreadable
      ? [
          '読めたトークンの行は無い。**プールが空だとは言えない**——読めない行が在り、' +
            'それが使えるかどうかはここから分からない。',
        ]
      : ['プールは空である。**この状態では回らない**——枠に当たっても次の候補が無い。']),
    '登録は人間の手で（`alteroid token add --label <名前> --file <path>`）。',
  ].join('\n');
}

function renderTokenListEntryExtra(view: AgentTokenView): (string | null)[] {
  return [
    view.sha256 === undefined ? null : `  指紋 ${view.sha256}`,
    view.cooldownUntil === undefined
      ? null
      : // 出所を添える: 時刻だけだと枠のリセット時刻なのか5時間足しただけなのかが一覧から言えない。無い回は「記録が無い」と書く: 黙ると「権威ある値」と読まれるため
        `  冷却明け ${new Date(view.cooldownUntil).toISOString()}` +
        `（出所: ${TOKEN_COOLDOWN_SOURCE_LABEL[view.cooldownSource ?? 'unrecorded'] ?? '記録が無い'}）`,
    view.disabledAt === undefined ? null : `  人間が外した ${view.disabledAt}`,
    view.lastRejectedReason === undefined
      ? null
      : // 文言は言い換えずそのまま出す: 回復の見込みは分類であって実測ではないので、そう断って添える
        `  止まった理由（原文）: ${excerptLine(view.lastRejectedReason, TOKEN_REASON_EXCERPT)}` +
        (view.recovery === undefined ? '' : ` / 回復の見込み（分類）: ${view.recovery}`),
    view.invalidatedReason === undefined
      ? null
      : `  失効（原文）: ${excerptLine(view.invalidatedReason, TOKEN_REASON_EXCERPT)}`,
  ];
}

function renderTokenListItems(
  views: readonly AgentTokenView[],
  now: number,
  active: TokenListActive,
): string[] {
  return views.map((view) => {
    // キャストを挟まない: 挟むと「値を持つ型として扱ってよい」が既成事実になるため
    const state = tokenAvailabilityAt(view, now);
    const title = `${state}${active?.tokenId === view.id ? ' ← 現役' : ''}`;
    return renderListingEntry({
      id: view.id,
      title,
      summary: `${view.label}（order ${String(view.order)}）`,
      // `now` で埋めない: 作成・更新が無い行が実在し、「いま作られた」という嘘になるため
      createdAt: view.createdAt ?? '（記録が無い）',
      updatedAt: view.updatedAt ?? '（記録が無い）',
      extra: renderTokenListEntryExtra(view),
    });
  });
}

// 母数は cursor を当てる前の全件: 頁が進んでも動かさないため
function renderTokenListOmitted(args: {
  rest: number;
  shown: number;
  tokens: readonly AgentToken[];
  total: number;
}): string {
  const { rest, shown, tokens, total } = args;
  const lastShown = tokens[shown - 1]!;
  return (
    `…ほか ${rest} 件は省略（プールは ${total} 件あり、order の昇順に ${shown} 件だけ出した）。` +
    // 「**残りを見る手はこの道具に無い**」と名乗らない: 案内先がどちらも人間の口で、クローンからは叩けなかったため
    `続きは token_list cursor=${encodeTokenCursor({ id: lastShown.id, order: lastShown.order })} で取れる。`
  );
}

function renderTokenListFootnotes(): string[] {
  return [
    // 欄の意味を出力に書く: 「作成と更新が同じ」は値を作ったのではなく一度も変わっていないという観測のため
    '（作成 = 行を足した時刻 / 更新 = 最後に変わった時刻。同じなら一度も変わっていない。' +
      'どちらも「記録が無い」ことがある——この2列より前に置かれた行である）',
    '（止まった理由は抜粋。全文は journal_read types=token_rotation の noticeText に在る）',
  ];
}

function renderTokenListBody(args: {
  head: readonly string[];
  items: readonly string[];
  tokens: readonly AgentToken[];
  total: number;
}): string {
  const { head, items, tokens, total } = args;
  return [
    ...head,
    '',
    renderListing(items, {
      budget: TOKEN_LIST_BUDGET,
      omitted: ({ rest, shown }) => renderTokenListOmitted({ rest, shown, tokens, total }),
    }),
    ...renderTokenListFootnotes(),
  ].join('\n');
}

function renderProfileWriteUnavailable(): string {
  return (
    'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。' +
    '次の会話で置くこと。'
  );
}

function renderProfileWriteBadName(): string {
  return `行の名前の形が不正（${PROFILE_ENTRY_NAME.source}）。何も変えていない。`;
}

function renderProfileWriteEmptyScript(): string {
  return '本文が空では行を置けない。外すなら profile_remove を使う。何も変えていない。';
}

// 名前と本文の検査。断る文を返す（通れば null）
function describeProfileWriteViolation(name: string, script: string): string | null {
  if (!PROFILE_ENTRY_NAME.test(name)) return renderProfileWriteBadName();
  if (script.trim().length === 0) return renderProfileWriteEmptyScript();
  return null;
}

// 置く前に書く先の行（`rowLabel` は `profileRowLabel(name)` の戻り）
function buildProfileWriteEntry(args: { summary: string; rowLabel: string }): JournalEntryInput {
  const { summary, rowLabel } = args;
  return {
    type: 'decision',
    decision: `実行環境プロファイルを差し替えようとしている${rowLabel}: ${summary}`,
    grounds: '人間から実行環境そのものを渡された（値は記録しない）',
  };
}

export function profileTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores } = shared;

  // `default` のときは足さない: 日誌を読む側と歯が、その文言で見ているため
  function profileRowLabel(name: string): string {
    return name === 'default' ? '' : `（行 ${name}）`;
  }

  // 文言では見分けない: `ProfileRollbackFailedError` で見る
  async function profileToolFailed(
    tool: 'profile_write' | 'profile_remove',
    name: string,
    summary: string,
    error: unknown,
  ) {
    await appendJournalOrDrop(tool, stores.journal, {
      type: 'decision',
      decision:
        tool === 'profile_remove'
          ? error instanceof ProfileRollbackFailedError
            ? `実行環境プロファイルの行 ${name} の削除が途中で止まった（正本は新しい版のまま・クローンは前の版）: ${summary}`
            : `実行環境プロファイルの行 ${name} を外せなかった: ${summary}`
          : error instanceof ProfileRollbackFailedError
            ? `実行環境プロファイルの差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）${profileRowLabel(name)}: ${summary}`
            : `実行環境プロファイルを差し替えられなかった${profileRowLabel(name)}: ${summary}`,
      grounds:
        tool === 'profile_remove'
          ? `外そうとしたが、状態の変更が失敗した: ${errorKindOf(error)}`
          : `差し替えようとしたが、状態の変更が失敗した: ${errorKindOf(error)}`,
    });
    // 道具のエラーにせず理由をそのまま返す: 置けない入力は利用者の誤りで、何も変えていないため
    if (error instanceof ProfileInputError) {
      return text(`プロファイルの行を置けなかった（何も変えていない）: ${reasonOf(error)}`);
    }
    // 道具のエラーにしない: 何も変えておらず、読み直せば続けられるため。本文は返さない（鍵が入りうる）
    if (error instanceof ProfileVersionMismatchError) {
      return text(
        `プロファイルの行 ${name} は読んだ後に${error.current === null ? '消されている' : '変わっている・作られている'}（何も変えていない）。` +
          `profile_read name=${name} で読み直し、いまの base_version で判断し直すこと。`,
      );
    }
    throw error;
  }

  async function profileToolReport(
    tool: 'profile_write' | 'profile_remove',
    name: string,
    summary: string,
    result: ApplyProfileResult,
    done: { decision: string; text: string },
  ) {
    // 失敗を判断として記録しない: 置けなかったのはシステムの結果で、クローンの判断ではないため
    if (!result.stored) {
      await appendJournalOrDrop(tool, stores.journal, {
        type: 'decision',
        // 外す道具では「差し替え」「置けなかった」と書かない（`profileToolFailed` の外す側の文に揃える）
        decision:
          tool === 'profile_remove'
            ? `実行環境プロファイルの行 ${name} を外せなかった（読めなかった）: ${summary}`
            : `実行環境プロファイルを差し替えられなかった（読めなかった）${profileRowLabel(name)}: ${summary}`,
        grounds: '人間から実行環境そのものを渡されたが、評価で断られた（値は記録しない）',
      });
      // クローンの文脈に鍵の値を入れない: シェルの stderr は入力の行を引用し `set -x` は値ごと吐くため伏せる
      const failure = redactProfileFailure(result.clone, process.env);
      return text(
        `${
          tool === 'profile_remove'
            ? `実行環境プロファイルの行 ${name} を外せなかった`
            : '実行環境プロファイルを置けなかった'
        }（保存も配布もしていない）: ${failure.error}` +
          `${failure.output.length === 0 ? '' : `\n${failure.output}`}`,
      );
    }

    // 一覧を読めず配布を確かめられなかったときだけ、その旨を日誌と応答に足す（無いときの文言は変えない）
    const unconfirmed =
      result.runnersUnconfirmed === undefined
        ? undefined
        : excerptLine(result.runnersUnconfirmed, PROFILE_DISTRIBUTION_EXCERPT);
    await appendJournalOrDrop(tool, stores.journal, {
      type: 'decision',
      decision:
        unconfirmed === undefined
          ? `${done.decision}: ${summary}`
          : `${done.decision}（runner への配布は確かめられなかった）: ${summary}`,
      grounds:
        '人間から実行環境そのものを渡された（値は記録しない）' +
        (unconfirmed === undefined
          ? ''
          : `。runner の一覧を読めず、配布を確かめられなかった: ${unconfirmed}`),
    });

    const failed = result.runners.filter((runner) => !runner.ok);
    const delivered = result.runners.filter((runner) => runner.ok).map((r) => r.runnerId);
    const row = result.entries?.find((entry) => entry.name === name);
    const composed = result.composed;
    return text(
      [
        `実行環境プロファイルを更新した（${done.text}${row === undefined ? '' : `。撒く先 ${row.scope}`}）。`,
        composed === undefined
          ? null
          : `合成後の指紋: クローン用 ${composed.clone.sha256 ?? '（掛かる行なし）'} / runner 用 ${composed.runner.sha256 ?? '（掛かる行なし）'}`,
        unconfirmed === undefined
          ? null
          : `runner への配布を確かめられなかった（runner の一覧を読めない）: ${unconfirmed}`,
        delivered.length === 0
          ? null
          : `配った先: ${excerptLine(delivered.join(', '), PROFILE_DISTRIBUTION_EXCERPT)}`,
        failed.length === 0
          ? null
          : `配れなかった先: ${excerptLine(
              failed.map((r) => `${r.runnerId}（${r.error ?? '理由不明'}）`).join(', '),
              PROFILE_DISTRIBUTION_EXCERPT,
            )}`,
        'これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う。',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  }

  return [
    tool(
      'profile_read',
      [
        '実行環境プロファイル（人間の ~/.zprofile / /etc/profile.d に当たるもの）を読む。',
        'プロファイルは**名前付きの行**の集まりで、行ごとに本文（何行でもよい）と撒く先（all / app / runner）を持つ。',
        'name を省略すると行の一覧（名前・撒く先・バイト数・更新時刻。**本文は載らない**）、',
        'name を渡すとその行の本文を返す。',
        '行は名前のコード単位順（辞書順）につなげられて、撒く先が掛かる側（あなた自身／マネージャーと作業者）へ効く。',
        '**本文には鍵が入っている。読んだ中身を記憶や日誌へ書き写さないこと**',
        '（記憶はあなたのシステムプロンプトに載るし、人間がいつでも開く場所である）。',
      ].join(' '),
      {
        name: z
          .string()
          .optional()
          .describe('読む行の名前。省略すると行の一覧を返す（本文は載らない）'),
        offset: z
          .number()
          .optional()
          .describe(
            `何文字目から読むか（name を渡したときだけ。${formatIntRangeJa({ min: 0 })}。既定 0）`,
          ),
      },
      async ({ name, offset = 0 }) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const rows = await stores.profile.list();
        if (rows.length === 0) {
          return text('実行環境プロファイルは置かれていない。');
        }
        if (name === undefined) {
          return text(
            [
              renderListing(
                rows.map(
                  (row) =>
                    `- ${row.name} / 撒く先 ${row.scope} / ${String(Buffer.byteLength(row.script))} バイト / 更新 ${row.updatedAt}`,
                ),
                {
                  budget: PROFILE_LIST_BUDGET,
                  omitted: ({ rest, shown, total }) =>
                    `…ほか ${rest} 件は省略（全 ${total} 件のうち ${shown} 件だけ出した。名前が分かっていれば profile_read name=<名前> で取れる）。`,
                },
              ),
              '（本文は載せていない。取るには profile_read name=<名前>。つなげる順番は名前のコード単位順。',
              '更新時刻は「最後に本文か撒く先を変えた時刻」で、作成時刻は持っていない）',
            ].join('\n'),
          );
        }
        const row = rows.find((entry) => entry.name === name);
        if (row === undefined) {
          return text(
            `プロファイルに行 ${name} は無い。行の一覧は profile_read（name を省略）で取れる。`,
          );
        }
        const part = page(row.script, offset, PROFILE_PAGE);
        // 「切れている」だけで終えず、書き戻す前に何をすべきかまで言う: 切れたものを `profile_write` へ渡すと、全文置換で検証を通ってしまい行が縮むため
        const tail = part.more
          ? `\n…（ここで切れている。続きは profile_read name=${row.name} offset=${part.to}。` +
            '**profile_write は行の全文置換なので、書き戻すつもりなら先に offset を進めて' +
            '最後まで取ること** — ここまでの分だけを渡すと残りが消える）'
          : '';
        return text(
          `（行 ${row.name} / 撒く先 ${row.scope} / 最終更新 ${row.updatedAt} / ${describePage(part)}）\n${part.body}${tail}` +
            `\n（版 base_version=${profileEntryVersionOf(row)} ——この行を書き直す profile_write と、外す profile_remove に渡せば、読んだ後に人間や別のターンが変えていたとき何も変えずに断られる）`,
        );
      },
    ),

    // 書き込みは渡さない: 枠に当たったクローンはターンを回さないので、判断を待つ設計はいちばん要るときに動かないため
    tool(
      'token_list',
      [
        '認証トークンのプールを読む（枠に当たったとき実装が回す候補の一覧）。',
        '**値は返らない。** 出るのは id・ラベル・指紋・状態だけである。',
        '**この道具に書き込みは無い。** 回すのは実装であってあなたの判断ではないし、',
        '登録・無効化は人間の手（alteroid token / PUT /tokens）に属する。',
        '枠で止まったときここを見れば、候補が残っているのか全部冷却中なのかが分かる。',
        '回った履歴のほうは journal_read types=token_rotation で引ける。',
      ].join(' '),
      {
        cursor: z
          .string()
          .optional()
          .describe(
            '続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。',
          ),
      },
      async ({ cursor }) => {
        // `readSettings()` と `readActive()` を素の `Promise.all` に入れない: どちらかが壊れているだけで一覧まで道連れになり、`token_list` そのものが使えなくなるため
        const allTokens = await stores.tokens.list();
        // 読めなかった行を言う: `list()` は読めない行を飛ばすので、プールが「空」に見えても壊れた行が在るかもしれないため
        const unreadableTokensNote = describeUnreadableTokens(await stores.tokens.listUnreadable());
        const settingsLine = await readTokenSettingsLine(stores.tokens);
        const { active, line: activeLine } = await readTokenActiveLine(stores.tokens);
        const resolved = resolveTokenCursor(allTokens, cursor);
        if (resolved.kind === 'malformed') return text(renderTokenListMalformedCursor());
        // cursor を渡されたときだけ「最後の頁」と言う: プールが空のときの言い方を奪わないため
        if (cursor !== undefined && resolved.view.length === 0) {
          return text(renderTokenListLastPage());
        }
        const tokens = resolved.view;
        // `toAgentTokenView` を通す: 自分で組むと値を含む `AgentToken` から拾う形になり、いつか `value` が混ざるため
        const views = tokens.map((token) => toAgentTokenView(token));
        const now = Date.now();
        const head = renderTokenListHead(settingsLine, activeLine, unreadableTokensNote);
        if (views.length === 0) {
          return text(renderTokenListEmpty(head, unreadableTokensNote !== null));
        }
        const items = renderTokenListItems(views, now, active);
        return text(renderTokenListBody({ head, items, tokens, total: allTokens.length }));
      },
    ),

    // 書き込みは渡さない: 取り消しも読めない行を消す口も人間の手に限る
    tool(
      'permission_grant_list',
      [
        '人間が承認した Bash 許可の記録の一覧（読むだけ）。',
        '取り消し済みの行も出る（状態の札で分かる）。生きている許可だけが Bash 呼び出しを自動で通す。',
        '**この道具に書き込みは無い。** 取り消しも、読めない行を消すことも人間の手に属する。',
        '一覧の本文（規則・回答・allows / denies）は抜粋で、全文が要る1件は id を渡して取る。',
        '切れたときは from で続きを取る。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        from: z
          .number()
          .optional()
          .describe(
            `一覧で、grantedAt 昇順の何件目から出すか（${formatIntRangeJa({ min: 0 })}、0 起点）`,
          ),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
      },
      async ({ id, from = 0, offset = 0 }) => {
        const fromError = describeIntRangeViolation('from', from, { min: 0 });
        if (fromError !== null) return text(fromError);
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        return text(await renderPermissionGrantList(stores, { id, from, offset }));
      },
    ),

    // 付与・取り消し・読めない行を消す口は渡さない
    // email と表示名は載せない: 人間が決めたら変わりうるため
    tool(
      'account_list',
      [
        'alteroid にログインしたアカウントと、使う許可の状態の一覧（読むだけ）。',
        '出るのは id・許可の状態（許可済み / 未許可、許可した時刻と者）・時刻だけ。',
        '**個人の情報（email・表示名）は出さない**（identity・アクセストークンも出ない）。人間が決めたら変わりうる。',
        '**この道具に書き込みは無い。** 許可の付与も取り消しも、読めない行を消すことも人間の手に属する。',
        '1件だけ読むときは id を渡す。切れたときは from で続きを取る。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe('この1件だけを読む（一覧に出ている id）。他の条件は無視される'),
        from: z
          .number()
          .optional()
          .describe(
            `一覧で、createdAt 昇順の何件目から出すか（${formatIntRangeJa({ min: 0 })}、0 起点）`,
          ),
        offset: z
          .number()
          .optional()
          .describe(`id で読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
      },
      async ({ id, from = 0, offset = 0 }) => {
        const fromError = describeIntRangeViolation('from', from, { min: 0 });
        if (fromError !== null) return text(fromError);
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        return text(await renderAccountList(stores, { id, from, offset }));
      },
    ),

    tool(
      'profile_write',
      [
        '実行環境プロファイルの**1行**（名前付き）を全文置換する（無ければ作る）。',
        'プロファイルは名前付きの行の集まりで、行ごとに本文（シェルスクリプト。何行でもよい）と撒く先を持つ。',
        '行は名前のコード単位順（辞書順）につなげられる（/etc/profile.d と同じ）。',
        '人間から「このトークンを使って」「PATH にこれを足して」のように**実行環境そのもの**を',
        '渡されたら、会話の中に置いたままにせずここへ移すこと — 会話は要約に潰れ、器は作り直される。',
        '記憶（判断の根拠）とは別の器である。鍵や PATH を記憶に書かないこと。',
        '置く前に実際に読めるかを確かめるので、読めなければ保存も配布もされず理由が返る',
        '（scope=runner の行だけは、あなたの側では評価できないので runner が評価し、読めなければ配布結果に出る）。',
        '**行の全文置換なので、足すだけのつもりなら先に profile_read name=<名前> で今の本文を取ること。**',
        '撒く先は scope で選ぶ（all=あなたと runner の両方 / app=あなた（デーモン）だけ / runner=マネージャー・作業者だけ。',
        '省略すると既存の行の撒く先を保つ。新しい行なら all）。',
        'runner だけに要る環境（runner に入れた道具の PATH など）を all で置くと、あなた自身にも届いてしまう。',
        '行を外すのは profile_remove。',
      ].join(' '),
      {
        name: z
          .string()
          .optional()
          .describe(
            `行の名前（${PROFILE_ENTRY_NAME.source}。英数字で始まり、英数字と . _ - が使える。64字まで。省略すると default）`,
          ),
        scope: z
          .enum(['all', 'app', 'runner'])
          .optional()
          .describe(
            '撒く先。all=クローン（あなた）と runner の両方 / app=クローンだけ / runner=runner（マネージャー・作業者）だけ。' +
              '省略は「既存の行の撒く先を保つ」（新しい行なら all）',
          ),
        script: z
          .string()
          .describe(
            'この行のシェルスクリプト全文（`export FOO=bar` / `export PATH="$HOME/bin:$PATH"` / `eval "$(tool env)"` など。何行でもよい）。' +
              '空にはできない（外すなら profile_remove）',
          ),
        summary: z
          .string()
          .describe('何を変えたかの一行要約（日誌に残る。**値そのものは書かない**）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の行の版（profile_read name=<名前> の応答に出る base_version）。' +
              '渡すと、読んだ後に人間や別のターンがこの行を変えていたら何も変えずに断る。省略すると比べずに置き換える',
          ),
      },
      async ({ name = 'default', script, summary, scope, base_version: baseVersion }) => {
        if (context.profile === undefined) {
          return text(renderProfileWriteUnavailable());
        }
        // 日誌を書く前に形を検査する: 置けない入力で「差し替えようとしている」を残さないため
        const violation = describeProfileWriteViolation(name, script);
        if (violation !== null) return text(violation);

        // 日誌を先に書く: 書けなければ差し替えずに道具のエラーで返すため
        await appendJournalOrThrow(
          'profile_write',
          stores.journal,
          buildProfileWriteEntry({ summary, rowLabel: profileRowLabel(name) }),
          'act-not-performed',
        );

        // 人間の口と同じ1本道を通る: 評価・保存・配布が1つの区間として直列に行われ、人間の更新と重なっても層ごとに違う本文が残らないため
        let result: Awaited<ReturnType<ProfileService['set']>>;
        try {
          result = await context.profile.set(
            name,
            script,
            scope,
            baseVersion === undefined ? undefined : { ifMatch: baseVersion },
          );
        } catch (error) {
          return await profileToolFailed('profile_write', name, summary, error);
        }
        return await profileToolReport('profile_write', name, summary, result, {
          decision: `実行環境プロファイルを更新した${profileRowLabel(name)}`,
          text: `行 ${name} を置いた`,
        });
      },
    ),

    tool(
      'profile_remove',
      [
        '実行環境プロファイルの1行を外す。他の行は変えない（全部外すときは行を1つずつ外す）。',
        '外した行がクローンと runner のどちらかの最後の1行だったなら、その側からは環境が外れる（空が降りる）。',
        '無い名前を渡しても何も変わらない。行の名前は profile_read（name を省略）で取れる。',
      ].join(' '),
      {
        name: z.string().describe('外す行の名前'),
        summary: z
          .string()
          .describe('何を外したかの一行要約（日誌に残る。**値そのものは書かない**）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の行の版（profile_read name=<名前> の応答に出る base_version）。' +
              '渡すと、読んだ後に人間や別のターンがこの行を変えていたら外さずに断る。省略すると比べずに外す',
          ),
      },
      async ({ name, summary, base_version: baseVersion }) => {
        if (context.profile === undefined) {
          return text(
            'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で外すこと。',
          );
        }
        if (!PROFILE_ENTRY_NAME.test(name)) {
          return text(`行の名前の形が不正（${PROFILE_ENTRY_NAME.source}）。何も変えていない。`);
        }
        await appendJournalOrThrow(
          'profile_remove',
          stores.journal,
          {
            type: 'decision',
            decision: `実行環境プロファイルの行 ${name} を外そうとしている: ${summary}`,
            grounds: '人間から実行環境そのものを渡された（値は記録しない）',
          },
          'act-not-performed',
        );
        let result: Awaited<ReturnType<ProfileService['remove']>>;
        try {
          result = await context.profile.remove(
            name,
            baseVersion === undefined ? undefined : { ifMatch: baseVersion },
          );
        } catch (error) {
          return await profileToolFailed('profile_remove', name, summary, error);
        }
        if (!result.removed) {
          await appendJournalOrDrop('profile_remove', stores.journal, {
            type: 'decision',
            decision: `実行環境プロファイルの行 ${name} は無かったので何も変えなかった: ${summary}`,
            grounds: '外そうとしたが、その名前の行は置かれていなかった',
          });
          return text(`プロファイルに行 ${name} は無い。何も変えていない。`);
        }
        return await profileToolReport('profile_remove', name, summary, result, {
          decision: `実行環境プロファイルの行 ${name} を外した`,
          text: `行 ${name} を外した`,
        });
      },
    ),
  ];
}
