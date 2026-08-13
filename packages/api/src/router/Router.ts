import type { ConfigLoader } from '../config/ConfigLoader.js';
import type { RouteDecision, RoutingScope } from '@myteam/shared';

export class Router {
  private config: ConfigLoader;
  private lastTeamId: string | null = null;

  constructor(config: ConfigLoader) {
    this.config = config;
  }

  route(message: string, override?: string): RouteDecision {
    let teamId: string | undefined = override;
    let source: RouteDecision['source'] = 'rule';
    let intent = 'unknown';
    let confidence = 0;

    // ① 用户 @指定团队
    if (teamId) {
      source = 'rule';
      confidence = 1.0;
    } else {
    // ② 规则匹配
    for (const rule of this.config.intentRules) {
      for (const pattern of rule.patterns) {
        if (message.toLowerCase().includes(pattern.toLowerCase())) {
          console.log(`[Router] MATCH: rule=${rule.intent} pattern="${pattern}" msg="${message}"`);
          teamId = rule.team;
          intent = rule.intent;
          source = 'rule';
          confidence = 0.9;
          break;
        }
      }
      if (teamId) break;
    }

    // ④ 上次团队粘性
    if (!teamId && this.lastTeamId) {
      console.log(`[Router] STICKY: lastTeam=${this.lastTeamId} msg="${message}"`);
      teamId = this.lastTeamId;
      source = 'sticky';
      confidence = 0.5;
    }

    // ⑤ 默认团队
    if (!teamId) {
      console.log(`[Router] DEFAULT: msg="${message}"`);
      teamId = this.config.defaultTeamId;
      source = 'default';
      confidence = 0.1;
    }
    }

    this.lastTeamId = teamId;
    const team = this.config.getTeam(teamId);
    const scope = inferScope(message);

    return {
      teamId: teamId!,
      strategy: team.strategy,
      intent,
      scope,
      confidence,
      source,
    };
  }
}

function inferScope(message: string): RoutingScope {
  const lower = message.toLowerCase();
  if (lower.includes('review') || lower.includes('lgtm') || message.includes('审查')) return 'review';
  if (lower.includes('architecture') || message.includes('架构') || message.includes('设计') || message.includes('方案')) return 'architecture';
  if (/实现|修复|重构|写|implement|fix/i.test(message)) return 'code';
  if (/什么是|怎么|为什么|解释|what|how|why/i.test(message)) return 'qa';
  return 'general';
}
