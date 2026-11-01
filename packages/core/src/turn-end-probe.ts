/** 生ログは MB 級になりうるので、全行を `JSON.parse` しない。 */
export const TURN_END_PROBE_CHARS = 200_000;

const TURN_END_TAIL_EXCERPT = 400;

/**
 * **判定ではない。** 事実（見つかった行の `timestamp` / `stop_reason` / 本文の末尾）だけを持ち、
 * 「報告が届いていない」「止まっている」という結論は持たない。
 */
export interface TurnEndProbe {
  /** 無ければ `undefined`（古い形式は省略しうる）。 */
  timestamp: string | undefined;
  stopReason: string;
  /** 無ければ空文字。 */
  tail: string;
}

/**
 * **`tools.ts` の `rawAssistantText` と中身はほぼ同じだが、意図的に別関数にしてある。**
 * 統合すると2つの探りが結合し、片方の規則を直したときにもう片方が黙って追随する。
 */
function turnEndBodyOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * **何も切らない・殺さない・止めない純関数**: 呼び出し側が結果で `status` を書き換えたり委譲を abort したりしない。
 *
 * **`tools.ts` の `probeLastAssistantUtterance` を流用しない。** あちらは本文が空の行を飛ばすので、
 * 思考だけ・道具だけの行を読み飛ばして1つ前のターンの `end_turn` まで遡り、働いている最中を終わりと誤る
 * （生ログの再生で `end_turn` と言う68時点のうち37が偽陽性）。こちらは最初に見つかった assistant 行を無条件に答えとする。
 * `stop_reason` が文字列でなければ `undefined`（分からないものを症状に化けさせない）。
 */
export function probeTurnEnd(transcript: string): TurnEndProbe | undefined {
  const truncated = transcript.length > TURN_END_PROBE_CHARS;
  const window = truncated ? transcript.slice(-TURN_END_PROBE_CHARS) : transcript;
  const rawLines = window.split('\n');
  const lines = truncated ? rawLines.slice(1) : rawLines;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; stop_reason?: unknown };
    };
    if (record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;

    // **本文の有無でここを飛ばさない。**
    const stopReason = record.message?.stop_reason;
    if (typeof stopReason !== 'string') return undefined;
    if (stopReason === 'tool_use') return undefined;

    const body = turnEndBodyOf(record.message?.content);
    return {
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      stopReason,
      tail: body.length > TURN_END_TAIL_EXCERPT ? body.slice(-TURN_END_TAIL_EXCERPT) : body,
    };
  }
  return undefined;
}

/**
 * 生ログの値をそのまま写すだけ。`name` は文字列でない形がありうるので `optional`:
 * 「不明」のような文字列を作って埋めない（取れない軸に0の行を作らない）。
 */
export interface PendingToolUse {
  id: string;
  name?: string;
}

/**
 * **判定ではない。時刻の閾値も持たない。** 「止まっている」という結論は持たず、読む側
 * （`tools.ts` の `describeToolUseStall`）が `record.waiting` と突き合わせて出す。
 */
interface ToolUseStallProbe {
  /** **この値で経過時間を計算しない。** 何分経ったかを判定するのは人間である。 */
  timestamp: string | undefined;
  /** **必ず1件以上**（0件なら `probeToolUseStall` は `undefined` を返す）。 */
  pending: PendingToolUse[];
}

/** **`id` が文字列でないブロックは落とす。** 突き合わせの鍵が無いものを「応答が来ていない」と言うと、鍵の無さが症状に化ける。 */
function toolUsesOf(content: unknown): PendingToolUse[] {
  if (!Array.isArray(content)) return [];
  const found: PendingToolUse[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typed.type !== 'tool_use') continue;
    if (typeof typed.id !== 'string') continue;
    found.push({
      id: typed.id,
      ...(typeof typed.name === 'string' ? { name: typed.name } : {}),
    });
  }
  return found;
}

/**
 * **行の `type` も `isSidechain` も見ない。** 突き合わせは `id` で行うので、絞ると
 * 「応答は在るのに拾えなかった」偽陽性が増える。拾い漏らさない側へ倒す。
 */
function collectToolResultIds(content: unknown, sink: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; tool_use_id?: unknown };
    if (typed.type !== 'tool_result') continue;
    if (typeof typed.tool_use_id !== 'string') continue;
    sink.add(typed.tool_use_id);
  }
}

/**
 * **何も切らない・殺さない・止めない純関数。** `probeTurnEnd` と同じ行を見て重ならない範囲を担当する
 * ので、2つの探りは同時には立たない。`stop_reason: 'tool_use'` だけでは何も決まらないので、
 * 対応する `tool_result` が無いことまでを事実として返し、`record.waiting` との突き合わせは `describeToolUseStall` が行う。
 *
 * **時刻の閾値を置かない**: 閾値を置くとそれより短い窓の症状が出力から消える。
 *
 * **「道具を回しているなら、その応答を待っているのはデーモンのはず」という前提は、確認が `canUseTool` を通る道具にしか成り立たない。**
 * 既定の `permissionMode: 'auto'` では `Bash`・前景の `Agent`・`WebFetch` などは `canUseTool` を通らず、
 * `record.waiting` が空でも矛盾ではない（ただ実行中）。この関数は生の事実だけを返し、分岐は読む側
 * （`manager-activity.ts` の `classifyManagerActivity`、`isDaemonAnsweredTool`）が持つ。
 *
 * 「前の行」の `tool_result` は別の（済んだ）呼び出しへの応答なので、採用した行より後ろだけを見る。
 */
export function probeToolUseStall(transcript: string): ToolUseStallProbe | undefined {
  const truncated = transcript.length > TURN_END_PROBE_CHARS;
  const window = truncated ? transcript.slice(-TURN_END_PROBE_CHARS) : transcript;
  const rawLines = window.split('\n');
  const lines = truncated ? rawLines.slice(1) : rawLines;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; stop_reason?: unknown };
    };
    if (record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;

    if (record.message?.stop_reason !== 'tool_use') return undefined;

    const pending = toolUsesOf(record.message?.content);
    if (pending.length === 0) return undefined;

    const answered = new Set<string>();
    for (let after = index + 1; after < lines.length; after += 1) {
      const laterLine = lines[after]!.trim();
      if (laterLine.length === 0) continue;
      let laterEntry: unknown;
      try {
        laterEntry = JSON.parse(laterLine);
      } catch {
        continue;
      }
      const later = laterEntry as { message?: { content?: unknown } };
      collectToolResultIds(later.message?.content, answered);
    }

    const unanswered = pending.filter((item) => !answered.has(item.id));
    if (unanswered.length === 0) return undefined;

    return {
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      pending: unanswered,
    };
  }
  return undefined;
}
