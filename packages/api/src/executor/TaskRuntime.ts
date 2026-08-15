import { randomUUID } from 'node:crypto';
import type { ExecutionPlan, ResolvedRole, TaskEvent, DAGEventType, RoleStatus } from '@myteam/shared';
import type { AppDatabase } from '../storage/Database.js';
import { spawnCli } from '../transport/CliSpawn.js';
import type { AgentEvent as ParsedEvent } from '../transport/parsers.js';

export interface SSEClient {
  taskId: string;
  lastEventId: number;
  res: any;
}

export class TaskRuntime {
  private db: AppDatabase;
  private sseClients: Map<string, Set<SSEClient>> = new Map();
  private activeControllers: Map<string, AbortController> = new Map();

  constructor(db: AppDatabase) {
    this.db = db;
  }

  registerSSE(taskId: string, lastEventId: number, res: any) {
    if (!this.sseClients.has(taskId)) this.sseClients.set(taskId, new Set());
    const client: SSEClient = { taskId, lastEventId, res };
    this.sseClients.get(taskId)!.add(client);
    res.on('close', () => {
      this.sseClients.get(taskId)?.delete(client);
    });
  }

  private broadcast(event: TaskEvent) {
    const clients = this.sseClients.get(event.taskId);
    if (!clients) return;
    for (const client of clients) {
      client.res.write(`id: ${event.eventId}\n`);
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
      client.lastEventId = event.eventId;
    }
  }

  private emit(type: DAGEventType, taskId: string, roleId: string | undefined, attemptId: string, extra: Partial<TaskEvent> = {}): TaskEvent {
    const event = this.db.appendEvent({
      taskId, roleId, attemptId, type, epoch: this.db.epoch,
      ...extra,
    });
    this.broadcast(event);
    return event;
  }

  async executeTask(plan: ExecutionPlan, message: string, worktreePath: string, sessionId: string): Promise<void> {
    const taskId = plan.taskId;
    const controller = new AbortController();
    this.activeControllers.set(taskId, controller);

    try {
      if (plan.strategy === 'parallel') {
        await this.executeParallel(plan, message, worktreePath, controller.signal, sessionId);
      } else {
        await this.executeSerial(plan, message, worktreePath, controller.signal, sessionId);
      }
      if (controller.signal.aborted) {
        this.emit('task_done', taskId, undefined, 'final', { status: 'cancelled' });
      } else {
        this.emit('task_done', taskId, undefined, 'final', { status: 'done' });
        this.db.updateTaskStatus(taskId, 'done');
      }
    } catch (err: any) {
      this.emit('node_error', taskId, undefined, 'final', { content: err?.message ?? String(err), status: 'error' });
      this.emit('task_done', taskId, undefined, 'final', { status: 'error' });
      this.db.updateTaskStatus(taskId, 'error');
    } finally {
      this.activeControllers.delete(taskId);
    }
  }

