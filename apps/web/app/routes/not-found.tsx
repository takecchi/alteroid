import { Link } from 'react-router';

import { Page } from '~/components/page';
import { Card, Empty } from '~/components/ui';

export default function NotFound() {
  return (
    <Page title="404" description="そんな画面は無い">
      <Card>
        <Empty>
          <Link to="/" className="text-accent hover:underline">
            ダッシュボードへ戻る
          </Link>
        </Empty>
      </Card>
    </Page>
  );
}
