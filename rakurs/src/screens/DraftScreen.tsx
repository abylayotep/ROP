import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '@/api';
import { CaseList } from '@/components/drafts/CaseList';
import { describeRun } from '@/components/drafts/cost';
import { OpDiff } from '@/components/drafts/OpDiff';
import { RunTable } from '@/components/drafts/RunTable';
import { Badge, Card, CardHead, Segmented, type SegmentItem } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { KbDraft, TestCase, TestRun } from '@/types';

/**
 * «Было — стало», read and decided. Reached only from `ProposalCard`'s «В черновик» — there
 * is no manual "new draft" flow yet, and no sidebar entry: a draft is something you arrive
 * at, not a section you browse.
 *
 * Owner-only on the server, the read included (`server/src/api/drafts.ts`,
 * `server/src/api/test-cases.ts`) — the same standing `CoachScreen` already gives its own
 * gate, copied here rather than shared, since the two screens have nothing else in common.
 *
 * How long a poll lives is bounded by how long the run itself runs, not by this component:
 * `useEffect`'s own cleanup is what stops it, on navigating away or on the run leaving
 * `'running'`, never a fixed number of attempts.
 */
const POLL_MS = 1800;

const STATUS_LABEL: Record<KbDraft['status'], string> = {
  open: 'Открыт',
  applied: 'Применён',
  discarded: 'Отклонён',
};

const TABS: SegmentItem<'run' | 'cases'>[] = [
  { id: 'run', label: 'Прогон' },
  { id: 'cases', label: 'Проверки' },
];

export function DraftScreen() {
  const { agent, role } = useAgent();
  const { draftId } = useParams<{ draftId: string }>();
  const owner = role === 'owner';

  const draft = useApi<KbDraft>(
    (signal) => (owner ? api.getDraft(agent.id, draftId!, signal) : Promise.resolve(null as never)),
    [agent.id, draftId, owner],
  );

  if (!owner) {
    return (
      <Card>
        <EmptyState>Черновики — дело владельца компании. У вас нет доступа к этому разделу.</EmptyState>
      </Card>
    );
  }

  return (
    <Async state={draft} skeleton={<Skeleton height={480} />}>
      {(loaded) => <Draft key={draftId} agentId={agent.id} draftId={draftId!} initial={loaded} />}
    </Async>
  );
}

