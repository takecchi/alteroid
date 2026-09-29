import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from './card';
import { Button } from './button';

const meta = {
  title: 'shadcn/Card',
  component: Card,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>マネージャー</CardTitle>
        <CardDescription>いま走っている作業の一覧です。</CardDescription>
        <CardAction>
          <Button size="sm" variant="ghost">
            編集
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground">未完了のタスクが3件あります。</p>
      </CardContent>
      <CardFooter>
        <Button size="sm">保存する</Button>
      </CardFooter>
    </Card>
  ),
};
