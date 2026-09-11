/** Mapping wizard page (spec 10.7). The wizard itself is shared with the first-run setup. */
import { PageHeader } from '../../ui';
import { AdminOnly } from './components/common';
import { MappingWizard } from './components/MappingWizard';

export function MappingPage() {
  return (
    <AdminOnly title="Mapping">
      <PageHeader
        title="Mapping"
        subtitle="Four steps · Tell the collector which FactoryLogix entity sets and fields hold jobs, unit events and defects."
      />
      <MappingWizard />
    </AdminOnly>
  );
}
