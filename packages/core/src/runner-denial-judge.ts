import { randomUUID } from 'node:crypto';

import type { AgentPermissionDeniedDecision, AgentPermissionDeniedRecord } from './agent-hooks.js';
import type { ClassifierDenialStreaks } from './classifier-denial-streak.js';
import { buildDenialInputHead, matchInputOf } from './denial-input-head.js';
import type { RecentMap } from './recent.js';
import {
  ONE_SHOT_ALLOW_TTL_MS,
  actorOf,
  digestOf,
  oneShotActorOf,
  oneShotAllowKey,
} from './runner-actor-keys.js';
import {
  buildDenialAllowedButDeniedNote,
  buildDenialEntryNote,
  buildDenialNoMatchKeyNote,
  buildDenialNoToolNameNote,
  buildDenialStreakNote,
} from './runner-permission-denied-text.js';

/**
 * `RunnerSession` が口として渡すもの。9 本。
 * 値で渡すのは作った後に変わらない欄（`managerId`・`env`。`RunnerSession` では `readonly`）と、参照で渡す器（`denialStreaks`・`RecentMap` 2 本）だけで、
 * `RecentMap` は参照のまま渡す（写すと、`RunnerSession` の他の経路が書いた控えをここが見られず、`RunnerDenialNotice` が書いた控えを見落とす）。
 * 関数の口は async の皮で包まずに渡す（`judge` は同期で、`await` を足すと呼び元の `#onPermissionDenied` の周回が動くため）。
 */
interface RunnerDenialJudgePorts {
  /** `RunnerSession#settleSessionAllowRuleUse`（一時規則の決着）。同期。 */
  settleSessionAllowRuleUse: (
    toolUseId: string | undefined,
    outcome: { kind: 'passed'; toolFailed: boolean } | { kind: 'denied'; via: string },
  ) => void;
  /** `RunnerSession#sweepExpiredSessionAllowRules`（期限切れの一時規則を掃く）。同期。 */
  sweepExpiredSessionAllowRules: () => void;
  /** `RunnerSession#denialStreaks`（連続拒否の数え）。参照。 */
  denialStreaks: Pick<ClassifierDenialStreaks, 'noteDenial' | 'view'>;
  /** `RunnerSession#note`（担当の note を出す）。同期。 */
  note: (text: string) => void;
  /** `RunnerSession#id`（作った後に変わらない）。 */
  managerId: string;
  /** `RunnerSession#env`（作った後に変わらない）。 */
  env: NodeJS.ProcessEnv;
  /** `RunnerSession#vaultValues`（資格の正本の値。呼ぶたびに読む）。同期。 */
  vaultValues: () => string[];
  /** `RunnerSession#oneShotAllowedToolUses`（1 回だけの許可で allow を返した呼び出しの控え）。参照。ここは読むだけ。 */
  oneShotAllowedToolUses: RecentMap<{
    readonly actor: string;
    readonly tool: string;
    readonly key: string;
    readonly at: number;
  }>;
  /** `RunnerSession#allowedButDenied`（allow を返した撃ち直しがまた拒否された呼び出しの鍵）。参照。ここは読むだけ。 */
  allowedButDenied: RecentMap<{ readonly expiresAt: number }>;
}

/** `judge` の結果。`decided` は呼び元がそのまま返す決定、`continue` は後半（再送・確認を積む・待ち）が使う値。 */
export type RunnerDenialJudgement =
  | { readonly kind: 'decided'; readonly decision: AgentPermissionDeniedDecision }
  | {
      readonly kind: 'continue';
      readonly actor: string;
      readonly toolName: string;
      readonly streakActor: string;
      readonly inputHead: string | undefined;
      readonly permitKey: string;
      readonly id: string;
    };

/**
 * `RunnerSession#onPermissionDenied` の同期の前半を受け持つ側。切り出し前の `RunnerSession` から切り出した。振る舞いは変えていない。
 * 自前の欄は無い。`judge` は同期・戻り値は判別付きの値のまま保つ（`await` を足すと呼び元の周回が動く）。
 */
