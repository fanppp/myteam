#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_BASE = 3102;
const WEB_BASE = 5102;

export function validateWorktreeOffset(offset) {
  if (!Number.isInteger(offset)) {
    throw new Error(`WORKTREE_PORT_OFFSET must be integer, got ${offset}`);
  }
  if (offset > 0) {
    throw new Error(`WORKTREE_PORT_OFFSET must be <= 0, got ${offset}`);
  }
  if (offset < -100) {
    throw new Error(`WORKTREE_PORT_OFFSET range exceeded ([-100, 0]), got ${offset}`);
  }
  if (offset % 10 !== 0) {
    throw new Error(`WORKTREE_PORT_OFFSET must be multiple of 10, got ${offset}`);
  }
}

export function deriveWorktreePorts(offset) {
  validateWorktreeOffset(offset);
  const api = API_BASE - offset;
  const web = WEB_BASE - offset;
  return {
    api,
    web,
    apiUrl: `http://localhost:${api}`,
  };
}

function isCliEntry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isCliEntry()) {
  const arg = process.argv[2];
  let offset;
  if (arg === undefined || arg === '') {
    offset = 0;
  } else {
    offset = Number(arg);
    if (Number.isNaN(offset)) {
      process.stderr.write(`[derive-ports] invalid number: '${arg}'\n`);
      process.exit(2);
    }
  }
  try {
    const ports = deriveWorktreePorts(offset);
    process.stdout.write(
      `export MYTEAM_API_PORT=${ports.api}\n` +
      `export MYTEAM_WEB_PORT=${ports.web}\n` +
      `export MYTEAM_API_URL=${ports.apiUrl}\n`
    );
  } catch (err) {
    process.stderr.write(`[derive-ports] ${err.message}\n`);
    process.exit(2);
  }
}
