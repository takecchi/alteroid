import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

const meta = {
  title: 'shadcn/Tabs',
  component: Tabs,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="journal" className="w-80">
      <TabsList>
        <TabsTrigger value="journal">日誌</TabsTrigger>
        <TabsTrigger value="settings">設定</TabsTrigger>
      </TabsList>
      <TabsContent value="journal">マネージャーの日誌がここに表示されます。</TabsContent>
      <TabsContent value="settings">設定の項目がここに表示されます。</TabsContent>
    </Tabs>
  ),
};

export const LineVariant: Story = {
  render: () => (
    <Tabs defaultValue="a" className="w-80">
      <TabsList variant="line">
        <TabsTrigger value="a">実行中</TabsTrigger>
        <TabsTrigger value="b">完了</TabsTrigger>
      </TabsList>
      <TabsContent value="a">実行中のマネージャーはいません。</TabsContent>
      <TabsContent value="b">完了した作業が3件あります。</TabsContent>
    </Tabs>
  ),
};
