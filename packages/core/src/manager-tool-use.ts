import {
  bashCommandLooksLikeGitBranchCreate,
  bashCommandLooksLikeGitPush,
} from './bash-git-command.js';
import type { ManagerRecord } from './manager.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';

/**
 * `Pool` が口として渡すもの。いずれも呼ぶたびに `Pool` の側で引く（時計は構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
interface ManagerToolUseReceiverPorts {
  /** `Pool#nowIso` を束ねたもの（器の時計を直に読まない）。 */
  nowIso: () => string;
  /** `Pool#journal`（日誌へ書く）。 */
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#observeUnpushedWorkOnce`（`report` の処理も使う共有。待たずに切り離す。同期）。 */
  observeUnpushedWorkOnce: (managerId: string, source: 'report' | 'tool_use') => void;
}

/**
 * 担当の出来事 `tool_use` を受け取る側（`Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 書くのは引数の `record`（`lastToolSettledAt`。読み手は `denial-renotify.ts`）だけ。
 */
export class ManagerToolUseReceiver {
  readonly #ports: ManagerToolUseReceiverPorts;

  constructor(ports: ManagerToolUseReceiverPorts) {
    this.#ports = ports;
  }

  /** 担当の出来事 `tool_use` の1件を処理する（`Pool#handleEvent` が振り分ける）。 */
  async handle(
    event: Extract<RunnerEvent, { type: 'tool_use' }>,
    record: ManagerRecord,
  ): Promise<void> {
    record.lastToolSettledAt = this.#ports.nowIso();
    await this.#ports.journal({
      type: 'tool_use',
      actor: event.actor,
      tool: event.tool,
      input: event.input,
    });
    // 検出は分類器ではなく単純な正規表現で、誤検出を許容する: 害は観測が1回余分になるだけ（読み取りで多重投げも止まる）。見逃すと報告より前に落ちた委譲の枝名が残らない穴が開く。
    // 例外で `tool_use` の処理を止めない。
    try {
      if (event.tool === 'Bash') {
        const toolInput = event.input as { command?: unknown } | null | undefined;
        const command = toolInput?.command;
        if (
          typeof command === 'string' &&
          (bashCommandLooksLikeGitPush(command) || bashCommandLooksLikeGitBranchCreate(command))
        ) {
          this.#ports.observeUnpushedWorkOnce(event.managerId, 'tool_use');
        }
      }
    } catch {
      // tool_use の処理を巻き添えにしないための保険。
    }
    return;
  }
}
