import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  analyzeConversation,
  analyzeDiagnostics,
  createSecretRedactor,
  parseJournalJsonl,
  renderConversationAnalysis,
  renderConversationCoverage,
  renderDiagnosticsAnalysis,
  resolveLedgerTimeZone,
  ROTATABLE_CREDENTIAL_KEYS,
  WITHHELD_ENV_KEYS,
  type ConversationExchangesInput,
  type ConversationManifestInput,
} from '@alteroid/core';

import { stderr, stdout } from './terminal-out.js';

export interface DiagnosticsAnalyzeOptions {
  journal?: string;
  usage?: string;
  exchanges?: string;
  dir?: string;
  ledgerTz?: string;
  top?: string;
  json?: boolean;
  // 試験の口: 伏せ字の走査に使う環境（既定は process.env）
  env?: NodeJS.ProcessEnv;
}

// `diagnostics pull` の出力ディレクトリの既定のファイル名
const DIR_JOURNAL = 'journal.jsonl';
const DIR_USAGE = 'usage.json';
const DIR_EXCHANGES = 'exchanges.jsonl';
const DIR_MANIFEST = 'manifest.json';

function resolveTop(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error('--top は 1〜1000 の整数で指定してください');
  }
  return value;
}

async function readInput(label: string, path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `${label} を読めませんでした（${path}: ${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
}

// `--dir` の既定の名前のファイルが無いのは、pull が取らなかった・取れなかったことがある（manifest が言う）ので、落とさず「無い」と返す
async function readOptionalInDir(label: string, path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error(
      `${label} を読めませんでした（${path}: ${error instanceof Error ? error.message : String(error)}）`,
      {
        cause: error,
      },
    );
  }
}

function parseUsage(label: string, path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} が JSON として読めません（${path}。usage --json の出力を渡す）`);
  }
}

async function readExchangesInput(
  options: DiagnosticsAnalyzeOptions,
): Promise<ConversationExchangesInput> {
  if (options.exchanges !== undefined) {
    return {
      state: 'read',
      parsed: parseJournalJsonl(await readInput('--exchanges', options.exchanges)),
    };
  }
  if (options.dir === undefined) {
    return { state: 'none', reason: '--exchanges も --dir も渡されていない' };
  }
  const text = await readOptionalInDir(DIR_EXCHANGES, join(options.dir, DIR_EXCHANGES));
  if (text === null) {
    return {
      state: 'none',
      reason: `${DIR_EXCHANGES} が --dir に無い（pull の --no-exchanges か、取得の失敗。manifest.json の requested・failures を見る）`,
    };
  }
  return { state: 'read', parsed: parseJournalJsonl(text) };
}

async function readManifestInput(
  options: DiagnosticsAnalyzeOptions,
): Promise<ConversationManifestInput> {
  if (options.dir === undefined) {
    return {
      state: 'none',
      reason: '--dir が渡されていない（窓・truncated・failures は manifest.json にある）',
    };
  }
  const text = await readOptionalInDir(DIR_MANIFEST, join(options.dir, DIR_MANIFEST));
  if (text === null) return { state: 'none', reason: `${DIR_MANIFEST} が --dir に無い` };
  try {
    return { state: 'read', value: JSON.parse(text) };
  } catch {
    return { state: 'unreadable', reason: `${DIR_MANIFEST} が JSON として読めない` };
  }
}

/**
 * `diagnostics export` / `diagnostics pull` の出力（JSONL）と、任意で `usage --json` の出力・会話（exchanges）を読んで、トークンの使い方の事実を並べる。
 * 入力ファイルは読むだけで書き換えない。通信しない。集計の本体は `@alteroid/core` の純関数。
 * `--dir`（pull の出力ディレクトリ）は既定の名前のファイルを読み、個別の旗が優先する。
 */
export async function diagnosticsAnalyzeCommand(options: DiagnosticsAnalyzeOptions): Promise<void> {
  const journalPath =
    options.journal ?? (options.dir === undefined ? undefined : join(options.dir, DIR_JOURNAL));
  if (journalPath === undefined) {
    throw new Error(
      '--journal <JSONL> が要ります（`alteroid diagnostics export > diag.jsonl` の出力）。pull の出力ディレクトリなら --dir <dir> でもよい',
    );
  }
  const topN = resolveTop(options.top);
  let usage: unknown;
  if (options.usage !== undefined) {
    usage = parseUsage('--usage', options.usage, await readInput('--usage', options.usage));
  } else if (options.dir !== undefined) {
    const path = join(options.dir, DIR_USAGE);
    const text = await readOptionalInDir(DIR_USAGE, path);
    if (text !== null) usage = parseUsage(DIR_USAGE, path, text);
  }
  // 不正な IANA 名は黙って捨てずに断る（台帳が申告した名前が使われる場合は、その不正も同じ口で出る）
  const zone = resolveLedgerTimeZone(usage, options.ledgerTz);
  if (zone.state === 'invalid') {
    throw new Error(`時間帯を使えません（${zone.given}）: ${zone.reason}`);
  }
  const journal = parseJournalJsonl(
    await readInput(options.journal === undefined ? DIR_JOURNAL : '--journal', journalPath),
  );
  const analysis = analyzeDiagnostics(journal, {
    usage,
    ...(options.ledgerTz === undefined ? {} : { ledgerTz: options.ledgerTz }),
    topN,
  });

  const exchanges = await readExchangesInput(options);
  const manifest = await readManifestInput(options);
  // 表示する会話の文面は、pull が伏せていても手元の別経路のファイルかもしれないので、表示の直前にもう一度伏せる（`diagnostics pull` と同じ一覧・同じ作法）
  const redactor = createSecretRedactor({
    env: options.env ?? process.env,
    knownSecretEnvNames: [...WITHHELD_ENV_KEYS, ...ROTATABLE_CREDENTIAL_KEYS],
  });
  const conversation = analyzeConversation({
    journal,
    exchanges,
    manifest,
    topN,
    redact: (text) => redactor.redact(text),
  });
  if (exchanges.state === 'read' || manifest.state === 'read') {
    const hits = redactor.hits();
    // 規則名と件数だけ。値は出さない
    stderr.write(
      `伏せ字: 会話の文面（表示の直前の再走査）— ${
        hits.length === 0
          ? '当たり 0 件'
          : hits.map((hit) => `${hit.rule} ${String(hit.count)} 件`).join('、')
      }\n`,
    );
  }

  if (options.json === true) {
    // `writeRaw`: 端末向けの掃除は JSON の中身を変えるため。既存の欄は変えず、会話の分析は `conversation` として足す
    stdout.writeRaw(`${JSON.stringify({ ...analysis, conversation })}\n`);
    return;
  }
  stdout.write(
    `${renderConversationCoverage(conversation)}\n\n${renderDiagnosticsAnalysis(analysis)}\n${renderConversationAnalysis(conversation, topN)}\n`,
  );
}
