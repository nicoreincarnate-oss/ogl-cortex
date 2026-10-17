import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type {
  HarnessHumanRequestProjection,
  HarnessProjectProjection,
  HarnessProjectStatus,
  HarnessProjectionSnapshot,
  HarnessSeatProjection,
  HarnessSeatState,
} from '@/lib/data/harness';

interface HarnessProjectsProps {
  snapshot: HarnessProjectionSnapshot;
  orgFilter?: string;
}

const LIVE_STATUSES = new Set<HarnessProjectStatus>([
  'admitted',
  'active',
  'blocked',
]);

function statusVariant(
  status: HarnessProjectStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'blocked') return 'destructive';
  if (status === 'active' || status === 'admitted') return 'default';
  if (status === 'completed') return 'secondary';
  return 'outline';
}

function label(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function projectProgress(project: HarnessProjectProjection): number | null {
  if (project.progress !== null) return project.progress;
  if (project.counts.total <= 0) return null;
  return (project.counts.completed / project.counts.total) * 100;
}

function formatUsd(microUsd: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(microUsd / 1_000_000);
}

function formatTimestamp(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function Metric({
  label: metricLabel,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{metricLabel}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

function ProjectCard({
  project,
  slot,
  compact = false,
}: {
  project: HarnessProjectProjection;
  slot?: number;
  compact?: boolean;
}) {
  const progress = projectProgress(project);
  const updatedAt = formatTimestamp(project.updatedAtMs);
  const spent = project.budget
    ? project.budget.spentMicroUsd + project.budget.reservedMicroUsd
    : null;

  return (
    <Card size={compact ? 'sm' : 'default'} className="h-full">
      <CardHeader>
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {slot ? `Project slot ${slot}` : project.org ?? 'Unscoped project'}
        </div>
        <CardTitle className="pr-20">{project.name}</CardTitle>
        <CardDescription className="font-mono text-xs">{project.id}</CardDescription>
        <CardAction>
          <Badge variant={statusVariant(project.status)}>{label(project.status)}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {(project.phase || project.currentNode || project.plannerSeat) && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {project.phase && (
              <>
                <dt className="text-muted-foreground">Phase</dt>
                <dd className="truncate text-right">{project.phase}</dd>
              </>
            )}
            {project.currentNode && (
              <>
                <dt className="text-muted-foreground">Current node</dt>
                <dd className="truncate text-right font-mono">{project.currentNode}</dd>
              </>
            )}
            {project.plannerSeat && (
              <>
                <dt className="text-muted-foreground">Planner</dt>
                <dd className="truncate text-right">{project.plannerSeat}</dd>
              </>
            )}
          </dl>
        )}

        {progress !== null && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Progress</span>
              <span className="tabular-nums">{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
          </div>
        )}

        {project.counts.total > 0 && (
          <div className="grid grid-cols-6 gap-1 rounded-lg bg-muted/50 p-2 text-center">
            {[
              ['Pending', project.counts.pending],
              ['Ready', project.counts.ready],
              ['Run', project.counts.running],
              ['Block', project.counts.blocked],
              ['Done', project.counts.completed],
              ['Fail', project.counts.failed],
            ].map(([nodeLabel, count]) => (
              <div key={nodeLabel}>
                <div className="text-sm font-medium tabular-nums">{count}</div>
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                  {nodeLabel}
                </div>
              </div>
            ))}
          </div>
        )}

        {(project.humanRequestsPending > 0 || project.approvalsPending > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {project.humanRequestsPending > 0 && (
              <Badge variant="outline">
                {project.humanRequestsPending} human request
                {project.humanRequestsPending === 1 ? '' : 's'}
              </Badge>
            )}
            {project.approvalsPending > 0 && (
              <Badge variant="outline">
                {project.approvalsPending} approval
                {project.approvalsPending === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
        )}

        {project.blockedReason && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {project.blockedReason}
          </p>
        )}

        {(spent !== null || updatedAt) && (
          <div className="flex flex-wrap justify-between gap-2 border-t pt-3 text-[11px] text-muted-foreground">
            {spent !== null && (
              <span>
                {formatUsd(spent)} committed
                {project.budget?.hardCapMicroUsd !== null &&
                  project.budget?.hardCapMicroUsd !== undefined &&
                  ` / ${formatUsd(project.budget.hardCapMicroUsd)} cap`}
              </span>
            )}
            {updatedAt && <time dateTime={updatedAt}>Updated {updatedAt}</time>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptySlot({ slot }: { slot: number }) {
  return (
    <Card className="min-h-52 border-dashed bg-muted/10">
      <CardHeader>
        <CardDescription className="text-[11px] font-medium uppercase tracking-wider">
          Project slot {slot}
        </CardDescription>
        <CardTitle>Available</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Waiting for the orchestrator to admit the next queued project.
      </CardContent>
    </Card>
  );
}

function HumanRequestsSection({
  requests,
  projects,
}: {
  requests: HarnessHumanRequestProjection[];
  projects: HarnessProjectProjection[];
}) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <section className="space-y-3" aria-labelledby="human-requests-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="human-requests-heading" className="text-lg font-medium">
            Open human requests
          </h2>
          <p className="text-sm text-muted-foreground">
            Agents created these tasks because work needs human input or a decision.
          </p>
        </div>
        <Badge variant={requests.length > 0 ? 'default' : 'outline'}>
          {requests.length} open
        </Badge>
      </div>

      <Card size="sm">
        <CardContent className="divide-y px-0">
          {requests.length > 0 ? (
            requests.map((request) => {
              const dueAt = formatTimestamp(request.dueAtMs);
              return (
                <div
                  key={request.id}
                  className="grid gap-2 px-3 py-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{request.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {projectNames.get(request.projectId) ?? request.projectId}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground md:text-right">
                    <div>{request.assignedTo ?? 'Unassigned'}</div>
                    <div>{dueAt ? `Due ${dueAt}` : 'No due time'}</div>
                  </div>
                  <Badge variant="outline">Open</Badge>
                </div>
              );
            })
          ) : (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No open human requests are present in the projection.
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function seatStateVariant(
  state: HarnessSeatState,
): 'default' | 'secondary' | 'outline' {
  if (state === 'running') return 'default';
  if (state === 'available') return 'secondary';
  return 'outline';
}

function SeatRosterSection({ seats }: { seats: HarnessSeatProjection[] }) {
  const groups: Array<{
    pool: HarnessSeatProjection['pool'];
    seats: HarnessSeatProjection[];
  }> = (['fable', 'codex', 'opus'] as const)
    .map((pool) => ({ pool, seats: seats.filter((seat) => seat.pool === pool) }))
    .filter((group) => group.seats.length > 0);
  const unknownSeats = seats.filter((seat) => seat.pool === 'unknown');
  if (unknownSeats.length > 0) {
    groups.push({ pool: 'unknown', seats: unknownSeats });
  }

  return (
    <section className="space-y-3" aria-labelledby="seat-roster-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="seat-roster-heading" className="text-lg font-medium">
            16-seat agent roster
          </h2>
          <p className="text-sm text-muted-foreground">
            Logical seat to physical agent mapping. Shadow leases are visible while executor control remains fail-closed.
          </p>
        </div>
        <Badge variant="outline">{seats.length} projected</Badge>
      </div>

      {groups.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-3">
          {groups.map((group) => (
            <div key={group.pool} className="overflow-hidden rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
                <h3 className="text-sm font-medium">{label(group.pool)}</h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {group.seats.length} seats
                </span>
              </div>
              <div className="divide-y">
                {group.seats.map((seat) => (
                  <div
                    key={seat.logicalSeat}
                    className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"
                  >
                    <span className="font-mono text-xs font-medium">
                      {seat.logicalSeat}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-xs">
                        {seat.physicalAgent ?? 'Unmapped'}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {seat.enabled ? 'Executor enabled' : 'Executor disabled'}
                        {seat.role ? `, ${seat.role}` : ''}
                      </div>
                    </div>
                    <Badge variant={seatStateVariant(seat.state)}>
                      {label(seat.state)}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card size="sm" className="border-dashed">
          <CardContent className="text-sm text-muted-foreground">
            No agent roster is present in the projection.
          </CardContent>
        </Card>
      )}
    </section>
  );
}

export function HarnessProjects({ snapshot, orgFilter }: HarnessProjectsProps) {
  const visibleProjects = orgFilter
    ? snapshot.projects.filter(
        (project) => project.org === null || project.org === orgFilter,
      )
    : snapshot.projects;
  const assigned = new Set<string>();
  const slots = Array.from<HarnessProjectProjection | null>({
    length: snapshot.maxLiveProjects,
  }).fill(null);

  for (const project of visibleProjects) {
    if (
      LIVE_STATUSES.has(project.status) &&
      project.slot !== null &&
      !slots[project.slot - 1]
    ) {
      slots[project.slot - 1] = project;
      assigned.add(project.id);
    }
  }
  for (const project of visibleProjects) {
    if (!LIVE_STATUSES.has(project.status) || assigned.has(project.id)) continue;
    const openIndex = slots.findIndex((slot) => slot === null);
    if (openIndex < 0) break;
    slots[openIndex] = project;
    assigned.add(project.id);
  }

  const queued = visibleProjects.filter(
    (project) =>
      project.status === 'queued' ||
      project.status === 'parked' ||
      project.status === 'paused',
  );
  const outcomes = visibleProjects
    .filter((project) =>
      ['completed', 'failed', 'cancelled'].includes(project.status),
    )
    .slice(0, 8);
  const visibleProjectIds = new Set(visibleProjects.map((project) => project.id));
  const openHumanRequests = snapshot.humanRequests.filter(
    (request) =>
      request.status === 'open' &&
      (!orgFilter || visibleProjectIds.has(request.projectId)),
  );

  if (!snapshot.available) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Project Harness</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only project, queue, and seat state from the harness projection.
          </p>
        </div>
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle>
              {snapshot.state === 'missing'
                ? 'Waiting for the first projection'
                : snapshot.state === 'stale'
                  ? 'Projection stale'
                  : 'Projection unavailable'}
            </CardTitle>
            <CardDescription>
              {snapshot.state === 'stale'
                ? 'The harness has stopped refreshing this view. Dispatch is shown fail-closed until a fresh projection arrives.'
                : 'Dispatch remains fail-closed. The dashboard will populate after the harness publishes a valid sanitized projection.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">No control-database access</Badge>
          </CardContent>
        </Card>
      </div>
    );
  }

  const generatedAt = formatTimestamp(snapshot.generatedAtMs);
  const occupiedSeats = snapshot.seatSummary.running + snapshot.seatSummary.leased;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">Project Harness</h1>
            <Badge variant={snapshot.mode === 'active' ? 'default' : 'outline'}>
              {label(snapshot.mode)}
            </Badge>
            <Badge variant="secondary">Projection only</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {orgFilter ? `Org: ${orgFilter}. ` : ''}Four concurrent project slots,
            shared seats, queue state, and human gates.
          </p>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          <div>Sequence {snapshot.sequence ?? 'N/A'}</div>
          {generatedAt && <time dateTime={generatedAt}>Generated {generatedAt}</time>}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Dispatch state"
          value={snapshot.dispatchEnabled ? 'Dispatch open' : 'Dispatch locked'}
          detail={
            snapshot.killSwitch
              ? 'Kill switch engaged'
              : snapshot.admissionMode === 'unknown'
                ? `${label(snapshot.mode)} mode, admission state not reported`
                : `${label(snapshot.admissionMode)} admission, ${label(snapshot.mode)} mode`
          }
        />
        <Metric
          label="Live projects"
          value={`${snapshot.liveProjects} active`}
          detail={`${snapshot.liveProjects} of ${snapshot.maxLiveProjects} slots occupied, ${snapshot.queuedProjects} queued`}
        />
        <Metric
          label="Agent seats"
          value={`${occupiedSeats} occupied`}
          detail={`${snapshot.seatSummary.available} available, ${snapshot.seatSummary.quarantined} quarantined, ${snapshot.seatSummary.total} total`}
        />
        <Metric
          label="Preflight"
          value={
            snapshot.preflightScope === 'compatibility-bus-projection'
              ? snapshot.compatibilityProjectionEffective
                ? 'Compatibility ready'
                : snapshot.compatibilityProjectionRequested
                  ? 'Compatibility blocked'
                  : 'Compatibility off'
              : snapshot.preflightReady === null
              ? 'Not reported'
              : snapshot.preflightReady
                ? 'Checks passed'
                : 'Checks blocked'
          }
          detail={
            snapshot.preflightScope === 'compatibility-bus-projection'
              ? snapshot.compatibilityProjectionEffective
                ? 'Compatibility bus projection is effective; production controls remain separate'
                : snapshot.compatibilityProjectionRequested
                  ? `${snapshot.preflightBlockers} compatibility blocker${snapshot.preflightBlockers === 1 ? '' : 's'}; shadow base ${snapshot.shadowBaseUsable ? 'usable' : 'unavailable'}`
                  : `Compatibility bus projection not requested; shadow base ${snapshot.shadowBaseUsable ? 'usable' : 'unavailable'}`
              : snapshot.preflightReady === null
              ? 'No preflight report was published'
              : snapshot.preflightReady
                ? '0 blockers reported'
                : snapshot.preflightBlockers > 0
                  ? `${snapshot.preflightBlockers} blocker${snapshot.preflightBlockers === 1 ? '' : 's'} reported`
                  : 'One or more checks failed'
          }
        />
      </div>

      <HumanRequestsSection
        requests={openHumanRequests}
        projects={visibleProjects}
      />

      <section className="space-y-3" aria-labelledby="live-projects-heading">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 id="live-projects-heading" className="text-lg font-medium">
              Live project slots
            </h2>
            <p className="text-sm text-muted-foreground">
              Each project keeps its own generation, plan graph, leases, and review loop.
            </p>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {slots.map((project, index) =>
            project ? (
              <ProjectCard key={project.id} project={project} slot={index + 1} />
            ) : (
              <EmptySlot key={`empty-slot-${index + 1}`} slot={index + 1} />
            ),
          )}
        </div>
      </section>

      <SeatRosterSection seats={snapshot.seats} />

      <section className="space-y-3" aria-labelledby="queue-heading">
        <div>
          <h2 id="queue-heading" className="text-lg font-medium">
            Waiting and paused projects
          </h2>
          <p className="text-sm text-muted-foreground">
            Queued projects wait for one of four slots. Paused projects keep their durable history without occupying a slot.
          </p>
        </div>
        {queued.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {queued.map((project) => (
              <ProjectCard key={project.id} project={project} compact />
            ))}
          </div>
        ) : (
          <Card size="sm" className="border-dashed">
            <CardContent className="text-sm text-muted-foreground">
              No projected projects are waiting for admission.
            </CardContent>
          </Card>
        )}
      </section>

      {outcomes.length > 0 && (
        <section className="space-y-3" aria-labelledby="outcomes-heading">
          <h2 id="outcomes-heading" className="text-lg font-medium">
            Recent outcomes
          </h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {outcomes.map((project) => (
              <ProjectCard key={project.id} project={project} compact />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
