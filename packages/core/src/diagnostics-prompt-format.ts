// `analyzePrompt` の結果を日本語の表にする。事実を並べるだけで、合否・原因は断定しない。
// 単位を行ごとに書く: 「字」は文字数（トークンの近似であって、トークンではない）、「トークン」は SDK が測った値（contextUsage 由来）だけ。
// 取れない軸は 0 ではなく「取れない」と理由を書く。能力（道具・MCP）を減らす候補は出さない。
import {
  PROMPT_NO_REMOVAL_NOTE,
  type PromptAnalysis,
  type PromptCandidates,
  type PromptCoverage,
  type PromptUnavailable,
} from './diagnostics-prompt-analysis.js';

const n = (value: number | null): string =>
  value === null ? '取れない' : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (value: number | null): string =>
  value === null ? '取れない' : `${(value * 100).toFixed(1)}%`;
const chars = (value: number | null): string => (value === null ? '取れない' : `${n(value)}字`);
const tokens = (value: number | null): string =>
  value === null ? '取れない' : `${n(value)}トークン`;

function unavailableLine(indent: string, what: string, u: PromptUnavailable): string {
  return `${indent}${what}: 取れない（${u.reason}）`;
}

function duration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 120) return `${sign}${String(minutes)} 分`;
  return `${sign}${(minutes / 60).toFixed(1)} 時間`;
}

export function renderPromptCoverage(c: PromptCoverage): string[] {
  const out: string[] = ['## P1. coverage（何がどの時点の値で、何が取れていないか）'];
  switch (c.session.state) {
    case 'none':
      out.push(`  session: 未取得（${c.session.reason}）`);
      break;
    case 'failed':
      out.push(
        `  session: 失敗の回（${c.session.at}。理由: ${c.session.error}）。systemPrompt・memoryInPrompt・tools は取れていない`,
      );
      break;
    case 'ok':
      out.push(
        `  session: 成功 / builtAt ${c.session.builtAt} / model ${c.session.model} / resumedFrom ${c.session.resumedFrom ?? 'なし（新規）'} / sessionId ${c.session.sessionId ?? '取れない'}`,
      );
      break;
  }
  out.push(
    `  プロンプトが焼かれてからの経過: ${c.ageAtPullMs === null ? '取れない' : duration(c.ageAtPullMs)}（${c.ageNote}。pulledAt ${c.pulledAt ?? '取れない'}）`,
  );
  out.push(
    `  full: ${c.full ? '1（本文を含む）' : '0（本文・道具の説明・入力スキーマが省かれている。節ごとの大きさは取れない。`pull` は既定で全文を取る）'}`,
  );
  switch (c.contextUsage.state) {
    case 'none':
      out.push(`  contextUsage: 未取得（${c.contextUsage.reason}）。SDK 実測のトークンは出せない`);
      break;
    case 'failed':
      out.push(
        `  contextUsage: 失敗の回（${c.contextUsage.at}。理由: ${c.contextUsage.error}）。SDK 実測のトークンは出せない`,
      );
      break;
    case 'ok':
      out.push(
        `  contextUsage: 成功（SDK が測った時刻 ${c.contextUsage.at}。プロンプトの焼き時刻とは別）`,
      );
      for (const axis of c.contextUsage.axes) {
        out.push(
          axis.available
            ? `    ${axis.axis}: 取れた${axis.omitted !== null && axis.omitted > 0 ? `（上限で ${n(axis.omitted)} 行切り捨て）` : ''}`
            : `    ${axis.axis}: 取れない（${axis.reason ?? ''}）`,
        );
      }
      break;
  }
  out.push(
    `  秘密走査（daemon の応答の伏せ字）: ${
      c.secretScan.length === 0
        ? '当たり 0 件'
        : c.secretScan.map((hit) => `${hit.rule} ${n(hit.count)} 件`).join('、')
    }（規則名と件数だけ。値は出ない）`,
  );
  out.push(`  notice（取れなかった軸の理由など。全 ${n(c.notices.length)} 件）:`);
  for (const notice of c.notices) out.push(`    - ${notice}`);
  out.push('  出所の区別:');
  out.push(
    '    [文字数] システムプロンプトの本文から数えた／daemon が応答に書いた文字数（トークンではない）',
  );
  out.push(
    '    [SDK 実測トークン] contextUsage（SDK の getContextUsage）が測った値だけ。文字数からの換算はしない',
  );
  return out;
}

