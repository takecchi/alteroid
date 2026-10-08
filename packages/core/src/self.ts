// alteroid の要約を手書きしない: docs と二重管理になりずれた瞬間、クローンは自分について間違ったことを確信するため

import { summarizeContextCategories } from './context-usage.js';
import { excerptLine } from './excerpt.js';
import { CANON_DOCUMENTS, CANON_REVISION, type CanonDocument } from './generated/canon.js';
import type { HeuristicChars } from './quantity.js';
import {
  describeBuildAge,
  describeBuildRevision,
  type BuildRevision,
  type BuildTime,
} from './revision.js';
import type { JournalEntry } from './schema.js';

// `clone.ts` から import しない: あちらが `self.ts` を import しており循環になるため
type ContextUsageObservation = NonNullable<
  Extract<JournalEntry, { type: 'turn_usage' }>['contextUsage']
>;

const SELF_MCP_SERVERS_EXCERPT = 400;

export { CANON_DOCUMENTS, CANON_REVISION, type CanonDocument };

export const REPOSITORY_URL = 'https://github.com/takecchi/alteroid';

export function canonNames(): string[] {
  return CANON_DOCUMENTS.map((doc) => doc.name);
}

export function canonDocument(name: string): CanonDocument | undefined {
  const key = name.trim().toLowerCase();
  return CANON_DOCUMENTS.find((doc) => doc.name === key);
}

// 鍵を入れない: そのままシステムプロンプトへ載るため
export interface SelfFacts {
  storage: string;
  // パスだけを渡さない: pg 構成でローカルに残るのは state だけで記憶ではなく、パスだけだと「記憶: PostgreSQL」と並んで矛盾する2つの事実を確信させるため
  local: string;
  workspace: string;
  cwd: string;
  runner: string;
  // 待ち受けアドレスを入口にしない: `ALTEROID_BIND=0.0.0.0` は人間が叩く先ではなく、TLS を手前で終端する構成では scheme も変わるため
  entrypoint: string;
  auth: string;
  // マネージャー層・作業者層は持たない: 実際に効くのは runner の環境変数で、デーモンの環境からは取れないため
  models: { clone: string };
}

// `null` を既定値や宣言値で埋めない: 埋めた瞬間、まだ観測していない値を確信することになるため
export interface CloneRuntimeFacts {
  revision: BuildRevision;
  buildTime: BuildTime;
  declaredModel: string;
  // 「既定と違うか」にしない: 置いた値がたまたま既定と同じ（`ALTEROID_CLONE_MODEL=opus`）でも真にするため
  modelOverridden: boolean;
  modelEnvKey: string;
  sdkModel: string | null;
  effort: string | null;
  requestedEffort: string | null;
  claudeCodeVersion: string | null;
  apiKeySource: string | null;
  permissionMode: string | null;
  requestedPermissionMode: string;
  mcpServers: Array<{ name: string; status: string }> | null;
  sessionId: string | null;
  resumedFrom: string | null;
  injectedMemoryChars: HeuristicChars;
  systemPromptChars: HeuristicChars;
  lastContextUsage: ContextUsageObservation | null;
  /**
   * 接続中の runner が名乗ったマネージャー・作業者のモデルの行（`collectRunnerModelLines`）。
   * 実行時に引く値なので、システムプロンプトには載せない。空・未指定なら何も足さない。
   */
  runnerModels?: readonly string[];
}

export const RUNNER_MODELS_HEADING = '## 接続中の runner が名乗ったモデル（マネージャー・作業者）';

function unknownBecause(reason: string): string {
  return `まだ分からない（${reason}）`;
}

const INIT_NOT_OBSERVED = 'init 未観測';

const CLONE_RUNTIME_ITEMS = {
  revision: '自分がいま走っているコードのリビジョン',
  buildAge: 'このイメージが焼かれた時刻とそこからの経過',
  declaredModel: '宣言されたモデル帯',
  sdkModel: 'SDK が実際に報告したモデル id',
  effort: 'effort（実効値）',
  requestedEffort: 'effort（alteroid が明示的に渡したもの）',
  claudeCodeVersion: 'Claude Code の版',
  apiKeySource: '認証の出所（値ではなく名前）',
  permissionMode: '許可モード（SDK が報告した実効値）',
  requestedPermissionMode: '許可モード（alteroid が渡したもの）',
  mcpServers: 'MCP サーバ',
  sessionId:
    'SDK セッション id（クローン本体のセッションで観測した値。蒸留のサイドクエリは別セッションなのでここには出ない）',
  resumedFrom: 'resume 元のセッション id',
  injectedMemoryChars:
    'システムプロンプトへ焼き込んだ記憶の文字数（このセッションを組み立てた時点）',
  systemPromptChars: 'システムプロンプト全体の文字数（毎ターン払っている入力の土台）',
  lastTurnUsedTokens:
    "直近に終わったターンの境界で観測した、実際に払っていた入力（SDK の実トークン。kind='used' の合計。いま走っているターンの分ではない）",
  lastTurnUnusedTokens:
    "同じ観測のうち払っていない枠（kind='free' の空き / kind='buffer' の compaction 予備 / kind='deferred' の窓の外の道具スキーマ / 分類できなかった軸）",
} as const;

