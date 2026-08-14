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

import { isKeyOfType, KEY } from './queries';

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
      // マネージャー詳細・生ログも束で落とす。理由は下の `invalidateManagerDetail` に。
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
      void mutate(KEY.managers);
      invalidateManagerDetail(mutate);
      break;
    case 'exchange':
      if (entry.with === 'manager') {
        void mutate(KEY.managers);
        invalidateManagerDetail(mutate);
      }
      if (entry.with === 'human') {
        void mutate((key) => isKeyOfType(key, 'conversations'));
        // **一覧だけでなく本文も落とす。** ここを忘れると、会話の画面を開いた
        // ときに一度読んだ履歴のまま止まり、裏で進んだ往復が追いつかない。
        void mutate((key) => isKeyOfType(key, 'conversation'));
      }
      break;
    case 'external_event':
    case 'decision':
      break;
  }
}

/**
 * マネージャー詳細（`KEY.manager(id)`）と生ログ（`KEY.transcript(id)`）を
 * **id を指定せず束で**落とす。
 *
 * `tool_use.actor` は `manager:<id>` / `worker:<id>:<agent>` で id を取り出せるが、
 * `exchange(with:'manager')` には manager id を持つフィールドが無い。種別によって
 * 精度が変わる（tool_use だけ id 指定、他は束）形にすると考えることが増えて
 * 漏れやすい。キャッシュに載っているのは開いている詳細画面の分だけなので、
 * 束で落としても安い — だから常に束で統一する。
 */
function invalidateManagerDetail(mutate: ReturnType<typeof useSWRConfig>['mutate']): void {
  void mutate((key) => isKeyOfType(key, 'manager'));
  void mutate((key) => isKeyOfType(key, 'transcript'));
}
