import { useEffect, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  awaitingScene,
  busyScene,
  crowdedScene,
  externalsScene,
  idleScene,
  liveFrames,
  perRunnerScene,
  runnerDownScene,
  runnerUnknownScene,
  storageDownScene,
  unknownScene,
  unreadableEmptyScene,
  usageBlockedScene,
} from './samples';
import { SystemTopology } from './system-topology';

const meta = {
  title: 'Features/Topology/SystemTopology',
  component: SystemTopology,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof SystemTopology>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Busy: Story = { args: busyScene };

export const Idle: Story = { args: idleScene };

export const RunnerOffline: Story = { args: runnerDownScene };

export const RunnerUnknown: Story = { args: runnerUnknownScene };

export const PerRunner: Story = { args: perRunnerScene };

export const UnreadableRows: Story = { args: unreadableEmptyScene };

export const Awaiting: Story = { args: awaitingScene };
export const UsageBlocked: Story = { args: usageBlockedScene };

export const Unknown: Story = { args: unknownScene };

export const StorageDown: Story = { args: storageDownScene };

export const Crowded: Story = { args: crowdedScene };

export const Externals: Story = { args: externalsScene };

export const Narrow: Story = { args: { ...busyScene, layout: 'narrow' } };

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
