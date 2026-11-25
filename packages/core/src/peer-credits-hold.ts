import type { AgentProviderId } from './agent-ports.js';

/** 残高切れで閉じた peer を、1度開き直して試すまでの待ち。 */
export const PEER_CREDITS_RETRY_MS = 30 * 60_000;

const DETAIL_LIMIT = 200;

interface Held {
  readonly since: number;
  readonly reopenAt: number;
  readonly detail: string;
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DETAIL_LIMIT ? flat : `${flat.slice(0, DETAIL_LIMIT)}…`;
}

/**
 * 残高切れで閉じている peer の状態。時計は引数で受ける。
 * 「閉じている」と「エピソード中（クローンへ知らせ済み）」は別に持つ: 開き直して試した先でまた落ちても、知らせは繰り返さないため。
 */
export class PeerCreditsHold {
  readonly #held = new Map<AgentProviderId, Held>();
  readonly #episode = new Set<AgentProviderId>();

  hold(provider: AgentProviderId, detail: string, nowMs: number): { notify: boolean } {
    this.#held.set(provider, {
      since: nowMs,
      reopenAt: nowMs + PEER_CREDITS_RETRY_MS,
      detail: excerpt(detail),
    });
    const notify = !this.#episode.has(provider);
    this.#episode.add(provider);
    return { notify };
  }

  reopenDue(nowMs: number): boolean {
    let any = false;
    for (const [provider, held] of this.#held) {
      if (held.reopenAt <= nowMs) {
        this.#held.delete(provider);
        any = true;
      }
    }
    return any;
  }

  nextReopenAt(): number | undefined {
    let next: number | undefined;
    for (const held of this.#held.values()) {
      if (next === undefined || held.reopenAt < next) next = held.reopenAt;
    }
    return next;
  }

  succeeded(provider: AgentProviderId): boolean {
    const had = this.#held.delete(provider);
    const inEpisode = this.#episode.delete(provider);
    return had || inEpisode;
  }

  reset(): boolean {
    const any = this.#held.size > 0 || this.#episode.size > 0;
    this.#held.clear();
    this.#episode.clear();
    return any;
  }

  closed(): { provider: AgentProviderId; reason: string }[] {
    return [...this.#held].map(([provider, held]) => ({
      provider,
      reason:
        `残高切れで閉じている（${isoUtc(held.since)} に Codex が「${held.detail}」で断った）。` +
        `人間が Codex のワークスペースに残高を足すまで通らない。` +
        `${isoUtc(held.reopenAt)} 以降に1度開き直して試す（資格を置き直しても開き直す）`,
    }));
  }
}
