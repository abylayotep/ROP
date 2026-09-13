# Production Source Repair and Semantic Funnel Release

**Owner:** Astra plans and coordinates; gpt-5.6-sol investigates, implements, verifies, and deploys.

**Authorization:** The user requested continuation with the remaining work after the deployment blocker was identified.

## Evidence

The initial deployment attempt made no production changes. The running API remained healthy at `/api/health`. The production source snapshot was an incomplete overlay of knowledge-generation commit `1e8359e` on base `89ac967`: required files including `generation-path.ts` were missing, while related interfaces had changed. A semantic-only build succeeded but would discard newer production changes if deployed directly.

## Repair Plan

1. Create a complete candidate from authoritative commit `1e8359e`; restore missing tracked files from source control rather than reconstructing business logic.
2. Incorporate the verified Instagram changes and semantic funnel commit `65eefa8`. Review the candidate against the fresh production snapshot to preserve production-only behavior and exclude unrelated unfinished local changes.
3. Inspect the database migration journal and schema before deciding whether a forward migration is necessary. Never renumber or repeat an already applied migration. Back up before any required database mutation.
4. Run relevant knowledge-generation, CRM, payment, and Instagram regression tests, both type checks, and both production builds. Resolve actual incompatibilities without bypassing checks.
5. Recheck production drift and retain rollback copies. Upload a complete explicit source manifest excluding environment files, data, dependencies, and patch rejects.
6. Successfully build the candidate image before restarting the healthy service. Publish the matching frontend and verify API health, funnel navigation/chat behavior, and scoped Sealhouse payment rules.
7. Record the deployed revision, actual checks, migration decision, and any remaining limitations. Do not send customer messages or create real payment invoices during validation.

## Acceptance

- Production is built from complete, mutually compatible sources.
- Existing Instagram and production-only behavior is preserved.
- The semantic funnel and Sealhouse payment instructions are active.
- Payment confirmation remains authoritative; receipt metadata alone does not confirm payment.
- A failed candidate build never replaces the healthy running service.
