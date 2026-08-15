import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CliConfig, ResolvedRole } from '@myteam/shared';
import { parseEvent, type AgentEvent } from './parsers.js';

export interface SpawnResult {
  events: AgentEvent[];
  sessionId?: string;
  exitCode: number | null;
  stderr: string;
}

const DEFAULT_STALL_MS = 120_000;
const STALL_CHECK_INTERVAL = 10_000;
const KILL_GRACE_MS = 3_000;

export async function spawnCli(
  role: ResolvedRole,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
  resumeSessionId?: string,
  stallMs: number = DEFAULT_STALL_MS,
): Promise<SpawnResult> {
  const cli = role.cliConfig;
  const events: AgentEvent[] = [];
  let sessionId: string | undefined;
  let stderr = '';

  const env = { ...process.env, ...cli.env, ...role.resolvedEnv };

  const isArgMode = cli.prompt_via === 'arg';
  let finalArgs = isArgMode ? [...cli.args, prompt] : [...cli.args];

  if (resumeSessionId) {
    if (cli.event_parser === 'claude') {
      const dashIdx = finalArgs.lastIndexOf('--');
      if (dashIdx >= 0) {
        finalArgs.splice(dashIdx, 0, '--resume', resumeSessionId);
      } else {
        finalArgs.push('--resume', resumeSessionId);
      }
    } else if (cli.event_parser === 'codex') {
      const result: string[] = [];
      let skipNext = false;
      for (let i = 0; i < finalArgs.length; i++) {
        if (skipNext) { skipNext = false; continue; }
        if (finalArgs[i] === '--sandbox') { skipNext = true; continue; }
        if (finalArgs[i] === '--skip-git-repo-check') continue;
        if (finalArgs[i] === 'exec') {
          result.push('exec', 'resume', resumeSessionId);
          continue;
        }
        result.push(finalArgs[i]);
      }
      finalArgs = result;
    } else if (cli.event_parser === 'opencode') {
      const runIdx = finalArgs.indexOf('run');
      if (runIdx >= 0) {
        finalArgs.splice(runIdx + 1, 0, '--session', resumeSessionId);
      }
    }
    console.log(`[CliSpawn] resuming session: ${resumeSessionId} (${cli.event_parser})`);
  }

  const child = spawn(cli.command, finalArgs, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  let lastActivityTime = Date.now();
  let killed = false;

  function killChild(reason: string) {
    if (killed) return;
    killed = true;
    console.warn(`[CliSpawn] killing child: ${reason}`);
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
  }

  if (child.stdin) {
    if (!isArgMode) {
      console.log('[CliSpawn] writing stdin:', prompt.length, 'chars');
      child.stdin.write(prompt);
    }
    child.stdin.end();
    console.log('[CliSpawn] stdin ended');
  }

  let lineBuf = '';

  function processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const raw = JSON.parse(trimmed);
      if (raw.sessionID && !sessionId) sessionId = raw.sessionID;
      const parsed = parseEvent(cli.event_parser, raw);
      if (parsed) {
        if (parsed.type === 'session_init' && parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
        events.push(parsed);
        onEvent?.(parsed);
        if (parsed.type === 'done' && parsed.isFinal) {
          killChild('done event received');
        }
      } else if (raw.part?.text) {
        const ev = { type: 'text' as const, content: raw.part.text };
        events.push(ev);
        onEvent?.(ev);
      }
    } catch (e: any) {
      console.error('[CliSpawn] JSON parse failed:', e?.message, 'line len:', trimmed.length, 'first 80:', trimmed.slice(0, 80));
      events.push({ type: 'text', content: trimmed });
    }
  }

  child.stdout!.on('data', (chunk: Buffer) => {
    lastActivityTime = Date.now();
    lineBuf += chunk.toString('utf-8');
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

  const done = new Promise<void>((resolve) => {
    child.on('close', () => {
      if (lineBuf.trim()) {
        console.log('[CliSpawn] flushing residual lineBuf:', lineBuf.length, 'chars');
        processLine(lineBuf);
        lineBuf = '';
      }
      resolve();
    });
    child.on('error', (err) => {
      console.error('[CliSpawn] error:', err.message);
      stderr += `Spawn error: ${err.message}\n`;
      resolve();
    });
  });

  const timeout = new Promise<void>((resolve) => {
    const totalTimer = setTimeout(() => {
      killChild(`total timeout ${timeoutMs}ms`);
      resolve();
    }, timeoutMs || 60000);

    const stallTimer = setInterval(() => {
      const elapsed = Date.now() - lastActivityTime;
      if (elapsed > stallMs) {
        clearInterval(stallTimer);
        killChild(`stall detected: no stdout for ${Math.round(elapsed / 1000)}s`);
        resolve();
      }
    }, STALL_CHECK_INTERVAL);
    stallTimer.unref();

    signal.addEventListener('abort', () => {
      clearTimeout(totalTimer);
      clearInterval(stallTimer);
      killChild('abort signal');
      resolve();
    }, { once: true });

    child.on('close', () => {
      clearTimeout(totalTimer);
      clearInterval(stallTimer);
    });
  });

  console.log('[CliSpawn] command:', cli.command);

  await Promise.race([done, timeout]);

  const exitCode = child.exitCode;
  const isLibuvCrash = process.platform === 'win32' && exitCode === 3221226505;
  if (exitCode !== 0 && exitCode !== null && !isLibuvCrash && !signal.aborted) {
    events.push({ type: 'done', isFinal: true, error: `CLI exited with code ${exitCode}` });
  } else {
    events.push({ type: 'done', isFinal: true });
  }

  return { events, sessionId, exitCode, stderr };
}
