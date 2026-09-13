import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '@/api';
import { AutopilotPanel } from '@/components/drafts/AutopilotPanel';
import { CaseList } from '@/components/drafts/CaseList';
import { describeRun } from '@/components/drafts/cost';
import { OpDiff, type OpEdit } from '@/components/drafts/OpDiff';
import { RunTable } from '@/components/drafts/RunTable';
import { Badge, Card, CardHead, Segmented, type SegmentItem } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { draftOrigin } from '@/lib/training-state';
import { useAgent } from '@/store/agent';
import type { DraftAutopilot, DraftOp, KbDraft, KbDraftDetail, TestCase, TestRun } from '@/types';
import './training-workspace.css';

/**
 * «Было — стало», read and decided. Reached only from `ProposalCard`'s «В черновик» — there
 * is no manual "new draft" flow yet, and no sidebar entry: a draft is something you arrive
 * at, not a section you browse.
 *
 * Owner-only on the server, the read included (`server/src/api/drafts.ts`,
 * `server/src/api/test-cases.ts`) — the same standing `CoachChat` already gives its own
 * gate, copied here rather than shared, since the two screens have nothing else in common.
 *
 * How long a poll lives is bounded by how long the run itself runs, not by this component:
 * `useEffect`'s own cleanup is what stops it, on navigating away or on the run leaving
 * `'running'`, never a fixed number of attempts.
 */
