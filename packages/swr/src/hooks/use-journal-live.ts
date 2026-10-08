import { useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';

import { useApiContext } from '../api';
import type { JournalEntry } from '@alteroid/logic';

import { isKeyOfType, KEY } from './queries';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

const RECENT_LIMIT = 200;

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface JournalLive {
  status: LiveStatus;
  recent: JournalEntry[];
  /** `RECENT_LIMIT` で切る前の総数。optional なのは、この型を直に組み立てるテストを壊さないためだけ。 */
  receivedCount?: number;
}

export function useJournalLive(enabled = true): JournalLive {
  const { client, baseUrl } = useApiContext();
  const { mutate } = useSWRConfig();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [recent, setRecent] = useState<JournalEntry[]>([]);
  const [receivedCount, setReceivedCount] = useState(0);

  // `mutate` を effect の依存に入れず ref 越しに読む: 同一性が崩れるたびに SSE を張り直すことになるため。
  // 更新を effect の中で行うのは、レンダー中に ref を書くと並行描画で書き込みが失われうるため
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let lost = false;

    async function connect(): Promise<void> {
      setStatus('connecting');
      try {
        for await (const message of client.journalStream({ signal: controller.signal })) {
          attempt = 0;
          if (message.event === 'open') {
            setStatus('live');
            if (lost) {
              lost = false;
              refetchMounted(mutateRef.current);
            }
            continue;
          }
          const entry = message.data;
          setRecent((previous) => [entry, ...previous].slice(0, RECENT_LIMIT));
          setReceivedCount((previous) => previous + 1);
          invalidate(entry, mutateRef.current);
        }
      } catch {
        // heartbeat があっても再接続は要る: 切られた側がブラウザだと、張り直さない限り画面は生きたまま古くなる
      }
      if (stopped || controller.signal.aborted) return;

      setStatus('offline');
      lost = true;
      const wait = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
      attempt += 1;
      timer = setTimeout(() => void connect(), wait);
    }

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, baseUrl, enabled]);

  // 止めている間は前の `live` を出さない: 届いていないのに受信中に見えるため
  return { status: enabled ? status : 'offline', recent, receivedCount };
}

// 除く理由: profile / mcpServers は値に鍵が入りうるので勝手に運ばない。
// authState は取り直しが失敗すると画面全体が置き換わるうえ、SSE の再接続では変わらない
const REFETCH_EXCLUDED_TYPES = new Set(['profile', 'mcpServers', 'authState']);

function refetchMounted(mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  void mutate((key) => {
    const type =
      typeof key === 'object' && key !== null ? (key as { type?: unknown }).type : undefined;
    return !(typeof type === 'string' && REFETCH_EXCLUDED_TYPES.has(type));
  });
}

// `@alteroid/core` の `CLONE_TOOL_NAMES` の写し: core の実行時コードを画面のバンドルへ持ち込まないため。
// `commitment_list` は含めない: クローンが一覧を読むたびに画面が取り直すことになる
const LEDGER_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'commitment_open',
  'commitment_close',
  'commitment_close_many',
  'commitment_edit',
]);

function invalidate(entry: JournalEntry, mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  void mutate((key) => isKeyOfType(key, 'journal'));

  switch (entry.type) {
    case 'escalation':
      void mutate((key) => isKeyOfType(key, 'approvals'));
      void mutate((key) => isKeyOfType(key, 'managers'));
      invalidateManagerDetail(mutate);
      break;
    case 'memory_update':
      void mutate(KEY.memory);
      void mutate(KEY.memoryDoc(entry.slug));
      break;
    case 'daily_report':
      void mutate((key) => isKeyOfType(key, 'reports'));
      void mutate(KEY.report(entry.date));
      break;
    case 'tool_use':
      // 台帳の分岐は `isCloneActor` の関門より前に置く: 台帳を動かすのは主にクローン自身で、関門の後だと落とせない
      if (LEDGER_WRITE_TOOLS.has(entry.tool)) {
        void mutate((key) => isKeyOfType(key, 'commitments'));
      }
      // クローン自身の `tool_use` では `managers` を落とさない: マネージャーが動いていないのに、クローンの作業中ずっと再取得を続けることになる
      if (!isCloneActor(entry.actor)) {
        void mutate((key) => isKeyOfType(key, 'managers'));
        invalidateManagerDetail(mutate);
      }
      break;
    case 'exchange':
      if (entry.with === 'manager') {
        void mutate((key) => isKeyOfType(key, 'managers'));
        invalidateManagerDetail(mutate);
        void mutate((key) => isKeyOfType(key, 'commitments'));
      }
      if (entry.with === 'human') {
        void mutate((key) => isKeyOfType(key, 'commitments'));
        void mutate((key) => isKeyOfType(key, 'conversations'));
        void mutate((key) => isKeyOfType(key, 'conversationUnreadCount'));
        // 一覧だけでなく本文も落とす: 開いた会話の画面が一度読んだ履歴のまま止まるため
        void mutate((key) => isKeyOfType(key, 'conversation'));
      }
      break;
    case 'external_event':
      break;
    case 'decision':
      // 印の無い行（欄が入る前の daemon が積んだ行）は取り直さない: 文面から推測すると取り違え・取り直しすぎになる
      if (entry.target?.kind === 'practice') {
        void mutate(KEY.practices);
        void mutate(KEY.practice(entry.target.slug));
        void mutate(KEY.practiceVersions(entry.target.slug));
      }
      break;
    case 'worker_wait':
      break;
    case 'turn_usage':
      break;
    case 'context_usage':
      break;
    case 'token_rotation':
      void mutate(KEY.tokens);
      break;
    // `exchange` と同じにしない: マネージャーの詳細や生ログの中身を変える出来事ではない
    case 'subagent_stall':
      break;
    case 'inbox_flow':
      break;
    case 'github_observation':
      break;
    case 'conversation_deleted':
      // 墓標が積まれた瞬間から、その会話の発言は読み口から外れる（#4218）: 一覧・未読数・開いている本文・台帳を読み直す
      void mutate((key) => isKeyOfType(key, 'conversations'));
      void mutate((key) => isKeyOfType(key, 'conversationUnreadCount'));
      void mutate((key) => isKeyOfType(key, 'conversation'));
      void mutate((key) => isKeyOfType(key, 'commitments'));
      break;
    default: {
      // `never` で網羅性を型に縛る: switch 文自体は網羅性を検査せず、`void` の関数では return 漏れの型エラーも出ない。
      // 実行時は投げない: SSE の `for await` の外側の `catch` が再接続へ落ちるので、
      // 古い bundle のブラウザが未知の種別を受けると、購読が切れたまま繋ぎ直し続ける
      const exhaustive: never = entry;
      void exhaustive;
      break;
    }
  }
}

// `@alteroid/core` の `isCloneActor` の写し: core の実行時コード（zod・`node:*`）を画面のバンドルへ持ち込まないため。枝を増やすときは両方直す
function isCloneActor(actor: string): boolean {
  return actor === 'clone' || actor.startsWith('clone:');
}

// id を指定せず束で落とす: `exchange(with:'manager')` に manager id が無く、種別で精度が変わると漏れやすい
function invalidateManagerDetail(mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  void mutate((key) => isKeyOfType(key, 'manager'));
  void mutate((key) => isKeyOfType(key, 'transcript'));
}
