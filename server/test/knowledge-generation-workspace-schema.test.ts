import { getTableColumns } from 'drizzle-orm';
import type {
  CommunicationStyle,
  KbGenerationClassification,
  KbGenerationConfidence,
  KbGenerationProposal,
  KbGenerationProposalKind,
  KbGenerationProposalUpdateRequest,
} from '@rakurs/contract';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  agents,
  kbGenerationBatches,
  kbGenerationDrafts,
  kbGenerationProposals,
} from '../src/db/schema.js';

describe('knowledge generation workspace schema', () => {
  it('exposes the persisted review workspace fields', () => {
    const agentColumns = getTableColumns(agents);
    expect(agentColumns).toHaveProperty('communicationStyle');
    expect(agentColumns.communicationStyle).toMatchObject({ notNull: true, default: 'warm' });

    const batchColumns = getTableColumns(kbGenerationBatches);
    expect(batchColumns).toMatchObject({
      classification: expect.anything(),
      classificationReason: expect.anything(),
    });
    expect(batchColumns.classification.notNull).toBe(false);
    expect(batchColumns.classificationReason.notNull).toBe(false);

    const proposalColumns = getTableColumns(kbGenerationProposals);
    expect(proposalColumns).toMatchObject({
      kind: expect.anything(),
      confidence: expect.anything(),
      selected: expect.anything(),
    });
    expect(proposalColumns.kind).toMatchObject({ notNull: true, default: 'knowledge' });
    expect(proposalColumns.confidence).toMatchObject({ notNull: true, default: 'review' });
    expect(proposalColumns.selected).toMatchObject({ notNull: true, default: false });

    expect(getTableColumns(kbGenerationDrafts)).toMatchObject({
      runId: expect.anything(),
      draftId: expect.anything(),
    });
    expect(getTableConfig(kbGenerationDrafts).uniqueConstraints.map((constraint) =>
      constraint.columns.map((column) => column.name),
    )).toContainEqual(['run_id', 'draft_id']);
  });

  it('shares the review workspace contract', () => {
    expectTypeOf<CommunicationStyle>().toEqualTypeOf<'warm' | 'calm' | 'friendly'>();
    expectTypeOf<KbGenerationClassification>().toEqualTypeOf<'customer' | 'irrelevant' | 'uncertain'>();
    expectTypeOf<KbGenerationProposalKind>().toEqualTypeOf<'knowledge' | 'script'>();
    expectTypeOf<KbGenerationConfidence>().toEqualTypeOf<'high' | 'review'>();
    expectTypeOf<KbGenerationProposal>().toHaveProperty('kind').toEqualTypeOf<KbGenerationProposalKind | undefined>();
    expectTypeOf<KbGenerationProposal>().toHaveProperty('confidence').toEqualTypeOf<KbGenerationConfidence | undefined>();
    expectTypeOf<KbGenerationProposal>().toHaveProperty('selected').toEqualTypeOf<boolean | undefined>();
    expectTypeOf<KbGenerationProposalUpdateRequest>().toHaveProperty('selected').toEqualTypeOf<boolean | undefined>();
  });
});
