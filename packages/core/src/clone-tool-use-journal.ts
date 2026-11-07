import type { AgentToolAuditFailureRecord, AgentToolAuditRecord } from './agent-hooks.js';
import { stampAnsweredApproval } from './approval-trace.js';
import { DENIED_TOOL_USE_MEMORY_LIMIT } from './clone-denial-journal.js';
import { UNKNOWN_AGENT_TYPE, UNKNOWN_TOOL_NAME } from './clone-unknown-labels.js';
import { redactErrorText } from './denial-input-head.js';
import { noteDroppedRecord } from './dropped-record.js';
import { excerptLine } from './excerpt.js';
import { createRecentMap } from './recent.js';
import type { JournalEntryInput } from './schema.js';
import {
  cloneToolCarriesSecrets,
  cloneToolJournalsItself,
  detectMcpInputValidationFailure,
  qualifiedToolName,
} from './tools.js';
import { CLONE_ACTOR_ID, CLONE_SUB_ACTOR_PREFIX } from './usage.js';

const JOURNAL_WRITE_QUALIFIED_TOOL_NAME = qualifiedToolName('journal_write');

// 切らずに残さない: `error` は上限の無い自由文で、1件の巨大な失敗メッセージが日誌の1行を埋め尽くしうるため
const TOOL_USE_ERROR_EXCERPT = 500;

/**
 * `Clone` が協力者へ渡す口。
 * 口の戻りは Promise を直に返す（`(entry) => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、
 * `#onPostToolUse` などの hook と `#applyAssistantMessage` の `await` の時機が動く。
 * 値ではなく読む関数にする: この協力者は `Clone` の field 初期化で作り、`#env` と `#sdkSession` は constructor の中で入る。
 */
export interface CloneToolUseJournalPorts {
  /** `Clone` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
  /** `Clone` の `#env`（道具の出力を日誌へ写す前に、伏せ字を通す） */
  env(): NodeJS.ProcessEnv;
  /** `Clone` の `#sdkSession.turn?.approvalId`（いま走っている答えのターンの承認の id。答えのターンでなければ無い） */
  turnApprovalId(): string | null | undefined;
}

/**
 * 道具の呼び（`tool_use`）の日誌を書く協力者。
 * 状態は1本（入力が読めず断られた tool_use の id）で、この中だけで書く。
 * `Clone` の hook（`#onPostToolUse` / `#onPostToolUseFailure` / `#onDistillToolUse` / `#onDistillToolUseFailure`）と `#applyAssistantMessage` が呼ぶ。
 * `exchange` の行は書かない（`#journalSelf` を持たない）。
 */
export class CloneToolUseJournal {
  readonly #ports: CloneToolUseJournalPorts;

