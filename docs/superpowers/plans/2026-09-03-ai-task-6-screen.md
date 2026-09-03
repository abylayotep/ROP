### Task 6: The agent screen and the sandbox

**Files:**
- Create: `rakurs/src/screens/AgentScreen.tsx`
- Modify: `rakurs/src/api/index.ts`, `rakurs/src/lib/sections.ts`, `rakurs/src/App.tsx`
- Modify: `rakurs/src/components/lead/LeadPanel.tsx` (the per-conversation switch)

**Interfaces:** consumes every route from task 5.

**Context.** Where an owner writes what their agent should say, picks the model, tries it, and turns it on. The section still shows its stage-5 placeholder; replace it.

**Comments English, strings Russian.** Match `KnowledgeScreen.tsx` and `CustomersScreen.tsx`.

The screen holds four things:

**Instructions.** A large textarea, saved explicitly. Above it, one line saying what it is for: what you sell, how you talk to customers, what you never promise. Say plainly that the agent answers only from the knowledge base and that instructions do not add facts — that is the misunderstanding this screen exists to prevent.

**The model.** A select from `GET /api/ai/models`, each with its description. Beside it, the temperature as a small number input with a line saying what it does in the owner's terms — lower is more predictable. And the OpenRouter key: a password input that shows «Ключ сохранён» when `keySet` is true and never shows the value, with a link to where an owner gets one. The same shape `IntegrationsScreen` uses for the WhatsApp token.

**The sandbox.** A message box and a «Проверить» button that calls the sandbox route. It shows the reply, the records the answer used with their titles, the stage it would have moved the lead to, the fields it would have filled, and the handoff with its reason. Say above it that nothing is sent and nothing is saved.

**The switch.** «Агент отвечает клиентам» — off by default. Refuse to turn it on, in the UI, when there is no key or no instructions, and say which is missing. An agent turned on with an empty prompt answers customers with whatever the model feels like.

In `LeadPanel.tsx`, add the per-conversation switch: «ИИ отвечает в этом диалоге», any member, with a line explaining that turning it off leaves the thread to a person and does not affect other conversations. Put it near the stage, where an operator is already looking when they decide to step in.

- [ ] **Step 1: Add the API calls**
- [ ] **Step 2: Route the screen** — `agent` loses its `pending`
- [ ] **Step 3: Write the screen**
- [ ] **Step 4: Add the switch to the lead panel**
- [ ] **Step 5: Check it compiles and builds**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
npm --prefix server run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add rakurs
git commit -m "Add the agent screen and the sandbox"
```
