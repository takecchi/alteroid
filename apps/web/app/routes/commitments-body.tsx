import { Markdown } from '@alteroid/ui';
import { redactBody } from '@alteroid/logic';
import type { TextMarkup } from '@alteroid/core';
import type { Commitment } from '@alteroid/logic';

const MANAGER_PREFIXES = ['[report] ', '[question] ', '[permission] '] as const;

// 接頭辞の形式（`[kind] text`）の持ち主は packages/core/src/clone.ts の commitmentFor。向こうが変えるとここは前方一致しなくなり、本文全体を Markdown で描く。
function splitManagerPrefix(body: string): { prefix: string | null; rest: string } {
  for (const prefix of MANAGER_PREFIXES) {
    if (body.startsWith(prefix)) return { prefix, rest: body.slice(prefix.length) };
  }
  return { prefix: null, rest: body };
}

// JSON として読めない・入れ子や配列を含むときは、欠落させないよう元の文字列のまま返す。
export function readableExternalBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return body;
  const flat = entries.every(
    ([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  if (!flat) return body;
  if (entries.length === 1 && entries[0]?.[0] === 'note' && typeof entries[0][1] === 'string') {
    return entries[0][1];
  }
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join('\n');
}

function PlainBody({ body }: { body: string }) {
  return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{body}</p>;
}

// 網羅性チェック専用（引数は never）。戻り値は使わず、本文は渡さない: 渡すと本文でなく起点の生の値が描かれる。
// 実行時に来たら黙って倒さず console.warn で残す。
function assertOriginHandled(origin: never): void {
  console.warn(`commitments.tsx: 未知の commitment.origin が来た: ${String(origin)}`);
}

// 網羅性チェック専用（引数は never）。never の変数を本文として描かない（assertClosedByHandled と同じ）。
function assertMarkupHandled(markup: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.bodyMarkup: ${String(markup)}`);
}

const KNOWN_TEXT_MARKUP = ['markdown', 'none'] as const satisfies readonly TextMarkup[];

function isKnownTextMarkup(value: string): value is TextMarkup {
  return (KNOWN_TEXT_MARKUP as readonly string[]).includes(value);
}

// bodyMarkup が undefined のときは Markdown のまま: 印が無いことを安全と読まず、いまの既定を変えないため。
function ManagerRestBody({ rest, bodyMarkup }: { rest: string; bodyMarkup: string | undefined }) {
  if (bodyMarkup === undefined) return <Markdown remoteImages={false}>{rest}</Markdown>;

  if (!isKnownTextMarkup(bodyMarkup)) {
    console.warn(
      `commitments.tsx: 未知の commitment.bodyMarkup が来た（undefined とは別扱い）: ${String(bodyMarkup)}`,
    );
    return <PlainBody body={rest} />;
  }

  const markup = bodyMarkup;
  switch (markup) {
    case 'markdown':
      return <Markdown remoteImages={false}>{rest}</Markdown>;

    case 'none':
      return <PlainBody body={rest} />;

    default:
      assertMarkupHandled(markup);
      return <PlainBody body={rest} />;
  }
}

// manager を丸ごと Markdown のままにする: text に型で区別されない3種（マネージャーの出力・既に ** を含むデーモンの通知文・SDK のエラー文）が
// 混ざり、本文を判定せずには分離できないため。human は人間が打った文字が化けないよう素のまま、external は書き手が不明なので化けて困る側（素）へ倒す。
// closedReason は origin では書き手を判別できないので、ClosedReasonBody が closedBy で描き分ける。
export function CommitmentBody({ commitment }: { commitment: Commitment }) {
  const body = redactBody(commitment.body);
  switch (commitment.origin) {
    case 'self':
      return <Markdown remoteImages={false}>{body}</Markdown>;

    case 'manager': {
      const { prefix, rest } = splitManagerPrefix(body);
      return (
        <div className="min-w-0">
          {prefix !== null && (
            <span className="mr-1 font-mono text-[11px] text-muted-foreground">{prefix}</span>
          )}
          <ManagerRestBody rest={rest} bodyMarkup={commitment.bodyMarkup} />
        </div>
      );
    }

    case 'human':
      return <PlainBody body={body} />;

    case 'external':
      return <PlainBody body={readableExternalBody(body)} />;

    default:
      // デーモンが先に新しい origin を返すと実行時にここへ来る: 空白を描かず、素のテキストで本文を消さない。
      assertOriginHandled(commitment.origin);
      return <PlainBody body={body} />;
  }
}