// 分類を二重に判定しない: `context-usage.ts` の `summarizeContextCategories` を呼ぶだけにする
function describeLastTurnContextUsage(lastContextUsage: ContextUsageObservation | null): {
  used: string;
  unused: string;
} {
  if (lastContextUsage === null) {
    const reason = unknownBecause('ターンの境界をまだ1度も越えていない');
    return { used: reason, unused: reason };
  }
  if (lastContextUsage.error !== undefined) {
    const reason = `観測を試みて失敗した（理由: ${lastContextUsage.error}）`;
    return { used: reason, unused: reason };
  }
  if (lastContextUsage.categories === undefined) {
    const reason =
      'SDK がカテゴリ別の内訳を返さなかった（この回の観測は categories を持っていない）';
    return { used: reason, unused: reason };
  }
  const summary = summarizeContextCategories(lastContextUsage.categories);
  return {
    used: `${summary.used.tokens.toLocaleString('en-US')} トークン（${summary.used.count} 軸）`,
    unused:
      `free ${summary.free.tokens.toLocaleString('en-US')} トークン（${summary.free.count} 軸） / ` +
      `buffer ${summary.buffer.tokens.toLocaleString('en-US')} トークン（${summary.buffer.count} 軸） / ` +
      `deferred ${summary.deferred.tokens.toLocaleString('en-US')} トークン（${summary.deferred.count} 軸） / ` +
      `分類できず ${summary.unclassified.tokens.toLocaleString('en-US')} トークン（${summary.unclassified.count} 軸）`,
  };
}

export const CLONE_RUNTIME_ITEM_LABELS: readonly string[] = Object.values(CLONE_RUNTIME_ITEMS);

export function describeCloneRuntime(facts: CloneRuntimeFacts): string {
  // `null`（未観測）と `[]`（観測できた0本）を同じ文言に畳まない: 「MCP 連携が1本も無い」という取れた事実が「まだ分からない」に化けるため
  const mcpServers =
    facts.mcpServers === null
      ? unknownBecause(INIT_NOT_OBSERVED)
      : facts.mcpServers.length === 0
        ? '0本（init は観測済み）'
        : excerptLine(
            facts.mcpServers.map((server) => `${server.name}(${server.status})`).join(', '),
            SELF_MCP_SERVERS_EXCERPT,
          );
  const lastTurnContextUsage = describeLastTurnContextUsage(facts.lastContextUsage);

  return [
    '## いまどう走っているか',
    '',
    // ここだけ `CLONE_RUNTIME_ITEMS` を字面として使わない: `describeBuildRevision` が1行を返すので、組み替えると既存の歯が測っている字面が動くため
    `- 自分がいま走っているコードの${describeBuildRevision(facts.revision)}`,
    `- ${CLONE_RUNTIME_ITEMS.buildAge}: ${describeBuildAge(facts.buildTime.builtAt)}`,
    // 次の2行の行頭を `- ` にしない: `tools.test.ts` の歯が `line.startsWith('- ')` で拾い、項目数の不一致で落ちるため
    // 「これより前のものは全部入っている」とは書かない: 反映と焼き込みの間に隙間があり、その保証はできないため
    '  この版が `main` の先端とは限らない —— `main` へのマージは夜1回の反映でしか ' +
      'alteroid の器へ届かないので、上の時刻より後に `main` へ入ったものはまだ届いて' +
      'いない（これより前のものが全部入っている、とは言えない。反映してから焼くまでの' +
      '隙間があるため）。',
    // 実測の数字は焼かない: 数字は腐っても赤くならないため
    `  差を数えるには \`gh api repos/takecchi/alteroid/compare/${
      facts.revision.commit ?? '<上のリビジョン>'
    }...main --jq .ahead_by\`（リポジトリを見るのはマネージャーの領域——デーモン` +
      '自身は PR もブランチも見に行かない。反映間隔の実測は `gh run list ' +
      '--workflow=release-prod.yml` で測り直すこと）。',
    // 「既定と同じ値か」で言わない: `ALTEROID_CLONE_MODEL=opus` を明示的に置いた場合に「既定のまま」と嘘になるため
    `- ${CLONE_RUNTIME_ITEMS.declaredModel}: ${facts.declaredModel}（` +
      (facts.modelOverridden
        ? `人間が \`${facts.modelEnvKey}\` に置いた値`
        : `既定。\`${facts.modelEnvKey}\` は置かれていない`) +
      '）',
    `- ${CLONE_RUNTIME_ITEMS.sdkModel}: ${facts.sdkModel ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- ${CLONE_RUNTIME_ITEMS.effort}: ${
      facts.effort ??
      unknownBecause('このセッションで最初の道具呼び出しか、モデルが effort に対応していない')
    }`,
    `- ${CLONE_RUNTIME_ITEMS.requestedEffort}: ${facts.requestedEffort ?? '渡していない（SDK の既定に任せている）'}`,
    `- ${CLONE_RUNTIME_ITEMS.claudeCodeVersion}: ${facts.claudeCodeVersion ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- ${CLONE_RUNTIME_ITEMS.apiKeySource}: ${facts.apiKeySource ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- ${CLONE_RUNTIME_ITEMS.permissionMode}: ${facts.permissionMode ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- ${CLONE_RUNTIME_ITEMS.requestedPermissionMode}: ${facts.requestedPermissionMode}`,
    `- ${CLONE_RUNTIME_ITEMS.mcpServers}: ${mcpServers}`,
    `- ${CLONE_RUNTIME_ITEMS.sessionId}: ${facts.sessionId ?? unknownBecause(INIT_NOT_OBSERVED)}`,
    `- ${CLONE_RUNTIME_ITEMS.resumedFrom}: ${facts.resumedFrom ?? '（新規に開いた。前のセッションを引き継いでいない）'}`,
    // 既存の文言・区切りは変えず `文字` の直後に注記を足す: `clone-self-status-and-memory-cause.test.ts` が `toContain` で固定しているため
    `- ${CLONE_RUNTIME_ITEMS.injectedMemoryChars}: ${facts.injectedMemoryChars.toLocaleString('en-US')} 文字（トークンの近似。実トークンは下の2行）`,
    `- ${CLONE_RUNTIME_ITEMS.systemPromptChars}: ${facts.systemPromptChars.toLocaleString('en-US')} 文字（トークンの近似）`,
    `- ${CLONE_RUNTIME_ITEMS.lastTurnUsedTokens}: ${lastTurnContextUsage.used}`,
    `- ${CLONE_RUNTIME_ITEMS.lastTurnUnusedTokens}: ${lastTurnContextUsage.unused}`,
    // **項目ではない**（行頭を `- ` にしない。`tools.test.ts` の項目名の歯が拾わない形）。
    ...(facts.runnerModels === undefined || facts.runnerModels.length === 0
      ? []
      : ['', RUNNER_MODELS_HEADING, '', ...facts.runnerModels.map((line) => `  ${line}`)]),
  ].join('\n');
}

