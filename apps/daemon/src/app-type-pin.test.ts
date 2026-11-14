import type { HonoBase } from 'hono/hono-base';
import { describe, expect, it } from 'vitest';

import type { AppType } from './app.js';

// `AppType`（CLI の `hc<AppType>` が頼る型）の「パス → メソッド」を、型の水準で丸ごと固定する。
// `app.ts` を族ごとのファイルへ分けて `.route()` で組み直しても、CLI から見える経路の型が変わらないことの歯。
// 検査は `tsc`（`pnpm typecheck`。`*.test.ts` も対象）が行う: 型が違えば下の代入がコンパイルエラーになる。
// 固定値（`ExpectedAppSchema`）は `app-routes-pin.json` から機械的に作った。経路を足す・消すときは
// `app-routes-pin.json` と一緒に作り直すこと（`/openapi.json`・`/docs` は鎖に載せないので型には無い）。

// `any` は hono 自身の `Client<T>`（hono/client の型）と同じ引き方: `never` だと条件が成り立たず `Schema` が `never` になる。
// `.route()` で組むと `AppType` のスキーマは「鎖の型 | MergeSchemaPath<…>」の和になり、和に `keyof` を取ると共通キーだけになる:
// `hc` の `UnionToIntersection` と同じに、和を交差へ直してから取り出す（固定する中身は変えない）。
type U2I<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = AppType extends HonoBase<any, infer S, any> ? U2I<S> : never;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

type ExpectedAppSchema = {
  '/health': '$get';
  '/status': '$get';
  '/attachments': '$post' | '$get';
  '/attachments/limits': '$get';
  '/attachments/:id/meta': '$get';
  '/attachments/:id': '$get' | '$patch' | '$delete';
  '/chat': '$post';
  '/client-messages/:clientMessageId': '$get';
  '/chat/:conversationId/stream': '$get';
  '/chat/:conversationId/end': '$post';
  '/clone/interrupt': '$post';
  '/clone/session/reopen': '$post';
  '/conversations': '$get';
  '/conversations/unread-count': '$get';
  '/conversations/:id': '$get' | '$delete';
  '/conversations/:id/read': '$post';
  '/journal/stream': '$get';
  '/topology': '$get';
  '/topology/stream': '$get';
  '/memory': '$get';
  '/memory/:slug': '$get' | '$put' | '$delete';
  '/practices': '$get';
  '/practices/:slug': '$get' | '$put' | '$delete';
  '/practices/:slug/versions': '$get';
  '/practices/:slug/versions/:version': '$get';
  '/journal': '$get';
  '/journal/:id': '$get';
  '/usage': '$get';
  '/reports': '$get';
  '/reports/:date': '$get';
  '/approvals': '$get';
  '/approvals/answered-dates': '$get';
  '/approvals/:id': '$get';
  '/approvals/:id/trace': '$get';
  '/approvals/answer': '$post';
  '/approvals/:id/answer': '$post';
  '/permission-grants': '$get';
  '/permission-grants/:id/revoke': '$post';
  '/permission-grants/unreadable/remove': '$post';
  '/integration-keys': '$get' | '$post';
  '/integration-keys/unreadable/remove': '$post';
  '/integration-keys/:id/revoke': '$post';
  '/events': '$post';
  '/events/:source': '$post';
  '/schedule': '$get' | '$post';
  '/schedule/:kind': '$delete';
  '/schedule/:kind/run': '$post';
  '/tasks': '$get' | '$post';
  '/tasks/:id': '$get' | '$patch';
  '/tasks/:id/close': '$post';
  '/tasks/:id/reopen': '$post';
  '/tasks/:id/move': '$post';
  '/managers': '$get';
  '/managers/:id': '$get' | '$delete';
  '/managers/:id/transcript': '$get';
  '/managers/:id/messages': '$post';
  '/runners': '$get';
  '/runners/vacate': '$post';
  '/profile': '$get';
  '/profile/:name': '$put' | '$delete';
  '/mcp-servers': '$get' | '$put';
  '/plugins': '$get' | '$post';
  '/plugins/preview': '$post';
  '/plugins/:name': '$delete';
  '/credentials': '$get' | '$put';
  '/codex/auth': '$get' | '$delete';
  '/codex/login': '$post';
  '/codex/login/:id': '$get' | '$delete';
  '/tokens': '$get' | '$put';
  '/tokens/unreadable/remove': '$post';
  '/tokens/policy': '$put';
  '/tokens/:id/try': '$post';
  '/archive': '$get';
  '/archive/sessions': '$get';
  '/archive/:id': '$get' | '$delete';
  '/inbox/remove': '$post';
  '/inbox': '$get';
  '/dropped': '$get';
  '/progress': '$get';
  '/auth/login': '$post';
  '/auth/:provider/callback': '$get';
  '/auth/login/:requestId/claim': '$post';
  '/auth/me': '$get';
  '/auth/logout': '$post';
  '/access': '$get';
  '/access/:accountId/grant': '$post';
  '/access/:accountId/revoke': '$post';
  '/access/unreadable/remove': '$post';
  '/shutdown': '$post';
  '/reset': '$post';
};

type ActualAppSchema = { [P in keyof Schema]: keyof Schema[P] };

// 出力か入力が `any` に落ちた経路（`${パス} ${メソッド}` の和）。落ちると CLI の型検査をすり抜ける。
type AnyEndpoints = {
  [P in keyof Schema & string]: {
    [M in keyof Schema[P] & string]: Schema[P][M] extends { input: infer I; output: infer O }
      ? IsAny<I> extends true
        ? `${P} ${M}`
        : IsAny<O> extends true
          ? `${P} ${M}`
          : never
      : `${P} ${M}`;
  }[keyof Schema[P] & string];
}[keyof Schema & string];

// 代表の 2 本は出力の中身まで固定する（小さい物）。
type ShutdownOutput = Schema['/shutdown']['$post']['output'];

describe('AppType の型（コンパイル時に検査する）', () => {
  it('パス → メソッドの一覧が固定値と同じ', () => {
    const paths: Equal<ActualAppSchema, ExpectedAppSchema> = true;
    expect(paths).toBe(true);
  });

  it('どの経路の入出力も any に落ちていない', () => {
    const none: Equal<AnyEndpoints, never> = true;
    expect(none).toBe(true);
  });

  it('POST /shutdown の出力は { ok: true } か 415 の本文', () => {
    const output: Equal<
      ShutdownOutput,
      { error: 'content-type: application/json が要る' } | { ok: true }
    > = true;
    expect(output).toBe(true);
  });
});
