import { Card } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import type { SectionDef } from '@/lib/sections';

/**
 * A section that has no endpoint behind it yet.
 *
 * It says which stage brings it rather than showing an empty table: a table with no rows
 * reads as "no orders", which would be a lie about data that is not connected at all.
 */
export function SectionScreen({ section }: { section: SectionDef }) {
  return (
    <Card>
      <EmptyState>{section.pending}</EmptyState>
    </Card>
  );
}
