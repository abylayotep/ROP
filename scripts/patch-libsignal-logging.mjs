import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const target = join(process.cwd(), 'node_modules/libsignal/src/session_record.js');
const replacements = [
  ['console.warn("Session already closed", session);', 'void 0; // Session object logging disabled by the application.'],
  ['console.info("Closing session:", session);', 'void 0; // Closing session object logging disabled by the application.'],
  ['console.info("Opening session:", session);', 'void 0; // Opening session object logging disabled by the application.'],
  ['console.info("Removing old closed session:", oldestSession);', 'void 0; // Old session object logging disabled by the application.'],
];

let source = await readFile(target, 'utf8');
let changed = false;
for (const [unsafe, safe] of replacements) {
  if (source.includes(unsafe)) {
    source = source.replaceAll(unsafe, safe);
    changed = true;
  } else if (!source.includes(safe)) {
    throw new Error(`Expected libsignal logging statement is missing: ${unsafe}`);
  }
}

if (changed) await writeFile(target, source);
