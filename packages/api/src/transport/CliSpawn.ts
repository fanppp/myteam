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

export async function spawnCli(
  role: ResolvedRole,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
): Promise<SpawnResult> {
  const cli = role.cliConfig;
  const events: AgentEvent[] = [];
  let sessionId: string | undefined;
  let stderr = '';

  const env = { ...process.env, ...cli.env, ...role.resolvedEnv };

  const isArgMode = cli.prompt_via === 'arg';
  const finalArgs = isArgMode ? [...cli.args, prompt] : cli.args;

  const child = spawn(cli.command, finalArgs, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  if (child.stdin) {
    if (!isArgMode) {
      console.log('[CliSpawn] writing stdin:', prompt.length, 'chars');
      child.stdin.write(prompt);
    }
    child.stdin.end();
    console.log('[CliSpawn] stdin ended');
  }

  let lineBuf = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    console.log('[CliSpawn] stdout:', chunk.length, 'bytes');
    lineBuf += chunk.toString('utf-8');
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
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
            try { child.kill('SIGTERM'); } catch {}
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
  });

  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

  const done = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', (err) => {
      console.error('[CliSpawn] error:', err.message);
      stderr += `Spawn error: ${err.message}\n`;
      resolve();
    });
  });

  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
      resolve();
    }, timeoutMs || 60000);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      try { child.kill('SIGTERM'); } catch {}
      resolve();
    }, { once: true });
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
