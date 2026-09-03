### Task 6: Documentation

**Files:**
- Create: `docs/knowledge-base.md`
- Modify: `README.md` (the section list and the links)

**Interfaces:** none.

**Context.** The guide an owner reads before they paste anything. Everything in it must be checkable in the cabinet, and every claim must describe the code as it stands — read the source, not this plan, wherever the two could disagree.

- [ ] **Step 1: Write the guide**

Create `docs/knowledge-base.md`, in Russian, under 200 lines. Read these before you write,
and describe what they actually do:

- `server/src/lib/knowledge/search.ts` — what the search matches and what it does not. Say
  plainly that it stems Russian and does not stem Kazakh, and what that means for someone
  whose products are named in Kazakh.
- `server/src/lib/knowledge/split.ts` — both rules, with a worked example of each. The
  pasted-text rule especially: an owner will paste, look at the result, and paste again, and
  the guide should let them predict the result the first time.
- `server/src/lib/knowledge/fetch-page.ts` — which pages can be imported and which are
  refused, in terms an owner can act on rather than in terms of HTTP.
- `server/src/api/knowledge.ts` — who may do what, the limits on a title and a body, and
  what a reimport keeps.

Cover, in this order: what the knowledge base is for and who reads it (the agent, from stage
5 — say that it does not exist yet, because a reader will otherwise expect answers today);
the five kinds of item and when to use each; writing one by hand; the two imports; what a
reimport preserves and why editing an imported item is safe; deleting a source and what
survives it; and how to check that the agent will find something — type the customer's own
question into the search box, because it is the same search.

Follow the shape of `docs/whatsapp-setup.md` and `docs/orders-funnel.md`: short sections, no
screenshots, no promises about stages that have not shipped.

- [ ] **Step 2: Point at it from the README**

In `README.md`, move «База знаний» out of the not-yet list into the working one, describe it
in one line, and link `docs/knowledge-base.md` beside the existing links.

- [ ] **Step 3: Check the line count**

```bash
wc -l docs/knowledge-base.md
```

Under 200. If it is over, cut rather than split — a guide this size is long because it is
restating the screen, and that part can go.

- [ ] **Step 4: Commit**

```bash
git add docs README.md
git commit -m "Document the knowledge base"
```
