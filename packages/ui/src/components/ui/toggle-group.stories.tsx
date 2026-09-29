import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlignLeftIcon, AlignCenterIcon, AlignRightIcon } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from './toggle-group';

const meta = {
  title: 'UI/ToggleGroup',
  component: ToggleGroup,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ToggleGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  args: { type: 'single' },
  render: () => (
    <ToggleGroup type="single" defaultValue="left">
      <ToggleGroupItem value="left" aria-label="左寄せ">
        <AlignLeftIcon />
      </ToggleGroupItem>
      <ToggleGroupItem value="center" aria-label="中央寄せ">
        <AlignCenterIcon />
      </ToggleGroupItem>
      <ToggleGroupItem value="right" aria-label="右寄せ">
        <AlignRightIcon />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Multiple: Story = {
  args: { type: 'multiple' },
  render: () => (
    <ToggleGroup type="multiple" variant="outline" defaultValue={['bold']}>
      <ToggleGroupItem value="bold">太字</ToggleGroupItem>
      <ToggleGroupItem value="italic">斜体</ToggleGroupItem>
    </ToggleGroup>
  ),
};
