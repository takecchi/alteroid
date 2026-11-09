import type { AgentPermissionDenial } from './agent-events.js';
import { denialInputShape, type DeniedRecord } from './denial-shape.js';
import type { RecentMap } from './recent.js';
import { ONE_SHOT_ALLOW_TTL_MS, actorOf, brief, digestOf } from './runner-actor-keys.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `RunnerSession` が口として渡すもの。9 本。
 * 値で渡すのは作った後に変わらない欄（`RecentMap` 4 本と `managerId`。`RunnerSession` では `readonly`）だけで、`RecentMap` は参照のまま渡す（写すと、
 * `RunnerSession` の他の経路が書いた控えをここが見られず、ここが書いた控えを他の経路が見られなくなる）。
 * 関数の口は async の皮で包まずに渡す（`noteDenial` は同期で、`await` を足すと呼び元の `for`（`#applyTurnEnded`）の 1 周ごとの `permission_denied` の送出の周回が動くため）。
 */
interface RunnerDenialNoticePorts {
  /** `RunnerSession#settleWorkerTool`（作業者の道具の見張りの決着）。同期。 */
  settleWorkerTool: (toolUseId: string) => void;
  /** `RunnerSession#settleSessionAllowRuleUse`（一時規則の決着。`denied` のときの note もこの中）。同期。 */
  settleSessionAllowRuleUse: (
    toolUseId: string | undefined,
    outcome: { kind: 'passed'; toolFailed: boolean } | { kind: 'denied'; via: string },
  ) => void;
  /** `RunnerSession#oneShotAllowedToolUses`（1 回だけの許可で allow を返した呼び出しの控え。引いたら消す）。参照。 */
  oneShotAllowedToolUses: RecentMap<{
    readonly actor: string;
    readonly tool: string;
    readonly key: string;
    readonly at: number;
  }>;
  /** `RunnerSession#allowedButDenied`（allow を返した撃ち直しがまた拒否された呼び出しの鍵。ここが書く）。参照。 */
  allowedButDenied: RecentMap<{ readonly expiresAt: number }>;
  /** `RunnerSession#preToolInputHeads`（PreToolUse で控えた入力の先頭。引いたら消す）。参照。 */
  preToolInputHeads: RecentMap<string>;
  /** `RunnerSession#denied`（「同じ拒否の 2 度目」を見分ける控え。ここが書く）。参照。 */
  denied: RecentMap<DeniedRecord>;
  /** `RunnerSession#note`（担当の note を出す）。同期。 */
  note: (text: string) => void;
  /** `RunnerSession#emit`（`permission_denied` を降ろす）。同期。 */
  emit: (event: RunnerEvent) => void;
  /** `RunnerSession#id`（作った後に変わらない）。 */
  managerId: string;
}

/**
 * `RunnerSession#noteDenial`（拒否の知らせの決着と `permission_denied` の送出）を受け持つ側。切り出し前の `RunnerSession` から切り出した。振る舞いは変えていない。
 * 自前の欄は無い（控えは `RunnerSession` が持つ `RecentMap` を参照で受ける）。`noteDenial` は同期・戻り値 void のまま保つ。
 */
export class RunnerDenialNotice {
  readonly #settleWorkerTool: RunnerDenialNoticePorts['settleWorkerTool'];
  readonly #settleSessionAllowRuleUse: RunnerDenialNoticePorts['settleSessionAllowRuleUse'];
  readonly #oneShotAllowedToolUses: RunnerDenialNoticePorts['oneShotAllowedToolUses'];
  readonly #allowedButDenied: RunnerDenialNoticePorts['allowedButDenied'];
  readonly #preToolInputHeads: RunnerDenialNoticePorts['preToolInputHeads'];
  readonly #denied: RunnerDenialNoticePorts['denied'];
  readonly #note: RunnerDenialNoticePorts['note'];
  readonly #emit: RunnerDenialNoticePorts['emit'];
  readonly #id: RunnerDenialNoticePorts['managerId'];

  constructor(ports: RunnerDenialNoticePorts) {
    this.#settleWorkerTool = ports.settleWorkerTool;
    this.#settleSessionAllowRuleUse = ports.settleSessionAllowRuleUse;
    this.#oneShotAllowedToolUses = ports.oneShotAllowedToolUses;
    this.#allowedButDenied = ports.allowedButDenied;
    this.#preToolInputHeads = ports.preToolInputHeads;
    this.#denied = ports.denied;
    this.#note = ports.note;
    this.#emit = ports.emit;
    this.#id = ports.managerId;
  }

