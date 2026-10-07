import type { InboxEvent, JobStatus } from './schema.js';

// この述語の戻り値で行を消さない: 決めるのは添える言葉だけで、消すなら `inbox-staleness.ts` の側で合図の性質だけで決めるため
// `unclaimed` と `unknowable` を `unchanged` に混ぜない: 「変わっていない」と「確かめられなかった」が読む側から同じ顔になるため
export type InboxEventValidity =
  | { readonly kind: 'unchanged'; readonly status: JobStatus }
  | { readonly kind: 'changed'; readonly claimed: JobStatus; readonly now: JobStatus }
  | { readonly kind: 'unclaimed' }
  | { readonly kind: 'unknowable'; readonly claimed: JobStatus; readonly detail: string };

export function statusValidity(
  claimed: JobStatus | undefined,
  now: { readonly status: JobStatus } | { readonly detail: string },
): InboxEventValidity {
  // 名乗っていない回に既定値を作らない: 取れない軸に 0 の行を作ることになるため
  if (claimed === undefined) return { kind: 'unclaimed' };
  if ('detail' in now) return { kind: 'unknowable', claimed, detail: now.detail };
  return now.status === claimed
    ? { kind: 'unchanged', status: claimed }
    : { kind: 'changed', claimed, now: now.status };
}

export function inboxEventValidity(
  event: InboxEvent,
  now: { readonly status: JobStatus } | { readonly detail: string },
): InboxEventValidity {
  switch (event.type) {
    case 'manager_message':
      return statusValidity(event.statusAtDelivery, now);
    case 'human_message':
    case 'human_answer':
    case 'external':
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return { kind: 'unclaimed' };
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（validity）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// `unclaimed` には1行も足さない: 言うことが無い回に足すと、毎ターンの床が伸びるだけのため
// 判定も助言もしない: 「こうしろ」はクローンが決めることで、ここが言えるのは測った事実だけのため
export function describeValidity(
  validity: InboxEventValidity,
  managerId: string,
  subject: string = '受信箱へ積まれた',
): string {
  switch (validity.kind) {
    case 'changed':
      return (
        `⚠️ この報告が${subject}時点で ${managerId} は \`${validity.claimed}\` でしたが、` +
        `この断り書きを組んだ時点では \`${validity.now}\` です（報告が名乗った前提は動いています。` +
        `中身が要らなくなったとは限りません）。`
      );
    case 'unknowable':
      return (
        `⚠️ この報告が${subject}時点で ${managerId} は \`${validity.claimed}\` でしたが、` +
        `この断り書きを組む時点の状態を引けませんでした（${validity.detail}）。` +
        `**「変わっていない」ではなく「確かめられなかった」です。**`
      );
    case 'unchanged':
    case 'unclaimed':
      return '';
    default: {
      const exhaustive: never = validity;
      throw new Error(`未知の validity: ${JSON.stringify(exhaustive)}`);
    }
  }
}
