### Task 6: The screen and the documentation

**Files:**
- Modify: `rakurs/src/screens/IntegrationsScreen.tsx`
- Modify: `rakurs/src/api/index.ts`
- Modify: `rakurs/src/components/lead/LeadPanel.tsx`
- Create: `docs/meta-capi.md`
- Modify: `README.md`

**Context.** Where the owner sets this up and sees whether it works. It belongs on Integrations, beside the WhatsApp number it depends on.

**The card.** Dataset id, access token (a password input showing «Токен сохранён», never the value), an optional test event code, and a switch. Saving verifies against Meta and says what happened. Above the form, one line explaining what this does in the owner's terms: покупки из переписки уходят в Meta, чтобы реклама искала похожих покупателей. Below it, plainly: reporting works only for conversations that came from a Click-to-WhatsApp ad.

**The log.** The last events: what, when, for how much, and the status. A failed one shows Meta's reason in full and offers «Отправить снова». A skipped one shows why it was skipped — that is the answer to «почему продажа не ушла».

**On the lead card,** for a conversation that came from an ad, show whether its sale was reported and offer to resend. For one that did not, say so rather than showing a disabled button with no explanation: “this lead did not come from an ad, so Meta has nothing to attribute a purchase to”.

**Comments English, strings Russian.** Match `KnowledgeScreen.tsx`. Never declare a component inside another's render body.

**The guide,** `docs/meta-capi.md`, Russian, under 200 lines: what this is for and what it will not do; getting a dataset id and a token from Meta Events Manager, in steps an owner can follow; the test event code and how to see events arriving in Events Manager; what is reported and when; what is NOT reported and why — a lead that did not come from an ad; what happens when Meta refuses; how to resend; and plainly, what is sent about the customer — the click, the hashed phone, the amount, and nothing else.

Read the code before writing the guide, not this plan.

`README.md`: move the Meta line into the working list and link the guide.

- [ ] **Step 1: The API calls**
- [ ] **Step 2: The Integrations card and log**
- [ ] **Step 3: The lead card**
- [ ] **Step 4: The guide and the README**
- [ ] **Step 5: `npm --prefix rakurs run typecheck`, `npm --prefix rakurs run build`, `npm --prefix server run typecheck`**
- [ ] **Step 6: Commit**
