import { Link } from 'react-router';

import { Page, Card, Empty } from '@alteroid/ui';

export default function NotFound() {
  return (
    <Page title="ページが見つかりません" description="そんな画面は無い">
      <Card>
        <Empty>
          <Link to="/" className="text-primary hover:underline">
            ホームへ戻る
          </Link>
        </Empty>
      </Card>
    </Page>
  );
}
