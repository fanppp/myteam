export type Strategy = 'serial' | 'parallel' | 'adaptive';
export type RoutingScope = 'code' | 'review' | 'architecture' | 'qa' | 'general';
export type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled' | 'stale';
export type RoleStatus = 'pending' | 'running' | 'thinking' | 'tool' | 'done' | 'error' | 'stale';

export interface RoleTransition {
  from: string;
  to: string;
  condition?: 'always' | 'on_handoff' | 'on_vote' | 'on_verdict';
}

export interface RoleConfig {
  id: string;
  cli: string;
  system_prompt: string;
  tools?: string[];
  max_turns: number;
  receives_from?: string[];
  handoff?: boolean;
  team_strengths?: string;
  caution?: string | null;
  restrictions?: string[];
  env_allowlist?: string[];
}

export interface TeamConfig {
  name: string;
  strategy: Strategy;
  transitions: RoleTransition[];
  total_budget: { max_turns: number; timeout_ms: number };
  roles: RoleConfig[];
}

export interface CliConfig {
  command: string;
  args: string[];
  cwd_mode: string;
  event_parser: string;
  prompt_via: string;
  env: Record<string, string>;
}

export interface ResolvedRole extends RoleConfig {
  cliConfig: CliConfig;
  resolvedEnv: Record<string, string>;
}

export interface ExecutionPlan {
  taskId: string;
  teamId: string;
  strategy: Strategy;
  scope: RoutingScope;
  roles: ResolvedRole[];
  transitions: RoleTransition[];
  totalBudget: { maxTurns: number; timeoutMs: number };
  createdAt: number;
}

export interface Task {
  id: string;
  message: string;
  plan: ExecutionPlan;
  worktreePath: string;
  status: TaskStatus;
  createdAt: number;
  finishedAt?: number;
}

export type DAGEventType =
  | 'node_start' | 'node_output' | 'node_complete' | 'node_error'
  | 'edge' | 'tool_use' | 'tool_result' | 'task_done';

export interface TaskEvent {
  eventId: number;
  taskId: string;
  roleId?: string;
  attemptId: string;
  type: DAGEventType;
  content?: string;
  cli?: string;
  nodeId?: string;
  toolUseId?: string;
  toolName?: string;
  fromNode?: string;
  toNode?: string;
  status?: RoleStatus;
  epoch: string;
  createdAt: number;
}

export interface RouteDecision {
  teamId: string;
  strategy: Strategy;
  intent: string;
  scope: RoutingScope;
  confidence: number;
  source: 'rule' | 'llm' | 'sticky' | 'default';
}

export interface IntentRule {
  intent: string;
  patterns: string[];
  team: string;
}

export interface RoutingConfig {
  intent_rules: IntentRule[];
  default_team: string;
}

export interface CliProvidersConfig {
  providers: Record<string, CliConfig>;
}

export interface TeamsConfig {
  teams: Record<string, TeamConfig>;
}
