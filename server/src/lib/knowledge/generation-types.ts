import type { KbGenerationClassification } from '@rakurs/contract';

/** Defense-in-depth filter for audit rows created before migration 0029. */
export const LEGACY_RAW_FINGERPRINT_PATTERN = 'raw:%';

export interface GenerationBatchClassification {
  classification: KbGenerationClassification;
  classificationReason: string;
}

export interface GenerationManifestEntry {
  messageId: string;
  conversationId: string;
  contentHash: string;
  ordinal: number;
}

export interface GenerationBatchManifest {
  ordinal: number;
  conversationId: string;
  messages: GenerationManifestEntry[];
  characterCount: number;
}

export interface GenerationManifest {
  messages: GenerationManifestEntry[];
  batches: GenerationBatchManifest[];
}

export interface GenerationStoredCounts {
  selectedConversations: number;
  selectedMessages: number;
  eligibleMessages: number;
  eligibleCharacters: number;
  skippedAiOrSystem: number;
  skippedUnsupported: number;
  skippedEmpty: number;
  skippedSensitive: number;
  skippedOversize: number;
  skippedNoSeller: number;
}

export interface GenerationStoredSource {
  conversationId: string;
  messageId: string;
  sentAt: string;
}