const POLL_MS = 1800;
const AUTOPILOT_POLL_MS = 3000;

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

  const draft = useApi<KbDraftDetail>(
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

function Draft({ agentId, draftId, initial }: { agentId: string; draftId: string; initial: KbDraftDetail }) {
  const navigate = useNavigate();
  const toast = useToast();

  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState<'run' | 'cases'>('run');

  // Whether `Draft` itself is still mounted — not the polling effect's own `alive`, below.
  // `[run?.id, run?.status]` in that effect's own deps means its cleanup fires and sets *its*
  // `alive` to `false` the instant the poll that reads a run's final status calls `setRun`,
  // because that status change is itself one of the effect's dependencies — before the nested
  // `api.getDraft` call a few lines down ever resolves. Gating that call's `setDraft` on the
  // same `alive` silently threw the fresh draft away every time: the effect had already torn
  // itself down by the time the fetch it started came back. This ref outlives that teardown.
  //
  // The setup function sets `mounted.current = true` itself, not only the initial `useRef`
  // value — `<StrictMode>` (`main.tsx`) runs every effect's setup, then its cleanup, then its
  // setup again on mount in development, precisely to catch an effect that only tears down and
  // never restores; a cleanup-only body here would leave `mounted.current` stuck `false` after
  // that simulated remount, with nothing left to ever set it back — caught by hand-testing
  // this exact fix against a live server, not by any type check.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  // `requestedCount` rides alongside `run` because `run.results` only grows once cases
  // actually finish, and «готово N из M» needs the M from the moment the run was asked for,
  // not from whatever has landed so far.
  const [run, setRun] = useState<TestRun | null>(null);
  const [requestedCount, setRequestedCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // Reopens the draft's own most recent run on load. `initial.runs` (newest first) is what
  // `GET .../drafts/:draftId` now carries for exactly this — a reload used to leave `run` null
  // until the owner started a fresh one, with no way to tell whether the draft had already
  // been proven. Runs once, on mount: `Draft` is remounted with `key={draftId}` per draft
  // (`DraftScreen` above), so a new draft always gets its own fresh look at its own history.
  useEffect(() => {
    const latest = initial.runs[0];
    if (!latest) return;
    let alive = true;
    (async () => {
      try {
        const fresh = await api.getDraftRun(agentId, draftId, latest.id);
        if (!alive) return;
        setRequestedCount(fresh.results.length);
        setRun(fresh);
      } catch (error) {
        if (!alive) return;
        toast.fail(error);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          if (fresh.status === 'running') {
            poll();
            return;
          }
          // The run just left `'running'` — `draft.applicable` is whatever `GET
          // .../drafts/:draftId` answered at mount (`initial`, above) and nothing since has
          // touched it, so «Применить» would stay disabled and the caption below it would go
          // on naming a reason that is no longer true until the page is reloaded. Re-fetching
          // the draft and writing straight into this component's own `draft` state — not a
          // `reload()` on the parent's `useApi` — is what actually fixes it: `Draft` took
          // `initial` into `useState` once, at mount, and a parent re-render does not by itself
          // push a new value into state a child already initialised from a stale prop. Gated on
          // `mounted`, not this effect's own `alive`: `alive` is already `false` by the time
          // this resolves — see `mounted`'s own comment above for why.
          try {
            const freshDraft = await api.getDraft(agentId, draftId);
            if (mounted.current) setDraft(freshDraft);
          } catch (error) {
            if (mounted.current) toast.fail(error);
          }
        } catch (error) {
          if (!alive) return;
          // The autopilot deletes runs when it edits a topic; a vanished run is not an error.
          if (error instanceof api.ApiError && error.status === 404) {
            setRun(null);
            return;
          }
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

  const [autopilot, setAutopilot] = useState<DraftAutopilot | null>(null);
  const [startingAuto, setStartingAuto] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getAutopilot(agentId, draftId).then(
      (loaded) => {
        if (alive) setAutopilot(loaded);
      },
      (error) => {
        if (alive) toast.fail(error);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The engine edits topics, adds cases and replaces runs under the owner, so every poll also
  // refetches the draft and follows the autopilot's own run. All reads land before any state is
  // set: the status change that ends this effect must not throw away the fetches that came with it.
  useEffect(() => {
    if (!autopilot || autopilot.status !== 'running') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    // `undefined` until the first poll, so a reopened screen syncs to the autopilot's run at once.
    let followedRunId: string | null | undefined;
    const caseKey = (ids: string[]) => [...ids].sort().join(',');
    let casesSeen = caseKey(autopilot.caseIds);
    // The server keeps going through a network blip or a deploy restart; so does the poll, and
    // the owner hears about an outage once rather than every three seconds.
    let failing = false;

    const poll = () => {
      timer = setTimeout(async () => {
        let fresh: DraftAutopilot | null;
        try {
          fresh = await api.getAutopilot(agentId, draftId);
        } catch (error) {
          if (!alive) return;
          if (!failing) toast.fail(error);
          failing = true;
          poll();
          return;
        }
        if (!alive) return;
        failing = false;
        if (!fresh) {
          setAutopilot(null);
          return;
        }

        let nextRun: TestRun | null | undefined;
        if (fresh.runId !== followedRunId) {
          try {
            nextRun = fresh.runId ? await api.getDraftRun(agentId, draftId, fresh.runId) : null;
            followedRunId = fresh.runId;
          } catch (error) {
            // Deleted by a topic edit between the two reads: show no run. Any other failure leaves
            // the run unfollowed so the next poll retries it.
            if (error instanceof api.ApiError && error.status === 404) {
              nextRun = null;
              followedRunId = fresh.runId;
            }
          }
        }
        const freshDraft = await api.getDraft(agentId, draftId).catch(() => null);
        if (!alive) return;

        if (nextRun !== undefined) {
          setRun(nextRun);
          setRequestedCount(nextRun?.status === 'running' ? fresh.caseIds.length : nextRun?.results.length ?? 0);
        }
        if (freshDraft) setDraft(freshDraft);
        if (caseKey(fresh.caseIds) !== casesSeen) {
          casesSeen = caseKey(fresh.caseIds);
          setSelected(new Set(fresh.caseIds));
          cases.reload();
        }
        setAutopilot(fresh);

        if (fresh.status === 'applied') {
          toast.ok('Черновик проверен и применён');
          navigate('../training?tab=review');
          return;
        }
        if (fresh.status === 'running') poll();
      }, AUTOPILOT_POLL_MS);
    };
    poll();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilot?.id, autopilot?.status]);

  // Which cases would reuse a baseline — the ones that already carried one in `run`, which is
  // now always the draft's own most recent run (reopened on load above, or the one just
  // started), never a guess left over from a session that has since reloaded. There is still
  // no route that answers "does a baseline exist" for an *unrun* case, so this can be stale
  // the moment a case is added or its baseline expires between polls — see `cost.ts`'s own
  // comment on why being wrong here only changes what the sentence says, never what a run
  // itself spends.
  const baselineIds = useMemo(
    () => new Set((run?.results ?? []).filter((r) => r.before !== null).map((r) => r.caseId)),
    [run],
  );

  // Ticked *and* switched on. The server drops a disabled case from the run, so counting one
  // here would price work nobody pays for and leave «готово N из M» one short forever.
  const selectedCases = useMemo(
    () => (cases.data ?? []).filter((c) => selected.has(c.id) && c.enabled),
    [cases.data, selected],
  );
  const requiredCase = draft.requiredCaseId
    ? cases.data?.find((item) => item.id === draft.requiredCaseId) : null;

  const isOpen = draft.status === 'open';
  const running = run?.status === 'running';
  const autoRunning = autopilot?.status === 'running';
  const canRun = isOpen && !running && !autoRunning && selectedCases.length > 0;
  // The server's own answer to "is this draft provably safe to apply right now" — the exact
  // predicate the apply route itself checks (`server/src/api/drafts.ts`'s `isDraftApplicable`),
  // not a local guess from `run.status` that a reload used to lose and that never accounted
  // for the store having moved since the run finished.
  const canApply = isOpen && !autoRunning && draft.applicable;

  async function startAutopilot() {
    if (!isOpen || running || autoRunning || startingAuto) return;
    setStartingAuto(true);
    try {
      setAutopilot(await api.startAutopilot(agentId, draftId, selectedCases.map((c) => c.id)));
    } catch (error) {
      toast.fail(error);
    } finally {
      setStartingAuto(false);
    }
  }

  async function cancelAutopilot() {
    if (cancelling) return;
    setCancelling(true);
    try {
      const cancelled = await api.cancelAutopilot(agentId, draftId);
      // The engine may have edited topics before it saw the cancel.
      const freshDraft = await api.getDraft(agentId, draftId).catch(() => null);
      if (!mounted.current) return;
      setAutopilot(cancelled);
      if (freshDraft) setDraft(freshDraft);
    } catch (error) {
      if (mounted.current) toast.fail(error);
    } finally {
      if (mounted.current) setCancelling(false);
    }
  }

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
      // The apply route answers with the plain `KbDraft` it always has — `runs` and
      // `applicable` are the GET route's own addition (see `packages/contract/index.ts`'s
      // `KbDraftDetail`) and stay whatever they last were rather than being re-fetched for a
      // screen that is about to navigate away regardless.
      setDraft((prev) => ({ ...prev, ...applied }));
      toast.ok('Черновик применён — правки уже в базе');
      navigate('../training?tab=review');
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

  // Removing or rewriting a topic changes what a run would prove, so the server drops the
  // draft's runs; the screen forgets the reopened run and «Применить» waits for a new one.
  async function editOp(index: number, current: DraftOp, edit: OpEdit): Promise<boolean> {
    try {
      const updated = await api.editDraftOp(agentId, draftId, { index, current, ...edit });
      setDraft((prev) => ({ ...prev, ...updated, runs: [], applicable: false }));
      setRun(null);
      setRequestedCount(0);
      toast.ok(edit.action === 'remove' ? 'Тема убрана из черновика' : 'Тема сохранена');
      return true;
    } catch (error) {
      toast.fail(error);
      return false;
    }
  }

  async function discard() {
    if (!isOpen || autoRunning || discarding) return;
    if (!window.confirm('Отбросить черновик? Это нельзя отменить.')) return;
    setDiscarding(true);
    try {
      const discarded = await api.discardDraft(agentId, draftId);
      setDraft((prev) => ({ ...prev, ...discarded }));
      toast.ok('Черновик отброшен');
      navigate('../training?tab=review');
    } catch (error) {
      toast.fail(error);
    } finally {
      setDiscarding(false);
    }
  }

  const topics = draftOrigin(draft) === 'Из переписки';
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
        <DraftBanner status={draft.status} topics={topics} />
        <Segmented items={TABS} value={tab} onChange={setTab} size="sm" />
      </Card>

      {tab === 'run' ? (
        <>
          <OpDiff agentId={agentId} ops={draft.ops} topics={topics}
            onEdit={isOpen && !running && !autoRunning ? editOp : undefined} />

          <Card>
            <CardHead title="Случаи для прогона" />
            {draft.requiredCaseId && <p role="status">Для этого исправления обязателен исходный случай.
              {requiredCase ? ` ${requiredCase.title}` : ' Если случай не найден, обновите список или создайте предложение заново.'}
            </p>}
            <Async state={cases} skeleton={<Skeleton height={140} />}>
              {(loadedCases) => (
                <CaseList
                  agentId={agentId}
                  draftId={draftId}
                  cases={loadedCases}
                  onChanged={cases.reload}
                  selected={selected}
                  onSelectedChange={setSelected}
                  selectionDisabled={autoRunning}
                />
              )}
            </Async>
          </Card>

          <Card>
            <CardHead title="Прогон" />
            <RunTable
              agentId={agentId}
              cases={cases.data ?? []}
              run={run}
              requestedCount={requestedCount}
              ops={draft.ops}
              base={draft.base}
            />
          </Card>

          {autopilot && (
            <AutopilotPanel autopilot={autopilot} onCancel={() => void cancelAutopilot()} cancelling={cancelling} />
          )}

          <Card className="draft-actionbar">
            <div className="draft-actionbar__row">
              <button type="button" className="btn-accent" disabled={!isOpen || running || autoRunning || startingAuto}
                onClick={startAutopilot}>
                {autoRunning || startingAuto ? 'Проверяем…' : 'Проверить и применить'}
              </button>
              <button type="button" className="btn" disabled={!canRun || starting} onClick={startRun}>
                {running ? 'Прогон идёт…' : starting ? 'Запускаем…' : 'Запустить прогон'}
              </button>
              <button type="button" className="btn" disabled={!canApply || applying} onClick={apply}>
                {applying ? 'Применяем…' : 'Применить'}
              </button>
              <button type="button" className="btn" disabled={!isOpen || autoRunning || discarding} onClick={discard}>
                {discarding ? 'Отбрасываем…' : 'Отбросить'}
              </button>
              {isOpen && !autoRunning && (
                <span className="draft-actionbar__hint">
                  {canApply
                    ? `Прогон пройден — нажмите «Применить», и ${topics ? 'темы попадут в базу знаний' : 'изменение попадёт в базу'}.`
                    : running
                    ? 'Прогон идёт — дождитесь «готово».'
                    : selectedCases.length === 0
                    ? 'Нажмите «Проверить и применить» — проверки подберутся сами, или отметьте случаи и запустите прогон вручную.'
                    : draft.requiredCaseId && !requiredCase
                    ? 'Обязательный случай исправления не найден. Обновите список; если он удалён, создайте предложение заново.'
                    : draft.requiredCaseId && run?.status === 'done' && run.results.find((result) => result.caseId === draft.requiredCaseId)?.verdict !== 'better'
                      ? 'Исходный случай должен стать лучше. Исправьте предложение и повторите прогон.'
                    : draft.runs.length === 0
                    ? `Прогоните черновик хотя бы раз. ${describeRun(selectedCases, baselineIds)}`
                    : 'База изменилась после последнего прогона — прогоните черновик заново.'}
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
                selectionDisabled={autoRunning}
              />
            )}
          </Async>
        </Card>
      )}
    </div>
  );
}

/** Says, before anything else on the screen, whether this is already in the agent's base and
 * what the owner does next — the list of topics alone read as if it had already landed. */
function DraftBanner({ status, topics }: { status: KbDraft['status']; topics: boolean }) {
  const what = topics ? 'Темы' : 'Изменения';
  if (status === 'applied') {
    return <div className="draft-banner" role="status"><span className="draft-banner__title">Применён — {what.toLowerCase()} уже в базе, агент их использует.</span></div>;
  }
  if (status === 'discarded') {
    return <div className="draft-banner" role="status"><span className="draft-banner__title">Отброшен — в базу ничего не попало.</span></div>;
  }
  return (
    <div className="draft-banner" role="status">
      <span className="draft-banner__title">Это черновик: {what.toLowerCase()} ещё не в базе, агент их пока не использует.</span>
      <ol>
        <li>{topics ? 'Уберите лишние темы и поправьте неточные.' : 'Прочитайте изменение ниже.'}</li>
        <li>Отметьте случаи и нажмите «Запустить прогон» — агент ответит на них с черновиком и без.</li>
        <li>Когда прогон готов, нажмите «Применить» — {topics ? 'темы появятся во вкладке «Знания»' : 'изменение попадёт в базу'}.</li>
      </ol>
    </div>
  );
}
