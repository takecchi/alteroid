import type {
  ClonePromptSnapshot,
  PromptSnapshotContextUsage,
  PromptSnapshotMemoryDocument,
  SecretRedactor,
} from '@alteroid/core';
import type { z } from 'zod';

import type { selfPromptResponseSchema } from './openapi.js';

// `GET /self/prompt` の応答を、クローンのスナップショット（`CloneHost#promptSnapshot`）から組む。
// - 組む関数（`buildSelfPromptBody`）と走査して閉じる関数（`finalizeSelfPrompt`）を分ける。走査は応答を返す前の最後の1か所（`finalizeSelfPrompt`）に集約し、値の通り道を1本にする。
// - 取れない軸に 0 や空配列を置かない（`null` と `notice` の理由）。
// - 外部 MCP は名前と種別だけ（スナップショットがそもそも接続設定の値を持たない。`GET /mcp-servers` は値を含むので使わない）。

export type SelfPromptBody = z.infer<typeof selfPromptResponseSchema>;

type UnscannedBody = Omit<SelfPromptBody, 'secretScan'>;

// スナップショットは深く凍結した readonly の値。応答の型（zod 由来）は可変なので、写しを取って型を合わせる（凍結した値を応答の側へ共有しない）
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

const NOTICE_NO_SESSION =
  'まだセッションが組まれていない（このプロセスでクローンのセッションをまだ開いていない。再起動後は次のセッションが始まるまで空）。' +
  'systemPrompt・memoryInPrompt・tools・builtinTools・externalMcpServers・plugins は取れていない（null は「使っていない」ではなく「まだ取れていない」）';

const NOTICE_NO_CONTEXT_USAGE =
  'ターン境界をまだ観測していない（今のセッションで1ターンも終わっていない）。contextUsage と builtinTools の名前・大きさは取れていない';

const NOTICE_FULL_OFF =
  '`full=0`: systemPrompt.text・tools[].description・tools[].inputSchema は省いた（大きさは chars の欄に残る）。全文は `full=1`（既定）で取れる';

function indexFields(index: PromptSnapshotMemoryDocument['index']): {
  indexChars: number | null;
  indexForm: string | null;
  omitted: boolean;
  indexNote: string | null;
} {
  if (index.kind === 'baked') {
    return { indexChars: index.chars, indexForm: index.form, omitted: false, indexNote: null };
  }
  return {
    indexChars: null,
    indexForm: null,
    omitted: index.kind === 'omitted',
    indexNote: index.reason,
  };
}

function cappedOmissions(usage: PromptSnapshotContextUsage & { ok: true }): string[] {
  const axes = [
    ['categories', usage.categories],
    ['mcpTools', usage.mcpTools],
    ['systemPromptSections', usage.systemPromptSections],
    ['memoryFiles', usage.memoryFiles],
    ['systemTools', usage.systemTools],
    ['deferredBuiltinTools', usage.deferredBuiltinTools],
    ['mcpInstructions', usage.mcpInstructions],
  ] as const;
  const notes: string[] = [];
  for (const [name, axis] of axes) {
    if (axis.available && axis.value.omitted > 0) {
      notes.push(`contextUsage.${name} は上限で ${String(axis.value.omitted)} 件切り捨てた`);
    }
  }
  const unavailable: string[] = axes.filter(([, axis]) => !axis.available).map(([name]) => name);
  if (!usage.messageBreakdown.available) unavailable.push('messageBreakdown');
  if (unavailable.length > 0) {
    notes.push(`contextUsage の ${unavailable.join('・')} は取れていない（理由は各欄の reason）`);
  }
  return notes;
}

