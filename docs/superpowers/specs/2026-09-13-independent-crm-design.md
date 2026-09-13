# Independent CRM Analysis and Payment Evidence Integrity

## Goal

Finish the outstanding verification findings: let Sealhouse classify conversations without enabling automatic replies, reject unsupported payment evidence, verify the remaining modal interactions, and record an identifiable production release.

## Existing Behavior

CRM currently follows the AI test/live policy and conversation AI toggle. This is intentional legacy behavior. Sealhouse's current test configuration excludes every conversation from CRM analysis. Do not enable live replies or change the test contact to work around that restriction.

The authoritative release tree is `/private/tmp/rop-release-fixed`, with migration history through `0034_material_nico_minoru.sql`. The shared workspace has divergent migrations and unrelated work. Preserve both; never copy the shared migration directory over the release history.

## Analysis Mode

Add an agent-scoped `crmAnalysisMode` with values `follow_ai` and `independent`, defaulting to `follow_ai` to preserve existing deployments. Expose it in the existing owner-authorized settings API and Agent screen. The Russian label is "Анализ воронки"; choices are "По режиму AI" and "Независимо от автоответов".

In `follow_ai`, retain all existing policy gates. In `independent`, permit CRM analysis regardless of response mode, test contact, or conversation AI toggle, while retaining tenant boundaries, credentials requirements, and concurrency protections.

Independent CRM analysis updates only CRM summaries, stages, profile/evidence, and existing lead fields. It must not send messages, create invoices, or enqueue conversion events. This prohibition also applies when a stale live-message/checkout marker is present. Existing independently authorized reply/checkout pipelines retain their current controls.

Background and inbound analysis must use the same policy. Board status should distinguish missing credentials, deferred analysis under AI policy, pending analysis, and completed analysis where the existing API can do so without misleading users.

## Payment Evidence

New text evidence must reference a real client message and contain an exact quote from that message. Seller-provided payment details cannot establish customer payment evidence.

For client attachments with unread contents, do not persist invented extracted quotes or model-written descriptions of the image. Use the deterministic Russian reason "Вложение требует проверки". An actual caption may be quoted as caption evidence; it is not extracted receipt text.

Retain POS as the sole authority for confirmed payment and success-stage enforcement. Keep prior valid evidence when output omits a replacement; do not implement a second keyword-only semantic classifier in the validator.

## Verification and Rollout

Verify legacy policy compatibility and independent analysis with AI disabled, test mode, stale live markers, and unsupported payment claims. Confirm no message, invoice, or conversion side effects in those tests. Update the stale profile expectation while retaining assertions about existing profile fields and stage behavior.

The live backdrop and mobile 390x844 modal checks have now passed through browser automation; preserve those behaviors.

Build from one coherent source tree and migration chain. Compare against current deployed state before publication and retain backups. Record commit/source manifest, immutable image identity, migration hash, and frontend index/asset hashes in a release receipt; verify the running instance against that receipt.

After successful deployment, set only the uniquely identified Sealhouse agent to `independent`, preserving all reply/test/contact settings. Reanalyze Sealhouse's existing backlog through the side-effect-free CRM path, including prior analyses missing payment evidence, with bounded concurrency and resumable progress. This is authorized completion of the user's automatic funnel request, not permission to send customer messages or create real invoices.

## Constraints

- All execution runs on gpt-5.6-sol; Astra writes the specification/plan and coordinates.
- Durable code and documentation use English; product UI and user chat use Russian.
- Maintained Markdown stays below 500 lines per file.
- Preserve unrelated changes and already applied migration identities.
- Do not expose credentials, raw customer logs, or private conversation content in reports.
