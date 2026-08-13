import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  TeamsConfig, RoutingConfig, CliProvidersConfig,
  TeamConfig, CliConfig, RoleConfig, ResolvedRole,
  ExecutionPlan, RoutingScope,
} from '@myteam/shared';

export class ConfigLoader {
  private teams: TeamsConfig;
  private routing: RoutingConfig;
  private cli: CliProvidersConfig;
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
    this.teams = this.loadYaml<TeamsConfig>('teams.yaml');
    this.routing = this.loadYaml<RoutingConfig>('routing.yaml');
    this.cli = this.loadYaml<CliProvidersConfig>('cli.yaml');
  }

  private loadYaml<T>(filename: string): T {
    const filepath = resolve(this.configDir, filename);
    const content = readFileSync(filepath, 'utf-8');
    return parseYaml(content) as T;
  }

  getTeam(teamId: string): TeamConfig {
    return this.teams.teams[teamId] ?? this.teams.teams[this.routing.default_team];
  }

  getCli(providerId: string): CliConfig {
    return this.cli.providers[providerId];
  }

  get defaultTeamId(): string {
    return this.routing.default_team;
  }

  get intentRules() {
    return this.routing.intent_rules;
  }

  resolvePlan(teamId: string, message: string, taskId: string): ExecutionPlan {
    const team = this.getTeam(teamId);
    const scope = inferRoutingScope(message);
    const roles: ResolvedRole[] = team.roles.map((r: RoleConfig) => ({
      ...r,
      cliConfig: this.resolveCli(this.getCli(r.cli)),
      resolvedEnv: this.resolveEnv(r),
    }));
    return {
      taskId,
      teamId,
      strategy: team.strategy,
      scope,
      roles,
      transitions: team.transitions,
      totalBudget: {
        maxTurns: team.total_budget?.max_turns ?? 100,
        timeoutMs: team.total_budget?.timeout_ms ?? 1800000,
      },
      createdAt: Date.now(),
    };
  }

  private resolveCli(cli: CliConfig): CliConfig {
    if (process.platform !== 'win32') return cli;
    const paths = (process.env.PATH ?? process.env.Path ?? '').split(';');
    for (const dir of paths) {
      if (!dir) continue;
      const cmdPath = `${dir}\\${cli.command}.cmd`;
      try {
        if (!existsSync(cmdPath)) continue;
        const content = readFileSync(cmdPath, 'utf-8');
        // 先检查 .js（用 node 运行，如 codex）
        const jsMatch = content.match(/"([^"]+\.js)"/);
        if (jsMatch) {
          const jsPath = jsMatch[1].replace(/%dp0%\\/g, dir + '\\').replace(/%dp0%/g, dir);
          const nodeMatch = content.match(/"([^"]+node\.exe)"/);
          const nodePath = nodeMatch ? nodeMatch[1].replace(/%dp0%\\/g, dir + '\\').replace(/%dp0%/g, dir) : 'node';
          return { ...cli, command: nodePath, args: [jsPath, ...cli.args] };
        }
        // 再检查 .exe（如 opencode, claude）
        const exeMatch = content.match(/"([^"]+\.exe)"/);
        if (exeMatch) {
          const exePath = exeMatch[1].replace(/%dp0%\\/g, dir + '\\').replace(/%dp0%/g, dir);
          return { ...cli, command: exePath };
        }
      } catch {}
    }
    return cli;
  }

  private resolveEnv(role: RoleConfig): Record<string, string> {
    const env: Record<string, string> = {};
    const allowlist = role.env_allowlist ?? [];
    for (const key of allowlist) {
      const val = process.env[key];
      if (val) env[key] = val;
    }
    return env;
  }
}

export function inferRoutingScope(message: string): RoutingScope {
  const lower = message.toLowerCase();
  if (lower.includes('review') || lower.includes('lgtm') || message.includes('审查')) return 'review';
  if (lower.includes('architecture') || message.includes('架构') || message.includes('设计') || message.includes('方案')) return 'architecture';
  if (/实现|修复|重构|写|implement|fix/i.test(message)) return 'code';
  if (/什么是|怎么|为什么|解释|what|how|why/i.test(message)) return 'qa';
  return 'general';
}
