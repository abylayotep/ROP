import { createInterface } from 'node:readline/promises';
import { createDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { addMember, ProvisionError, type Role } from '../lib/provision.js';

/**
 * Adds a person to an existing company. See create-account.ts for why stdin, not argv.
 *
 * The password is asked for unconditionally but used only when the email is new: an
 * already-registered person is attached to this company with the password they already have.
 */

const FIELDS = [
  'Company',
  'Email',
  'Name',
  'Initials',
  'Password (min 12 chars)',
  'Role (owner|member)',
] as const;

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

const [company = '', email = '', name = '', initials = '', rawPassword = '', rawRole = ''] =
  await readAnswers();

const role = rawRole.trim().toLowerCase();
if (role !== 'owner' && role !== 'member') {
  console.error('Роль должна быть owner или member');
  process.exit(1);
}

// The scripts are run from a checkout, where the environment lives in server/.env, and
// from `docker compose run` in production, where Compose supplies it and no file exists.
// A missing file is therefore the normal case in one of the two, not an error.
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — fall back to whatever is already in the environment.
  }
}

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

try {
  await addMember(db, {
    company,
    email,
    name,
    initials,
    password: rawPassword.replace(/\r?\n$/, ''),
    role: role as Role,
  });
  console.log(`Added ${email.trim().toLowerCase()} to ${company} as ${role}.`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof ProvisionError ? error.message : error);
  process.exit(1);
}
