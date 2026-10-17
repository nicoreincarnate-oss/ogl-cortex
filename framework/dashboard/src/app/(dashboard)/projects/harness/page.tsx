import { HarnessProjects } from '@/components/projects/harness-projects';
import { readHarnessProjection } from '@/lib/data/harness';

export const dynamic = 'force-dynamic';

export default async function HarnessPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgFilter = typeof params.org === 'string' ? params.org : undefined;
  const snapshot = readHarnessProjection();

  return <HarnessProjects snapshot={snapshot} orgFilter={orgFilter} />;
}
