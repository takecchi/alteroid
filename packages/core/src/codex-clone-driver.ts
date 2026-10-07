import type { AgentEvent } from './agent-events.js';
import type {
  AgentCloneDriver,
  AgentCloneSession,
  AgentCloneSessionSpec,
} from './agent-clone-session.js';
import type { AgentManagerSessionSpec, AgentPermissionDecision } from './agent-session.js';
import {
  openCodexSession,
  type CodexManagerDriverOptions,
  type CodexSession,
} from './codex-manager-driver.js';
import type { McpServers } from './mcp-servers.js';
import { MCP_SERVER_NAME } from './tools.js';

const CLONE_TOOLS_NAME = MCP_SERVER_NAME;

// 許可の代用を作らない: クローンは承認の能力を持たないため、常に拒否する
export function denyEveryApproval(): AgentPermissionDecision {
  return {
    behavior: 'deny',
    message:
      'クローンを Codex で動かすときは承認の能力を持たない（approvalPolicy=never で走らせている）。' +
      '承認が要る操作はここでは許可できない',
  };
}

export function toCodexCloneMcpServers(spec: {
  tools: AgentCloneSessionSpec['tools'];
  externalMcpServers: McpServers;
}): McpServers {
  if (spec.tools.kind !== 'stdio') {
    throw new Error(
      'Codex のクローンはクローンの道具を stdio の中継でしか受け取れない（inproc は渡せない）',
    );
  }
  const own: McpServers[string] = {
    type: 'stdio',
    command: spec.tools.command,
    args: spec.tools.args,
    env: spec.tools.env,
  };
  return { ...spec.externalMcpServers, [CLONE_TOOLS_NAME]: own };
}

export function toCodexSessionSpec(spec: AgentCloneSessionSpec): AgentManagerSessionSpec {
  return {
    ...(spec.resume === null ? {} : { resume: spec.resume }),
    input: spec.input,
    model: spec.model,
    // Claude の帯の名前を Codex へ渡さない: 人間が ALTEROID_CLONE_MODEL を置いたときだけモデルを渡す
    modelPlaced: spec.modelPlaced === true,
    // spec.permissionMode を読まない: Codex に Claude の auto に当たるものが無く、常に approvalPolicy=never で走らせるため
    permissionMode: 'bypassPermissions',
    systemPromptAppend: spec.systemPrompt,
    workerAgentName: '',
    workerPrompt: '',
    workerModel: '',
    cwd: spec.cwd ?? process.cwd(),
    env: spec.env,
    managerAutoMemoryEnabled: false,
    mcpServers: toCodexCloneMcpServers(spec),
    sessionLog: { append: async () => undefined, load: async () => null },
    onPermission: async () => denyEveryApproval(),
    ...(spec.onNote === undefined ? {} : { onNote: spec.onNote }),
    onPreToolUse: spec.onPreToolUse,
    onPermissionDenied: async () => ({ kind: 'no-retry' }),
    onPostToolUse: async (record) => {
      await spec.onPostToolUse(record);
      return { kind: 'continue' };
    },
    onPostToolUseFailure: spec.onPostToolUseFailure,
    onPreCompact: spec.onPreCompact,
    onUserPromptSubmit: () => undefined,
    onSubagentStop: async (record) => {
      await spec.onSubagentStop(record);
      return { kind: 'continue' };
    },
    onStop: () => undefined,
  };
}

class CodexCloneSession implements AgentCloneSession {
  readonly #session: CodexSession;

  constructor(session: CodexSession) {
    this.#session = session;
  }

  readEvents(onEvent: (event: AgentEvent) => Promise<void>): Promise<void> {
    return this.#session.readEvents(onEvent);
  }

  interrupt(): Promise<unknown> {
    return this.#session.interrupt();
  }

  close(): void {
    this.#session.close();
  }

  contextUsage(): ReturnType<CodexSession['contextUsage']> {
    return this.#session.contextUsage();
  }

  sessionModelUsage(): ReturnType<CodexSession['sessionModelUsage']> {
    return this.#session.sessionModelUsage();
  }
}

export class CodexCloneDriver implements AgentCloneDriver {
  readonly providerId = 'codex';
  // inproc を渡せない: Codex は別プロセスで、自分のプロセスの中の MCP サーバを持てないため
  readonly requiredToolsTransport = 'stdio';
  readonly providesContextUsage = false;
  readonly #options: CodexManagerDriverOptions;

  constructor(options: CodexManagerDriverOptions = {}) {
    this.#options = options;
  }

  open(spec: AgentCloneSessionSpec): AgentCloneSession {
    return new CodexCloneSession(openCodexSession(toCodexSessionSpec(spec), this.#options));
  }

  // distill を定義しない: 圧縮の前に割り込む口が Codex に無いため
}
