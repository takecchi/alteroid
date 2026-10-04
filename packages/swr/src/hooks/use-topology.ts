/**
 * 稼働の地図（`GET /topology/stream`）を購読する。**ホームだけが開く。**
 *
 * ## 日誌の購読（`useJournalLive`）とは違い、シェルで1本張らない
 *
 * 日誌の SSE を `AuthedShell` が1本だけ張るのは、**全画面のキャッシュ無効化を担う**
 * からである（どの画面にいても届いた出来事で SWR のキーを落とす）。複数の画面が
 * 自分で張ると同じ出来事を2回処理し、本数も画面の数だけ増える。
 *
 * こちらは**キャッシュを動かさない**。届いたスナップショットを持つだけで、使うのは
 * 地図を描くホームの1画面だけである。だから呼んだ画面が開いているあいだだけ張り、
 * 閉じれば中断する（開いたままのタブが、誰も見ていない地図のためにデーモンへ
 * 組み直しを要求し続けない）。**ホーム以外の画面から呼ぶ形を足すときは**、同時に
 * 2本張られないか（同じ地図を2か所で出すなら context 越しに共有する）を先に確かめること。
 *
 * ## 再接続
 *
 * `useJournalLive` と同じ指数バックオフ。heartbeat が塞ぐのはサーバ側の穴で、
 * 切られたあとに張り直すのはこちらの仕事である（`use-journal-live.ts` の冒頭）。
 *
 * ## 古いスナップショットを「いま」にしない
 *
 * - 切れた（`offline`）あとも**最後のスナップショットは残す**（まっさらにすると、
 *   一瞬の切断で地図が消える）。だから呼び手は `status` を見て、古いことを言う
 * - `unavailable`（デーモンが組めなかった）は、次の `snapshot` が届くまで残る。
 *   その間の `snapshot` は組めた最後のもので、いまの状態ではない
 * - `receivedAt` は**このブラウザが受け取った時刻**。「いま流れている」の窓は
 *   デーモンの `observedAt` を基準に、`receivedAt` からの経過で進める
 *   （ブラウザとデーモンの時計のずれで光が出たり消えたりしないように）
 */
import type { TopologySnapshot } from '@alteroid/logic';
import { useEffect, useState } from 'react';

import { useApiContext } from '../api';

import type { LiveStatus } from './use-journal-live';

/** 切れたときに待つ時間。指数で伸ばし、上限で頭打ちにする（日誌の購読と同じ）。 */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface TopologyLive {
  /** 最後に受け取った地図。まだ1つも届いていなければ無い。切れたあとも残る。 */
  snapshot?: TopologySnapshot;
  /** `snapshot` をこのブラウザが受け取った時刻（`Date.now()`）。 */
  receivedAt?: number;
  /** 購読の状態。最初のメッセージ（`snapshot` か `unavailable`）が届いたら `live`。 */
  status: LiveStatus;
  /**
   * デーモンが地図を組めなかった理由（種別だけ）。**次の `snapshot` が届くまで残る。**
   * 無ければ組めている。
   */
  unavailable?: string;
}

export function useTopology(): TopologyLive {
  const { client, baseUrl } = useApiContext();
  const [state, setState] = useState<TopologyLive>({ status: 'connecting' });

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function connect(): Promise<void> {
      setState((previous) => ({ ...previous, status: 'connecting' }));
      try {
        for await (const message of client.topologyStream({ signal: controller.signal })) {
          attempt = 0;
          if (message.event === 'snapshot') {
            setState({ snapshot: message.data, receivedAt: Date.now(), status: 'live' });
          } else if (message.event === 'unavailable') {
            // 直前のスナップショットは残す（古いと言えるように）。理由は種別だけが届く。
            setState((previous) => ({
              ...previous,
              status: 'live',
              unavailable: typeof message.data?.error === 'string' ? message.data.error : '不明',
            }));
          }
          // 知らない種別（版のずれ）は読み飛ばす。購読は切らない。
        }
      } catch {
        // 接続失敗も切断も同じ扱い（下の再接続へ）。中断だけは黙って抜ける。
      }
      if (stopped || controller.signal.aborted) return;

      setState((previous) => ({ ...previous, status: 'offline' }));
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

  return state;
}