export function buildSelfPromptBody(
  snapshot: ClonePromptSnapshot,
  options: { full: boolean },
): UnscannedBody {
  const { full } = options;
  const notice: string[] = [];
  const { session, contextUsage } = snapshot;

  if (!full) notice.push(NOTICE_FULL_OFF);

  if (contextUsage === null) {
    notice.push(NOTICE_NO_CONTEXT_USAGE);
  } else if (!contextUsage.ok) {
    notice.push(
      `直近の文脈占有の取得に失敗した（${contextUsage.at}）。理由は contextUsage.error。builtinTools の名前・大きさは取れていない`,
    );
  } else {
    notice.push(...cappedOmissions(contextUsage));
  }
  const usageOk = contextUsage !== null && contextUsage.ok ? contextUsage : null;

  if (session === null || !session.ok) {
    notice.unshift(
      session === null
        ? NOTICE_NO_SESSION
        : `セッションのスナップショットを組めなかった回（${session.at}）。理由は session.error。systemPrompt・memoryInPrompt・tools・builtinTools・externalMcpServers・plugins は取れていない`,
    );
    return {
      full,
      session,
      systemPrompt: null,
      memoryInPrompt: null,
      tools: null,
      builtinTools: null,
      externalMcpServers: null,
      externalMcpServersLive: null,
      plugins: null,
      contextUsage: mutable(contextUsage),
      notice,
    };
  }

  const omittedFromIndex = session.memoryInPrompt.documents.filter(
    (document) => document.index.kind === 'omitted',
  ).length;
  if (omittedFromIndex > 0) {
    notice.push(
      `記憶の文書のうち ${String(omittedFromIndex)} 件は、焼いた索引から省かれた（memoryInPrompt の omitted: true。理由は indexNote）`,
    );
  }
  const unmeasured = session.memoryInPrompt.documents.filter(
    (document) => document.index.kind === 'unavailable',
  ).length;
  if (unmeasured > 0) {
    notice.push(
      `記憶の文書のうち ${String(unmeasured)} 件は、索引の中での長さを取れなかった（indexChars は null。理由は indexNote）`,
    );
  }
  if (session.memoryInPrompt.omitted > 0) {
    notice.push(
      `記憶の文書は ${String(session.memoryInPrompt.omitted)} 件を、載せる件数の上限で切り捨てた（memoryInPrompt.omittedDocuments）`,
    );
  }

  const builtin = session.builtinTools;
  if (builtin.available) throw new Error('組み込みの道具の定義が取れた値は、まだ型に無い');

  return {
    full,
    session: {
      ok: true,
      builtAt: session.builtAt,
      resumedFrom: session.resumedFrom,
      sessionId: session.sessionId,
      model: session.model,
    },
    systemPrompt: full
      ? { text: session.systemPrompt.text, chars: session.systemPrompt.chars }
      : { chars: session.systemPrompt.chars },
    memoryInPrompt: {
      documents: session.memoryInPrompt.documents.map((document) => ({
        slug: document.slug,
        type: document.type,
        description: document.description,
        chars: document.chars,
        ...indexFields(document.index),
      })),
      omittedDocuments: session.memoryInPrompt.omitted,
    },
    tools: session.tools.map((tool) => ({
      name: tool.name,
      source: 'clone' as const,
      ...(full ? { description: tool.description, inputSchema: tool.inputSchema } : {}),
      descriptionChars: tool.descriptionChars,
      inputSchemaChars: tool.inputSchemaChars,
    })),
    builtinTools: {
      available: false,
      reason: builtin.reason,
      systemTools: usageOk === null ? null : mutable(usageOk.systemTools),
      deferredBuiltinTools: usageOk === null ? null : mutable(usageOk.deferredBuiltinTools),
    },
    externalMcpServers: session.externalMcpServers.map((server) => ({
      name: server.name,
      type: server.type,
    })),
    externalMcpServersLive:
      session.externalMcpServersLive === null
        ? null
        : {
            at: session.externalMcpServersLive.at,
            failed: [...session.externalMcpServersLive.failed],
            retained: [...session.externalMcpServersLive.retained],
          },
    plugins: session.plugins.map((plugin) => ({ name: plugin.name })),
    contextUsage: mutable(contextUsage),
    notice,
  };
}

function describeSecretScan(hits: readonly { rule: string; count: number }[]): string {
  if (hits.length === 0) return '秘密走査: 走査した（当たり0件）';
  return `秘密走査: ${hits.map((hit) => `${hit.rule} ${String(hit.count)} 件`).join('、')}を伏せた`;
}

/**
 * 返す全部の文字列（キーを含む）をここで1回だけ走査し、当たった箇所を伏せた応答を返す。走査の結果（規則の名前と件数だけ）は、走査した後に足す
 * （`notice` の文に値は入らない）。走査が例外で落ちたらここで投げる: 呼び手は応答を返さない（走査できていない全文を返さない）。
 */
export function finalizeSelfPrompt(body: UnscannedBody, redactor: SecretRedactor): SelfPromptBody {
  const scanned = redactor.redactDeep(body);
  const hits = redactor.hits();
  return {
    ...scanned,
    notice: [...scanned.notice, describeSecretScan(hits)],
    secretScan: { scanned: true, hits: hits.map((hit) => ({ rule: hit.rule, count: hit.count })) },
  };
}