function Draft({ agentId, draftId, initial }: { agentId: string; draftId: string; initial: KbDraft }) {
  const navigate = useNavigate();
  const toast = useToast();

  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState<'run' | 'cases'>('run');

  const cases = useApi<TestCase[]>((signal) => api.listTestCases(agentId, signal), [agentId]);

  // Defaults to every enabled case, exactly once — a reload after an edit must not silently
  // re-tick a case the owner had unchecked on purpose.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || !cases.data) return;
    defaulted.current = true;
    setSelected(new Set(cases.data.filter((c) => c.enabled).map((c) => c.id)));
  }, [cases.data]);

  // No route lists a draft's past runs — the only run this screen can ever know about is one
  // it started itself, in this session. `requestedCount` is remembered alongside it because
  // `run.results` only grows once cases actually finish, and «готово N из M» needs the M from
  // the moment the run was asked for, not from whatever has landed so far.
  const [run, setRun] = useState<TestRun | null>(null);
  const [requestedCount, setRequestedCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = () => {
      timer = setTimeout(async () => {
        try {
          const fresh = await api.getDraftRun(agentId, draftId, run.id);
          if (!alive) return;
          setRun(fresh);
          if (fresh.status === 'running') poll();
        } catch (error) {
          if (!alive) return;
          toast.fail(error);
        }
      }, POLL_MS);
    };
    poll();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status]);

  // The best guess this screen can make about which cases would reuse a baseline — the ones
  // that already carried one in the run just polled. There is no route that answers "does a
  // baseline exist" without running one; see `cost.ts`'s own comment on why being wrong here
  // only changes what the sentence says, never what the run itself spends.
  const baselineIds = useMemo(
    () => new Set((run?.results ?? []).filter((r) => r.before !== null).map((r) => r.caseId)),
    [run],
  );

  const selectedCases = useMemo(
    () => (cases.data ?? []).filter((c) => selected.has(c.id)),
    [cases.data, selected],
  );

  const isOpen = draft.status === 'open';
  const running = run?.status === 'running';
  const canRun = isOpen && !running && selectedCases.length > 0;
  const canApply = isOpen && run !== null && run.status === 'done';

  async function startRun() {
    if (!canRun || starting) return;
    setStarting(true);
    try {
      const ids = selectedCases.map((c) => c.id);
      const started = await api.runDraft(agentId, draftId, ids);
      setRequestedCount(ids.length);
      setRun(started);
    } catch (error) {
      toast.fail(error);
    } finally {
      setStarting(false);
    }
  }

  async function apply() {
    if (!canApply || applying) return;
    setApplying(true);
    try {
      const applied = await api.applyDraft(agentId, draftId);
      setDraft(applied);
      toast.ok('Черновик применён — правки уже в базе');
      navigate('../coach');
    } catch (error) {
      // The server's own words: a stale draft names what moved, a missing run says to run
      // it first — see `server/src/api/drafts.ts`'s own comment on the apply route. Shown
      // rather than a generic "не удалось", exactly what the brief asks for instead of
      // greying the button out on a guess.
      toast.fail(error);
    } finally {
      setApplying(false);
    }
  }

  async function discard() {
    if (!isOpen || discarding) return;
    if (!window.confirm('Отбросить черновик? Это нельзя отменить.')) return;
    setDiscarding(true);
    try {
      const discarded = await api.discardDraft(agentId, draftId);
      setDraft(discarded);
      toast.ok('Черновик отброшен');
      navigate('../coach');
    } catch (error) {
      toast.fail(error);
    } finally {
      setDiscarding(false);
    }
  }

  const verdictBadge: Record<KbDraft['status'], { bg: string; fg: string }> = {
    open: { bg: 'var(--seg)', fg: 'var(--text-dim)' },
    applied: { bg: 'var(--accent-a14)', fg: 'var(--accent)' },
    discarded: { bg: 'var(--danger-a14)', fg: 'var(--danger)' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardHead
          title={draft.title}
          right={
            <Badge bg={verdictBadge[draft.status].bg} fg={verdictBadge[draft.status].fg} size="md">
              {STATUS_LABEL[draft.status]}
            </Badge>
          }
        />
        <Segmented items={TABS} value={tab} onChange={setTab} size="sm" />
      </Card>

      {tab === 'run' ? (
        <>
          <OpDiff agentId={agentId} ops={draft.ops} />

          <Card>
            <CardHead title="Случаи для прогона" />
            <Async state={cases} skeleton={<Skeleton height={140} />}>
              {(loadedCases) => (
                <CaseList
                  agentId={agentId}
                  draftId={draftId}
                  cases={loadedCases}
                  onChanged={cases.reload}
                  selected={selected}
                  onSelectedChange={setSelected}
                />
              )}
            </Async>
          </Card>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn" disabled={!canRun || starting} onClick={startRun}>
                {running ? 'Прогон идёт…' : starting ? 'Запускаем…' : 'Запустить прогон'}
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                {selectedCases.length === 0
                  ? 'Отметьте хотя бы один случай.'
                  : describeRun(selectedCases, baselineIds)}
              </span>
            </div>

            <div style={{ marginTop: 16 }}>
              <RunTable agentId={agentId} cases={cases.data ?? []} run={run} requestedCount={requestedCount} />
            </div>
          </Card>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" className="btn-accent" disabled={!canApply || applying} onClick={apply}>
                {applying ? 'Применяем…' : 'Применить'}
              </button>
              <button type="button" className="btn" disabled={!isOpen || discarding} onClick={discard}>
                {discarding ? 'Отбрасываем…' : 'Отбросить'}
              </button>
              {isOpen && run === null && (
                <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                  Прогоните черновик хотя бы раз — иначе применить будет нечего проверить.
                </span>
              )}
            </div>
          </Card>
        </>
      ) : (
        <Card>
          <CardHead title="Проверки" />
          <Async state={cases} skeleton={<Skeleton height={200} />}>
            {(loadedCases) => (
              <CaseList
                agentId={agentId}
                draftId={draftId}
                cases={loadedCases}
                onChanged={cases.reload}
                selected={selected}
                onSelectedChange={setSelected}
              />
            )}
          </Async>
        </Card>
      )}
    </div>
  );
}
