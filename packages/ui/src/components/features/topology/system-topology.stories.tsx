import { useEffect, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  busyScene,
  crowdedScene,
  idleScene,
  liveFrames,
  runnerDownScene,
  storageDownScene,
  unknownScene,
} from './samples';
import { SystemTopology } from './system-topology';

/**
 * 稼働の地図。器（デーモン・manager-runner・DB）と層（人間・クローン・マネージャー・作業者）を
 * 1枚に描き、指示（下り・紫）と報告（上り・青）が行き来している線に光を流す。
 * 札に触れるとその線だけが浮き、押すと詳細が出る（広い画面は Popover、狭い画面はシート）。
 */
const meta = {
  title: 'Features/Topology/SystemTopology',
  component: SystemTopology,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof SystemTopology>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 3本のマネージャーが走り、作業者へ指示が下り、報告が上っている。 */
export const Busy: Story = { args: busyScene };

/** 何も走っていない。光は流れない。 */
export const Idle: Story = { args: idleScene };

/** runner へ届かない。そこへ向かう線は破線にして、光を流さない。 */
export const RunnerOffline: Story = { args: runnerDownScene };

/** 確かめられない軸は「不明」（破線の札）。待機・正常とは描かない。 */
export const Unknown: Story = { args: unknownScene };

/** 記憶ストアへ繋がらない。理由を札に出し、線は破線にして光を流さない。 */
export const StorageDown: Story = { args: storageDownScene };

/** マネージャーと作業者が多いとき。出口と幹を線ごとに分けているので、線が重ならない。 */
export const Crowded: Story = { args: crowdedScene };

/** 狭い画面の配置（上から下への木）。押すと下からシートが出る。 */
export const Narrow: Story = { args: { ...busyScene, layout: 'narrow' } };

/** 場面を 2.5 秒ごとに巡る。実際の画面では SSE の出来事で同じ props が入れ替わる。 */
export const Live: Story = {
  args: busyScene,
  render: function Render(args) {
    const [i, setI] = useState(0);
    useEffect(() => {
      const t = setInterval(() => setI((n) => (n + 1) % liveFrames.length), 2500);
      return () => clearInterval(t);
    }, []);
    const frame = liveFrames[i] ?? busyScene;
    return <SystemTopology {...frame} layout={args.layout} />;
  },
};
