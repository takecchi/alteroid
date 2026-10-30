import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import type {
  AttachmentLimits,
  BuildRevision,
  RunnerEvent,
  RunnerHost,
  RunnerManagerPeersAnnouncement,
} from '@alteroid/core';
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  isArchiveRefId,
  isOutboxFileId,
  readAttachmentLimits,
  readExecutionResources,
  reasonOf,
  RunnerAttachmentRejectedError,
  RunnerAttachmentStageError,
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
  runnerSetPermissionRulesCommandSchema,
  runnerSetPluginCommandSchema,
  runnerRetainPluginsCommandSchema,
  decodeRunnerPlugin,
  RunnerPluginExtractError,
  RUNNER_PLUGIN_BODY_LIMIT_BYTES,
  RUNNER_PLUGIN_RETAIN_BODY_LIMIT_BYTES,
  runnerSetCodexAuthCommandSchema,
  runnerTakeCodexAuthWriteBackCommandSchema,
  runnerSetProfileCommandSchema,
  runnerStartCommandSchema,
  writeStderrLine,
} from '@alteroid/core';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
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
  // hello で名乗るモデル。渡さなければ欄ごと載せない（既定の帯で埋めない）。
  managerModel?: string;
  workerModel?: string;
}

const TRANSCRIPT_TAIL_MAX_CHARS = 2_000_000;

