export const MESSAGE_PAGE_SIZE = 60;
export const CONVERSATION_PAGE_SIZE = 100;

/** Keep old source links inside a bounded page instead of rendering the entire tail. */
export function messageWindow(
  messages: readonly { id: string }[],
  requestedStart: number | null,
  targetMessageId: string | null,
): { start: number; end: number } {
  const lastStart = Math.max(0, messages.length - MESSAGE_PAGE_SIZE);
  const targetIndex = requestedStart === null && targetMessageId
    ? messages.findIndex((message) => message.id === targetMessageId)
    : -1;
  const start = Math.max(0, Math.min(lastStart, requestedStart ?? (
    targetIndex < 0 ? lastStart : targetIndex - Math.floor(MESSAGE_PAGE_SIZE / 2)
  )));
  return { start, end: Math.min(messages.length, start + MESSAGE_PAGE_SIZE) };
}