export function renderPromptAnalysis(a: PromptAnalysis, top: number): string {
  const out: string[] = [
    '# プロンプトの大きさの分析（クローンが毎ターン払っている量。pull が保存した prompt.json）',
  ];
  if (a.state !== 'read') {
    out.push(
      `  ${a.state === 'none' ? '入力が無い' : '読めない'}: ${a.reason}。この節は取れない（0 ではない）`,
    );
    return out.join('\n');
  }
  out.push(...renderPromptCoverage(a.coverage));

  // P2
  out.push('', '## P2. システムプロンプトの節ごとの大きさ（[文字数]。行頭の `# ` の見出しで割る）');
  const sp = a.systemPrompt;
  if (sp.state === 'unavailable') {
    out.push(unavailableLine('  ', 'システムプロンプト', sp));
  } else {
    out.push(`  全体: ${chars(sp.chars)}（応答の systemPrompt.chars）`);
    if (sp.sections.state === 'unavailable') {
      out.push(unavailableLine('  ', '節ごと', sp.sections));
    } else {
      if (sp.sections.textCharsDiffersFromChars) {
        out.push(
          `  ⚠ 本文の長さ ${chars(sp.sections.textChars)} が chars と違う（秘密走査の伏せ字で長さが変わりうる）。割合は本文の長さが分母`,
        );
      }
      for (const row of sp.sections.rows) {
        out.push(
          `    ${row.heading === null ? '導入（最初の見出しより前）' : `# ${row.heading}`}: ${chars(row.chars)}（${pct(row.share)}）`,
        );
      }
    }
    out.push(
      '  記憶の索引と節の突き合わせ（memoryInPrompt の indexChars の合計 vs「# 現在の記憶」の節）:',
    );
    if (sp.memoryIndex.state === 'unavailable') {
      out.push(unavailableLine('    ', '突き合わせ', sp.memoryIndex));
    } else {
      const m = sp.memoryIndex;
      out.push(
        `    節 ${chars(m.sectionChars)} / 索引の合計 ${chars(m.indexCharsSum)}（節の ${pct(m.indexShareOfSection)}） / 差 ${n(m.difference)}字`,
      );
      out.push(`    ${m.note}`);
      if (m.documentsWithoutIndexChars > 0) {
        out.push(
          `    索引の長さが取れなかった（indexChars が null の）文書 ${n(m.documentsWithoutIndexChars)} 件は合計に入っていない`,
        );
      }
    }
    out.push(
      '  [SDK 実測トークン] contextUsage.systemPromptSections（SDK が名前つきで測った節。上の文字数の表とは別物で、換算していない）:',
    );
    if (sp.sdkSections.state === 'unavailable') {
      out.push(unavailableLine('    ', 'SDK の節', sp.sdkSections));
    } else {
      out.push(
        `    合計 ${tokens(sp.sdkSections.total)}${sp.sdkSections.omitted > 0 ? `（上限で ${n(sp.sdkSections.omitted)} 行切り捨て）` : ''}`,
      );
      for (const row of sp.sdkSections.rows) {
        out.push(`    ${row.name}: ${tokens(row.tokens)}（${pct(row.share)}）`);
      }
    }
  }

  // P3
  out.push(
    '',
    '## P3. 記憶の索引の文書ごとの大きさ（[文字数]。indexChars の大きい順 = どの記憶がプロンプトを太らせているか）',
  );
  const mem = a.memory;
  if (mem.state === 'unavailable') {
    out.push(unavailableLine('  ', '記憶の索引', mem));
  } else {
    out.push(
      `  文書 ${n(mem.documents)} 件 / 索引の合計 ${chars(mem.indexCharsSum)}${mem.omittedDocuments > 0 ? ` / 載せる件数の上限で切り捨てた文書 ${n(mem.omittedDocuments)} 件（一覧に無い）` : ''}`,
    );
    out.push('  slug（区分）: 索引 N字（索引全体の %）/ 本文 N字 / 索引÷本文 / 要旨 N字');
    for (const row of mem.rows) {
      out.push(
        `    ${row.slug}（${row.type}）: 索引 ${chars(row.indexChars)}（${pct(row.shareOfIndex)}）/ 本文 ${chars(row.chars)} / 索引÷本文 ${pct(row.indexOverBody)} / 要旨 ${chars(row.descriptionChars)}`,
      );
    }
    out.push(
      `  索引に載っていない文書（indexChars は null。0 ではない）: ${n(mem.unindexed.length)} 件`,
    );
    for (const row of mem.unindexed) {
      out.push(
        `    ${row.slug}（${row.type}）: ${row.omitted ? '索引から省かれた' : '索引の中での長さが取れなかった'} / 本文 ${chars(row.chars)} / indexNote: ${row.indexNote ?? '取れない'}`,
      );
    }
    out.push(
      '  [SDK 実測トークン] contextUsage.memoryFiles（CLAUDE.md などの指示ファイル。記憶の索引とは別）:',
    );
    if (mem.memoryFiles.state === 'unavailable') {
      out.push(unavailableLine('    ', '指示ファイル', mem.memoryFiles));
    } else {
      out.push(
        `    合計 ${tokens(mem.memoryFiles.total)}${mem.memoryFiles.omitted > 0 ? `（上限で ${n(mem.memoryFiles.omitted)} 行切り捨て）` : ''}`,
      );
      for (const row of mem.memoryFiles.rows) {
        out.push(
          `    ${row.path}${row.type === null ? '' : `（${row.type}）`}: ${tokens(row.tokens)}`,
        );
      }
    }
  }

  // P4
  out.push(
    '',
    '## P4. クローンの道具の定義の大きさ（[文字数]。説明 + 入力スキーマの大きい順。「モデルに見える定義（$schema を外した後）」の大きさ）',
  );
  const tools = a.tools;
  if (tools.state === 'unavailable') {
    out.push(unavailableLine('  ', '道具の定義', tools));
  } else {
    out.push(`  ${n(tools.count)} 本 / 合計 ${chars(tools.totalChars)}`);
    out.push('  名前: 合計 N字（全体の %）= 説明 N字 + 入力スキーマ N字 / [SDK 実測トークン]');
    for (const row of tools.rows) {
      out.push(
        `    ${row.name}: ${chars(row.totalChars)}（${pct(row.shareOfTotal)}）= 説明 ${chars(row.descriptionChars)} + スキーマ ${chars(row.inputSchemaChars)} / ${
          row.tokens === null
            ? tools.tokens.state === 'unavailable'
              ? 'トークン 取れない（contextUsage が無い）'
              : 'トークン 取れない（contextUsage.mcpTools に名前の対応する行が無い）'
            : tokens(row.tokens)
        }`,
      );
    }
    if (tools.tokens.state === 'unavailable') {
      out.push(unavailableLine('  ', '道具ごとの SDK 実測トークン', tools.tokens));
    } else {
      out.push(
        `  SDK 実測トークンと名前が対応した道具: ${n(tools.tokens.matched)} / ${n(tools.count)} 本（クローンの道具は mcp__alteroid__<名前> として SDK に見える）`,
      );
      if (tools.tokens.unmatchedCloneServerRows.count > 0) {
        out.push(
          `  クローン自身の MCP サーバ名の行のうち、どの道具とも名前が対応しないもの: ${n(tools.tokens.unmatchedCloneServerRows.count)} 行 / ${tokens(tools.tokens.unmatchedCloneServerRows.tokens)}（対応が取れない）`,
        );
      }
    }
  }

  // P5
  out.push('', '## P5. 外部 MCP（人間が登録したもの。クローン自身の道具とは混ぜない）');
  const ext = a.externalMcp;
  if (ext.state === 'unavailable') {
    out.push(unavailableLine('  ', '外部 MCP', ext));
  } else {
    out.push(
      `  登録（名前と種別だけ。接続設定の値は応答に無い）: ${
        ext.servers.state === 'read'
          ? ext.servers.rows.length === 0
            ? '0 件'
            : ext.servers.rows.map((row) => `${row.name}（${row.type}）`).join('、')
          : '取れない'
      }`,
    );
    out.push(
      ext.live.state === 'read'
        ? `  走行中の差し替え（externalMcpServersLive）: ${ext.live.at} / 失敗 ${ext.live.failed.length === 0 ? 'なし' : ext.live.failed.join('、')} / 残った ${ext.live.retained.length === 0 ? 'なし' : ext.live.retained.join('、')}`
        : `  走行中の差し替え: なし（${ext.live.reason}）`,
    );
    if (ext.tokens.state === 'unavailable') {
      out.push(unavailableLine('  ', 'SDK 実測トークン', ext.tokens));
    } else {
      out.push(
        `  [SDK 実測トークン] contextUsage.mcpTools のうちクローン自身のサーバ（alteroid）を除いた合計 ${tokens(ext.tokens.total)}${ext.tokens.omittedRows > 0 ? `（上限で ${n(ext.tokens.omittedRows)} 行切り捨て）` : ''}`,
      );
      out.push('  サーバごと（foldMcpToolsByServer。トークンの大きい順）:');
      for (const row of ext.tokens.byServer) {
        out.push(
          `    ${row.name}${row.type === null ? '（登録の写しに無い名前）' : `（${row.type}）`}: ${n(row.tools)} 本 / ${tokens(row.tokens)}`,
        );
      }
      if (ext.tokens.registeredWithoutRows.length > 0) {
        out.push(
          `    登録はあるが mcpTools に行が無い（取れない。0 ではない）: ${ext.tokens.registeredWithoutRows.join('、')}`,
        );
      }
      out.push(`  道具ごとの上位 ${n(top)}:`);
      for (const row of ext.tokens.topTools) {
        out.push(
          `    ${row.name}（${row.serverName ?? 'サーバ不明'}）: ${tokens(row.tokens)}${row.isLoaded === false ? ' / 未ロード' : ''}`,
        );
      }
    }
  }

  // P6
  out.push('', '## P6. SDK 組み込みの道具（[SDK 実測トークン]。説明・スキーマは SDK が返さない）');
  const builtin = a.builtin;
  if (builtin.state === 'unavailable') {
    out.push(unavailableLine('  ', 'SDK 組み込みの道具', builtin));
  } else {
    out.push(`  builtinTools.reason: ${builtin.reason}`);
    if (builtin.systemTools.state === 'unavailable') {
      out.push(unavailableLine('  ', 'systemTools', builtin.systemTools));
    } else {
      out.push(
        `  systemTools: 合計 ${tokens(builtin.systemTools.total)}${builtin.systemTools.omitted > 0 ? `（上限で ${n(builtin.systemTools.omitted)} 行切り捨て）` : ''}`,
      );
      for (const row of builtin.systemTools.rows)
        out.push(`    ${row.name}: ${tokens(row.tokens)}`);
    }
    if (builtin.deferredBuiltinTools.state === 'unavailable') {
      out.push(unavailableLine('  ', 'deferredBuiltinTools', builtin.deferredBuiltinTools));
    } else {
      out.push(
        `  deferredBuiltinTools: 合計 ${tokens(builtin.deferredBuiltinTools.total)}（isLoaded が false の分は毎ターンは払っていない）${builtin.deferredBuiltinTools.omitted > 0 ? `（上限で ${n(builtin.deferredBuiltinTools.omitted)} 行切り捨て）` : ''}`,
      );
      for (const row of builtin.deferredBuiltinTools.rows) {
        out.push(`    ${row.name}: ${tokens(row.tokens)} / isLoaded ${String(row.isLoaded)}`);
      }
    }
  }

  // P7
  out.push(
    '',
    '## P7. 文脈占有のカテゴリ（[SDK 実測トークン]。kind で分ける。名前では分類しない）',
  );
  const occ = a.occupancy;
  if (occ.state === 'unavailable') {
    out.push(unavailableLine('  ', '文脈占有', occ));
  } else {
    out.push(
      `  全体 ${tokens(occ.totalTokens)} / 上限 ${tokens(occ.rawMaxTokens)}（${occ.percentage.toFixed(1)}%）${occ.omittedRows > 0 ? ` / categories は上限で ${n(occ.omittedRows)} 行切り捨て` : ''}`,
    );
    out.push(
      `  ★ 毎ターン払っている量（kind=used）: ${tokens(occ.used.tokens)}（${n(occ.used.count)} 行）`,
    );
    for (const row of occ.used.rows) {
      out.push(`      ${row.name}: ${tokens(row.tokens)}（used の ${pct(row.share)}）`);
    }
    out.push('  払っていない量（used に混ぜない）:');
    out.push(`    free: ${tokens(occ.free.tokens)}（${n(occ.free.count)} 行）`);
    out.push(`    buffer: ${tokens(occ.buffer.tokens)}（${n(occ.buffer.count)} 行）`);
    out.push(`    deferred: ${tokens(occ.deferred.tokens)}（${n(occ.deferred.count)} 行）`);
    if (occ.unclassified.count > 0) {
      out.push(
        `    kind が無い・未知の行: ${tokens(occ.unclassified.tokens)}（${n(occ.unclassified.count)} 行。used に入れていない）`,
      );
    }
  }

  out.push('', ...renderPromptCandidates(a.candidates, top));
  return out.join('\n');
}