// 別口の添付の控え（クエリ）。`size` は10進の整数、`sha256` は小文字の hex（64桁）だけを受ける。
const attachmentStageQuery = z.object({
  name: z.string(),
  type: z.string(),
  size: z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(Number),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const AUTH_SCHEME = /^Bearer\s+(.+)$/i;

/**
 * hello に載せる peer の欄。開いている peer が無ければ `managerPeers` を送らない
 * （`manager-peers` の能力で「無い」と読める）。閉じている理由は在るときだけ送る。
 */
function helloManagerPeers(
  announcement: RunnerManagerPeersAnnouncement | undefined,
): Partial<RunnerManagerPeersAnnouncement> {
  if (announcement === undefined) return {};
  return {
    ...(announcement.managerPeers.length === 0 ? {} : { managerPeers: announcement.managerPeers }),
    ...(announcement.managerPeersClosed === undefined
      ? {}
      : { managerPeersClosed: announcement.managerPeersClosed }),
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

// 定数時間で比べる: 総当たりに時間の手がかりを与えないため。
function matches(header: string | undefined, expectedHex: string): boolean {
  const token = AUTH_SCHEME.exec(header ?? '')?.[1];
  if (token === undefined) return false;
  // 不正な hex は例外にならず、切れた Buffer になる（下の長さの検査で落ちる）。
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== 32) return false;
  return timingSafeEqual(sha256(token), expected);
}

// 連番を `RunnerEvent` に載せない: wire の形を変えずに、取りこぼしの手当てを配送層だけで済ませるため。
type OutboxSeq = number;

// 列の1件。連番と `queuedAt` は `push` のときに1回だけ振り、以後は書き換えない（差し戻しで振り直すと、次の接続で同じ出来事が2回届き、最古の時刻の計器が嘘になるため）。
export interface OutboxItem {
  event: RunnerEvent;
  queuedAt: string;
  seq: OutboxSeq;
  // 書き出した本文（`JSON.stringify(event)`）の字数。書き終えるまで無い
  chars?: number;
}

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
  // 'detached' の件数は 0 と書かない（#629）: 切れた側の件数は取れなかった時代の区別で、文言の形を保つために残している（#5692 段2 で畳む報告ごと見直す）。
  subscriber:
    | { status: 'never-subscribed' }
    | { status: 'subscribed'; count?: number; oldestAt?: string }
    | { status: 'detached' };
}

/**
 * `/events` の1接続が持つのは「次に書く連番」（cursor）だけ。出来事そのものは `Outbox` の列にしか無い。
 * 書き込みが成功したら `wrote` で進める。失敗・締め切り越え・置き換えのときは進めず、cursor は接続と一緒に捨てる。
 */
export interface OutboxSubscription {
  /** 新しい接続に置き換えられたら true。以後 `wrote` は何も進めない（止まっていた書き込みが後から成功で返っても、書き終えたことにしない）。 */
  readonly superseded: boolean;
  /** 次に書く1件。書き終える（`wrote`）まで同じものを返す。 */
  peek(): OutboxItem | undefined;
  wrote(item: OutboxItem, chars?: number): void;
  /** この接続がこれから書く件数（cursor 以降。書きかけの1件を含む）。 */
  pending(): number;
  detach(): void;
}

interface SubscriptionState {
  cursor: OutboxSeq;
  superseded: boolean;
  wake: () => void;
  onSuperseded: (() => void) | undefined;
}

// 溜める量に上限を置かない: 上限は取りこぼしになるため。落とすのは、書き終えた分（控え）だけである。
export class Outbox {
  // 連番の昇順の1本の列。連番が `#written` 以下は書いた分（控え）、より大きいのはまだ書いていない分。
  readonly #log: OutboxItem[] = [];
  #current: SubscriptionState | null = null;
  // detach でも戻さない: `#current` とは別の軸（過去に購読されたか）で、「一度も無い」と「切れた」を分けるため。
  #everSubscribed = false;
  readonly #now: () => string;
  #nextSeq: OutboxSeq = 1;
  // 書き終えた連番の最大。接続が変わっても持ち越す（次の接続は、ここより後ろから書き始める）。
  #written: OutboxSeq = 0;
  // `#log` の先頭からの、書き終えた分の件数と字数の合計。
  #sentCount = 0;
  #sentChars = 0;
  /** 字数で控えから落とした出来事のうち、いちばん新しい連番。繋ぎ直しで、それより前を求められたら送り直せない。 */
  #droppedForCharsThrough: OutboxSeq = 0;

  static readonly SENT_HISTORY_LIMIT = 1000;
  /**
   * 控えの字数（書き出した本文の合計）の上限（#4669）。生ログの写し（`mirror`）は1件で最大100万字になり、件数だけでは
   * 数十 MB〜を抱えうるため。控えが要るのは「書いたが届いたか分からない」直近の分だけで、届いた分は二度と要らない。
   * 値は `/journal/stream`・`/chat` の送り待ちの上限（1,600万字）に揃える。直近の1件は必ず残す。
   */
  static readonly SENT_HISTORY_MAX_CHARS = 16_000_000;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  push(event: RunnerEvent): OutboxSeq {
    const seq = this.#nextSeq++;
    this.#log.push({ event, queuedAt: this.#now(), seq });
    this.#current?.wake();
    return seq;
  }

  /**
   * 接続を1本つなぐ。古い接続があれば置き換え（`superseded`）、`onSuperseded` で畳ませる。
   * 古い接続の分を引き出して渡す必要は無い: 古い側は何も持たず、書き終えていない分は列に残っていて、新しい接続が `#written` の後ろから書くため。
   */
  subscribe(options: {
    lastEventId?: OutboxSeq;
    wake: () => void;
    onSuperseded?: () => void;
  }): OutboxSubscription {
    const state: SubscriptionState = {
      cursor: this.#startCursor(options.lastEventId),
      superseded: false,
      wake: options.wake,
      onSuperseded: options.onSuperseded,
    };
    const previous = this.#current;
    this.#current = state;
    this.#everSubscribed = true;
    if (previous !== null) {
      previous.superseded = true;
      previous.onSuperseded?.();
    }
    return {
      get superseded() {
        return state.superseded;
      },
      peek: () => this.#log[this.#lowerBound(state.cursor)],
      wrote: (item, chars) => {
        if (state.superseded) return;
        this.#markWritten(item, chars);
        state.cursor = Math.max(state.cursor, item.seq + 1);
        this.#trim();
      },
      pending: () => this.#log.length - this.#lowerBound(state.cursor),
      detach: () => {
        if (this.#current === state) this.#current = null;
      },
    };
  }

  /**
   * **試験の口（本番の /events は `subscribe` を使う。本番の呼び元は無い）。**
   * 溜まった分を同期で渡す購読で、畳みの待ちの試験が「脚が繋がっている」を作るために在る。渡した分は書き終えたことにする。
   */
  attach(listener: (event: RunnerEvent, seq: OutboxSeq, queuedAt: string) => void): () => void {
    const deliver = (): void => {
      for (let item = subscription.peek(); item !== undefined; item = subscription.peek()) {
        listener(item.event, item.seq, item.queuedAt);
        subscription.wrote(item);
      }
    };
    const subscription = this.subscribe({ wake: deliver });
    deliver();
    return () => subscription.detach();
  }

  /**
   * **試験の口（本番の /events は `subscribe` の `wrote` を使う。本番の呼び元は無い）。**
   * 連番を指して書き終えたことにする（列に無い連番なら列へ挿入する）。控えの上限・`sentSince` の試験が、書き込みを通さずに控えを作るために在る。
   * `chars` は書き出した本文（`JSON.stringify(event)`）の字数。省けばここで数える。
   */
  recordSent(event: RunnerEvent, seq: OutboxSeq, queuedAt: string, chars?: number): void {
    const index = this.#lowerBound(seq);
    let item = this.#log[index];
    if (item === undefined || item.seq !== seq) {
      item = { event, queuedAt, seq };
      this.#log.splice(index, 0, item);
      this.#nextSeq = Math.max(this.#nextSeq, seq + 1);
    }
    this.#markWritten(item, chars);
    this.#trim();
  }

  // 書き終えた連番は二度数えない: 読み返して再送した分が控えに二重に入り、デーモンへ同じ出来事が2回届くため。
  #markWritten(item: OutboxItem, chars?: number): void {
    if (item.seq <= this.#written) return;
    if (chars !== undefined) item.chars = chars;
    this.#written = item.seq;
    for (
      let next = this.#log[this.#sentCount];
      next !== undefined;
      next = this.#log[this.#sentCount]
    ) {
      if (next.seq > this.#written) break;
      next.chars ??= JSON.stringify(next.event).length;
      this.#sentChars += next.chars;
      this.#sentCount += 1;
    }
  }

  // 古い方から落とすのは、書き終えていて、かつ購読中の接続が次に書く連番より前の分だけ: まだ書いていない分と、繋ぎ直しで読み返している最中の分は落とさない。
  #trim(): void {
    const floor = this.#current?.cursor ?? Number.POSITIVE_INFINITY;
    while (
      this.#sentCount > Outbox.SENT_HISTORY_LIMIT ||
      (this.#sentChars > Outbox.SENT_HISTORY_MAX_CHARS && this.#sentCount > 1)
    ) {
      const first = this.#log[0];
      if (first === undefined || first.seq >= floor) break;
      this.#log.shift();
      this.#sentCount -= 1;
      this.#sentChars -= first.chars ?? 0;
      if (this.#sentCount < Outbox.SENT_HISTORY_LIMIT) {
        this.#droppedForCharsThrough = Math.max(this.#droppedForCharsThrough, first.seq);
      }
    }
  }

  #lowerBound(seq: OutboxSeq): number {
    let low = 0;
    let high = this.#log.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.#log[mid] as OutboxItem).seq < seq) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  // 字数で落とした分より前を求められたら、送り直せないことを黙らない（#4669）。届いていたかは runner からは分からない
  #noteDroppedBefore(lastEventId: OutboxSeq): void {
    if (lastEventId < this.#droppedForCharsThrough) {
      writeStderrLine(
        `alteroid-runner: 繋ぎ直しで連番 ${String(lastEventId)} より後を求められたが、` +
          `${String(this.#droppedForCharsThrough)} までは控えの字数の上限で落としてあり、送り直せない` +
          `（届いていなければ、その間の出来事は失われた）\n`,
      );
    }
  }

  // 申告が無ければ、まだ書いていない分だけを書く。申告 L があれば L の次から書く（L が書き終えた分より先なら、届いたものとして飛ばす）。
  // 振っていない連番の申告は、残っている列を先頭から書く: runner が入れ替わると連番は1から数え直され、前の runner の高い値で絞ると1件も書けないため。
  #startCursor(lastEventId: OutboxSeq | undefined): OutboxSeq {
    if (lastEventId === undefined) return this.#written + 1;
    if (lastEventId >= this.#nextSeq) return this.#log[0]?.seq ?? this.#nextSeq;
    this.#noteDroppedBefore(lastEventId);
    return lastEventId + 1;
  }

  sentSince(lastEventId: OutboxSeq): { event: RunnerEvent; queuedAt: string; seq: OutboxSeq }[] {
    const sent = this.#log.slice(0, this.#sentCount);
    if (lastEventId >= this.#nextSeq) {
      return sent.map(({ event, queuedAt, seq }) => ({ event, queuedAt, seq }));
    }
    this.#noteDroppedBefore(lastEventId);
    return sent
      .filter((item) => item.seq > lastEventId)
      .map(({ event, queuedAt, seq }) => ({ event, queuedAt, seq }));
  }

  // 購読中は、その接続がこれから書く分（読み返しの最中の分を含む）。購読が無いときは、書き終えた後ろ。
  #pendingFrom(): OutboxSeq {
    return this.#current?.cursor ?? this.#written + 1;
  }

  get pending(): number {
    return this.#log.length - this.#lowerBound(this.#pendingFrom());
  }

  get oldestPendingAt(): string | undefined {
    return this.#log[this.#lowerBound(this.#pendingFrom())]?.queuedAt;
  }

  get subscribed(): boolean {
    return this.#current !== null;
  }

  describeForShutdown(): OutboxShutdownSnapshot {
    // 購読中は、まだ書いていない分と読み返しの分を購読側の欄（その接続の溜まり）に数え、`queue` は空にする（#629 の報告の形）。
    // 購読が無いときは、書いていない分を `queue` に内訳つきで出す。
    const unwritten = this.#current === null ? this.#log.slice(this.#sentCount) : [];
    const groups = new Map<string, OutboxPendingGroup>();
    for (const item of unwritten) {
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
    const oldestPending = this.oldestPendingAt;
    const subscriber: OutboxShutdownSnapshot['subscriber'] =
      this.#current !== null
        ? {
            status: 'subscribed',
            count: this.pending,
            ...(oldestPending === undefined ? {} : { oldestAt: oldestPending }),
          }
        : this.#everSubscribed
          ? { status: 'detached' }
          : { status: 'never-subscribed' };
    return {
      queue: {
        count: unwritten.length,
        ...(unwritten[0] === undefined ? {} : { oldestAt: unwritten[0].queuedAt }),
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

// デーモンの名乗りの確認の期限（`runner-protocol.ts` の `HEARTBEAT_PROBE_MS` = 5000ms）の写しではない: 期限に届く前の兆しを残したいので、その半分から出す。
const SLOW_HEALTH_MS = 2_500;

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

// 出し箱と rescue-files の退避先の GET / DELETE の共通部分（違うのは host のどのメソッドを呼ぶかだけ）。
// `fileId` の形を先に検める: パス区切りや `..` を退避先のパスへ通さないため。
async function serveSpilledFile(
  c: Context,
  open: (
    managerId: string,
    fileId: string,
  ) => Promise<{ stream: Readable; size: number } | undefined>,
) {
  const fileId = c.req.param('fileId') ?? '';
  if (!isOutboxFileId(fileId)) return c.json({ error: 'invalid fileId' as const }, 400);
  const file = await open(c.req.param('id') ?? '', fileId);
  if (file === undefined) return c.json({ error: 'not found' as const }, 404);
  return c.body(Readable.toWeb(file.stream) as ReadableStream, 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(file.size),
  });
}

async function deleteSpilledFile(
  c: Context,
  remove: (managerId: string, fileId: string) => Promise<boolean>,
) {
  const fileId = c.req.param('fileId') ?? '';
  if (!isOutboxFileId(fileId)) return c.json({ error: 'invalid fileId' as const }, 400);
  if (!(await remove(c.req.param('id') ?? '', fileId))) {
    return c.json({ error: 'invalid managerId' as const }, 400);
  }
  return c.body(null, 204);
}

// 本文かクエリを schema で検め、形が違えば `{ ok: false, error }` の 400 で断る。
// zValidator の既定の 400 を使わない: ZodError の整形が変わった時点で、本文（鍵・スクリプト・依頼文・メッセージ等）が返りうるため。
function validated<Target extends 'json' | 'query', Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
  error: string,
) {
  return zValidator(target, schema, (result, c: Context) => {
    if (!result.success) return c.json({ ok: false, error }, 400);
    return undefined;
  });
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
      writeStderrLine(
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
    .use('/permission-rules', control)
    .use('/plugins', control)
    .use('/plugins/*', control)
    .use('/codex-auth', control)
    .use('/codex-auth/*', control)
    .use('/rescue-refs/*', control)

    .get('/health', async (c) => {
      const startedAt = performance.now();
      const tasks = await taskBreakdownReader.read();
      const resources = {
        ...(await readExecutionResources()),
        pidOwnerRecords: host.delegationPidOwnerRecords(),
        ...(tasks === undefined ? {} : { tasks }),
      };
      // 遅かった回だけ残す: デーモンの名乗りの確認（期限 5000ms）が全台同時に倒れたとき、器の側で遅れたのかを器のログだけで言えるようにするため（#4454）。
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= SLOW_HEALTH_MS) {
        writeStderrLine(
          `alteroid-runner: /health の材料集め（/proc の走査と cgroup の読み）に ${String(Math.round(elapsedMs))}ms かかりました` +
            `（デーモンの名乗りの確認の期限は 5000ms）\n`,
        );
      }
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
        plugins: host.plugins(),
        revision,
      });
    })

    .post(
      '/credentials',
      validated('json', runnerSetCredentialsCommandSchema, '鍵の入力の形が不正（置いていない）'),
      async (c) => {
        const fingerprints = await host.setCredentials(c.req.valid('json').credentials);
        return c.json({ ok: true, credentials: fingerprints });
      },
    )

    // script は鍵を含みうる。大きさの上限を付けない: 共有すべき既存の上限が daemon にも core にも無く、新しい制限を発明することになるため。
    .get('/profile', (c) => c.json({ ok: true, profile: host.profile() }))
    .post(
      '/profile',
      validated(
        'json',
        runnerSetProfileCommandSchema,
        'プロファイルの入力の形が不正（置いていない）',
      ),
      async (c) => {
        const result = await host.setProfile(c.req.valid('json').script);
        return c.json(result);
      },
    )

    // 袋の形だけをここで受け、中身の検査は `host.setMcpServers` に任せる。
    .get('/mcp-servers', (c) => c.json({ ok: true, mcpServers: host.mcpServers() }))
    .post(
      '/mcp-servers',
      validated(
        'json',
        runnerSetMcpServersCommandSchema,
        'MCP サーバの登録の袋の形が不正（置いていない）',
      ),
      (c) => {
        try {
          const placed = host.setMcpServers(c.req.valid('json').mcpServers);
          return c.json({ ok: true, ...(placed === undefined ? {} : { mcpServers: placed }) });
        } catch (error) {
          return c.json({ ok: false, error: reasonOf(error) }, 400);
        }
      },
    )

    /**
     * 委譲先の許可規則（#4952。人間が承認した許可）の一覧を丸ごと置き直す。**制御面である**（門番を外さないこと）:
     * マネージャーが叩けると、自分のセッションに許可規則を足せる。袋の形だけをここで受け、中身の検査は `host.setPermissionRules` に任せる。
     * 規則の本文は返さない（件数と、変わったかだけ）。
     */
    .post(
      '/permission-rules',
      validated(
        'json',
        runnerSetPermissionRulesCommandSchema,
        '許可規則の一覧の袋の形が不正（置いていない）',
      ),
      (c) => {
        try {
          const placed = host.setPermissionRules(c.req.valid('json').rules);
          return c.json({ ok: true, ...placed });
        } catch (error) {
          return c.json({ ok: false, error: reasonOf(error) }, 400);
        }
      },
    )

    /**
     * plugin を1本置く。**制御面である**（門番を外さないこと）。plugin の hooks とコードは
     * マネージャーの SDK 子プロセスが読むので、マネージャーが叩けると自分に効くものを自分で差し替えられる。
     *
     * **受けて検査し、置き場へ展開する**（メモリに残すのは指紋と展開先だけ）。不正（base64・path・
     * `contentSha256` の不一致・scope が `app`・名前が URL と違う）なら 400、展開の失敗は 500 で、
     * どちらも前の状態が残る。**本文を返さない**（`/mcp-servers` と同じ）。`bodyLimit` は本文を読む前に掛かる（鍵の無い呼びは更にその前に 401）。
     */
    .post(
      '/plugins/:name',
      bodyLimit({
        maxSize: RUNNER_PLUGIN_BODY_LIMIT_BYTES,
        onError: (c) =>
          c.json(
            {
              ok: false,
              error: `本文が大きすぎる（${RUNNER_PLUGIN_BODY_LIMIT_BYTES} バイトまで。置いていない）`,
            },
            413,
          ),
      }),
      validated('json', runnerSetPluginCommandSchema, 'plugin の入力の形が不正（置いていない）'),
      async (c) => {
        try {
          const placed = await host.setPlugin(
            c.req.param('name'),
            decodeRunnerPlugin(c.req.valid('json')),
          );
          return c.json({ ok: true, plugin: placed });
        } catch (error) {
          // 検査で落ちたのは送り手の不正（400）。展開で落ちたのは runner 側の事情（500）で、
          // 送り直せば通りうるので、400 と区別して返す。どちらも前の状態が残る。
          const status = error instanceof RunnerPluginExtractError ? 500 : 400;
          return c.json({ ok: false, error: reasonOf(error) }, status);
        }
      },
    )
    /**
     * 残す plugin の名前の一覧。一覧に無いものを runner はメモリから外す（外すのは新しい
     * 名乗りの一覧が正本だから）。形が不正なら 400 で、何も外さない。
     */
    .put(
      '/plugins',
      bodyLimit({
        maxSize: RUNNER_PLUGIN_RETAIN_BODY_LIMIT_BYTES,
        onError: (c) => c.json({ ok: false, error: '本文が大きすぎる（外していない）' }, 413),
      }),
      validated(
        'json',
        runnerRetainPluginsCommandSchema,
        'plugin の一覧の形が不正（外していない）',
      ),
      (c) => {
        const placed = host.retainPlugins(c.req.valid('json').names);
        return c.json({ ok: true, ...(placed === undefined ? {} : { plugins: placed }) });
      },
    )
    // Codex の ChatGPT ログイン。値は受け取るだけで、状態（GET）には指紋しか載せない。
    .get('/codex-auth', (c) => c.json({ ok: true, codexAuth: host.codexAuth() }))
    .post(
      '/codex-auth',
      validated(
        'json',
        runnerSetCodexAuthCommandSchema,
        'Codex の ChatGPT ログインの袋の形が不正（置いていない）',
      ),
      async (c) => {
        try {
          const codexAuth = await host.setCodexAuth(c.req.valid('json').codexAuth);
          return c.json({ ok: true, codexAuth });
        } catch (error) {
          return c.json({ ok: false, error: reasonOf(error) }, 500);
        }
      },
    )
    // Codex が書き換えた auth.json を、知らせた指紋と一致するときだけ渡す。値を返すのは
    // この制御面の口だけ（デーモンだけが叩ける。合鍵のハッシュで守る）。
    .post(
      '/codex-auth/write-back',
      validated('json', runnerTakeCodexAuthWriteBackCommandSchema, '指紋が無い'),
      (c) =>
        c.json({
          ok: true,
          writeBack: host.takeCodexAuthWriteBack(c.req.valid('json').fingerprint),
        }),
    )

    // heartbeat を流す: 無音が続くと読む側（undici）の `bodyTimeout`（300000ms）で必ず切れるため。
    .get('/events', (c) => {
      return streamSSE(c, async (stream) => {
        let wake: (() => void) | null = null;
        let closed = false;

        // 申告の無い・不正な Last-Event-ID は、無いものとして書いていない分だけを流す。
        const lastEventIdHeader = c.req.header('Last-Event-ID');
        const lastEventId =
          lastEventIdHeader === undefined ? Number.NaN : Number(lastEventIdHeader);

        // この接続が持つのは「次に書く連番」だけ。書き終えた分を `wrote` で進めない限り、出来事は列に残る（差し戻しは要らない）。
        // 置き換えられた後は何もしない: 止まっていた書き込みが後から成功で返っても、書き終えたことにしない（`wrote` が見る）。
        const subscription = outbox.subscribe({
          ...(Number.isInteger(lastEventId) && lastEventId >= 0 ? { lastEventId } : {}),
          wake: () => wake?.(),
          onSuperseded: () => stream.abort(),
        });
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
                  ...(deps.managerModel === undefined ? {} : { managerModel: deps.managerModel }),
                  ...(deps.workerModel === undefined ? {} : { workerModel: deps.workerModel }),
                  attachmentBodyLimit: attachmentBodyMax,
                  attachmentStageLimit: host.attachmentStageLimit,
                  // 接続のたびにいまの実効の env から読む: 鍵・プロファイルが降りるたびに変わるため（その後の変化は `anthropic_route`）
                  anthropicRoute: host.anthropicRoute(),
                  // 接続のたびにいまの開閉を読む: 資格が届く・外れるたびに変わるため（その後の変化は `manager_peers`）
                  ...helloManagerPeers(host.managerPeers()),
                }),
              }),
            sseWriteDeadlineMs,
          );
          if (subscription.superseded) {
            // 何もしない: 書き終えていない分は列に残っていて、新しい接続が書く。
          } else if (helloResult.outcome === 'deadline-exceeded') {
            writeStderrLine(
              `alteroid-runner: /events への hello 書き込みが ${String(sseWriteDeadlineMs)}ms を超えたため接続を畳みます` +
                `（この接続が抱えていた ${String(subscription.pending())} 件を箱へ戻します）\n`,
            );
            stream.abort();
            return;
          }

          stopHeartbeat = startSseHeartbeat(stream, sseHeartbeatMs, () => wake?.());

          for (;;) {
            if (closed || stream.aborted || stream.closed || subscription.superseded) break;
            const item = subscription.peek();
            if (item === undefined) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
              continue;
            }
            // 書き終える（`wrote`）まで cursor を進めない: 書けたか分からない1件を、次の接続が同じ連番で書き直せるように。
            const data = JSON.stringify(item.event);
            const result = await withDeadline(
              () =>
                stream.writeSSE({
                  event: item.event.type,
                  data,
                  id: String(item.seq),
                }),
              sseWriteDeadlineMs,
            );
            if (subscription.superseded) {
              // `result` を読まずに抜ける: 書き終えていない分は新しい接続が書いており、進むと二重に書く。
              break;
            }
            if (result.outcome === 'deadline-exceeded') {
              // cursor は進めない: 書きかけの1件も後続も列に残り、次の接続が書く。
              // `break` だけで済ませず `stream.abort()` を呼ぶ: pending の書き込みがある間は `close()` が解決せず、応答が終わらないため。
              writeStderrLine(
                `alteroid-runner: /events への書き込みが ${String(sseWriteDeadlineMs)}ms を超えたため接続を畳みます` +
                  `（書きかけの1件を含め ${String(subscription.pending())} 件を箱へ戻します）\n`,
              );
              stream.abort();
              break;
            }
            // 届いたとは限らないので控えにする（書き終えた分として列に残す）: hono の `write()` は死んだ接続へ書いても例外を出さないため。
            subscription.wrote(item, data.length);
          }
        } catch (error) {
          // 書き込みが投げた（相手が読まなくなった接続など）ときはここで受け止め、ほかの /events の跡と同じ1行で書く（#5011）:
          // 外へ抜くと hono の `streamSSE` が `console.error` でスタックごと標準エラーへ出し、跡の書き先（試験の準備）も通らないため。
          // hono の `onError` は使わない: 渡すと相手へ取り決めに無い `event: error` を、壊れた接続へもう一度書こうとするため。
          // 書けなかった分は cursor が進んでいないので列に残り、接続を閉じるのは hono の `run` が今どおりする
          writeStderrLine(
            `alteroid-runner: /events への書き込みが失敗したため接続を畳みます（${String(subscription.pending())} 件を箱へ戻します）: ${reasonOf(error)}\n`,
          );
        } finally {
          stopHeartbeat?.();
          subscription.detach();
        }
      });
    })

    .get('/managers', (c) => c.json({ managers: host.list() }))

    .post(
      '/managers',
      bodyLimit({ maxSize: attachmentBodyMax, onError: tooLarge }),
      validated('json', runnerStartCommandSchema, '起動命令の入力の形が不正（置いていない）'),
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

    .post(
      '/managers/:id/resume',
      validated('json', runnerResumeCommandSchema, '再開命令の入力の形が不正（置いていない）'),
      async (c) => {
        const command = c.req.valid('json');
        // `bodyLimit` を掛けない: 本文の生ログ `entries` は上限が無く大きく、掛けると正当な resume を壊すため。添付の `data` の合計だけを比べる。
        const attachmentDataBytes = (command.attachments ?? []).reduce(
          (sum, item) => sum + (item.data?.length ?? 0),
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

    .post(
      '/managers/:id/messages',
      bodyLimit({ maxSize: attachmentBodyMax, onError: tooLarge }),
      validated('json', runnerMessageCommandSchema, 'メッセージの入力の形が不正（置いていない）'),
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

    .post(
      '/managers/:id/answers',
      validated('json', runnerAnswerCommandSchema, '回答の入力の形が不正（置いていない）'),
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
      validated(
        'json',
        runnerRescueRefDeleteRequestSchema,
        '退避 ref の後始末の入力の形が不正（消していない）',
      ),
      async (c) => {
        const result = await host.deleteRescueRef(c.req.valid('json'), {
          signal: c.req.raw.signal,
        });
        return c.json(result);
      },
    )

    .delete('/managers/:id', async (c) => {
      // `keepPeers=1`: 鍵の付け替えのための畳み。peer を閉じずに預ける（#4734）
      const keepPeers = c.req.query('keepPeers') === '1';
      await host.stop(c.req.param('id'), keepPeers ? { keepPeers: true } : {});
      return c.json({ ok: true });
    })

    .get('/managers/:id/transcript', async (c) => {
      const body = await host.transcript(c.req.param('id'));
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    })

    // 上限を持たせる: 末尾の読みは `maxChars` に比例して読み・メモリを使うので、上限が無いと全文を読む口と変わらない。
    // 見回りが使う値（`TURN_END_PROBE_CHARS` = 20万字）の10倍まで許し、それ以上は断る（全文は `/transcript` が持つ）。
    .get('/managers/:id/transcript/tail', async (c) => {
      const raw = c.req.query('maxChars');
      const maxChars = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > TRANSCRIPT_TAIL_MAX_CHARS) {
        return c.json(
          { error: `maxChars は 1 以上 ${String(TRANSCRIPT_TAIL_MAX_CHARS)} 以下の整数` },
          400,
        );
      }
      const body = await host.transcriptTail(c.req.param('id'), maxChars);
      if (body === null) return c.json({ error: 'not found' as const }, 404);
      return c.text(body);
    })

    .get('/managers/:id/unpushed-work', async (c) => {
      const result = await host.unpushedWork(c.req.param('id'), { signal: c.req.raw.signal });
      if (result === undefined) return c.json({ error: 'not found' as const }, 404);
      return c.json(result);
    })

    // 大きいファイルの別口（Issue #4128 段3a）。デーモンが中身をストリームで押す向きだけで、runner から取りに行く経路は無い。
    // 本文は `bodyLimit` で縛らず、置き場が流しながら数えて `size` と上限で断る。置き先と作法は命令の添付と同じ。
    .put(
      '/managers/:id/attachments/:attachmentId',
      validated(
        'query',
        attachmentStageQuery,
        '別口の添付の控え（クエリ）の形が不正（置いていない）',
      ),
      async (c) => {
        const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (contentType !== 'application/octet-stream') {
          return c.json(
            { ok: false, error: 'content-type は application/octet-stream だけを受ける' },
            415,
          );
        }
        const query = c.req.valid('query');
        const raw = c.req.raw.body;
        const body: AsyncIterable<Uint8Array> =
          raw === null ? Readable.from([]) : Readable.fromWeb(raw as NodeWebReadableStream);
        try {
          await host.stageAttachment(
            c.req.param('id'),
            {
              id: c.req.param('attachmentId'),
              name: query.name,
              mediaType: query.type,
              size: query.size,
              sha256: query.sha256,
            },
            body,
          );
        } catch (error) {
          if (error instanceof RunnerAttachmentRejectedError) {
            const status = error instanceof RunnerAttachmentStageError ? error.status : 422;
            return c.json({ ok: false, error: reasonOf(error) }, status);
          }
          throw error;
        }
        return c.json({
          ok: true,
          id: c.req.param('attachmentId'),
          name: query.name,
          mediaType: query.type,
          size: query.size,
          sha256: query.sha256,
        });
      },
    )

    // 出し箱の退避先。デーモンが取りに来る向きだけで、runner からは押し上げない。中身は SSE に載せない。
    // `fileId` の形を先に検める: パス区切りや `..` を退避先のパスへ通さないため。
    .get('/managers/:id/outbox/:fileId', (c) => serveSpilledFile(c, host.openOutboxFile.bind(host)))

    // 無くても 204: 受け取った後に消す呼び出しが再送されても同じ結果になる（冪等）
    .delete('/managers/:id/outbox/:fileId', (c) =>
      deleteSpilledFile(c, host.deleteOutboxFile.bind(host)),
    )

    // 未追跡のファイルの預かりの退避先（`rescue_files`。#4863）。出し箱の退避先とは別の dir（予算・掃除を共有しない）。
    // デーモンが取りに来る向きだけ。`fileId` の形を先に検める
    .get('/managers/:id/rescue-files/:fileId', (c) =>
      serveSpilledFile(c, host.openRescueFile.bind(host)),
    )

    .delete('/managers/:id/rescue-files/:fileId', (c) =>
      deleteSpilledFile(c, host.deleteRescueFile.bind(host)),
    )

    // 預けた生ログの退避の本文（#4485）。デーモンが取りに来る向きだけで、SSE には載せない。`archiveId` の形を先に検める
    .get('/managers/:id/archive/:archiveId', (c) => {
      const archiveId = c.req.param('archiveId');
      if (!isArchiveRefId(archiveId)) return c.json({ error: 'invalid archiveId' as const }, 400);
      const body = host.readArchive(c.req.param('id'), archiveId);
      if (body === undefined) return c.json({ error: 'not found' as const }, 404);
      // 全部を返し終えた時点で取り終えた印を付ける（#4899）。読み手が最後の塊を受け取って次を求めたときに印を付ける
      // （`highWaterMark: 0` で、読まれるまで引かない）。途中で切れたら印は付かず、これまでどおり待つ・送り直す
      const managerId = c.req.param('id');
      const bytes = new TextEncoder().encode(body);
      const CHUNK = 1024 * 1024;
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close();
              host.markArchiveFetched(managerId, archiveId);
              return;
            }
            controller.enqueue(bytes.subarray(offset, offset + CHUNK));
            offset += CHUNK;
          },
        },
        { highWaterMark: 0 },
      );
      return c.body(stream, 200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(bytes.length),
      });
    })

    // 無くても 204（冪等）
    .delete('/managers/:id/archive/:archiveId', (c) => {
      const archiveId = c.req.param('archiveId');
      if (!isArchiveRefId(archiveId)) return c.json({ error: 'invalid archiveId' as const }, 400);
      host.deleteArchive(c.req.param('id'), archiveId);
      return c.body(null, 204);
    });

  return app;
}
