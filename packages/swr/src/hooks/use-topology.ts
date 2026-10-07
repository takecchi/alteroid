import type { TopologySnapshot } from '@alteroid/logic';
import { useEffect, useState } from 'react';

import { useApiContext } from '../api';

import type { LiveStatus } from './use-journal-live';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface TopologyLive {
  snapshot?: TopologySnapshot;
  receivedAt?: number;
  status: LiveStatus;
  unavailable?: string;
}

// シェルで1本張らず、呼んだ画面が開いているあいだだけ張る: キャッシュを動かさずホームだけが使うので、
// 開きっぱなしのタブに誰も見ていない地図をデーモンへ要求し続けさせない
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
            // 直前のスナップショットは残す: 呼び手が「古い」と言えるように
            setState((previous) => ({
              ...previous,
              status: 'live',
              unavailable: typeof message.data?.error === 'string' ? message.data.error : '不明',
            }));
          }
          // 知らない種別（版のずれ）は読み飛ばす: 購読は切らない
        }
      } catch {
        // 切断後の張り直しはこちらの仕事: heartbeat が塞ぐのはサーバ側の穴だけ
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
  }, [client, baseUrl]);

  return state;
}
