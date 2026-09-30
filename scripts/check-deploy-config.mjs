#!/usr/bin/env node
/**
 * Pre-deploy guard for VTGrab.
 *
 * Cloudflare Workers Builds (and a local `wrangler deploy`) fails with a cryptic
 * API error when the account resources referenced by `wrangler.jsonc` do not
 * exist yet. The two failures everybody hits are:
 *
 *   1. `d1_databases[0].database_id` is still the all-zero template value
 *      -> "Invalid database UUID (00000000-0000-0000-0000-000000000000) [code: 80000222]"
 *   2. `assets.directory` (./dist) was never built, because `dist/` is git-ignored
 *      -> "The directory specified by the "assets.directory" field in your
 *          configuration file does not exist"
 *
 * This script turns both into an actionable message *before* anything is uploaded.
 * It is wired to the npm `predeploy` hook, so `npm run deploy` runs it first.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';

/** Strip line and block comments plus trailing commas so JSON.parse can read JSONC. */
function parseJsonc(source) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += char;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const configPath = resolve(root, 'wrangler.jsonc');
const config = parseJsonc(readFileSync(configPath, 'utf8'));

const errors = [];
const notes = [];

const d1Databases = config.d1_databases ?? [];
for (const database of d1Databases) {
  if (!database.database_id || database.database_id === PLACEHOLDER_D1_ID) {
    errors.push(
      `D1 binding "${database.binding}" still has the template database_id ` +
        `(${database.database_id ?? 'missing'}).`,
    );
  }
}

if (config.assets?.directory) {
  const assetsDir = resolve(root, config.assets.directory);
  if (!existsSync(assetsDir)) {
    notes.push(
      `assets.directory "${config.assets.directory}" does not exist yet - ` +
        '`npm run build:client` creates it (it is git-ignored, so Cloudflare must ' +
        'run a build command before deploying).',
    );
  }
}

if (errors.length > 0) {
  console.error('\nDeploy blocked - the Cloudflare account is not set up yet:\n');
  for (const error of errors) console.error(`  * ${error}\n`);
  console.error('  Cloudflare rejects the placeholder UUID with:');
  console.error('    Invalid database UUID (00000000-0000-0000-0000-000000000000) [code: 80000222]\n');
  console.error('  Run these once, from your machine (npx wrangler login first):\n');
  console.error('    npx wrangler d1 create vtgrab-db        # prints database_id = "..."');
  console.error('    npx wrangler r2 bucket create vtgrab-files');
  console.error('    npx wrangler queues create vtgrab-jobs\n');
  console.error('  Then paste the real database_id into wrangler.jsonc');
  console.error('  (d1_databases[0].database_id), commit, push - Cloudflare rebuilds.\n');
  console.error('  Afterwards, still required once:');
  console.error('    npm run db:migrate                       # apply migrations to the remote D1');
  console.error('    npx wrangler secret put SOURCE_API_TOKEN');
  console.error('    npx wrangler secret put DOWNLOAD_SERVICE_TOKEN');
  console.error('    npx wrangler secret put DOWNLOAD_CALLBACK_SECRET\n');
  process.exit(1);
}

for (const note of notes) console.log(`  note: ${note}`);
console.log('Deploy config looks good (D1 database_id is a real UUID).');
