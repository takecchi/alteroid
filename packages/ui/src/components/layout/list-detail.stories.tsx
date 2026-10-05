import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '../common';
import { ListDetail, ListDetailItems } from './list-detail';
import { sampleEntries } from './list-detail-samples';

/**
 * 一覧＋詳細の共通レイアウト。広い画面では左に一覧・右に詳細（それぞれ独立にスクロール）。
 * 狭い画面では未選択なら一覧、選択ありなら詳細で、上端のボタンから一覧をドロワーに出す。
 * 親の高さを受けるので、見本では高さ固定の箱で包む。
 */
const meta = {
  title: 'Layout/ListDetail',
  component: ListDetail,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ListDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({
  count,
  initial,
  withFooter,
}: {
  count: number;
  initial?: string;
  withFooter?: boolean;
}) {
  const entries = sampleEntries(count);
  const [selected, setSelected] = useState(initial);
  const entry = entries.find((e) => e.id === selected);
  return (
    <div className="h-[600px] border border-border">
      <ListDetail
        listLabel="日報"
        hasSelection={entry !== undefined}
        selectionKey={selected}
        emptyDetail={
          <p className="text-sm text-muted-foreground">左の一覧から日報を選んでください。</p>
        }
        listFooter={
          withFooter ? (
            <div className="p-2">
              <Button size="sm" variant="ghost" className="w-full">
                さらに読む
              </Button>
            </div>
          ) : undefined
        }
        list={
          <ListDetailItems
            label="日報の一覧"
            items={entries.map((e) => ({
              key: e.id,
              href: `#${e.id}`,
              current: e.id === selected,
              children: (
                <>
                  <p className="truncate text-xs">{e.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{e.date}</p>
                </>
              ),
            }))}
            renderLink={(props) => (
              <a
                {...props}
                onClick={(event) => {
                  event.preventDefault();
                  setSelected(props.href.slice(1));
                  props.onClick(event);
                }}
              >
                {props.children}
              </a>
            )}
          />
        }
        detail={
          entry && (
            <article>
              <h2 className="text-base font-semibold">{entry.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{entry.date}</p>
              <p className="mt-4 text-sm">{entry.body}</p>
              {Array.from({ length: 30 }, (_, i) => (
                <p key={i} className="mt-3 text-sm text-muted-foreground">
                  詳細が長いときは右のペインだけがスクロールする（{i + 1}）。
                </p>
              ))}
            </article>
          )
        }
      />
    </div>
  );
}

const args = {
  listLabel: '日報',
  list: null,
  detail: null,
  hasSelection: false,
};

export const Selected: Story = { args, render: () => <Demo count={6} initial="2" /> };

export const Unselected: Story = { args, render: () => <Demo count={6} /> };

/** 項目が多く、一覧の下端に「さらに読む」がある。一覧と詳細は別々にスクロールする。 */
export const ManyItems: Story = {
  args,
  render: () => <Demo count={60} initial="25" withFooter />,
};

/** 題名だけがリンクで、名前・日時は選択・コピーできる形（`extra` / `lead`）。 */
function PartialDemo() {
  const entries = sampleEntries(12);
  const [selected, setSelected] = useState<string | undefined>('3');
  return (
    <div className="h-[600px] border border-border">
      <ListDetail
        listLabel="記憶"
        hasSelection={selected !== undefined}
        selectionKey={selected}
        detail={<h2 className="text-base font-semibold">{selected}</h2>}
        list={
          <ListDetailItems
            label="記憶の一覧"
            items={entries.map((e) => ({
              key: e.id,
              href: `#${e.id}`,
              current: e.id === selected,
              lead: <span className="mr-1.5 shrink-0 text-[10px] text-muted-foreground">前提</span>,
              children: e.title,
              extra: (
                <>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{e.id}</p>
                  <p className="text-[11px] text-muted-foreground">{e.date}</p>
                </>
              ),
            }))}
            renderLink={(props) => (
              <a
                {...props}
                onClick={(event) => {
                  event.preventDefault();
                  setSelected(props.href.slice(1));
                  props.onClick(event);
                }}
              >
                {props.children}
              </a>
            )}
          />
        }
      />
    </div>
  );
}

export const PartialLink: Story = {
  args,
  render: () => <PartialDemo />,
};
