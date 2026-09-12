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
  kbGenerationRawFindings,
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
      requestKey: expect.objectContaining({ notNull: false }),
    });
    expect(getTableConfig(kbGenerationDrafts).uniqueConstraints.map((constraint) =>
      constraint.columns.map((column) => column.name),
    )).toContainEqual(['run_id', 'draft_id']);

    expect(getTableColumns(kbGenerationRawFindings)).toMatchObject({
      runId: expect.objectContaining({ notNull: true }),
      batchId: expect.objectContaining({ notNull: true }),
      fingerprint: expect.objectContaining({ notNull: true }),
      path: expect.objectContaining({ notNull: true }),
      body: expect.objectContaining({ notNull: true }),
      warnings: expect.objectContaining({ notNull: true }),
      sources: expect.objectContaining({ notNull: true }),
      createdAt: expect.objectContaining({ notNull: true }),
    });
    expect(getTableColumns(kbGenerationRawFindings)).not.toHaveProperty('revision');
    expect(getTableColumns(kbGenerationRawFindings)).not.toHaveProperty('status');
    expect(getTableColumns(kbGenerationRawFindings)).not.toHaveProperty('draftId');
  });

  it('shares the review workspace contract', () => {
    expectTypeOf<CommunicationStyle>().toEqualTypeOf<'warm' | 'calm' | 'friendly'>();
    expectTypeOf<KbGenerationClassification>().toEqualTypeOf<'customer' | 'irrelevant' | 'uncertain'>();
    expectTypeOf<KbGenerationProposalKind>().toEqualTypeOf<'knowledge' | 'script'>();
    expectTypeOf<KbGenerationConfidence>().toEqualTypeOf<'high' | 'review'>();
    expectTypeOf<KbGenerationProposal>().toHaveProperty('kind').toEqualTypeOf<KbGenerationProposalKind>();
    expectTypeOf<KbGenerationProposal>().toHaveProperty('confidence').toEqualTypeOf<KbGenerationConfidence>();
    expectTypeOf<KbGenerationProposal>().toHaveProperty('selected').toEqualTypeOf<boolean>();
    expectTypeOf<KbGenerationProposalUpdateRequest>().toHaveProperty('selected').toEqualTypeOf<boolean | undefined>();
  });
});
