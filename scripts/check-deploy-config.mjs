#!/usr/bin/env node
/**
 * Pre-deploy helper for VTGrab.
 *
 * Ensures the static frontend bundle (`assets.directory`) exists before
 * `wrangler deploy` runs and strips any accidental all-zero placeholder D1 UUID
 * from `wrangler.jsonc` so Cloudflare never rejects the deployment with
 * `Invalid database UUID (00000000-0000-0000-0000-000000000000) [code: 80000222]`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const rawConfig = readFileSync(configPath, 'utf8');
const config = parseJsonc(rawConfig);

// If someone pasted the all-zero template UUID into wrangler.jsonc, remove that
// line so Wrangler 4 can look up / provision the database by `database_name`
// instead of failing with code 80000222.
const d1Databases = config.d1_databases ?? [];
const hasPlaceholder = d1Databases.some((db) => db.database_id === PLACEHOLDER_D1_ID);
if (hasPlaceholder) {
  const cleaned = rawConfig.replace(
    /^\s*"database_id"\s*:\s*"00000000-0000-0000-0000-000000000000"\s*,?\r?\n/gm,
    '',
  );
  if (cleaned !== rawConfig) {
    writeFileSync(configPath, cleaned);
    console.log('Removed placeholder D1 database_id from wrangler.jsonc.');
  }
}

if (config.assets?.directory) {
  const assetsDir = resolve(root, config.assets.directory);
  if (!existsSync(assetsDir)) {
    console.log(`Building frontend assets into ${config.assets.directory}...`);
    const result = spawnSync('npm', ['run', 'build:client'], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

console.log('Deploy configuration verified and ready for Cloudflare.');
