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
        cli TEXT,
        epoch TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, event_id);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        cli_session_id TEXT,
        PRIMARY KEY (session_id, role_id)
      );
    `);
    this.migrate();
  }

  private migrate() {
    const eventCols = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!eventCols.some(c => c.name === 'cli')) {
      this.db.exec('ALTER TABLE events ADD COLUMN cli TEXT');
    }
    const taskCols = this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!taskCols.some(c => c.name === 'session_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN session_id TEXT');
    }
    const sessionCols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (sessionCols.some(c => c.name === 'task_id')) {
      this.db.exec('DROP TABLE sessions; CREATE TABLE IF NOT EXISTS sessions (session_id TEXT NOT NULL, role_id TEXT NOT NULL, cli_session_id TEXT, PRIMARY KEY (session_id, role_id))');
    }
  }

  createTask(id: string, message: string, teamId: string, worktreePath: string, sessionId: string) {
    this.db.prepare('INSERT INTO tasks (id, message, team_id, worktree_path, session_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, message, teamId, worktreePath, sessionId, Date.now());
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
      `INSERT INTO events (task_id, role_id, attempt_id, type, content, node_id, tool_use_id, tool_name, from_node, to_node, status, cli, epoch, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      event.taskId, event.roleId ?? null, event.attemptId, event.type, event.content ?? null,
      event.nodeId ?? null, event.toolUseId ?? null, event.toolName ?? null,
      event.fromNode ?? null, event.toNode ?? null, event.status ?? null, event.cli ?? null,
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
      toNode: r.to_node, status: r.status as RoleStatus | undefined, cli: r.cli,
      epoch: r.epoch, createdAt: r.created_at,
    }));
  }

  getCliSessionId(sessionId: string, roleId: string): string | null {
    const row = this.db.prepare('SELECT cli_session_id FROM sessions WHERE session_id = ? AND role_id = ?')
      .get(sessionId, roleId) as { cli_session_id: string | null } | undefined;
    return row?.cli_session_id ?? null;
  }

  setCliSessionId(sessionId: string, roleId: string, cliSessionId: string) {
    this.db.prepare('INSERT OR REPLACE INTO sessions (session_id, role_id, cli_session_id) VALUES (?,?,?)')
      .run(sessionId, roleId, cliSessionId);
  }

  getSessionIdByTask(taskId: string): string | null {
    const row = this.db.prepare('SELECT session_id FROM tasks WHERE id = ?').get(taskId) as { session_id: string | null } | undefined;
    return row?.session_id ?? null;
  }

  getTaskListBySession(sessionId: string): Array<{ taskId: string; message: string; status: string; createdAt: number }> {
    const rows = this.db.prepare(
      `SELECT t.id, t.message, ts.status, t.created_at FROM tasks t JOIN task_states ts ON t.id = ts.task_id WHERE t.session_id = ? ORDER BY t.created_at ASC`
    ).all(sessionId) as any[];
    return rows.map(r => ({ taskId: r.id, message: r.message, status: r.status, createdAt: r.created_at }));
  }

  getSessionOutputs(sessionId: string): Array<{
    taskId: string; message: string; status: string; createdAt: number;
    outputs: Array<{ roleId: string; cli: string; content: string }>;
  }> {
    const tasks = this.db.prepare(
      `SELECT t.id, t.message, ts.status, t.created_at FROM tasks t JOIN task_states ts ON t.id = ts.task_id WHERE t.session_id = ? ORDER BY t.created_at ASC`
    ).all(sessionId) as any[];

    return tasks.map(t => {
      const events = this.db.prepare(
        `SELECT role_id, type, content, cli, node_id FROM events WHERE task_id = ? AND type = 'text' ORDER BY event_id ASC`
      ).all(t.id) as any[];

      const roleMap = new Map<string, { content: string; cli: string }>();
      for (const e of events) {
        const key = e.role_id ?? e.node_id ?? 'unknown';
        if (!roleMap.has(key)) roleMap.set(key, { content: '', cli: e.cli ?? '' });
        const entry = roleMap.get(key)!;
        if (e.content) entry.content += e.content;
        if (e.cli && !entry.cli) entry.cli = e.cli;
      }

      return {
        taskId: t.id,
        message: t.message,
        status: t.status,
        createdAt: t.created_at,
        outputs: Array.from(roleMap.entries()).map(([roleId, v]) => ({ roleId, cli: v.cli, content: v.content })),
      };
    });
  }
}
