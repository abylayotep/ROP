# Semantic Funnel Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Execution is delegated to gpt-5.6-sol as requested by the user.

**Goal:** Classify leads with retained conversational evidence and make funnel cards the entry point for sales conversations.

**Architecture:** Extend the current incremental CRM context and payment evidence fields while retaining the existing authoritative POS boundary. Reuse the existing conversation workspace inside a board-owned accessible modal. Apply seller payment instructions through agent configuration rather than global merchant-specific prompt behavior.

**Tech Stack:** Existing TypeScript server, CRM model worker, Kaspi POS integration, React rakurs frontend, and workspace test runners.

**Spec:** `docs/superpowers/specs/2026-09-12-semantic-funnel-design.md`

## Global Constraints

- Preserve unrelated existing work, including Instagram changes in the dirty worktree.
- Keep durable code and documentation in English; customer-facing UI and seller instructions use the product language.
- Keep each maintained Markdown file below 500 lines.
- Reuse current CRM stages, conversation APIs, and Kaspi POS reconciliation.
- Do not mark orders paid without authoritative evidence or weaken existing payment verification.
- Do not send customer messages or create live invoices during development or validation.

## Task 1: Retain Semantic Context and Payment Evidence

**Files:** `server/src/lib/crm/worker.ts`, `server/src/lib/crm/analysis.ts`, `server/test/crm-analysis.test.ts`, and the existing worker test location or a focused `server/test/crm-worker.test.ts`.

**Interface:** Preserve existing worker entry points and stage resolution signatures. Extend model context with prior summary/stage and attachment metadata. Use existing extensible fields for payment evidence where possible; validate model output before persistence.

- [x] Add behavior cases for retained context, unverified payment evidence, stale confirmation, and confirmed POS overriding model output.
- [x] Pass the prior summary, stage, profile, and fields as explicitly revisable historical context alongside ordered messages; maintain forward progress through backfill pages.
- [x] Update semantic prompt rules and output normalization so intent, unverified evidence, and provider confirmation are distinct. Keep no-evidence cases unknown rather than definitely unpaid.
- [x] Include known attachment metadata without treating attachment presence as verified contents. No reusable vision or OCR path exists in this repository.
- [x] Run targeted CRM and Kaspi tests and fix regressions without weakening verification assertions.

## Task 2: Configure Seller Payment Methods

**Files:** Locate the existing per-agent rules/configuration writer and seller bootstrap; use `server/src/lib/ai/turn.ts` only if needed to consume that existing configuration. Do not put merchant details into a universal assistant prompt.

**Interface:** Existing agent rules/context remains the source for seller reply policy. Add the exact methods in the spec non-destructively and idempotently for the relevant deployment agent(s).

- [x] Resolve the user-confirmed seller Sealhouse by an explicitly configured agent ID or unique normalized exact name; preserve unrelated rules and refuse ambiguous matches.
- [x] Add durable instructions mapping Kaspi transfer and Halyk transfer to their exact respective phone numbers and recipient, and invoices to Kaspi POS.
- [x] Apply the policy to existing Sealhouse agents at startup and to newly created or renamed Sealhouse agents.
- [x] Verify configuration scope and existing invoice confirmation behavior using local database tests, with no external sends.

## Task 3: Replace Dialogues Navigation with Board Chat

**Files:** `rakurs/src/lib/sections.ts`, `rakurs/src/App.tsx`, `rakurs/src/screens/BoardScreen.tsx`, `rakurs/src/screens/DialogsScreen.tsx`, `rakurs/src/screens/board.css`, and a reusable conversation/modal component if extraction improves ownership.

**Interface:** Keep existing thread/composer APIs and lead mutations. Board owns selected conversation and opens the reusable workspace; close restores the initiating card. Display validated payment evidence through the current lead fields or a focused readable status treatment.

- [x] Extract/reuse the thread and lead panel without duplicating send or media logic.
- [x] Replace card navigation with modal selection; guard drag versus click and preserve board state.
- [x] Implement responsive dialog layout, close controls, keyboard focus behavior, scroll locking, and loading/error handling.
- [x] Remove Dialogues from navigation and route rendering; redirect existing conversation links into the board modal where supported.
- [x] Refresh board data after relevant mutations and retain the existing composer capabilities.

## Task 4: Verify the Complete Flow

**Files:** `rakurs/src/screens/BoardScreen.test.ts`, existing dialogue tests (update paths if workspace extraction moves them), and targeted server tests above.

- [x] Test the accessible card trigger and preserve existing conversation behavior tests; verify the focus, drag, and modal implementation through type checking and production build.
- [x] Run targeted CRM, agent configuration, and Kaspi tests.
- [x] Run the targeted Rakurs board and conversation tests.
- [x] Run the Rakurs type check and both production builds. Full server test type checking is currently affected by unrelated in-progress Instagram test code.
- [ ] Inspect the rendered modal on desktop and narrow layouts using the available browser workflow if the app can be started locally; check composer, scrolling, close behavior, and board return.
- [x] Review the final diff for unrelated changes, payment authority regressions, incorrect numbers, and unhandled model fields. Record actual results and material environment limitations.

## Validation Record

- Server integration: 33 targeted tests passed across agent routes, CRM analysis, and Kaspi service.
- Client: 9 targeted tests passed; type check and production build passed.
- Server production build and `git diff --check` passed.
- Browser inventory was available, but its authenticated Rakurs tab points to the deployed application. No local authenticated backend with fixture conversations was running, so the unshipped modal was not inspected there.
- Receipt files are surfaced as attachment metadata only. Their contents are not read because the repository has no existing vision or OCR path.

## Handoff

Astra authored this specification and plan from Sol's repository investigation. Sol implements, tests, and reviews the change. No additional approval is needed for the requested reversible local changes; do not deploy or send external messages.
