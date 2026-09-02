import { createInterface } from 'node:readline/promises';
import { createDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { createAccountWithOwner, ProvisionError } from '../lib/provision.js';

/**
 * Creates a company and its first user.
 *
 * Reads five lines — company, email, name, initials, password — from prompts on a terminal
 * or from piped stdin. Piped input matters for `docker compose run`; readline's question()
 * never resolves once a pipe has ended, so the two cases cannot share one code path.
 *
 * The password is never taken from argv: arguments land in shell history and are visible in
 * `ps` to every user on the machine.
 */

const FIELDS = ['Company', 'Email', 'Name', 'Initials', 'Password (min 12 chars)'] as const;

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

const [company = '', email = '', name = '', initials = '', rawPassword = ''] =
  await readAnswers();

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

try {
  await createAccountWithOwner(db, {
    company,
    email,
    name,
    initials,
    password: rawPassword.replace(/\r?\n$/, ''),
  });
  console.log(`Created ${company} with owner ${email.trim().toLowerCase()}.`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof ProvisionError ? error.message : error);
  process.exit(1);
}
