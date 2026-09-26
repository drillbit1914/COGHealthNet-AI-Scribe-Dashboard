'use client';

import { TimeOffPanel } from '@/components/admin/time-off';
import { PageHeader } from '@/components/admin/ui';

export default function TimeOffPage() {
  return (
    <div>
      <PageHeader title="Time off" />
      <TimeOffPanel />
    </div>
  );
}