export function renderPromptCandidates(c: PromptCandidates, top: number): string[] {
  const out: string[] = [
    `## P8. 定義を短くできる余地の大きい順（上位 ${n(top)}。${PROMPT_NO_REMOVAL_NOTE}）`,
    '  文字数どうし・トークンどうしで別々に並べる（単位が違うものは混ぜない）。「変える所」は、誰がどこを書き換えるかの所在である。',
  ];
  out.push('  [文字数] 大きい順');
  if (c.chars.state === 'unavailable') {
    out.push(unavailableLine('    ', '文字数の候補', c.chars));
  } else {
    out.push(
      `    ${c.chars.baselineNote}（分母 ${chars(c.chars.baseline)}。候補 ${n(c.chars.total)} 件中）`,
    );
    for (const row of c.chars.rows) {
      out.push(
        `    ${chars(row.size)}（${pct(row.share)}）[${row.basis === 'text-counted' ? '本文から数えた文字数' : 'daemon の応答の文字数'}] ${row.label}`,
      );
      out.push(`        変える所: ${row.where}`);
    }
  }
  out.push('  [SDK 実測トークン] 大きい順');
  if (c.tokens.state === 'unavailable') {
    out.push(unavailableLine('    ', 'トークンの候補', c.tokens));
  } else {
    out.push(
      `    ${c.tokens.baselineNote}（分母 ${tokens(c.tokens.baseline)}。候補 ${n(c.tokens.total)} 件中）`,
    );
    if (c.tokens.excludedNotLoaded > 0) {
      out.push(
        `    未ロードの SDK 組み込みの遅延道具 ${n(c.tokens.excludedNotLoaded)} 件は毎ターンは払っていないので、並べていない`,
      );
    }
    for (const row of c.tokens.rows) {
      out.push(`    ${tokens(row.size)}（${pct(row.share)}）[SDK 実測トークン] ${row.label}`);
      out.push(`        変える所: ${row.where}`);
    }
  }
  return out;
}
