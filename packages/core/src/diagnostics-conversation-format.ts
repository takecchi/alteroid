// `analyzeConversation` の結果を日本語の表にする。事実を並べるだけで、原因・合否は断定しない。
// 実測・本文からの導出・見積りは節ごとに分け、見積りの節には「見積り（実測ではない）」と書く。取れない軸は 0 ではなく「取れない」と書く。
import type {
  ConversationAnalysis,
  ConversationAxis,
  ConversationDist,
  EstimateSection,
  ExchangesSection,
  MeasuredSection,
  PatternStats,
  ShareRow,
} from './diagnostics-conversation-analysis.js';
import { BODYLESS_SIGNAL_KINDS, EXCHANGE_HEAD_CHARS } from './diagnostics-conversation-analysis.js';
import { CONTAMINATION_PATTERNS } from './diagnostics-conversation-classify.js';

const n = (value: number | null, digits = 0): string =>
  value === null
    ? '取れない'
    : value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const pct = (value: number | null): string =>
  value === null ? '取れない' : `${(value * 100).toFixed(1)}%`;

const BASIS_LABEL: Record<ConversationAxis['basis'], string> = {
  measured: '実測',
  'text-derived': '本文から数えた',
  estimate: '見積り（実測ではない）',
  unavailable: '取れない',
};

// 件数を別の所で書くときの、合計・中央値・p90・最大だけ
function distTail(d: ConversationDist, digits = 0): string {
  if (d.count === 0) return '行なし';
  return `合計 ${n(d.sum, digits)} / 中央値 ${n(d.median, digits)} / p90 ${n(d.p90, digits)} / 最大 ${n(d.max, digits)}`;
}
function dist(d: ConversationDist, digits = 0): string {
  return d.count === 0 ? '行なし' : `${d.count}件 / ${distTail(d, digits)}`;
}

function share(label: string, s: ShareRow): string {
  return (
    `    ${label}: ${n(s.chars)}字（${pct(s.share)}）/ 1ターン中央値 ${n(s.perTurnMedian)}` +
    `（取れた ${s.rows.obtained} / 取れない ${s.rows.missing}）`
  );
}

export function renderConversationCoverage(a: ConversationAnalysis): string {
  const c = a.coverage;
  const out: string[] = [];
  out.push('# 会話の分析の coverage（何が実測で、何が見積りで、何が取れないか）');
  const m = c.manifest;
  out.push(
    m.state === 'read'
      ? `pull の記録（manifest.json）: 窓 ${m.window === null ? '取れない' : `${m.window.since} 〜 ${m.window.until}`}` +
          ` / 取得 ${m.pulledAt ?? '取れない'} / 上限で止めた ${m.truncated.length} 件 / 失敗 ${m.failures.length} 件` +
          ` / 人間との会話の行（保存せず）${n(m.skippedNonManager)}`
      : `pull の記録（manifest.json）: ${m.state === 'none' ? '入力が無い' : '読めない'}（${m.reason ?? ''}）。窓・truncated・failures は取れない`,
  );
  out.push(
    `日誌の行: ${c.journal.rows} / turn_input ${c.journal.turnInputRows} / turn_timing ${c.journal.turnTimingRows}`,
  );
  out.push(
    c.exchanges.state === 'none'
      ? `exchanges.jsonl: 入力が無い（${c.exchanges.reason}）`
      : `exchanges.jsonl: 読めた行 ${c.exchanges.rows}（読めない行 ${c.exchanges.invalidLines} / exchange でない行 ${c.exchanges.notExchangeRows} / with が manager 以外 ${c.exchanges.nonManagerRows} / text が読めない ${c.exchanges.unreadableRows}）`,
  );
  for (const w of c.warnings) out.push(`⚠ ${w}`);
  out.push('軸ごとの出所:');
  for (const x of c.axes) {
    out.push(`  [${BASIS_LABEL[x.basis]}] ${x.axis}（${x.source}）: ${x.note}`);
  }
  return out.join('\n');
}