export class RunnerDenialJudge {
  readonly #settleSessionAllowRuleUse: RunnerDenialJudgePorts['settleSessionAllowRuleUse'];
  readonly #sweepExpiredSessionAllowRules: RunnerDenialJudgePorts['sweepExpiredSessionAllowRules'];
  readonly #denialStreaks: RunnerDenialJudgePorts['denialStreaks'];
  readonly #note: RunnerDenialJudgePorts['note'];
  readonly #id: RunnerDenialJudgePorts['managerId'];
  readonly #env: RunnerDenialJudgePorts['env'];
  readonly #vaultValues: RunnerDenialJudgePorts['vaultValues'];
  readonly #oneShotAllowedToolUses: RunnerDenialJudgePorts['oneShotAllowedToolUses'];
  readonly #allowedButDenied: RunnerDenialJudgePorts['allowedButDenied'];

  constructor(ports: RunnerDenialJudgePorts) {
    this.#settleSessionAllowRuleUse = ports.settleSessionAllowRuleUse;
    this.#sweepExpiredSessionAllowRules = ports.sweepExpiredSessionAllowRules;
    this.#denialStreaks = ports.denialStreaks;
    this.#note = ports.note;
    this.#id = ports.managerId;
    this.#env = ports.env;
    this.#vaultValues = ports.vaultValues;
    this.#oneShotAllowedToolUses = ports.oneShotAllowedToolUses;
    this.#allowedButDenied = ports.allowedButDenied;
  }

  // 鍵が作れない入力はクローンへ確認を上げず `no-retry` で終える: 一致させる鍵が無いと撃ち直しを安全に特定できないため
  // 鍵は入力全体（`matchInputOf`）で作る: `command` だけだと `run_in_background` 等だけが違う撃ち直しにまで許可が及ぶため
  judge(record: AgentPermissionDeniedRecord): RunnerDenialJudgement {
    const actor = actorOf(this.#id, record);
    const toolName = record.toolName;

    // 道具名や入力の鍵が取れない回より前に置く: 一時規則に当たった呼び出しの拒否は、この先で早く返る回でも決着させるため（#4905）
    this.#settleSessionAllowRuleUse(record.toolUseId, { kind: 'denied', via: 'PermissionDenied' });
    this.#sweepExpiredSessionAllowRules();

    // 道具名や入力の鍵が取れない回も数える: 分類器が止めた事実は変わらず、CLI の数えも進むため
    const streakActor = record.agentId ?? 'manager';
    if (this.#denialStreaks.noteDenial(streakActor, record.reason)) {
      const view = this.#denialStreaks.view(streakActor);
      this.#note(buildDenialStreakNote(actor, streakActor, view));
    }

    this.#note(buildDenialEntryNote(actor, toolName, record.toolUseId, record.reason));

    if (toolName === undefined) {
      this.#note(buildDenialNoToolNameNote(actor));
      return { kind: 'decided', decision: { kind: 'no-retry' } };
    }

    const matchInput = matchInputOf(record.toolInput);
    if (matchInput === undefined) {
      this.#note(buildDenialNoMatchKeyNote(actor, toolName));
      return { kind: 'decided', decision: { kind: 'no-retry' } };
    }

    const inputHead = buildDenialInputHead(record.toolInput, this.#env, this.#vaultValues());
    const permitKey = oneShotAllowKey(
      oneShotActorOf(this.#id, record),
      toolName,
      digestOf(matchInput),
    );
    const id = record.toolUseId ?? randomUUID();

    // allow を返した撃ち直しがそれでも拒否された呼び出しは、確認を重ねて上げずに止める: 上げても同じ入力は通らないことがあり、確認が1件ずつ積み上がるため（#4904）
    // 拒否の合図と `#noteDenial` のどちらが先に届いても拾えるよう、控え済みの鍵と、まだ決着していない allow の撃ち直しの両方を見る
    const nowMs = Date.now();
    const pendingRetry = this.#oneShotAllowedToolUses
      .entries()
      .some(([, use]) => use.key === permitKey && use.at + ONE_SHOT_ALLOW_TTL_MS > nowMs);
    const deniedAgain = this.#allowedButDenied.get(permitKey);
    if (pendingRetry || (deniedAgain !== undefined && deniedAgain.expiresAt > nowMs)) {
      this.#note(buildDenialAllowedButDeniedNote(actor, toolName));
      return { kind: 'decided', decision: { kind: 'no-retry' } };
    }

    return { kind: 'continue', actor, toolName, streakActor, inputHead, permitKey, id };
  }
}
