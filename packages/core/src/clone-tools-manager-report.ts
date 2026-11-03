// マネージャーへの委譲の道具のうち `manager_report`。`clone-tools-manager.ts` の `managerTools` が並びのまま連結する。
// このファイルから `clone-tools-manager.ts` を import しない（一方向）。他の道具とも使う補助は `clone-tools-manager-describe.ts` に在る。

import { z } from 'zod';
import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import { describeUnobservedOutcome } from './digest.js';
import { reasonOf } from './dropped-record.js';
import { describePage, page } from './excerpt.js';
import { describeReportDrift } from './manager-activity.js';
import type { ManagerPool, ManagerSummary, ManagerTranscript } from './manager.js';
import { tokenGenerationMismatched } from './manager-summary.js';
import { describeUnreadableManagerRow } from './store.js';
import { describeManagerModels, managerModelsOf } from './manager-models.js';
import { describeIntRangeViolation, formatIntRangeJa } from './tool-arg-checks.js';
import { text, TRANSCRIPT_PAGE, tool, NO_POOL, isSubagentCaller } from './clone-tools-common.js';
import type { ToolContext } from './clone-tools-context.js';
import {
  describeDenials,
  describeManagerCgroupEvents,
  describeManagerFailure,
  describeManagerSystemError,
  describeRunnerVanished,
  describeUnpushedWorkObservation,
  describeUsageStopped,
  isFoldedTurnReport,
} from './clone-tools-manager-describe.js';

const REPORT_PAGE = 8_000;

// 全行を JSON.parse しない: 生ログは MB 級になりうるため末尾からこの文字数だけ見る
const REPORT_GENERATED_PROBE_CHARS = 200_000;

interface LastAssistantUtterance {
  timestamp: string | undefined;
  length: number;
  // 本文があっても終わったとは限らない: 道具を挟む前の語りも `type: 'text'` で、`stop_reason` は `tool_use` になる
  stopReason: string | undefined;
}

type AssistantUtteranceProbe =
  { kind: 'found'; utterance: LastAssistantUtterance } | { kind: 'empty' } | { kind: 'truncated' };

// 判定はしない: 見つけたことと、そのターンが終わっていることは別の軸のため `stopReason` を添えて返す
function probeLastAssistantUtterance(transcript: string): AssistantUtteranceProbe {
  const truncated = transcript.length > REPORT_GENERATED_PROBE_CHARS;
  const tail = truncated ? transcript.slice(-REPORT_GENERATED_PROBE_CHARS) : transcript;
  const rawLines = tail.split('\n');
  const lines = truncated ? rawLines.slice(1) : rawLines;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; stop_reason?: unknown };
    };
    if (record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;
    const body = rawAssistantText(record.message?.content);
    if (body.length === 0) continue;
    return {
      kind: 'found',
      utterance: {
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        length: body.length,
        stopReason:
          typeof record.message?.stop_reason === 'string' ? record.message.stop_reason : undefined,
      },
    };
  }
  return truncated ? { kind: 'truncated' } : { kind: 'empty' };
}

function rawAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// 読めなかったことを「無い」に潰さない
async function describeMissingReport(
  managers: ManagerPool,
  managerId: string,
  status: ManagerSummary['status'],
): Promise<string> {
  const base = `マネージャー ${managerId} からの報告はまだ無い（状態: ${status}）。`;
  let result: ManagerTranscript;
  // 末尾を読む口があれば使う: 判定は末尾の REPORT_GENERATED_PROBE_CHARS 文字しか見ず、全文（退避なら数十〜百 MB 級）をデーモンのループの上で文字へ戻すと1回で約1秒止まりうるため（#4638）
  const tailRead = managers.transcriptTail !== undefined;
  try {
    result =
      managers.transcriptTail !== undefined
        ? await managers.transcriptTail(managerId, REPORT_GENERATED_PROBE_CHARS)
        : await managers.transcript(managerId);
  } catch (error) {
    return (
      `${base} 生ログは読めなかった（` +
      reasonOf(error) +
      '）。「まだ書いていない」か「書いたのに届いていない」かは、これだけでは判定できない。'
    );
  }
  if (result.kind === 'removed') {
    // `missing` に畳まない: 退避はあったが本文が落とされており、「まだ書いていない」とも「読めなかった」とも別の状態のため
    return (
      `${base} 生ログは退避されていたが本文が消されている` +
      `（${result.removedAt} に ${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
      `archive id: ${result.archiveId}）。現物は確かめられない。`
    );
  }
  if (result.kind === 'unreadable') {
    return `${base} 生ログは読みに行けなかった。${result.detail}`;
  }
  if (result.kind === 'missing' || result.body.length === 0) {
    return (
      `${base} 生ログにも本文は無い` +
      '（走行中の runner のディスク・退避済みアーカイブ・預かった生ログ、3段のどこにも見当たらなかった）。'
    );
  }
  const transcript = result.body;

  const outcome = probeLastAssistantUtterance(transcript);
  if (outcome.kind === 'empty') {
    return `${base} 生ログにも本文は無い（生ログ全体を見た）。`;
  }
  if (outcome.kind === 'truncated') {
    return (
      `${base} 生ログの末尾 ${REPORT_GENERATED_PROBE_CHARS.toLocaleString('ja-JP')} 文字を遡ったが、` +
      'マネージャー自身の発言（本文つき）は見つからなかった。' +
      'それより前は見ていないので「無い」とは言い切れない——' +
      `manager_transcript managerId=${managerId} で自分で遡って確かめられる。`
    );
  }

  const { timestamp, length, stopReason } = outcome.utterance;
  const when = timestamp ?? '時刻不明（生ログの行に timestamp が無かった）';
  const state = `（状態: ${status}）`;
  const found = `生ログには ${when} に本文が在る（約 ${length.toLocaleString('ja-JP')} 文字）`;
  // 末尾だけを読んだ回は全体の長さが分からないので、読み始めを offset ではなく発言の時刻（since）で案内する
  const where = tailRead
    ? timestamp === undefined
      ? 'で読める（末尾だけを見たので、読み始めの位置は示せない）'
      : ` since=${timestamp} で、その発言から読める`
    : ` offset=${Math.max(0, transcript.length - TRANSCRIPT_PAGE)} で読める`;
  const howToDigIn =
    `manager_transcript managerId=${managerId}${where}` +
    '（作業者の発言は除いて探したが、混ざる余地が完全に無いとまでは確認していない）。';

  // 3つに割る: 「終わっていないと分かった」と「分からなかった」を1つに畳まない
  if (stopReason === 'end_turn') {
    return (
      `⚠ マネージャー ${managerId} からの報告としては届いていない${state}が、${found}。` +
      `＝ 生成されたが配られていない（#323）。${howToDigIn}`
    );
  }
  if (stopReason !== undefined) {
    return (
      `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンはまだ終わっていない` +
      `（stop_reason=${stopReason}）。＝ まだ書き終えていない側である。${howToDigIn}`
    );
  }
  return (
    `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンが終わっているかを判定できなかった` +
    `（行に stop_reason が無い）。${howToDigIn}`
  );
}

// `tasks`（背景タスクの在り高）と混ぜない: 別の軸のため
// `count` が 0 でも出す: 「取れない」ではなく「0 と測れた」ため
function describeWithheldReports(manager: ManagerSummary): string | null {
  if (manager.awaitingBackground === undefined) return null;
  return (
    `配っていない報告 ${manager.awaitingBackground.withheldReports} 本` +
    '（中身は日誌の decision に在る）。'
  );
}

function unpushedWorkReportNote(
  manager: ManagerSummary,
  rescueAll: boolean = false,
): string | null {
  const note = describeUnpushedWorkObservation(manager, rescueAll ? 'full' : 'report');
  return note === null ? null : note.trimStart();
}

