import { stdout } from './terminal-out.js';

import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
} from '@alteroid/core/cli-light';
import type { InferResponseType } from 'hono/client';

import { createClient, type DaemonClient } from './client.js';
import { describeFailedResponse } from './format.js';
import { redactBody } from './redact.js';
import { resolveTarget } from './target.js';

export async function droppedCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.dropped.$get();
  if (!response.ok) {
    throw new Error(
      await describeFailedResponse(
        `握り潰しの跡を読めませんでした（HTTP ${String(response.status)}）`,
        response,
        target,
      ),
    );
  }
  stdout.write(`${renderDropped(await response.json())}\n`);
}

// デーモンの応答の型から導く（型付きクライアントの `InferResponseType`）: 手で写さない。欄が増えたら tsc が教える
type DroppedView = InferResponseType<DaemonClient['dropped']['$get'], 200>;

export function renderDropped(view: DroppedView): string {
  const lines: string[] = [
    describeDroppedTraceOrigin(view.origin),
    '',
    `帳面が数え始めた時刻: ${view.since}`,
    `件数: ${view.total}（${describeDroppedTraceRetention(view.limit)}）`,
    '',
  ];
  if (view.total === 0) {
    lines.push(describeDroppedTraceEmpty());
    return lines.join('\n');
  }
  // 伏せる: 跡の行は理由の文を含むため（Web の握り潰しの跡と揃える）
  lines.push(...view.traces.map((trace) => redactBody(trace)));
  return lines.join('\n');
}
