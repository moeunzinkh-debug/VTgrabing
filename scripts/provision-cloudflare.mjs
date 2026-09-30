#!/usr/bin/env node
/**
 * Optional provisioning helper for dedicated Cloudflare D1 / R2 / Queue resources.
 *
 * Note: VTGrab already deploys and works 100% out of the box without running this
 * script (using built-in Edge fallbacks in `src/runtime/fallbacks.ts`). Run this
 * script only when you want to provision dedicated D1 / R2 / Queue resources on
 * your Cloudflare account from the CLI.
 *
 * Usage:
 *   npx wrangler login
 *   npm run cf:provision
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const D1_NAME = 'vtgrab-db';
const R2_BUCKET = 'vtgrab-files';
const QUEUE_NAME = 'vtgrab-jobs';

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

function alreadyExists(output) {
  return /already exist|duplicate|conflict|409|7502/i.test(output);
}

console.log('Checking / provisioning optional Cloudflare resources...');

const d1 = wrangler(['d1', 'create', D1_NAME]);
if (d1.status === 0 || alreadyExists(d1.stdout + d1.stderr)) {
  console.log(`  D1 database "${D1_NAME}" is ready.`);
  wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote']);
} else {
  console.warn(`  Skipping D1 "${D1_NAME}" (built-in Edge fallback will be used).`);
}

const r2 = wrangler(['r2', 'bucket', 'create', R2_BUCKET]);
if (r2.status === 0 || alreadyExists(r2.stdout + r2.stderr)) {
  console.log(`  R2 bucket "${R2_BUCKET}" is ready.`);
} else {
  console.warn(`  Skipping R2 "${R2_BUCKET}" (built-in Edge fallback will be used).`);
}

const queue = wrangler(['queues', 'create', QUEUE_NAME]);
if (queue.status === 0 || alreadyExists(queue.stdout + queue.stderr)) {
  console.log(`  Queue "${QUEUE_NAME}" is ready.`);
} else {
  console.warn(`  Skipping Queue "${QUEUE_NAME}" (built-in Edge fallback will be used).`);
}

console.log('\nDone. You can now run `npm run deploy` or push to GitHub.');
