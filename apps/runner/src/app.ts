import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import type {
  AttachmentLimits,
  BuildRevision,
  RunnerEvent,
  RunnerHost,
  RunnerManagerPeer,
} from '@alteroid/core';
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  readAttachmentLimits,
  readExecutionResources,
  reasonOf,
  RunnerAttachmentRejectedError,
  runnerAttachmentBodyLimit,
  resolveBuildRevision,
  RUNNER_CAPABILITIES,
  startSseHeartbeat,
  RunnerFenceError,
  runnerAnswerCommandSchema,
  runnerRescueRefDeleteRequestSchema,
  runnerMessageCommandSchema,
  runnerResumeCommandSchema,
  runnerSetCredentialsCommandSchema,
  runnerSetMcpServersCommandSchema,
  runnerSetCodexAuthCommandSchema,
  runnerTakeCodexAuthWriteBackCommandSchema,
  runnerSetProfileCommandSchema,
  runnerStartCommandSchema,
} from '@alteroid/core';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';

import { TaskBreakdownReader } from './tasks.js';

// 逆向きのコールバックを足さない: runner の中の子プロセス（マネージャー）がその経路で記憶へ届くようになるため。
export interface RunnerAppDeps {
  host: RunnerHost;
  outbox: Outbox;
  // 鍵そのものではなくハッシュだけ持つ: 素の鍵を環境変数に置くとマネージャーが読めて、自分宛の許可確認に自分で allow を返せるため。
  tokenSha256: string;
  revision?: BuildRevision;
  // 環境変数にしない: テストで短くする以外に差し替える理由が無いため。
  sseHeartbeatMs?: number;
  // 書き込みに期限を切る: 読まなくなった接続の `writeSSE` は返らず、1件の詰まりが後続の配送を全部止めるため。
  sseWriteDeadlineMs?: number;
  taskBreakdownReader?: TaskBreakdownReader;
  attachmentLimits?: AttachmentLimits;
  /** `hello.managerPeers` に載せる peer（#3940）。空・省略なら欄ごと送らない。 */
  managerPeers?: readonly RunnerManagerPeer[];
}

const AUTH_SCHEME = /^Bearer\s+(.+)$/i;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

// 定数時間で比べる: 総当たりに時間の手がかりを与えないため。
function matches(header: string | undefined, expectedHex: string): boolean {
  const token = AUTH_SCHEME.exec(header ?? '')?.[1];
  if (token === undefined) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== 32) return false;
  return timingSafeEqual(sha256(token), expected);
}

export interface OutboxPending {
  count: number;
  oldestAt?: string;
}

// 連番を `RunnerEvent` に載せない: wire の形を変えずに、取りこぼしの手当てを配送層だけで済ませるため。
export type OutboxSeq = number;

export interface OutboxPendingGroup {
  type: string;
  managerId?: string;
  count: number;
  oldestAt: string;
}

export interface OutboxShutdownSnapshot {
  queue: {
    count: number;
    oldestAt?: string;
    groups: OutboxPendingGroup[];
  };
  // 'detached' の件数は 0 と書かない: `#probe` が外れて取れず、「何も失っていない」と読めてしまうため。
  subscriber:
    | { status: 'never-subscribed' }
    | { status: 'subscribed'; count?: number; oldestAt?: string }
    | { status: 'detached' };
}

// 溜める量に上限を置かない: 上限は取りこぼしになるため。
export class Outbox {
  readonly #queue: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] = [];
  #listener: ((event: RunnerEvent, seq: OutboxSeq, queuedAt: string) => void) | null = null;
  #probe: (() => OutboxPending) | null = null;
  // detach でも戻さない: `#listener` とは別の軸（過去に購読されたか）で、「一度も無い」と「切れた」を分けるため。
  #everSubscribed = false;
  #drain: (() => { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[]) | null = null;
  readonly #now: () => string;
  #nextSeq: OutboxSeq = 1;

  readonly #sent: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] = [];

