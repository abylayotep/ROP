# CRM Classification and Race-Test Closure

**Ownership:** Astra plans and coordinates; gpt-5.6-sol executes investigation, implementation, review, and deployment.

## Authorization and Evidence

The user explicitly authorized one-case diagnostic transmission of the disputed conversation to the existing OpenRouter provider and correction of the two remaining AI concurrency tests. Credentials remain on the server; diagnostics do not modify CRM records or send customer messages.

A controlled non-persisting replay of the current prompt selected the initial lead stage with confidence 85. A comparison using the same conversation contents and prior analysis, with generic chronology and mutual-order guidance, selected the configured accepted-order stage with confidence 85. Neither replay established payment. This supports a focused prompt correction; it does not establish universal classifier accuracy.

## Task 1: Correct Stage Guidance

**Owner:** semantic_qa. **File:** `server/src/lib/crm/analysis.ts` in the authoritative release tree.

1. Clarify that previous stage and summary are provisional, and current chronological evidence of mutual agreement determines the stage.
2. Explain that a seller acknowledgement alone is insufficient to establish a customer order.
3. For a specific mutually agreed order accepted/prepared by the seller or with agreed pickup, choose the configured stage representing an accepted order even before invoice issuance. Do not hard-code a merchant stage ID or name.
4. Keep payment confirmation and success-stage requirements unchanged: only verified POS establishes confirmed payment.
5. Run relevant existing parser, stage, and worker regression checks. Use the controlled real-model comparison as prompt-behavior evidence rather than a test that merely searches for prompt text.

## Task 2: Repair Two Existing Concurrency Tests

**Owner:** sol_work. **Scope:** the two reproducible stage-message/CAPI race failures in the AI turn tests and the smallest responsible implementation layer if actual runtime behavior is wrong.

1. Reproduce on an isolated database and inspect the lock/effect sequence.
2. Distinguish obsolete test synchronization from a real concurrency defect.
3. Preserve the original business invariant; do not weaken assertions solely to make tests pass.
4. If the harness is obsolete, make synchronization deterministic around the current locking boundary. If the implementation is wrong, fix that boundary and retain a reproducing test.
5. Run the repaired tests and relevant neighboring tests after the final change.

## Task 3: Publish and Verify

1. Review the focused final diff, preserve unrelated work, and retain coherent migration history. No new schema change is planned for this closure.
2. Build and deploy runtime changes through the existing verified process, recording the immutable image and frontend identity. Do not redeploy solely for test-only edits, but the prompt change requires the API update.
3. Reanalyze only the disputed Sealhouse conversation through the independent CRM path. Verify the resulting stage and unchanged payment authority.
4. Confirm no customer messages, invoices, conversion events, or reply-setting changes result from this work.
5. Report actual test results, deployed revision, corrected case outcome, and remaining known limitations.
