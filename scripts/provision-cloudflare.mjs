#!/usr/bin/env node
/**
 * Provision the Cloudflare account resources VTGrab needs - idempotently.
 *
 * A Worker deploy fails while any of these are missing:
 *   * D1 database  "vtgrab-db"       -> Invalid database UUID (00000000-...) [code: 80000222]
 *   * R2 bucket    "vtgrab-files"    -> R2 bucket 'vtgrab-files' not found [code: 10085]
 *   * Queue        "vtgrab-jobs"     -> queue not found
 *
 * This script creates whatever is missing, writes the real D1 `database_id`
 * into wrangler.jsonc (the all-zero template value), and prints what is left
 * to do. Running it twice is a no-op.
 *
 * It never sees a credential in the chat: authentication comes from
 *   * `npx wrangler login` (local), or
 *   * CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (GitHub Actions secret).
 *
 * Usage:
 *   npm run cf:provision
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const D1_NAME = 'vtgrab-db';
const R2_BUCKET = 'vtgrab-files';
const QUEUE_NAME = 'vtgrab-jobs';
const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';

/** Run wrangler, capture output, always log it. */
function wrangler(args) {
  const localBin = ['wrangler', 'wrangler.cmd']
    .map((name) => resolve(root, 'node_modules', '.bin', name))
    .find((candidate) => existsSync(candidate));

  const command = localBin ?? 'npx';
  const fullArgs = localBin ? args : ['wrangler', ...args];

  console.log(`\n$ ${command} ${fullArgs.join(' ')}`);
  const result = spawnSync(command, fullArgs, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  return { status: result.status ?? 1, stdout, stderr };
}

function wranglerJson(args) {
  const result = wrangler([...args, '--json']);
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} --json failed (exit ${result.status})`);
  }
  return JSON.parse(result.stdout);
}

function alreadyExists(output) {
  return /already exist|duplicate|conflict|409/i.test(output);
}

function requireAuth() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error(`
No Cloudflare credentials found.

Run this script on your own machine after logging in:

    npx wrangler login
    npm run cf:provision

...or add a CLOUDFLARE_API_TOKEN (GitHub Actions secret / environment variable).
Create the token in the Cloudflare dashboard with these permissions:

    Account  Account Settings (Read), Workers Scripts (Edit),
             Workers R2 Storage (Edit), D1 (Edit), Queues (Edit)
    User     User Details (Read), Memberships (Read)
`);
    process.exit(1);
  }
}

async function ensureD1() {
  const list = wranglerJson(['d1', 'list']);
  const databases = Array.isArray(list) ? list : (list.databases ?? []);
  let database = databases.find((entry) => entry.name === D1_NAME);

  if (!database) {
    console.log(`\nD1 database "${D1_NAME}" does not exist yet - creating it.`);
    const created = wrangler(['d1', 'create', D1_NAME]);
    if (created.status !== 0 && !alreadyExists(created.stdout + created.stderr)) {
      throw new Error(`wrangler d1 create ${D1_NAME} failed`);
    }
    const refreshed = wranglerJson(['d1', 'list']);
    const refreshedList = Array.isArray(refreshed) ? refreshed : (refreshed.databases ?? []);
    database = refreshedList.find((entry) => entry.name === D1_NAME);
  } else {
    console.log(`\nD1 database "${D1_NAME}" already exists.`);
  }

  const databaseId = database?.uuid ?? database?.database_id;
  if (!databaseId) throw new Error(`Could not determine the database_id of "${D1_NAME}".`);
  console.log(`  database_id = ${databaseId}`);
  return databaseId;
}

function ensureR2Bucket() {
  console.log(`\nR2 bucket "${R2_BUCKET}"...`);
  const result = wrangler(['r2', 'bucket', 'create', R2_BUCKET]);
  if (result.status === 0) {
    console.log('  created.');
    return;
  }
  if (alreadyExists(result.stdout + result.stderr)) {
    console.log('  already exists.');
    return;
  }
  throw new Error(`wrangler r2 bucket create ${R2_BUCKET} failed`);
}

function ensureQueue() {
  console.log(`\nQueue "${QUEUE_NAME}"...`);
  const result = wrangler(['queues', 'create', QUEUE_NAME]);
  if (result.status === 0) {
    console.log('  created.');
    return;
  }
  if (alreadyExists(result.stdout + result.stderr)) {
    console.log('  already exists.');
    return;
  }
  throw new Error(`wrangler queues create ${QUEUE_NAME} failed`);
}

/** Replace the template D1 id in wrangler.jsonc, keeping every comment intact. */
function writeDatabaseId(databaseId) {
  const configPath = resolve(root, 'wrangler.jsonc');
  const before = readFileSync(configPath, 'utf8');
  const after = before.replace(
    /("database_id"\s*:\s*")[^"]*(")/,
    `$1${databaseId}$2`,
  );
  if (after === before) return false;
  writeFileSync(configPath, after);
  return true;
}

requireAuth();

const databaseId = await ensureD1();
ensureR2Bucket();
ensureQueue();

const patched = writeDatabaseId(databaseId);
console.log(
  patched
    ? `\nwrangler.jsonc now uses the real database_id (${databaseId}).`
    : `\nwrangler.jsonc already uses the real database_id (${databaseId}).`,
);

console.log(`
Done. Next steps:
  npm run db:migrate     # apply migrations to the remote D1 database
  npm run deploy         # build + wrangler deploy

Optional (only when you use an authorized catalog / download service):
  npx wrangler secret put SOURCE_API_TOKEN
  npx wrangler secret put DOWNLOAD_SERVICE_TOKEN
  npx wrangler secret put DOWNLOAD_CALLBACK_SECRET
  npx wrangler versions secret put PUBLIC_BASE_URL
`);