  static readonly SENT_HISTORY_LIMIT = 1000;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  push(event: RunnerEvent): OutboxSeq {
    return this.requeue(event, this.#now());
  }

  // 差し戻しは `queuedAt` を打ち直さない: `oldestPendingAt` が戻すたびに新しくなる嘘になるため。連番は新しく振る。
  requeue(event: RunnerEvent, queuedAt: string): OutboxSeq {
    const seq = this.#nextSeq++;
    if (this.#listener !== null) {
      this.#listener(event, seq, queuedAt);
      return seq;
    }
    this.#queue.push({ event, queuedAt, seq });
    return seq;
  }

  // 古い購読者の分を `#drain` で引き出してから置き換える: 古い購読者は `writeSSE` で止まり自分の `finally` を走らせられず、抱えた分が誰にも配られず消えるため。
  attach(
    listener: (event: RunnerEvent, seq: OutboxSeq, queuedAt: string) => void,
    pending?: () => OutboxPending,
    drain?: () => { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[],
  ): () => void {
    if (this.#drain !== null) {
      const stale = this.#drain();
      for (const item of stale) listener(item.event, item.seq, item.queuedAt);
    }
    while (this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (item !== undefined) listener(item.event, item.seq, item.queuedAt);
    }
    this.#listener = listener;
    this.#probe = pending ?? null;
    this.#everSubscribed = true;
    this.#drain = drain ?? null;
    return () => {
      if (this.#listener !== listener) return;
      this.#listener = null;
      this.#probe = null;
      this.#drain = null;
    };
  }

  recordSent(event: RunnerEvent, seq: OutboxSeq, queuedAt: string): void {
    // 同じ連番が既に在れば積まない: 読み返して再送した分が控えに二重に入り、デーモンへ同じ出来事が2回届くため。
    for (let i = this.#sent.length - 1; i >= 0; i--) {
      const known = this.#sent[i];
      if (known === undefined || known.seq < seq) break;
      if (known.seq === seq) return;
    }
    this.#sent.push({ event, seq, queuedAt });
    while (this.#sent.length > Outbox.SENT_HISTORY_LIMIT) this.#sent.shift();
  }

  sentSince(lastEventId: OutboxSeq): { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] {
    // 振っていない連番を申告されたら控えを全部返す: runner が入れ替わると連番は1から数え直され、前の runner の高い値で絞ると1件も返らないため。
    if (lastEventId >= this.#nextSeq) return [...this.#sent];
    return this.#sent.filter((item) => item.seq > lastEventId);
  }

  // `#queue` の長さだけを数えない: listener が付いている間は購読側に溜まり、デーモンが読まなくなっても 0 のままになるため。
  get pending(): number {
    return this.#queue.length + (this.#probe?.().count ?? 0);
  }

  get oldestPendingAt(): string | undefined {
    const mine = this.#queue[0]?.queuedAt;
    const theirs = this.#probe?.().oldestAt;
    if (mine === undefined) return theirs;
    if (theirs === undefined) return mine;
    return theirs < mine ? theirs : mine;
  }

  get subscribed(): boolean {
    return this.#listener !== null;
  }

  describeForShutdown(): OutboxShutdownSnapshot {
    const groups = new Map<string, OutboxPendingGroup>();
    for (const item of this.#queue) {
      const managerId = 'managerId' in item.event ? item.event.managerId : undefined;
      const key = `${item.event.type} ${managerId ?? ''}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          type: item.event.type,
          ...(managerId === undefined ? {} : { managerId }),
          count: 1,
          oldestAt: item.queuedAt,
        });
      } else {
        existing.count += 1;
        if (item.queuedAt < existing.oldestAt) existing.oldestAt = item.queuedAt;
      }
    }
    const probed = this.#probe?.();
    const subscriber: OutboxShutdownSnapshot['subscriber'] =
      this.#listener !== null
        ? {
            status: 'subscribed',
            ...(probed === undefined
              ? {}
              : {
                  count: probed.count,
                  ...(probed.oldestAt === undefined ? {} : { oldestAt: probed.oldestAt }),
                }),
          }
        : this.#everSubscribed
          ? { status: 'detached' }
          : { status: 'never-subscribed' };
    return {
      queue: {
        count: this.#queue.length,
        ...(this.#queue[0] === undefined ? {} : { oldestAt: this.#queue[0].queuedAt }),
        groups: [...groups.values()],
      },
      subscriber,
    };
  }
}

export function formatOutboxShutdownReport(snapshot: OutboxShutdownSnapshot): string | null {
  const subscriberKnownCount =
    snapshot.subscriber.status === 'subscribed' ? (snapshot.subscriber.count ?? 0) : 0;
  // 'detached' のとき `#queue` が0件でも黙らない: 切れた側の件数は取れず、0件と決めつけると静かに失敗するため。
  const subscriberUnknown = snapshot.subscriber.status === 'detached';
  const total = snapshot.queue.count + subscriberKnownCount;
  if (total === 0 && !subscriberUnknown) return null;

  const oldestCandidates = [
    snapshot.queue.oldestAt,
    snapshot.subscriber.status === 'subscribed' ? snapshot.subscriber.oldestAt : undefined,
  ].filter((value): value is string => value !== undefined);
  oldestCandidates.sort();
  const oldest = oldestCandidates[0];

  const lines = [
    total > 0
      ? `alteroid-runner: 畳む直前の出来事が ${total} 件、このプロセスの終了と一緒に失われる` +
        `${oldest === undefined ? '' : `（最古 ${oldest}）`}。Outbox はプロセス内メモリだけで、` +
        'ディスクにも DB にも無い——この直後に process.exit(0) するので、これより後は無い。' +
        `${
          subscriberUnknown
            ? ' 購読側が過去に抱えていた分は件数不明——それとは別に、さらに失われている可能性がある。'
            : ''
        }`
      : 'alteroid-runner: 畳む直前、自分の待ち行列（#queue）に残っているものは無いが、' +
        '過去に購読されていた接続がいま切れており、そちら側で何件失っていたかはここからは' +
        '分からない（0件だったとは言い切れない）。',
  ];

  if (snapshot.queue.groups.length === 0) {
    lines.push('  自分の待ち行列（#queue）: 0件。');
  } else {
    lines.push('  自分の待ち行列（#queue）の内訳:');
    for (const group of snapshot.queue.groups) {
      lines.push(
        `    type=${group.type}` +
          `${group.managerId === undefined ? '' : ` managerId=${group.managerId}`}` +
          ` count=${group.count} oldest=${group.oldestAt}`,
      );
    }
  }

  lines.push(describeSubscriberLine(snapshot.subscriber));

  return `${lines.join('\n')}\n`;
}

function describeSubscriberLine(subscriber: OutboxShutdownSnapshot['subscriber']): string {
  switch (subscriber.status) {
    case 'never-subscribed':
      return '  購読側が抱えている分: 購読が一度も無いので該当なし。';
    case 'detached':
      return (
        '  購読側が抱えている分: 過去に購読されていたが、いま切れている' +
        '（件数は取れない——0件だったとは言い切れない）。'
      );
    case 'subscribed': {
      const oldest = subscriber.oldestAt === undefined ? '' : `（最古 ${subscriber.oldestAt}。`;
      const closing = subscriber.oldestAt === undefined ? '（' : '';
      const count = subscriber.count ?? '不明';
      return `  購読側が抱えている分: ${count} 件${oldest}${closing}内訳は取れない）。`;
    }
    default: {
      const unreachable: never = subscriber;
      return `  購読側が抱えている分: 判定できない（未知の状態 ${JSON.stringify(unreachable)}）。`;
    }
  }
}

// createRunnerApp の中で作らない: テストが app を作り直すたびに変わり、器の入れ替わりに見えるため。
const INSTANCE_ID = randomUUID();

// デーモンの無音の見張り（`RUNNER_STREAM_SILENCE_TIMEOUT_MS`）と同じ式にする。
// `deps.sseHeartbeatMs` から導かない: テストで heartbeat を縮めても、書き込みの締め切りまで縮める理由は無いため。
const DEFAULT_SSE_WRITE_DEADLINE_MS = DEFAULT_SSE_HEARTBEAT_MS * 3;

async function withDeadline<T>(
  run: () => Promise<T>,
  deadlineMs: number,
): Promise<{ outcome: 'done'; value: T } | { outcome: 'deadline-exceeded' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ outcome: 'deadline-exceeded' }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'deadline-exceeded' }), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      run().then((value) => ({ outcome: 'done' as const, value })),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createRunnerApp(deps: RunnerAppDeps) {
  const { host, outbox } = deps;
  const sseHeartbeatMs = deps.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const sseWriteDeadlineMs = deps.sseWriteDeadlineMs ?? DEFAULT_SSE_WRITE_DEADLINE_MS;
  const revision = deps.revision ?? resolveBuildRevision();
  const taskBreakdownReader = deps.taskBreakdownReader ?? new TaskBreakdownReader();
  const attachmentBodyMax = runnerAttachmentBodyLimit(
    deps.attachmentLimits ?? readAttachmentLimits().limits,
  );
  const tooLarge = (c: Context) =>
    c.json(
      { ok: false, error: `本文が大きすぎる（${attachmentBodyMax} バイトまで。置いていない）` },
      413,
    );

  const control = createMiddleware(async (c, next) => {
    if (!matches(c.req.header('authorization'), deps.tokenSha256)) {
      return c.json({ error: 'unauthorized' as const }, 401);
    }
    // 認証の前に時計を進めない: `/livez` を叩くだけで貸し出し期限が延び、自己失効が機能しなくなるため。
    host.noteDaemonContact();
    await next();
  });

  const app = new Hono()
    // Hono の既定の `console.error(err)` を使わない: 例外の本文を出さないため。
    .onError((err, c) => {
      if ('getResponse' in err) {
        const res = err.getResponse();
        return c.newResponse(res.body, res);
      }
      process.stderr.write(
        `alteroid-runner: HTTP 経路で例外を捕まえました（本文は出しません）: ${reasonOf(err)}\n`,
      );
      return c.text('Internal Server Error', 500);
    })
    .get('/livez', (c) => c.json({ ok: true }))

    .use('/health', control)
    .use('/events', control)
    .use('/managers', control)
    .use('/managers/*', control)
    .use('/credentials', control)
    .use('/profile', control)
    .use('/mcp-servers', control)
    .use('/codex-auth', control)
    .use('/codex-auth/*', control)
    .use('/rescue-refs/*', control)

    .get('/health', async (c) => {
      const tasks = await taskBreakdownReader.read();
      const resources = {
        ...(await readExecutionResources()),
        ...(tasks === undefined ? {} : { tasks }),
      };
      return c.json({
        ok: true,
        runnerId: host.runnerId,
        // 起動をまたいで引き継がない: 変わることが役目で、引き継ぐと器の入れ替えが見えなくなるため。
        instanceId: INSTANCE_ID,
        workspacePath: host.workspacePath,
        managers: host.list().length,
        pendingEvents: outbox.pending,
        ...(outbox.oldestPendingAt === undefined
          ? {}
          : { oldestPendingAt: outbox.oldestPendingAt }),
        resources,
        credentials: host.credentials(),
        profile: host.profile(),
        mcpServers: host.mcpServers(),
        revision,
      });
    })

    // zValidator の既定の 400 を使わない: ZodError の整形が変わった時点で、鍵の値が本文へ流れうるため。
    .post(
      '/credentials',
      zValidator('json', runnerSetCredentialsCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ok: false, error: '鍵の入力の形が不正（置いていない）' }, 400);
        }
        return undefined;
      }),
      async (c) => {
        const fingerprints = await host.setCredentials(c.req.valid('json').credentials);
        return c.json({ ok: true, credentials: fingerprints });
      },
    )

    // zValidator の既定の 400 を使わない: ZodError の整形が変わった時点で、鍵を含みうるスクリプトが本文へ流れうるため。
    // script に大きさの上限を付けない: 共有すべき既存の上限が daemon にも core にも無く、新しい制限を発明することになるため。
    .get('/profile', (c) => c.json({ ok: true, profile: host.profile() }))
    .post(
      '/profile',
      zValidator('json', runnerSetProfileCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ok: false, error: 'プロファイルの入力の形が不正（置いていない）' }, 400);
        }
        return undefined;
      }),
      async (c) => {
        const result = await host.setProfile(c.req.valid('json').script);
        return c.json(result);
      },
    )

    // zValidator の既定の 400 を使わない: 本文をそのまま返すため。袋の形だけをここで受け、中身の検査は `host.setMcpServers` に任せる。
    .get('/mcp-servers', (c) => c.json({ ok: true, mcpServers: host.mcpServers() }))
    .post(
      '/mcp-servers',
      zValidator('json', runnerSetMcpServersCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json(
            { ok: false, error: 'MCP サーバの登録の袋の形が不正（置いていない）' },
            400,
          );
        }
        return undefined;
      }),
      (c) => {
        try {
          const placed = host.setMcpServers(c.req.valid('json').mcpServers);
          return c.json({ ok: true, ...(placed === undefined ? {} : { mcpServers: placed }) });
        } catch (error) {
          return c.json({ ok: false, error: reasonOf(error) }, 400);
        }
      },
    )

    // Codex の ChatGPT ログイン（#3939）。値は受け取るだけで、状態（GET）には指紋しか載せない。
    .get('/codex-auth', (c) => c.json({ ok: true, codexAuth: host.codexAuth() }))
    .post(
      '/codex-auth',
      zValidator('json', runnerSetCodexAuthCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ok: false, error: 'Codex の ChatGPT ログインの袋の形が不正（置いていない）' }, 400);
        }
        return undefined;
      }),
      async (c) => {
        try {
          const codexAuth = await host.setCodexAuth(c.req.valid('json').codexAuth);
          return c.json({ ok: true, codexAuth });
        } catch (error) {
          return c.json({ ok: false, error: reasonOf(error) }, 500);
        }
      },
    )
    // Codex が書き換えた auth.json を、知らせた指紋と一致するときだけ渡す（#3939）。値を返すのは
    // この制御面の口だけ（デーモンだけが叩ける。合鍵のハッシュで守る）。
    .post(
      '/codex-auth/write-back',
      zValidator('json', runnerTakeCodexAuthWriteBackCommandSchema, (result, c) => {
        if (!result.success) return c.json({ ok: false, error: '指紋が無い' }, 400);
        return undefined;
      }),
      (c) =>
        c.json({ ok: true, writeBack: host.takeCodexAuthWriteBack(c.req.valid('json').fingerprint) }),
    )

    // heartbeat を流す: 無音が続くと読む側（undici）の `bodyTimeout`（300000ms）で必ず切れるため。
    .get('/events', (c) =>
      streamSSE(c, async (stream) => {
        const queue: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] = [];
        let wake: (() => void) | null = null;
        let closed = false;

        let writing: { event: RunnerEvent; queuedAt: string; seq: OutboxSeq } | null = null;

        // 置き換えられた後は何もしない旗: 待っていた書き込みが後から成功で返り、差し戻し済みの出来事を二重に記録するため。
        let superseded = false;

        // 控えは `outbox.attach(...)` より前に積む: 並び順を「控え（古い）→待ち行列（新しい）」に保つため。
        const lastEventIdHeader = c.req.header('Last-Event-ID');
        if (lastEventIdHeader !== undefined) {
          const lastEventId = Number(lastEventIdHeader);
          if (Number.isInteger(lastEventId) && lastEventId >= 0) {
            for (const item of outbox.sentSince(lastEventId)) queue.push(item);
          }
        }

        const detach = outbox.attach(
          // `queuedAt` を打ち直さない: 差し戻しの元の時刻が `oldestPendingAt` に残らなくなるため。
          (event, seq, queuedAt) => {
            queue.push({ event, queuedAt, seq });
            wake?.();
          },
          () => {
            const oldest = writing ?? queue[0];
            return {
              count: queue.length + (writing === null ? 0 : 1),
              ...(oldest === undefined ? {} : { oldestAt: oldest.queuedAt }),
            };
          },
          // 呼ばれた時点で自分の `writing` / `queue` を空にする: 後で自分の `finally` が同じ分をもう一度差し戻し、二重になるため。
          () => {
            const drained = writing === null ? [...queue] : [writing, ...queue];
            queue.length = 0;
            writing = null;
            superseded = true;
            stream.abort();
            return drained;
          },
        );
        stream.onAbort(() => {
          closed = true;
          wake?.();
        });

        let stopHeartbeat: (() => void) | null = null;

        try {
          // `hello` にも締め切りを掛ける: 読まなくなった接続だと本ループに入る前に固着し、heartbeat も始まらないため。
          const helloResult = await withDeadline(
            () =>
              stream.writeSSE({
                event: 'hello',
                data: JSON.stringify({
                  type: 'hello',
                  runnerId: host.runnerId,
                  capabilities: RUNNER_CAPABILITIES,
                  // `managerProvider` / `managerProviders` は名乗らない（2026-10-07 の決定。マネージャー層は常に
                  // Claude）。名乗ると旧いデーモンが `provider` 付きの命令を送ってくるため。
                  attachmentBodyLimit: attachmentBodyMax,
                  ...(deps.managerPeers === undefined || deps.managerPeers.length === 0
                    ? {}
                    : { managerPeers: deps.managerPeers }),
                }),
              }),
            sseWriteDeadlineMs,
          );
          if (superseded) {
            // 何もしない: 抱えていた分は `attach` のドレインで既に渡っている。
          } else if (helloResult.outcome === 'deadline-exceeded') {
            process.stderr.write(
              `alteroid-runner: /events への hello 書き込みが ${String(sseWriteDeadlineMs)}ms を超えたため接続を畳みます` +
                `（この接続が抱えていた ${String(queue.length)} 件を箱へ戻します）\n`,
            );
            stream.abort();
            return;
          }

          stopHeartbeat = startSseHeartbeat(stream, sseHeartbeatMs, () => wake?.());

          for (;;) {
            if (closed || stream.aborted || stream.closed || superseded) break;
            const item = queue.shift();
            if (item === undefined) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
              continue;
            }
            // 書き終わるまで `writing` に持つ: `queue` から出た瞬間に忘れると、固着した1件が数えられなくなるため。
            writing = item;
            const result = await withDeadline(
              () =>
                stream.writeSSE({
                  event: item.event.type,
                  data: JSON.stringify(item.event),
                  id: String(item.seq),
                }),
              sseWriteDeadlineMs,
            );
            if (superseded) {
              // `result` を読まずに抜ける: 抱えていた分は既に新しい購読者へ渡っており、進むと二重に記録するため。
              break;
            }
            if (result.outcome === 'deadline-exceeded') {
              // `writing` を `null` へ戻さない: `finally` が元の `queuedAt` のまま箱へ戻すため。
              // `break` だけで済ませず `stream.abort()` を呼ぶ: pending の書き込みがある間は `close()` が解決せず、応答が終わらないため。
              const stuck = 1 + queue.length;
              process.stderr.write(
                `alteroid-runner: /events への書き込みが ${String(sseWriteDeadlineMs)}ms を超えたため接続を畳みます` +
                  `（書きかけの1件を含め ${String(stuck)} 件を箱へ戻します）\n`,
              );
              stream.abort();
              break;
            }
            // 届いたとは限らないので控えへ積む: hono の `write()` は死んだ接続へ書いても例外を出さないため。
            outbox.recordSent(item.event, item.seq, item.queuedAt);
            // 投げたときは `writing` を残したまま抜ける: `finally` が箱へ戻さないと、書けなかった1件だけが静かに失われるため。
            writing = null;
          }
        } finally {
          stopHeartbeat?.();
          detach();
          // 書きかけの1件も戻す: 書けたか分からず、落とすより二重に届くほうを選ぶため。
          // `push` ではなく `requeue` で戻す: `queuedAt` が打ち直され、`oldestPendingAt` が戻すたびに新しくなるため。
          if (writing !== null) outbox.requeue(writing.event, writing.queuedAt);
          for (const item of queue) outbox.requeue(item.event, item.queuedAt);
        }
      }),
    )

    .get('/managers', (c) => c.json({ managers: host.list() }))

    // zValidator の既定の 400 を使わない: ZodError の整形が変わった時点で、依頼文が本文へ流れうるため。
    .post(
      '/managers',
      bodyLimit({ maxSize: attachmentBodyMax, onError: tooLarge }),
      zValidator('json', runnerStartCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ok: false, error: '起動命令の入力の形が不正（置いていない）' }, 400);
        }
        return undefined;
      }),
      async (c) => {
        try {
          const { cwd, sessionGeneration } = await host.start(c.req.valid('json'));
          return c.json({ ok: true, cwd, sessionGeneration });
        } catch (error) {
          if (error instanceof RunnerAttachmentRejectedError) {
            return c.json({ ok: false, error: reasonOf(error) }, 422);
          }
          throw error;
        }
      },
    )

    // zValidator の既定の 400 を使わない: 本文（依頼文・メッセージ）が返りうるため。
    .post(
      '/managers/:id/resume',
      zValidator('json', runnerResumeCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ok: false, error: '再開命令の入力の形が不正（置いていない）' }, 400);
        }
        return undefined;
      }),
      async (c) => {
        const command = c.req.valid('json');
        // `bodyLimit` を掛けない: 本文の生ログ `entries` は上限が無く大きく、掛けると正当な resume を壊すため。添付の `data` の合計だけを比べる。
        const attachmentDataBytes = (command.attachments ?? []).reduce(
          (sum, item) => sum + item.data.length,
          0,
        );
        if (attachmentDataBytes > attachmentBodyMax) return tooLarge(c);
        if (command.managerId !== c.req.param('id')) {
          return c.json({ error: 'manager_id が経路と本文で食い違っている' as const }, 400);
        }
        let resumed: { cwd: string; reusedLiveSession: boolean; sessionGeneration: string };
        try {
          resumed = await host.resume(command);
        } catch (error) {
          if (error instanceof RunnerAttachmentRejectedError) {
            return c.json({ ok: false, error: reasonOf(error) }, 422);
          }
          // 世代が古い resume を 500 に落とさない: 5xx は再試行されるため、古い命令を延々と投げ直される。
          if (error instanceof RunnerFenceError) {
            return c.json(
              { error: 'fenced' as const, expected: error.expected, given: error.given },
              409,
            );
          }
          throw error;
        }
        return c.json({
          ok: true,
          cwd: resumed.cwd,
          reusedLiveSession: resumed.reusedLiveSession,
          sessionGeneration: resumed.sessionGeneration,
        });
      },
    )

    // zValidator の既定の 400 を使わない: 本文（メッセージ）が返りうるため。
    .post(
      '/managers/:id/messages',
      bodyLimit({ maxSize: attachmentBodyMax, onError: tooLarge }),
      zValidator('json', runnerMessageCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ok: false, error: 'メッセージの入力の形が不正（置いていない）' }, 400);
        }
        return undefined;
      }),
      async (c) => {
        const command = c.req.valid('json');
        let delivered: boolean;
        try {
          delivered = await host.send(c.req.param('id'), command.text, command.attachments);
        } catch (error) {
          if (error instanceof RunnerAttachmentRejectedError) {
            return c.json({ ok: false, error: reasonOf(error) }, 422);
          }
          throw error;
        }
        if (!delivered) return c.json({ error: 'not found' as const }, 404);
        return c.json({ ok: true });
      },
    )

    // zValidator の既定の 400 を使わない: 本文（回答）が返りうるため。
    .post(
      '/managers/:id/answers',
      zValidator('json', runnerAnswerCommandSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ok: false, error: '回答の入力の形が不正（置いていない）' }, 400);
        }
        return undefined;
      }),
      async (c) => {
        const outcome = await host.answer(c.req.param('id'), c.req.valid('json'));
        return c.json({
          ok: outcome.delivered,
          ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
        });
      },
    )

    .post(
      '/rescue-refs/delete',
      zValidator('json', runnerRescueRefDeleteRequestSchema, (result, c) => {
        if (!result.success) {
          return c.json(
            { ok: false, error: '退避 ref の後始末の入力の形が不正（消していない）' },
            400,
          );
        }
        return undefined;
      }),
      async (c) => {
        const result = await host.deleteRescueRef(c.req.valid('json'), {
          signal: c.req.raw.signal,
        });
        return c.json(result);
      },
    )

    .delete('/managers/:id', async (c) => {
      await host.stop(c.req.param('id'));
      return c.json({ ok: true });
    })

    .get('/managers/:id/transcript', async (c) => {
      const body = await host.transcript(c.req.param('id'));
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    })

    .get('/managers/:id/unpushed-work', async (c) => {
      const result = await host.unpushedWork(c.req.param('id'), { signal: c.req.raw.signal });
      if (result === undefined) return c.json({ error: 'not found' as const }, 404);
      return c.json(result);
    });

  return app;
}

export type RunnerAppType = ReturnType<typeof createRunnerApp>;