function renderMeasured(
  m: MeasuredSection | { state: 'none'; reason: string },
  top: number,
): string[] {
  const out: string[] = ['', '## A. ターンの入力（実測: journal の turn_input）'];
  if (m.state === 'none') {
    out.push(`  入力が無い: ${m.reason}`);
    return out;
  }
  out.push(
    `  ターン ${m.rows}（totalChars が読めず除いた行 ${m.unreadableRows}）。totalChars: ${dist(m.total)}`,
  );
  const groups = (title: string, rows: MeasuredSection['byKind']): void => {
    out.push(`  ${title}`);
    for (const g of rows) out.push(`    ${g.key}: ${g.turns}ターン / ${distTail(g.total)}`);
  };
  groups('kind 別', m.byKind);
  groups('起点の束ごと', m.byBundle);
  groups('1起点ごと（束は構成する起点すべてに数える）', m.bySingleTrigger);

  const o = m.occupancy;
  out.push(
    '',
    '### A2. 内訳の占有率（totalChars に占める割合。1ターン中央値は読めたターンの中央値）',
  );
  out.push(`  totalChars の合計: ${n(o.totalCharsSum)}字`);
  out.push('  ★ 毎ターン付く「いまの全体」の注記（notices.situation）:');
  out.push(share('situation', o.situation));
  out.push('  notices の各項目（0 のターンも含めた割合）:');
  for (const x of o.notices) out.push(share(x.key, x));
  out.push('  それ以外の区分（totalChars = Σnotices + humanActions + freshMemory + body）:');
  out.push(share('humanActionsChars', o.humanActions));
  out.push(share('freshMemoryChars', o.freshMemory));
  out.push(share('bodyChars', o.body));
  out.push(
    '  bodyChars の内側（重ならない区分の足し算ではない。signals は切る前の長さで、切り詰めがあると body を超えうる）:',
  );
  out.push(share('signals の元の長さ', o.bodyInside.signals));
  out.push(share('templates（本文中の定型。合図の本文の外の出現だけ）', o.bodyInside.templates));
  out.push(share('framingChars（導出値）', o.bodyInside.framing));

  const sp = m.situationParts;
  out.push(
    '',
    `### A3. 「いまの全体」の内訳（situationParts。situation のあるターン ${sp.turnsWithSituation} / 内訳が組めたターン ${sp.turnsWithParts}）`,
  );
  if (sp.turnsWithSituation > sp.turnsWithParts) {
    out.push(
      `  内訳を持たないターン ${sp.turnsWithSituation - sp.turnsWithParts} は下の表に入らない（取れない）`,
    );
  }
  for (const p of sp.parts) {
    out.push(
      `    ${p.key}: ${n(p.chars)}字 / totalChars の ${pct(p.shareOfTotal)} / situation の ${pct(p.shareOfSituation)} / 1ターン中央値 ${n(p.perTurnMedian)}`,
    );
  }

  out.push(
    '',
    '### A4. 本文中の定型（templates。合図の本文の中の出現は signals 側に数えられていて、ここには入らない。' +
      '拒否の知らせの定型 DENIAL_REPLY_ROUTE は報告の本文の一部なので、多くはここでなく B の「本文に残る定型」に出る）',
  );
  if (m.templates.length === 0) out.push('  （合図の本文の外に定型が出たターンなし）');
  for (const t of m.templates) {
    const mark = t.name === 'DENIAL_REPLY_ROUTE' ? '★ ' : '';
    out.push(
      `    ${mark}${t.name}: ${t.turns}ターン / 合計 ${n(t.chars)}字（totalChars の ${pct(t.shareOfTotal)}）/ 出現 ${
        t.occurrences === null
          ? '取れない（定数の長さが不明）'
          : `約 ${t.occurrences} 回（字数 ÷ いまの定数の長さ${t.divisible === false ? '。割り切れない = 定数の版が違う日誌' : ''}）`
      }`,
    );
  }

  const s = m.signals;
  out.push('', '### A5. 合図（signals。先頭 20 件まで。chars は 8000 字で切る前の長さ）');
  for (const k of s.byKind) {
    const bodyless = (BODYLESS_SIGNAL_KINDS as readonly string[]).includes(k.kind);
    out.push(
      `    ${k.kind}: ${k.count}件 / ${
        k.chars === null
          ? `字数は集計しない（${bodyless ? '本文を持たない種類は束のとき 0 で書かれ、取れない' : '取れない'}）`
          : distTail(k.chars)
      }${k.overLimit > 0 ? ` / 8000 字超（頭だけがモデルに入る）${k.overLimit}件` : ''}`,
    );
  }
  out.push(
    `  8000 字を超えた報告系の合図（切られた分）: ${s.overLimitTotal} 件 / chars が取れない合図 ${s.missingChars}`,
  );
  out.push(
    `  取れなかった分（先頭 20 件より後。signalsOmitted）: ${s.omitted.total} 件（${s.omitted.rows} ターン）。その kind・chars は分からない`,
  );
  out.push(
    `  委譲ごと（managerId。報告・質問・確認・拒否の知らせ。chars の合計の大きい上位 ${s.byManager.limit}、全 ${s.byManager.totalManagers} 件）`,
  );
  for (const r of s.byManager.rows) {
    out.push(
      `    ${r.managerId}: ${r.count}件 / ${n(r.chars)}字（${r.byKind.map((k) => `${k.kind} ${k.count}件 ${n(k.chars)}字`).join(' / ')}）`,
    );
  }
  out.push(
    `  再配達の注記（redelivery）が出たターン: ${m.redelivery.withNotice} / ${m.redelivery.rows.obtained}（${pct(m.redelivery.share)}）。` +
      '同じ報告をクローンが何回読んだかの目安',
  );
  out.push(
    `  添付の件数（attachments）: ${n(m.attachments.sum)}（取れた ${m.attachments.rows.obtained} / 取れない ${m.attachments.rows.missing}）`,
  );

  out.push('', `### A6. 上位の大きいターン（上位 ${top}。文字数だけで、本文は載せない）`);
  for (const t of m.top) {
    out.push(
      `    ${t.at} ${t.kind} [${t.triggers.join('+')}] total ${n(t.totalChars)} = notices ${n(t.noticesChars)}（situation ${n(t.situationChars)}）` +
        ` + humanActions ${n(t.humanActionsChars)} + freshMemory ${n(t.freshMemoryChars)} + body ${n(t.bodyChars)}（framing ${n(t.framingChars)}）/ 添付 ${n(t.attachments)}`,
    );
  }
  return out;
}

