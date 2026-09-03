### Task 11: The funnel editors and the documentation

**Files:**
- Create: `rakurs/src/screens/FunnelSettings.tsx` (its contents are in [task-11-editors.md](2026-09-03-orders-task-11-editors.md))
- Modify: `rakurs/src/screens/AgentSettingsScreen.tsx` (mount the editors under the form)
- Create: `docs/orders-funnel.md`
- Modify: `README.md` (one line in the section list)

**Interfaces:**
- Consumes: `listStages`, `createStage`, `updateStage`, `deleteStage`, `reorderStages`, `listLeadFields`, `createLeadField`, `deleteLeadField` from task 8; `useAgent` for the role.
- Produces: nothing other tasks read.

**Context.** The last piece: the owner shapes the funnel that task 2 seeded and task 3 guards, and the operator's guide explains what a stage description and a template are for.

**Owner only, and said so.** A member sees the funnel read-only with one line explaining who changes it — the same shape the agent form already uses.

**Reordering without drag.** Two arrows per row, because a settings list is not a board: the arrow says exactly what it will do, and the whole list is sent on every move, which is the only form task 3 accepts.

- [ ] **Step 1: Write the editors**

The two editors are long enough to live in their own document:
[task-11-editors.md](2026-09-03-orders-task-11-editors.md). Create
`rakurs/src/screens/FunnelSettings.tsx` with exactly the contents given there.

- [ ] **Step 2: Mount it under the agent form**

In `rakurs/src/screens/AgentSettingsScreen.tsx`, add the import and wrap the return of
`AgentSettingsScreen`:

```tsx
import { FunnelSettings } from '@/screens/FunnelSettings';
```

```tsx
export function AgentSettingsScreen() {
  const { agent, role, replace } = useAgent();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Keyed on the agent's id so the form cannot show one agent's name and save it
          onto another when the URL moves under a provider that stays alive. */}
      <SettingsForm key={agent.id} agent={agent} role={role} replace={replace} />
      <FunnelSettings key={`funnel:${agent.id}`} />
    </div>
  );
}
```

Move the comment that was above the old return into the JSX as shown, so it stays with the
`key` it explains.

- [ ] **Step 3: Check it compiles and builds**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

- [ ] **Step 4: Write the operator's guide**

Create `docs/orders-funnel.md`, in Russian, under 200 lines, covering:

- what a stage is and what the five kinds mean, with the rule that exactly one stage is the
  sale and why every number in statistics and in the Meta events depends on it;
- what the stage description is for — nobody reads it yet, the agent will in stage 5 — with
  one worked example of a description that is specific enough to act on;
- the auto-message: where `{{name}}` goes, that it is skipped when the 24-hour window is
  closed or the number is off, and that the reason lands in the lead's notes;
- lead fields, and that the hint is written for the agent, not for an operator;
- orders: that payment is marked by hand, that a repeat purchase is a second order, and
  that a lead can sit in the sale stage with no order without anything being wrong;
- the board: dragging a card, the Без стадии column, and that a card opens its thread;
- the customers table and its CSV, including that Excel needs no extra step because the
  file carries a byte order mark.

Follow the shape of `docs/whatsapp-setup.md`: short sections, no screenshots, every claim
checkable in the cabinet.

- [ ] **Step 5: Point at it from the README**

In `README.md`, in the list of sections, replace the Заказы line with one that says the
board, the lead card and the orders work, and link `docs/orders-funnel.md` beside the
existing link to `docs/whatsapp-setup.md`.

- [ ] **Step 6: Commit**

```bash
git add rakurs/src/screens/FunnelSettings.tsx rakurs/src/screens/AgentSettingsScreen.tsx docs/orders-funnel.md README.md
git commit -m "Let an owner edit the funnel, and document how it works"
```