  // 入力が読めず断られた tool_use の id（#5313）。上限で忘れた id の再送は二重に書かれうるが、行が1本増えるだけで欠けはしない
  readonly #unparsedToolInputJournaled = createRecentMap<true>({
    limit: DENIED_TOOL_USE_MEMORY_LIMIT,
  });

  constructor(ports: CloneToolUseJournalPorts) {
    this.#ports = ports;
  }

  async journalToolUse(
    raw: AgentToolAuditRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    // `tool_name` が読めなくても落とさず `(不明な道具)` で残す: 読めないのは「観測できなかった」のであって、黙って消すと監査の穴が最も静かに空く
    const tool = typeof raw?.toolName === 'string' ? raw.toolName : UNKNOWN_TOOL_NAME;
    if (cloneToolJournalsItself(tool)) {
      await this.#journalSelfJournalingToolValidationFailure(tool, raw, mainThreadActor);
      return;
    }
    await this.#ports.journal(
      stampAnsweredApproval(
        {
          type: 'tool_use',
          actor: cloneToolActor(raw, mainThreadActor),
          tool,
          input: raw?.toolInput,
        },
        this.#answeredApprovalFor(mainThreadActor),
      ),
    );
  }

  /** 本セッションの actor の行だけに返す: 蒸留のサイドクエリは答えのターンと並行して走りうるので、`#turn` を読むと無関係な行へ印が付く。 */
  #answeredApprovalFor(mainThreadActor: string): string | null {
    return mainThreadActor === CLONE_ACTOR_ID ? (this.#ports.turnApprovalId() ?? null) : null;
  }

  /**
   * `cloneToolCarriesSecrets(tool)` の道具（いまは `profile_write`）の `input` は残さない: 鍵・トークンの値そのものを運び、日誌は要約にも載るので焼かれると回収できない。検証で落ちた欄の名前だけを `error` に残す。
   * `self_dropped` は `journal_write` にだけ足す: 判断の記録そのものが落ちるのはそれだけで、他の自作ツールはここで初めて `tool_use` の代わりが生まれるので二重に名乗らない。
   */
  async #journalSelfJournalingToolValidationFailure(
    tool: string,
    raw: AgentToolAuditRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    const validation = detectMcpInputValidationFailure(raw?.toolResponse);
    if (validation === undefined) return;

    const fieldList =
      validation.fields.length > 0 ? validation.fields.join(', ') : '（取れなかった）';
    const secretBearing = cloneToolCarriesSecrets(tool);

    await this.#ports.journal(
      stampAnsweredApproval(
        {
          type: 'tool_use',
          actor: cloneToolActor(raw, mainThreadActor),
          tool,
          outcome: 'failed',
          ...(secretBearing
            ? {
                error: excerptLine(
                  `入力検証で落ちた（この道具は実行環境の秘密を運びうるため、値は日誌へ写さない。` +
                    `欠けた/不正な引数: ${fieldList}）`,
                  TOOL_USE_ERROR_EXCERPT,
                ),
              }
            : {
                input: raw?.toolInput,
                error: excerptLine(
                  redactErrorText(validation.message, this.#ports.env()),
                  TOOL_USE_ERROR_EXCERPT,
                ),
              }),
        },
        this.#answeredApprovalFor(mainThreadActor),
      ),
    );

    if (tool === JOURNAL_WRITE_QUALIFIED_TOOL_NAME) {
      noteDroppedRecord(
        '判断そのもの（journal_write）',
        `fields=${fieldList}`,
        new Error('入力検証で落ちた——decision が届かなかった可能性がある（issue #1338 残件1）'),
      );
    }
  }

  /**
   * 失敗は `exchange` でなく `tool_use` に落とす: 失敗は走った結果で副作用が在りうるので「自分で手を動かした回数」に数える（拒否は走っていないので `exchange`）。成功と区別するため `outcome` を立てる。
   * 自作ツールの除外は成功側と同じ規則（`cloneToolJournalsItself`）を通す: 成功は除き失敗は残す、という非対称を持ち込むと読み手が道具ごとに確かめることになる。
   * 入力検証落ち（ハンドラが走らない回）はここへ来ない（`PostToolUse` に来る。`Clone` の `#onPostToolUse` の doc「除外の前提が崩れる回」）。
   */
  async journalToolUseFailure(
    raw: AgentToolAuditFailureRecord | null | undefined,
    mainThreadActor: string,
  ): Promise<void> {
    const tool = typeof raw?.toolName === 'string' ? raw.toolName : UNKNOWN_TOOL_NAME;
    if (cloneToolJournalsItself(tool)) return;
    await this.#ports.journal(
      stampAnsweredApproval(
        {
          type: 'tool_use',
          actor: cloneToolActor(raw, mainThreadActor),
          tool,
          input: raw?.toolInput,
          // 欠けを第3の値にせず failed へ倒す: `isInterrupt` が無いのは「中断ではないと確定」ではなく「分かっていない」だけ
          outcome: raw?.isInterrupt === true ? 'interrupted' : 'failed',
          ...(typeof raw?.error === 'string'
            ? // 道具の出力を運びうるので、伏せてから切る
              {
                error: excerptLine(
                  redactErrorText(raw.error, this.#ports.env()),
                  TOOL_USE_ERROR_EXCERPT,
                ),
              }
            : {}),
        },
        this.#answeredApprovalFor(mainThreadActor),
      ),
    );
  }

  /**
   * 入力が JSON として読めず本体が断った呼び出し（`__unparsedToolInput`。#5313）を `tool_use` / `failed` で1行残す。
   * 本体は hook より前に断るので、`PostToolUseFailure` では拾えない。assistant メッセージの tool_use が運ぶ長さだけを根拠にする。
   * `input` は書かない・`error` に raw を写さない: 入力が記憶の本文・資格を運びうるため（`cloneToolCarriesSecrets` の道具に限らず全道具で伏せる。どの道具の入力が読めなかったかは道具名で足りる）。
   * 同じ `id` は1回だけ書く: 再送・再生で同じメッセージが届いても行が増えないため。
   */
  async journalUnparsedToolInput(
    tool: string,
    toolUseId: string | undefined,
    len: number,
    parentToolUseId: string | null,
  ): Promise<void> {
    if (toolUseId !== undefined) {
      if (this.#unparsedToolInputJournaled.has(toolUseId)) return;
      this.#unparsedToolInputJournaled.set(toolUseId, true);
    }
    // 作業者（`parentToolUseId` 付き）の手は、hook 側と同じ `cloneToolActor` の規則で `clone:sub:` に寄せる
    const actor =
      parentToolUseId === null
        ? CLONE_ACTOR_ID
        : cloneToolActor({ agentId: parentToolUseId }, CLONE_ACTOR_ID);
    await this.#ports.journal({
      type: 'tool_use',
      actor,
      tool,
      outcome: 'failed',
      error: excerptLine(
        `入力が JSON として読めず本体が断った（${String(len)} bytes。入力は日誌へ写さない）`,
        TOOL_USE_ERROR_EXCERPT,
      ),
    });
  }
}

/**
 * どの層の手だったかを `PostToolUse` の合図から決める。`agent_id` で見る。
 *
 * [sdk-verbatim BaseHookInput.agent_id]
 * > Use this field (not agent_type) to distinguish subagent calls from main-thread calls.
 *
 * 分けない（`agent_type` で見ない）と、サブエージェントの分だけ「クローンが自分で叩いた回数」が膨らむ。
 */
function cloneToolActor(
  hook: { agentId?: string; agentType?: string } | null | undefined,
  mainThreadActor: string,
): string {
  if (typeof hook?.agentId !== 'string' || hook.agentId.length === 0) return mainThreadActor;
  const type =
    typeof hook.agentType === 'string' && hook.agentType.length > 0
      ? hook.agentType
      : UNKNOWN_AGENT_TYPE;
  return `${CLONE_SUB_ACTOR_PREFIX}${type}`;
}