function renderExchanges(
  e: ExchangesSection | { state: 'none'; reason: string },
  top: number,
): string[] {
  const out: string[] = ['', '## B. 会話（exchanges.jsonl。本文から種類へ分けた）'];
  if (e.state === 'none') {
    out.push(`  入力が無い: ${e.reason}`);
    return out;
  }
  out.push(
    '  字数は本文（接頭辞と [id…] を除く）の長さ。Pool の全文行と配達行は別の種類として数え、同じ報告を二重に足さない。',
    '  追加指示・返事・依頼は日誌に専用の欄が無く、順序と直前の質問・許可確認の有無からの判定（本文から数えた他の種類とは確かさが違う）',
  );
  out.push('  ### 種類ごと（件数・文字数）');
  for (const k of e.byKind) {
    out.push(
      `    ${k.label}${k.basis === 'derived-from-order' ? ' ［順序からの判定］' : ''}: ${k.count === 0 ? '0件' : dist(k.chars)}`,
    );
  }
  if (e.otherBreakdown.length > 0) {
    out.push('  「その他」の内訳（捨てずに数えた）:');
    for (const o of e.otherBreakdown) out.push(`    ${o.key}: ${o.count}件 / ${n(o.chars)}字`);
  }
  out.push(
    `  クローンが受け取った行（配達行の合計。Pool の全文行は含めない）: ${dist(e.delivered)}`,
  );

  const b = e.byManager;
  out.push(
    `  ### 委譲ごと（managerId。文字数の合計の大きい上位 ${b.limit}、全 ${b.totalManagers} 件。managerId なし ${b.withoutManagerId.count}件 / ${n(b.withoutManagerId.chars)}字）`,
  );
  for (const r of b.rows) {
    out.push(
      `    ${r.managerId}: ${dist(r.total)}（${r.byKind.map((k) => `${k.kind} ${k.count}件 ${n(k.chars)}字`).join(' / ')}）`,
    );
  }

  const t = e.templatesInText;
  out.push(
    '  ### 本文に残る定型の占有（日誌の本文の字面から数えた。プロンプト組み立て時に足される定型は D の見積り）',
    `    配達行の本文の合計 ${n(t.deliveredChars)}字のうち:`,
    `    ★ 拒否の答え方（DENIAL_REPLY_ROUTE）: ${t.denialRoute.rows}行 / 出現 ${t.denialRoute.occurrences}回 / ${n(t.denialRoute.chars)}字 = 配達行の ${pct(t.denialRoute.shareOfDelivered)} / 拒否の知らせの行の ${pct(t.denialRoute.shareOfDenialRows)}`,
    `    許可確認の拒否後の答え方（DENIAL_ASK_AFTER_ANSWER_PARAGRAPH*）: ${t.denialAskAfterAnswer.rows}行 / ${n(t.denialAskAfterAnswer.chars)}字 = 配達行の ${pct(t.denialAskAfterAnswer.shareOfDelivered)}`,
  );
  for (const note of t.notes) {
    out.push(
      `    ${note.label}: ${note.rows}行 / ${n(note.chars)}字 = 配達行の ${pct(note.shareOfDelivered)}`,
    );
  }

  out.push(
    `  ### 上位の大きい文面（上位 ${top}。先頭 ${EXCHANGE_HEAD_CHARS} 字・改行は空白・伏せ字を掛けた後に切る）`,
  );
  for (const x of e.top) {
    out.push(
      `    [${x.kind}] ${x.at} ${n(x.chars)}字 managerId=${x.managerId ?? '(なし)'}: ${x.head}`,
    );
  }
  return out;
}

