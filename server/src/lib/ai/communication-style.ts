import type { CommunicationStyle } from '@rakurs/contract';

const STYLE_INSTRUCTIONS: Record<CommunicationStyle, string> = {
  warm: 'Пиши живо и тепло, уважительно на вы/сіз, короткими естественными фразами; используй 0–2 уместных эмодзи.',
  calm: 'Пиши спокойно, ясно и уважительно, без канцелярита и без лишних эмодзи.',
  friendly: 'Пиши дружелюбно и естественно, коротко, без фамильярности и шаблонных фраз.',
};

export function communicationStyleInstruction(style: CommunicationStyle): string {
  return STYLE_INSTRUCTIONS[style];
}
