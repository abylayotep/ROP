import { describe, expect, it } from 'vitest';
import { communicationStyleInstruction } from '../src/lib/ai/communication-style.js';

describe('communicationStyleInstruction', () => {
  it('keeps warm replies natural, respectful, brief, and restrained with emoji', () => {
    const instruction = communicationStyleInstruction('warm');

    expect(instruction).toContain('живо и тепло');
    expect(instruction).toContain('на вы/сіз');
    expect(instruction).toContain('коротко и естественно');
    expect(instruction).toContain('0–2');
  });

  it('keeps calm replies clear without requiring emoji', () => {
    const instruction = communicationStyleInstruction('calm');

    expect(instruction).toContain('спокойно, ясно и уважительно');
    expect(instruction).not.toContain('обязательно используй эмодзи');
  });

  it('keeps friendly replies natural without familiarity or canned phrases', () => {
    const instruction = communicationStyleInstruction('friendly');

    expect(instruction).toContain('дружелюбно и естественно');
    expect(instruction).toContain('без фамильярности');
    expect(instruction).toContain('шаблонных фраз');
  });
});