  cancelTask(taskId: string) {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.abort('user_cancel');
      this.db.updateTaskStatus(taskId, 'cancelled');
    }
  }

  private async executeSerial(plan: ExecutionPlan, message: string, cwd: string, signal: AbortSignal, sessionId: string) {
    let currentInput = message;
    const nodeIdBase = plan.taskId;

    for (let i = 0; i < plan.roles.length; i++) {
      if (signal.aborted) break;
      const role = plan.roles[i];
      const nodeId = `${nodeIdBase}-${role.id}`;
      const attemptId = `${plan.taskId}-${role.id}-${i}`;

      this.emit('node_start', plan.taskId, role.id, attemptId, {
        nodeId, status: 'running', content: role.id, cli: role.cli,
      });

      if (i > 0) {
        this.emit('edge', plan.taskId, role.id, attemptId, {
          fromNode: `${nodeIdBase}-${plan.roles[i - 1].id}`,
          toNode: nodeId,
        });
      }

      const prompt = this.buildPrompt(role, currentInput, plan);
      const timeoutMs = Math.min((role.max_turns ?? 50) * 60000, plan.totalBudget?.timeoutMs ?? 1800000);
      const resumeSessionId = this.db.getCliSessionId(sessionId, role.id) ?? undefined;

      let outputText = '';
      const result = await spawnCli(role, prompt, cwd, timeoutMs, signal, (ev) => {
        const mapped = this.mapEvent(ev, plan.taskId, role.id, attemptId, nodeId);
        if (mapped) {
          this.emit(mapped.type, plan.taskId, role.id, attemptId, mapped.extra);
        }
        if (ev.type === 'text') outputText += ev.content;
      }, resumeSessionId);

      if (result.sessionId) {
        this.db.setCliSessionId(sessionId, role.id, result.sessionId);
      }

      if (result.exitCode !== 0 && result.exitCode !== null && !signal.aborted) {
        const hasText = result.events.some(e => e.type === 'text');
        if (!hasText) {
          this.emit('node_error', plan.taskId, role.id, attemptId, {
            nodeId, content: `Exit code: ${result.exitCode}`, status: 'error',
          });
          break;
        }
      }

      this.emit('node_complete', plan.taskId, role.id, attemptId, {
        nodeId, status: signal.aborted ? 'cancelled' : 'done',
      });

      currentInput = outputText || currentInput;
    }
  }

  private async executeParallel(plan: ExecutionPlan, message: string, cwd: string, signal: AbortSignal, sessionId: string) {
    const parallelRoles = plan.roles.filter(r => !r.receives_from || r.receives_from.length === 0);
    const synthesizer = plan.roles.find(r => r.receives_from && r.receives_from.length > 0);

    const results: Record<string, string> = {};

    await Promise.all(parallelRoles.map(async (role) => {
      const nodeId = `${plan.taskId}-${role.id}`;
      const attemptId = `${plan.taskId}-${role.id}-0`;

      this.emit('node_start', plan.taskId, role.id, attemptId, {
        nodeId, status: 'running', content: role.id, cli: role.cli,
      });

      const prompt = this.buildPrompt(role, message, plan);
      const timeoutMs = Math.min((role.max_turns ?? 50) * 60000, plan.totalBudget?.timeoutMs ?? 1800000);
      const resumeSessionId = this.db.getCliSessionId(sessionId, role.id) ?? undefined;

      let outputText = '';
      const result = await spawnCli(role, prompt, cwd, timeoutMs, signal, (ev) => {
        const mapped = this.mapEvent(ev, plan.taskId, role.id, attemptId, nodeId);
        if (mapped) {
          this.emit(mapped.type, plan.taskId, role.id, attemptId, mapped.extra);
        }
        if (ev.type === 'text') outputText += ev.content;
      }, resumeSessionId);

      if (result.sessionId) {
        this.db.setCliSessionId(sessionId, role.id, result.sessionId);
      }

      this.emit('node_complete', plan.taskId, role.id, attemptId, {
        nodeId, status: signal.aborted ? 'cancelled' : 'done',
      });

      results[role.id] = outputText;
    }));

    if (synthesizer && !signal.aborted) {
      const nodeId = `${plan.taskId}-${synthesizer.id}`;
      const attemptId = `${plan.taskId}-${synthesizer.id}-0`;

      for (const from of parallelRoles) {
        this.emit('edge', plan.taskId, synthesizer.id, attemptId, {
          fromNode: `${plan.taskId}-${from.id}`,
          toNode: nodeId,
        });
      }

      this.emit('node_start', plan.taskId, synthesizer.id, attemptId, {
        nodeId, status: 'running', content: synthesizer.id, cli: synthesizer.cli,
      });

      const combinedInput = parallelRoles.map(r => `【${r.id}的观点】\n${results[r.id]}`).join('\n\n');
      const prompt = this.buildPrompt(synthesizer, combinedInput, plan);
      const timeoutMs = Math.min(synthesizer.max_turns * 60000, plan.totalBudget.timeoutMs);
      const synthResumeId = this.db.getCliSessionId(sessionId, synthesizer.id) ?? undefined;
      const result = await spawnCli(synthesizer, prompt, cwd, timeoutMs, signal, (ev) => {
        const mapped = this.mapEvent(ev, plan.taskId, synthesizer.id, attemptId, nodeId);
        if (mapped) {
          this.emit(mapped.type, plan.taskId, synthesizer.id, attemptId, mapped.extra);
        }
      }, synthResumeId);

      if (result.sessionId) {
        this.db.setCliSessionId(sessionId, synthesizer.id, result.sessionId);
      }

      this.emit('node_complete', plan.taskId, synthesizer.id, attemptId, {
        nodeId, status: signal.aborted ? 'cancelled' : 'done',
      });
    }
  }

  private buildPrompt(role: ResolvedRole, input: string, plan: ExecutionPlan): string {
    const teammates = plan.roles.filter(r => r.id !== role.id);
    const roster = teammates.length > 0
      ? `\n\n## 队友名册\n${teammates.map(r => `- @${r.id}: ${r.team_strengths ?? 'N/A'}${r.caution ? ` (注意: ${r.caution})` : ''}`).join('\n')}`
      : '';

    return `${role.system_prompt}${roster}

## 任务
${input}

## 完成指示
任务完成后，在回复末尾输出:
\`\`\`decision
{"action":"finish","reason":"完成原因","confidence":0.9}
\`\`\`
如果需要交接给队友，输出:
\`\`\`decision
{"action":"handoff","nextRole":"目标角色ID","reason":"交接原因","confidence":0.8}
\`\`\``;
  }

  private mapEvent(
    ev: ParsedEvent,
    taskId: string,
    roleId: string,
    attemptId: string,
    nodeId: string,
  ): { type: DAGEventType; extra: Partial<TaskEvent> } | null {
    switch (ev.type) {
      case 'text':
        return { type: 'node_output', extra: { nodeId, content: ev.content, status: 'running' } };
      case 'tool_use':
        return { type: 'tool_use', extra: { nodeId, toolName: ev.tool, toolUseId: ev.toolUseId, content: JSON.stringify(ev.input), status: 'tool' } };
      case 'tool_result':
        return { type: 'tool_result', extra: { nodeId, toolUseId: ev.toolUseId, content: JSON.stringify(ev.output), status: 'running' } };
      case 'status':
        if (ev.status === 'rate_limited') {
          const msg = `[速率限制] 等待 API 恢复${ev.resetsAt ? '，重置于 ' + ev.resetsAt : ''}...`;
          return { type: 'node_output', extra: { nodeId, content: msg, status: 'running' } };
        }
        return { type: 'node_output', extra: { nodeId, content: '', status: ev.status as RoleStatus } };
      case 'session_init':
        return null;
      case 'done':
        return null;
      default:
        return null;
    }
  }
}