function patternLine(label: string, p: PatternStats): string {
  if (p.rows === 0) return `    ${label}: 行なし`;
  return (
    `    ${label}: ${p.rows}行 / コードブロックのある行 ${p.rowsWithFence}（字数の ${pct(p.fenceCharShare)}）` +
    ` / パス風の行 ${pct(p.pathLikeLineShare)}（含む行 ${p.rowsWithPathLike}）` +
    ` / スタックトレース風 ${pct(p.stackLineShare)}（含む行 ${p.rowsWithStack}）` +
    ` / Error: ${pct(p.errorLineShare)}（含む行 ${p.rowsWithError}）` +
    ` / tool_result 風 ${pct(p.toolResultLineShare)}（含む行 ${p.rowsWithToolResult}）`
  );
}

function renderContamination(c: ConversationAnalysis['contamination']): string[] {
  const out: string[] = [
    '',
    '## C. 作業途中の混入の目安（本文を機械的に測っただけ。合否の判定ではない。しきい値は置いていない）',
  ];
  if (c.state === 'none') {
    out.push(`  入力が無い: ${c.reason}`);
    return out;
  }
  out.push('  使ったパターン（本文の文字列検査。tool_result の専用の欄は日誌に無い）:');
  for (const p of CONTAMINATION_PATTERNS) out.push(`    ${p.label}: ${p.source}`);
  const pv = c.poolVsDelivery;
  out.push(
    `  Pool 行（途中の発言込みの全文）と配達行（縮めた方）の長さ比: 対にできた ${pv.paired} / Pool 行だけ ${pv.unpairedPool} / 配達行だけ ${pv.unpairedDelivery}（窓の端・対の無い行）`,
    `    配達行 ÷ Pool 行: ${dist(pv.ratio, 3)}`,
  );
  const f = pv.fullTextNote;
  out.push(
    `  配達行の注記「途中の発言を含む全文 N 字」: 報告系の配達行 ${f.reportRows} のうち注記あり ${f.rowsWithNote}（${pct(f.noteShare)}）`,
    `    全文 N: ${dist(f.fullChars)}`,
    `    途中の発言の量の目安（N − 主文の字数）: ${dist(f.intermediateChars)}${f.inconsistent > 0 ? ` / N が主文より小さい行 ${f.inconsistent}（読み取りが合わない）` : ''}`,
  );
  const ol = c.overLimit;
  out.push(
    `  8000 字超の報告: 報告系の配達行 ${ol.reportRows} のうち主文が ${n(ol.limit)} 字（コードポイント）を超える行 ${ol.rowsOverLimit}（${pct(ol.share)}）。` +
      '「⚠ 本文が長いので頭の…」の注記はプロンプト組み立て時に付き、日誌には書かれないので、その注記の件数は文面から数えられない（上の条件を満たす行数が、付くはずの数）',
    `    報告1件の字数の分布: ${dist(ol.reportChars)}`,
  );
  out.push('  本文の中身の目安（報告の主文。注記と拒否の答え方の定型を除いた）:');
  out.push(patternLine('配達行（クローンへ渡った方）', c.patterns.delivery));
  out.push(patternLine('Pool 行（途中の発言込み）', c.patterns.poolFull));
  out.push(
    `  添付: 添付のある行 ${c.attachments.rowsWithAttachments} / 添付の件数 ${c.attachments.attachments} / 受け取れなかったファイルのある行 ${c.attachments.rowsWithRejected}`,
  );
  const r = c.requestVsReport;
  out.push(
    `  クローンの依頼文と報告の長さの比（依頼と報告の両方が見えた委譲 ${r.delegations} 件）: 報告の合計 ${n(r.totalReportChars)}字 ÷ 依頼の合計 ${n(r.totalRequestChars)}字 = ${n(r.overallRatio, 2)} / 委譲ごと ${dist(r.perDelegationRatio, 2)}`,
  );
  return out;
}