  // `#progressed` を立てない: 拒否は手が動いた印ではなく、立てると resume が効かず終わった回を「もう作業した」と誤認して生ログからの作り直しを止めるため
  noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): void {
    const tool = denial.tool ?? '(不明な道具)';
    const input = denial.input;
    if (typeof denial.toolUseId === 'string') this.#settleWorkerTool(denial.toolUseId);
    // フックと拒否の知らせのどちらが先に届いても決着させる（先に届いた方だけが note を出す。#4905）
    this.#settleSessionAllowRuleUse(denial.toolUseId, { kind: 'denied', via });

    // SDK が付けてきた `denial.toolUseId` で引く: 下で組む代用の `toolUseId` は実在の id ではなく、無関係な一致が起きうるため
    if (typeof denial.toolUseId === 'string') {
      const funneled = this.#oneShotAllowedToolUses.get(denial.toolUseId);
      if (funneled !== undefined) {
        this.#oneShotAllowedToolUses.delete(denial.toolUseId);
        // 同じ呼び出しの次の拒否では確認を上げない（#4904）。期限は許可と同じ: 過ぎれば別の機会として扱うため
        this.#allowedButDenied.set(funneled.key, {
          expiresAt: funneled.at + ONE_SHOT_ALLOW_TTL_MS,
        });
        this.#note(
          `1回だけの許可（issue #1105 P1、${funneled.actor}・${funneled.tool}）で allow を` +
            `返した呼び出しが、それでも拒否された（合図の出所: ${via}）。分類器がこの allow を` +
            `分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか` +
            `（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いて` +
            `いない可能性がある。分類器が迂回・敵対の型で止めた呼び出しは、クローンの allow や` +
            `担当の伝言を人間の確認と見なさないため、同じ入力の撃ち直しは通らないことがある。` +
            `同じ呼び出しへの確認は重ねて上げない（#4904）。`,
        );
      }
    }

    // 道具名だけで束ねない: 「同じ拒否の2度目」と「live を見逃した初出」が潰れるため（`tool_use_id` は SDK の型で必須なのでこの経路はいま踏まれない）
    // 入力そのものを鍵に混ぜない: 鍵は `onForget` が日誌へそのまま並べ、道具の入力にはトークンが入りうるため
    const toolUseId = denial.toolUseId ?? `${tool}:${digestOf(brief(input, 120))}`;
    // 引いたら消す: 生の入力を持ち回っていないので、同じ tool_use_id の拒否がもう一度来ても作り直せないため
    const inputHead = this.#preToolInputHeads.get(toolUseId);
    if (inputHead !== undefined) this.#preToolInputHeads.delete(toolUseId);
    // `has` だけで弾かない: 入力を持つのは `via: 'result'` だけで、弾くと入力を持つ authoritative な記録が捨てられ日誌に「何を実行しようとしたか」が残らないため
    // `permission_denied` をもう一度降ろさず既存の `note` で足す: デーモンは拒否を1件ずつ数えており二重計上で escalation が段を跨いで飛ぶため。新しい種別を足すとまだ知らないデーモンの `safeParse` が落ちる
    const seen = this.#denied.get(toolUseId);
    if (seen !== undefined) {
      if (seen.input || input === undefined) return;
      this.#denied.set(toolUseId, { input: true });
      const shape = denialInputShape(input);
      if (shape !== undefined) {
        this.#note(
          `先に降ろした ${tool} の拒否について、ターン終わりの記録（via: result）に` +
            `入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: ${shape}`,
        );
      }
      return;
    }
    this.#denied.set(toolUseId, { input: input !== undefined });
    // 文字列であることを確かめてからしか載せない: 型を保証しないまま `z.string().optional()` へ渡すと、SDK の型変化で数値や null が黙って通るため。無いものは作り物を出さずキーごと省く
    // `actor` は `via: 'live'` のときだけ載せる: `result` 側の SDK 型には `agent_id` が無く、「マネージャーだった」と決めつけないため
    // `agent_type` を作り物で埋めない: SDK の型に無い情報のため
    const agentId = denial.agentId;
    const agentType = denial.agentType;
    const actor = via === 'live' ? actorOf(this.#id, { agentId, agentType }) : undefined;
    this.#emit({
      type: 'permission_denied',
      managerId: this.#id,
      toolUseId,
      tool,
      input,
      via,
      ...(actor === undefined ? {} : { actor }),
      ...(denial.reason === undefined ? {} : { reason: denial.reason }),
      ...(denial.reasonType === undefined ? {} : { reasonType: denial.reasonType }),
      ...(denial.message === undefined ? {} : { message: denial.message }),
      // `input` の欄には詰めない: `runner-protocol.ts` の `input` の doc が禁じているため（別の任意欄に載せる）
      ...(inputHead === undefined ? {} : { inputHead }),
    });
  }
}
