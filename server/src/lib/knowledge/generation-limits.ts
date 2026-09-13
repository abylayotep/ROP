export const GENERATION_LIMITS = {
  maxConversations: 200,
  maxEligibleMessages: 5_000,
  maxInputCharacters: 200_000,
  maxBatches: 200,
  maxBatchCharacters: 10_000,
  maxBatchMessages: 100,
  maxProposalsPerBatch: 20,
  maxConsolidationItems: 40,
  maxConsolidationCharacters: 20_000,
  maxExistingTopicCharacters: 40_000,
  /** The assign step returns only `{id, topic}` pairs. */
  maxAssignOutputTokens: 1_500,
  /** One topic body per write call. */
  maxTopicOutputTokens: 4_000,
  /** Findings per write call, kept small so one answer can hold the merged body. */
  maxTopicSliceCharacters: 6_000,
  /** An existing or growing body past this is not rewritten: the answer could not hold it whole. */
  maxRewritableBodyCharacters: 8_000,
  /** A write call emits a whole note body, so it gets twice the model client's default deadline. */
  topicWriteTimeoutMs: 120 * 1_000,
  /** What the assign prompt aims for across the whole knowledge base. */
  targetTopics: 12,
  /** Hard cap on topics written by one consolidation; findings for further topics are dropped. */
  maxTopics: 20,
  previewTtlMs: 15 * 60 * 1_000,
  slotAcquisitionTimeoutMs: 60 * 1_000,
  maxOutputTokens: 2_000,
  maxBatchAttempts: 2,
  maxDraftProposals: 20,
} as const;