export function managerReportTool(context: ToolContext) {
  return tool(
    'manager_report',
    [
      'マネージャーの依頼文・直近の報告を全文で読む。',
      'manager_list は抜粋なので、欠落に気づいたらここで全部読むこと。',
      'manager_list の行は退避 ref を件数と最新の1件しか出さない。ここ（manager_report）も報告の本文の前に、退避 ref を既定では種類ごとの本数に畳んで出す:',
      '生きている退避 ref（最新の1件つき）・消し終えた ref（消した理由ごと）・生きている間に消えた作業ツリー・送るもの無しは本数だけで、',
      '退避できていない（失われうる）作業ツリー（未追跡・submodule・送れなかった失敗）は、本数と代表の1本の行を必ず出す。',
      '全部（ref 名・退避できていない作業ツリーのすべて）は rescueAll: true で作業ツリーごとに読む。',
      '長い場合は続きの取り方が末尾に出るので、最後まで読み切ること。',
      'それでも足りない（報告に書かれていない中身を確かめたい）ときは manager_transcript で生ログまで降りられる。',
      '直近の報告の全文が既にあなたの発言（会話の上）に載っているときは、本文を繰り返さず、載っている時刻を示す注記だけを返す。引き直したいときは refetch: true を付ける（offset で頁を送る・依頼文は影響を受けない）。',
      '全文が載っている報告に未 push などの状態の注記だけが要るなら、引き直さず manager_list の行を見る。',
      'report が「まだ無い」と返ったときは、内部で生ログも見ている（#323）——',
      '「まだ書いていない」のか「書いたのに配られていない」のかを、応答の文言（⚠ の有無）で見分けられる。',
    ].join(' '),
    {
      managerId: z.string().describe('manager_list に出ている id'),
      part: z
        .enum(['report', 'request'])
        .optional()
        .describe('report=直近の報告（既定） / request=依頼文'),
      offset: z
        .number()
        .optional()
        .describe(
          `何文字目から読むか（${formatIntRangeJa({ min: 0 })}）。前回の応答が示した続きの位置を渡す`,
        ),
      rescueAll: z
        .boolean()
        .optional()
        .describe(
          '真なら退避 ref を畳まず作業ツリーごとに全部出す（既定は、種類ごとの本数と、退避できていない作業ツリーの本数・代表の1本だけ）',
        ),
      refetch: z
        .boolean()
        .optional()
        .describe(
          '真なら、報告の全文が既に会話の上に載っていても本文を必ず返す（既定は、載っているときは注記だけ返す）',
        ),
    },
    async (
      { managerId, part = 'report', offset = 0, rescueAll = false, refetch = false },
      extra: unknown,
    ) => {
      const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
      if (offsetError !== null) return text(offsetError);
      if (!context.managers) return NO_POOL;
      const managers = await context.managers.list();
      const found = managers.find((manager) => manager.managerId === managerId);
      if (!found) {
        // 読めない委譲の行は「居ない」と分けて言う: 見つからなかったときだけ台帳を読み直す（単票の取得のたびに一覧を読まない）
        const unreadableRow = (await context.stores.jobs.listUnreadableJobs()).find(
          (row) => row.id === managerId,
        );
        if (unreadableRow !== undefined) {
          return text(describeUnreadableManagerRow(managerId, unreadableRow.reason));
        }
        return text(
          `マネージャー ${managerId} は居ない（もう畳まれたか、id が違う）。` +
            'manager_list で今あるものが見える。',
        );
      }

      const modelLine = `モデル: ${describeManagerModels(managerModelsOf(context.managers, found))}`;
      // 在れば `lastReport` より優先して見せる: `lastFoldedTurn` は `lastReport` より後に届いた内容で、陰に隠れたままだと `manager_report` から一生読めなくなるため
      const foldedTurn = part === 'request' ? undefined : found.lastFoldedTurn;
      const body = part === 'request' ? found.request : (foldedTurn?.text ?? found.lastReport);
      if (body === undefined || body.length === 0) {
        if (part === 'request') {
          return text(`マネージャー ${managerId} の依頼文が記録に無い。`);
        }
        // 依頼文では見に行かない: 往復を無条件に増やさないため、report のときだけ生ログを見る
        const missing = await describeMissingReport(context.managers, managerId, found.status);
        // 報告の有無とは別の軸なので、報告が空の回だからこちらも出さない、にはしない
        const usageStopped = describeUsageStopped(found);
        const runnerVanished = describeRunnerVanished(found);
        const systemError = describeManagerSystemError(found);
        const cgroupEvents = describeManagerCgroupEvents(found);
        // 報告が空の回でも拒否は出す: 黙ると「まだ書いていない」と「番人に止められて書けない」を区別できないため
        const denied = describeDenials(context.managers.denials(managerId), found.lastReportAt);
        // この枝でも出す: `manager_list` で「何も届いていない」と読んだクローンが掘りに来る先で、黙ると順位を付けた意味が掘った先で消えるため
        const unobserved = describeUnobservedOutcome(found);
        const unpushedWork = unpushedWorkReportNote(found, rescueAll);
        const withheldReportsNote = describeWithheldReports(found);
        return text(
          [
            modelLine,
            missing,
            usageStopped,
            runnerVanished,
            systemError,
            cgroupEvents,
            denied,
            unobserved,
            unpushedWork,
            withheldReportsNote,
          ]
            .filter((s) => s !== null)
            .join('\n\n'),
        );
      }

      // 失敗した回は「報告」と呼ばない: 見出しが「直近の報告」のままだと、⚠ を見た直後に包みの内側だけを読んで報告として扱うため
      // `foldedTurn` が在る回は注記を出さない: `lastFailure` は畳まれる前の無関係な古いターンを指し、注記が予告する本文の種類と実際の本文が食い違うため
      const managerFailure =
        part === 'request' || foldedTurn !== undefined
          ? null
          : describeManagerFailure(
              found.lastFailure,
              found.lastReport,
              found.status,
              tokenGenerationMismatched(found),
            );
      const usageStopped = part === 'request' ? null : describeUsageStopped(found);
      const runnerVanished = part === 'request' ? null : describeRunnerVanished(found);
      const systemError = part === 'request' ? null : describeManagerSystemError(found);
      const cgroupEvents = part === 'request' ? null : describeManagerCgroupEvents(found);
      // 報告が在る回でも拒否は出す: 報告を書いた後で別の道具を止められていると、本文だけ読むと「報告どおり進んでいる」と読めるため
      // foldedTurn の回は `lastReportAt` の代わりに `foldedTurn.at` を渡す: `lastReportAt` は畳まれる前の古い値のままで、「拒否の後の報告はまだ届いていない」と誤判定するため
      const denied =
        part === 'request'
          ? null
          : describeDenials(
              context.managers.denials(managerId),
              foldedTurn !== undefined ? foldedTurn.at : found.lastReportAt,
            );
      // 依頼文（`part === 'request'`）では注記を出さない: 依頼文は報告・失敗・拒否の話ではないため
      const unobserved = part === 'request' ? null : describeUnobservedOutcome(found);
      const unpushedWork = part === 'request' ? null : unpushedWorkReportNote(found, rescueAll);
      const withheldReportsNote = part === 'request' ? null : describeWithheldReports(found);
      const label =
        part === 'request'
          ? '依頼文'
          : // 停止後に届いた本文は別の見出しで言い分ける: `isFoldedTurnReport` とは別の畳まれ方のため
            foldedTurn !== undefined
            ? `停止後に届いた、畳まれたターンの中身（${foldedTurn.at} 受信）`
            : isFoldedTurnReport(found)
              ? '直近のターンの中身'
              : '直近の報告';
      const part1 = page(body, offset, REPORT_PAGE);
      // 齢といまの status を見出しに添える: 読み手が直近に完了したターンの中身をいまの状態として読まないため
      const reportAgeStatus =
        part === 'request'
          ? ''
          : foldedTurn !== undefined
            ? // foldedTurn の回は `lastReportAt` の欄ごと出さない: 畳まれる前の別のターンの受信時刻で、いま読んでいる本文の齢に見えるため
              ` — いまの status: \`${found.status}\``
            : // 文言に「直近の報告」を含めない: 見出しを「直近のターンの中身」へ切り替えた回で混ざると、切り替えた意味が薄れるため
              ` — lastReportAt: ${found.lastReportAt ?? '一度も届いていない'} / いまの status: \`${found.status}\``;
      const head = `マネージャー ${managerId} の${label}（${describePage(part1)}）${reportAgeStatus}`;
      // foldedTurn の回はその材料で組む: `lastReportAt` / `lastReportStatus` は畳まれる前の別のターンの値で、そのまま渡すと無関係な drift を語るため
      const drift =
        part === 'request'
          ? ''
          : describeReportDrift({
              managerId,
              lastReportAt: foldedTurn !== undefined ? foldedTurn.at : found.lastReportAt,
              lastReportStatus: foldedTurn !== undefined ? 'stopped' : found.lastReportStatus,
              status: found.status,
              now: new Date(),
            });
      const driftNote = drift === '' ? '' : `${drift}\n\n`;
      // 失敗は本文の上に置く: 下だと包まれたエラー文を先に読んでから「実は報告ではない」と分かる順になるため。以下の注記も同じ順
      const failureNote = managerFailure === null ? '' : `${managerFailure}\n\n`;
      const usageStoppedNote = usageStopped === null ? '' : `${usageStopped}\n\n`;
      const runnerVanishedNote = runnerVanished === null ? '' : `${runnerVanished}\n\n`;
      const systemErrorNote = systemError === null ? '' : `${systemError}\n\n`;
      const cgroupEventsNote = cgroupEvents === null ? '' : `${cgroupEvents}\n\n`;
      const denialNote = denied === null ? '' : `${denied}\n\n`;
      const unobservedNote = unobserved === null ? '' : `${unobserved}\n\n`;
      const unpushedWorkNote = unpushedWork === null ? '' : `${unpushedWork}\n\n`;
      const withheldReportsFooterNote =
        withheldReportsNote === null ? '' : `${withheldReportsNote}\n\n`;
      // 本文だけを畳む: 状態の注記（失敗・拒否・退避 ref など）は発言の後に変わりうるので残す。依頼文・頁送り（offset > 0）・refetch は従来どおり本文を出す
      const shownAt =
        part === 'report' && offset === 0 && !refetch && !isSubagentCaller(context, extra)
          ? (context.managerReportShownAt?.(managerId, body) ?? null)
          : null;
      if (shownAt !== null) {
        return text(
          `${head}\n\n${modelLine}\n\n${driftNote}${failureNote}${usageStoppedNote}${runnerVanishedNote}${systemErrorNote}${cgroupEventsNote}${denialNote}${unobservedNote}${unpushedWorkNote}${withheldReportsFooterNote}` +
            `この報告の全文（${body.length.toLocaleString('en-US')} 文字）は ${shownAt.toISOString().slice(11, 16)}Z の発言に載っている（会話の上）。` +
            '引き直すには `refetch: true` を付ける。' +
            `\n\n（さらに掘るなら manager_transcript managerId=${managerId} で生ログへ）`,
        );
      }
      const tail = part1.more
        ? `\n\n…（ここで切れている。続きは manager_report managerId=${managerId}` +
          `${part === 'request' ? ' part=request' : ''} offset=${part1.to}）`
        : '';
      // 切れていない場合にも次の一手を常に添える: ここに載る `lastReport` は報告の全文で、セッションの生ログではないため
      const footer =
        '\n\n（さらに掘るなら manager_transcript managerId=' + managerId + ' で生ログへ）';
      return text(
        `${head}\n\n${modelLine}\n\n${driftNote}${failureNote}${usageStoppedNote}${runnerVanishedNote}${systemErrorNote}${cgroupEventsNote}${denialNote}${unobservedNote}${unpushedWorkNote}${withheldReportsFooterNote}${part1.body}${tail}${footer}`,
      );
    },
  );
}