function renderEstimate(e: EstimateSection): string[] {
  const out: string[] = [
    '',
    '## D. 見積り（実測ではない）: プロンプト組み立て時に足される定型の注記',
    '  turn_input が実測できる日・ターンは実測で置き換え、残りだけを固定の定数の長さから見積もる（同じターンを二重に数えない）。',
  ];
  const k = e.constants;
  out.push(
    `  使った定数の長さ: SITUATION_HEAD ${k.situationHeadChars}字 / READINGS_NOTICE（区分の読み方）${k.readingsNoticeChars}字 / REPORT_FOLLOW_UP_GUIDE ${k.reportFollowUpGuideChars}字 / 起点の案内 ${k.originGuideChars.min}〜${k.originGuideChars.max}字`,
  );
  if (e.state === 'unavailable') {
    out.push(`  取れない: ${e.reason ?? ''}`);
  } else {
    if (e.reason !== null) out.push(`  ⚠ ${e.reason}`);
    for (const d of e.days) {
      const label = {
        measured: '実測のみ',
        mixed: '実測＋見積りが混ざる',
        estimated: '見積りのみ',
        'no-turns': '対象なし',
      }[d.basis];
      out.push(
        `  ${d.day} [${label}]: 通常ターン ${d.timingNormalTurns}（実測 ${d.measuredNormalTurns} / 見積りに回す ${d.estimatedNormalTurns}）` +
          ` / 見積り: いまの全体の固定部 ${n(d.situationFixedChars)}字（下限）` +
          ` / 報告系の配達のうち見積りに回す ${n(d.remainderReportDeliveries)}件、案内 ${d.reportGuideChars === null ? '取れない' : `${n(d.reportGuideChars.min)}〜${n(d.reportGuideChars.max)}字`}` +
          ` / 定型の占有 ${d.framingShare === null ? '取れない（本文の合計が見積りの日だけ出る）' : `${pct(d.framingShare.min)}〜${pct(d.framingShare.max)}`}`,
      );
    }
    out.push(
      `  見積りの合計: 見積りに回した通常ターン ${e.totals.estimatedNormalTurns} / いまの全体の固定部 ${n(e.totals.situationFixedChars)}字（下限）/ 報告の案内 ${e.totals.reportGuideChars === null ? '取れない' : `${n(e.totals.reportGuideChars.min)}〜${n(e.totals.reportGuideChars.max)}字（単発の案内を1件ずつ数えた。束なら案内は束に1つなので上寄り）`}`,
    );
  }
  out.push('  見積りに入れていない（取れない）もの:');
  for (const x of e.notEstimated) out.push(`    ${x}`);
  return out;
}

/** 会話の分析の本体（coverage は含まない。`renderConversationCoverage` を先頭に置く） */
export function renderConversationAnalysis(a: ConversationAnalysis, topN: number): string {
  return [
    ...renderMeasured(a.measured, topN),
    ...renderExchanges(a.exchanges, topN),
    ...renderContamination(a.contamination),
    ...renderEstimate(a.estimate),
  ].join('\n');
}
