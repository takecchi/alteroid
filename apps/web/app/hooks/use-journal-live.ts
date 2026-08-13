/**
 * 日誌の SSE を1本だけ張り、届いた出来事で画面を更新する。
 *
 * デーモンは**あらゆる追記**を `GET /journal/stream` に流す（`journal-bus.ts` が
 * `JournalStore.append` を包んでいる）。だから購読はここ1本でよく、種別ごとに
 * 対応する SWR キーを無効化すれば画面全体が生きたままになる。ポーリングを
 * 画面ごとに足すと、負荷の割に遅く、しかも「どこが古いのか」が分からなくなる。
 *
 * 再接続を自分で持っているのは、デーモンが SSE に heartbeat を送らないため。
 * 間にプロキシが挟まると無通信で黙って切られることがあり、放っておくと画面は
 * 「静かなだけ」に見える（実際には死んでいる）。
 */
import { useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';

import { useApiContext } from '~/lib/api';
import type { JournalEntry } from '~/lib/types';

import { KEY } from './queries';

/** 切れたときに待つ時間。指数で伸ばし、上限で頭打ちにする。 */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** 画面に出しておく直近の件数。 */
const RECENT_LIMIT = 200;

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface JournalLive {
  status: LiveStatus;
  /** 新しい順。接続してから届いたものだけ（履歴は `useJournal` が持つ）。 */
  recent: JournalEntry[];
}

export function useJournalLive(): JournalLive {
  const { client, baseUrl } = useApiContext();
  const { mutate } = useSWRConfig();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [recent, setRecent] = useState<JournalEntry[]>([]);

  // `mutate` を購読の effect の依存に入れると、その同一性が崩れた瞬間に
  // SSE を張り直すことになる。購読は張りっぱなしにしたいので ref 越しに読む
  // （更新は effect の中で行う。レンダー中に ref を書くと、React が並行に
  // 描き直したときに書き込みが失われうる）。
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function connect(): Promise<void> {
      setStatus('connecting');
      try {
        for await (const message of client.journalStream({ signal: controller.signal })) {
          attempt = 0;
          if (message.event === 'open') {
            setStatus('live');
            continue;
          }
          const entry = message.data;
          setRecent((previous) => [entry, ...previous].slice(0, RECENT_LIMIT));
          invalidate(entry, mutateRef.current);
        }
      } catch {
        // 接続失敗も切断も同じ扱い（下の再接続へ）。中断だけは黙って抜ける。
      }
      if (stopped || controller.signal.aborted) return;

      setStatus('offline');
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
    // 接続先が変わったら張り直す。
  }, [client, baseUrl]);

  return { status, recent };
}

/** 届いた出来事に対応するキャッシュだけを落とす。 */
function invalidate(entry: JournalEntry, mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  // 日誌一覧は limit / type ごとにキーが違うので、type で束ねて全部落とす。
  void mutate((key) => isKeyOfType(key, 'journal'));

  switch (entry.type) {
    case 'escalation':
      void mutate((key) => isKeyOfType(key, 'approvals'));
      void mutate(KEY.managers);
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
      void mutate(KEY.managers);
      break;
    case 'exchange':
      if (entry.with === 'manager') void mutate(KEY.managers);
      if (entry.with === 'human') void mutate((key) => isKeyOfType(key, 'conversations'));
      break;
    case 'external_event':
    case 'decision':
      break;
  }
}

/** SWR のキーはオブジェクトなので、`type` を見て束で指す。 */
function isKeyOfType(key: unknown, type: string): boolean {
  return typeof key === 'object' && key !== null && (key as { type?: unknown }).type === type;
}
