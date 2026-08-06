import { createInterface } from 'node:readline/promises';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { hashPassword } from '../lib/password.js';

/**
 * Creates a cabinet user.
 *
 * There is no sign-up route and there will not be one: this is a single-company
 * cabinet, and an open registration endpoint would be a liability serving no user.
 *
 * Reads four lines — email, name, initials, password — either from prompts on a
 * terminal or from piped stdin. Piped input matters for `docker compose run` and
 * for testing; readline's question() never resolves once a pipe has ended, so the
 * two cases cannot share one code path.
 *
 * The password is never taken from argv: arguments land in shell history and are
 * visible in `ps` to every user on the machine.
 */

const FIELDS = ['Email', 'Name', 'Initials', 'Password (min 12 chars)'] as const;

async function readAnswers(): Promise<string[]> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answers: string[] = [];
    for (const field of FIELDS) answers.push(await rl.question(`${field}: `));
    rl.close();
    return answers;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

const [rawEmail = '', rawName = '', rawInitials = '', rawPassword = ''] = await readAnswers();

const email = rawEmail.trim().toLowerCase();
const name = rawName.trim();
const initials = rawInitials.trim().toUpperCase();
const password = rawPassword.replace(/\r?\n$/, '');

if (!email.includes('@') || !name || !initials) {
  console.error('Email, name and initials are all required.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

await db.insert(users).values({
  email,
  name,
  initials,
  passwordHash: await hashPassword(password),
});

console.log(`Created ${email}.`);
process.exit(0);