// `facts` が無いときは実行環境の節を落とす: 無い事実を埋めると、クローンは自分の環境について嘘を確信するため
export function buildSelfKnowledge(facts?: SelfFacts): string {
  const lines = [
    '# あなた自身（alteroid）',
    '',
    'あなたを走らせているのは alteroid というプロダクトであり、**あなたはその外から使われる部品ではなく、実装の最上位に居る当事者である。**',
    'alteroid は「人間が PC の前に座り、Claude Code に作業を依頼して物事を進める」を、人間の代わりにあなたが行うためのツールである。',
    '',
    `- 実装は公開されている: ${REPOSITORY_URL}`,
    '- 実行基盤は Claude Agent SDK のラッパで、外部サービスへの接続は MCP。人間からの入口は CLI・HTTP API・Web UI の3つで、どれも同じ API の上に乗っている',
  ];

  if (facts === undefined) {
    lines.push(
      `- 層の対応: あなた（クローン）→ マネージャー → 作業者。あなたが \`manager_start\` で起こすのがマネージャーで、その下に作業者が居る`,
    );
  } else {
    lines.push(
      `- 層の対応: あなた（クローン / ${facts.models.clone}）→ マネージャー → 作業者。あなたが \`manager_start\` で起こすのがマネージャーで、その下に作業者が居る。マネージャーと作業者のモデルは runner ごとに決まるので、ここには書かない — \`self_status\`（接続中の runner が名乗った分）と \`manager_list\`（委譲ごと）で確かめること`,
      '',
      '## いまのあなたが走っている環境',
      '',
      `- 記憶（あなたの同一性が宿る場所）: ${facts.storage}`,
      `- ローカルの置き場: ${facts.local}`,
      `- あなた自身の作業ディレクトリ（自分の手で相対パスを使うときの基準）: ${facts.cwd}`,
      `- マネージャーの既定の作業ディレクトリ（あなたの器から見えるとは限らない）: ${facts.workspace}`,
      `- 委譲先: ${facts.runner}`,
      `- 人間からの入口: ${facts.entrypoint}（${facts.auth}）`,
    );
  }

  lines.push(
    '',
    '## 自分のことを調べる',
    '',
    '`self_read` で正典を全文読める。矛盾したら上が勝つ。',
    '',
    ...CANON_DOCUMENTS.map((doc, index) => `${index + 1}. \`${doc.name}\` — ${doc.summary}`),
    '',
    `**正典と実装が食い違ったら、バグなのは実装である。** ただしここにあるのはビルド時点の写し（写しの焼き込み時のリビジョン: ${CANON_REVISION.length > 0 ? CANON_REVISION : '不明'}）なので、実装の方が先に進んでいることもある。いま自分が走っているコードそのものの版は \`self_status\` が名乗る（写しの版と食い違うことがある）。`,
    'コードそのものや最新の状態が要るなら、`manager_start` でリポジトリを読ませること（マネージャーは実際に `git` と `gh` を持っている）。',
    '自分について分かったこと・人間と決めた自分の扱いは、他のことと同じように記憶へ移す。',
  );

  return lines.join('\n');
}
