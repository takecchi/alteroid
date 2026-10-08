import type { CommitmentList } from './store.js';

export type SupersededDecision =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'superseded';
      readonly reports: number;
      readonly latestAt: string;
      readonly uncertain: string | undefined;
    }
  | { readonly kind: 'uncountable'; readonly detail: string };

export function countSupersedingReports(input: {
  readonly list: CommitmentList;
  readonly managerId: string;
  // 畳む前の形で受け取る: 呼び出し側で畳むと読めなかった回に基準が -Infinity になり、全報告が「後続」に見えるため
  readonly afterAts: readonly string[];
  readonly excludeIds: ReadonlySet<string>;
}): SupersededDecision {
  const { list, managerId, afterAts, excludeIds } = input;

  let afterMs = -Infinity;
  for (const at of afterAts) {
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed)) {
      return { kind: 'uncountable', detail: 'いま配っている合図の受け取り時刻が読めない' };
    }
    if (parsed > afterMs) afterMs = parsed;
  }
  if (afterMs === -Infinity) {
    return { kind: 'uncountable', detail: 'いま配っている合図に受け取り時刻が1つも無い' };
  }

  const candidates = list.entries.filter(
    (entry) =>
      entry.origin === 'manager' &&
      entry.source === managerId &&
      entry.body.startsWith('[report] ') &&
      !excludeIds.has(entry.id),
  );

  let unparsableAt = 0;
  let n = 0;
  let latestMs = -Infinity;
  let latestAt: string | undefined;
  for (const entry of candidates) {
    const parsed = Date.parse(entry.at);
    if (Number.isNaN(parsed)) {
      unparsableAt += 1;
      continue;
    }
    if (parsed > afterMs) {
      n += 1;
      if (parsed > latestMs) {
        latestMs = parsed;
        latestAt = entry.at;
      }
    }
  }

  const troubles: string[] = [];
  if (list.unreadable.length > 0) troubles.push(`読めない行が ${list.unreadable.length} 件`);
  if (list.trimmedClosed > 0)
    troubles.push(`保持上限を超えて物理削除された片付き行が累計 ${list.trimmedClosed} 件`);
  if (unparsableAt > 0) troubles.push(`受け取り時刻が壊れている行が ${unparsableAt} 件`);
  const uncertain = troubles.length === 0 ? undefined : troubles.join('・');

  // n >= 1 ではなく latestAt を条件にする: as で押し通すと undefined を渡せる穴が注釈だけで守られるため
  if (latestAt !== undefined) {
    return { kind: 'superseded', reports: n, latestAt, uncertain };
  }
  if (uncertain === undefined) return { kind: 'none' };
  return { kind: 'uncountable', detail: uncertain };
}

export function describeSuperseded(decision: SupersededDecision, managerId: string): string {
  if (decision.kind === 'none') return '';

  if (decision.kind === 'superseded') {
    return block([
      `⚠ **この委譲（${managerId}）からは、この合図より後に報告が ${decision.reports} 件届いている**` +
        `（最新: ${decision.latestAt}）。`,
      '⟹ **この報告の中身は既に古いかもしれない。** 手を動かす前に、その' +
        ` ${decision.reports} 件を先に読むこと（\`manager_list\` / \`commitment_list\`）。`,
      '⚠ ただし「新しい報告が在る」は「この報告が要らない」ではない —— 別の話題のこともある。' +
        '読むのは中身であって件数ではない。',
      ...(decision.uncertain === undefined
        ? []
        : [`⚠ **これより多い可能性がある**（${decision.uncertain}）。`]),
    ]);
  }

  return block([
    `⚠ **この委譲（${managerId}）の、この合図より後の報告を数えられなかった**（${decision.detail}）。`,
    'これは「0 件」ではなく「**数えられなかった**」である。要るなら `manager_list` / ' +
      '`commitment_list` を自分で呼ぶこと。',
  ]);
}

// 末尾の区切り（---）まで含めて返す: 呼び出し側で足すと、節を足すたびに #runTurn の連結にも手が要るため
function block(lines: readonly string[]): string {
  return [...lines, '', '---', ''].join('\n');
}
