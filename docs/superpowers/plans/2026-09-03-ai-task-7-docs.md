### Task 7: Documentation

**Files:**
- Create: `docs/ai-agent.md`
- Modify: `README.md`

**Context.** The guide an owner reads before they turn the agent on for real customers. Describe the code as it stands — read the source, not this plan.

Read before writing: `server/src/lib/ai/prompt.ts` (what the agent is actually told), `server/src/lib/ai/turn.ts` (every refusal and every handoff), `server/src/lib/ai/openrouter.ts` (the models offered), and `server/src/api/ai.ts`.

Cover, in this order, in Russian, under 200 lines:

- what the agent can and cannot do — above all, that it answers only from the knowledge base, and that instructions change how it talks, never what it knows;
- getting an OpenRouter key and what a model costs;
- choosing a model, and what temperature does;
- writing instructions, with a worked example for a small Kazakhstan seller;
- the sandbox, and why to use it before turning the agent on;
- when the agent stays silent: off, taken over, the window closed, or the last word was ours;
- when it hands off, what the customer sees, and where the reason is written;
- how it moves leads and fills fields, and that a stage description is what it reads to decide;
- turning it off for one conversation versus for the whole agent;
- what a reply costs and where to see it.

Say plainly that this is the first version: it does not send pictures, does not follow up on its own, and does not learn from corrections. An owner should know what they are turning on.

`README.md`: move «Агент» into the working list with one line, and link `docs/ai-agent.md`.

- [ ] **Step 1: Write the guide**
- [ ] **Step 2: Point at it from the README**
- [ ] **Step 3: Check the line count**
- [ ] **Step 4: Commit**
