import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { TaskEvent, DAGEventType, RoleStatus, TaskStatus } from '@myteam/shared';

export class AppDatabase {
  db: DatabaseSync;
  epoch: string;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.epoch = randomUUID();
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        team_id TEXT NOT NULL,
        worktree_path TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_states (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        role_id TEXT,
        attempt_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        node_id TEXT,
        tool_use_id TEXT,
        tool_name TEXT,
        from_node TEXT,
        to_node TEXT,
        status TEXT,
        epoch TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, event_id);

      CREATE TABLE IF NOT EXISTS sessions (
        task_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        cli_session_id TEXT,
        PRIMARY KEY (task_id, role_id)
      );
    `);
  }

  createTask(id: string, message: string, teamId: string, worktreePath: string) {
    this.db.prepare('INSERT INTO tasks (id, message, team_id, worktree_path, created_at) VALUES (?,?,?,?,?)')
      .run(id, message, teamId, worktreePath, Date.now());
    this.db.prepare('INSERT INTO task_states (task_id, status, started_at) VALUES (?,?,?)')
      .run(id, 'running', Date.now());
  }

  updateTaskStatus(taskId: string, status: TaskStatus) {
    this.db.prepare('UPDATE task_states SET status = ?, finished_at = ? WHERE task_id = ?')
      .run(status, Date.now(), taskId);
  }

  getTaskStatus(taskId: string): TaskStatus | null {
    const row = this.db.prepare('SELECT status FROM task_states WHERE task_id = ?').get(taskId) as { status: TaskStatus } | undefined;
    return row?.status ?? null;
  }

  appendEvent(event: Omit<TaskEvent, 'eventId' | 'createdAt'>): TaskEvent {
    const result = this.db.prepare(
      `INSERT INTO events (task_id, role_id, attempt_id, type, content, node_id, tool_use_id, tool_name, from_node, to_node, status, epoch, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      event.taskId, event.roleId ?? null, event.attemptId, event.type, event.content ?? null,
      event.nodeId ?? null, event.toolUseId ?? null, event.toolName ?? null,
      event.fromNode ?? null, event.toNode ?? null, event.status ?? null,
      event.epoch, Date.now()
    ) as any;
    return { ...event, eventId: Number(result.lastInsertRowid), createdAt: Date.now() };
  }

  getEventsAfter(taskId: string, afterEventId: number, limit = 100): TaskEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE task_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?'
    ).all(taskId, afterEventId, limit) as any[];
    return rows.map(r => ({
      eventId: r.event_id, taskId: r.task_id, roleId: r.role_id, attemptId: r.attempt_id,
      type: r.type as DAGEventType, content: r.content, nodeId: r.node_id,
      toolUseId: r.tool_use_id, toolName: r.tool_name, fromNode: r.from_node,
      toNode: r.to_node, status: r.status as RoleStatus | undefined,
      epoch: r.epoch, createdAt: r.created_at,
    }));
  }
}
