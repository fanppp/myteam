import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hello } from '@myteam/shared';
import { ConfigLoader } from './config/ConfigLoader.js';
import { AppDatabase } from './storage/Database.js';
import { TaskRuntime } from './executor/TaskRuntime.js';
import { Router } from './router/Router.js';

const PORT = Number(process.env.MYTEAM_API_PORT ?? process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '127.0.0.1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let configDir = resolve(process.cwd(), 'config');
if (!existsSync(configDir)) configDir = resolve(__dirname, '..', '..', 'config');
const config = new ConfigLoader(configDir);

const envName = process.env.MYTEAM_ENV ?? 'default';
const dataDir = process.env.MYTEAM_DB_PATH
  ? resolve(process.env.MYTEAM_DB_PATH)
  : resolve(homedir(), '.myteam', envName !== 'default' ? envName : '');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = resolve(dataDir, 'data.sqlite');
const db = new AppDatabase(dbPath);

const runtime = new TaskRuntime(db);
const router = new Router(config);

const fastify = Fastify({ logger: { level: 'info' } });

fastify.get('/api/tasks', async () => {
  const tasks = db.db.prepare(
    `SELECT t.id, t.message, t.team_id, t.session_id, t.created_at, ts.status 
     FROM tasks t JOIN task_states ts ON t.id = ts.task_id 
     ORDER BY t.created_at DESC LIMIT 20`
  ).all() as any[];
  return tasks.map(t => ({ taskId: t.id, message: t.message, teamId: t.team_id, sessionId: t.session_id, status: t.status, createdAt: t.created_at }));
});

fastify.post('/api/tasks', async (request, reply) => {
  const { message, teamId: override, workdir, sessionId: existingSessionId } = request.body as any;
  if (!message) return reply.code(400).send({ error: 'message is required' });

  let effectiveOverride = override;
  if (!effectiveOverride && existingSessionId) {
    const prevTask = db.db.prepare('SELECT team_id FROM tasks WHERE session_id = ? ORDER BY created_at ASC LIMIT 1').get(existingSessionId) as any;
    if (prevTask?.team_id) effectiveOverride = prevTask.team_id;
  }

  const decision = router.route(message, effectiveOverride);
  const taskId = randomUUID();
  const sessionId = existingSessionId ?? randomUUID();
  const worktreePath = workdir ?? process.cwd();

  const plan = config.resolvePlan(decision.teamId, message, taskId);
  db.createTask(taskId, message, decision.teamId, worktreePath, sessionId);

  reply.send({ taskId, sessionId, teamId: decision.teamId, strategy: decision.strategy, scope: decision.scope });

  runtime.executeTask(plan, message, worktreePath, sessionId).catch(err => {
    fastify.log.error({ err }, 'Task execution failed');
  });
});

fastify.get('/api/tasks/:id/stream', async (request, reply) => {
  const taskId = (request.params as any).id;
  const lastEventIdHeader = request.headers['last-event-id'] as string | undefined;
  let lastEventId = lastEventIdHeader ? parseInt(lastEventIdHeader) : 0;
  if (isNaN(lastEventId)) lastEventId = 0;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 补发失落事件
  let cursor = lastEventId;
  while (true) {
    const batch = db.getEventsAfter(taskId, cursor, 100);
    if (batch.length === 0) break;
    for (const event of batch) {
      reply.raw.write(`id: ${event.eventId}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      cursor = event.eventId;
    }
    if (batch.length < 100) break;
  }

  runtime.registerSSE(taskId, cursor, reply.raw);
});

fastify.post('/api/tasks/:id/cancel', async (request, reply) => {
  const taskId = (request.params as any).id;
  runtime.cancelTask(taskId);
  reply.send({ ok: true });
});

fastify.get('/api/tasks/:id', async (request, reply) => {
  const taskId = (request.params as any).id;
  const status = db.getTaskStatus(taskId);
  if (!status) return reply.code(404).send({ error: 'not found' });
  const task = db.db.prepare('SELECT team_id, session_id, message FROM tasks WHERE id = ?').get(taskId) as any;
  const events = db.getEventsAfter(taskId, 0, 10000);
  reply.send({ taskId, sessionId: task?.session_id, teamId: task?.team_id, message: task?.message, status, events });
});

fastify.get('/api/sessions/:sessionId/tasks', async (request) => {
  const sessionId = (request.params as any).sessionId;
  return db.getTaskListBySession(sessionId);
});

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.get('/api/hello', async (request) => {
  const { name } = request.query as { name?: string };
  return {
    message: name === undefined ? hello() : hello(name),
    echo: { name: name ?? null },
  };
});

fastify.get('/api/debug/routing', async () => {
  return {
    rules: config.intentRules.map(r => ({ intent: r.intent, team: r.team, patterns: r.patterns })),
    defaultTeam: config.defaultTeamId,
  };
});

fastify.get('/api/teams/:teamId', async (request) => {
  const teamId = (request.params as any).teamId;
  const team = config.getTeam(teamId);
  return {
    teamId,
    name: team.name,
    strategy: team.strategy,
    roles: team.roles.map(r => ({
      id: r.id,
      cli: r.cli,
      team_strengths: r.team_strengths,
      caution: r.caution,
    })),
    transitions: team.transitions,
  };
});

fastify.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[myteam] env=${envName} port=${PORT}`);
  console.log(`[myteam] db=${dbPath}`);
  console.log(`[myteam] config=${configDir}`);
});
