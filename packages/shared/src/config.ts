import { z } from 'zod';

export const RoleConfigSchema = z.object({
  id: z.string(),
  cli: z.string(),
  system_prompt: z.string(),
  tools: z.array(z.string()).optional(),
  max_turns: z.number().default(50),
  receives_from: z.array(z.string()).optional(),
  handoff: z.boolean().optional(),
  team_strengths: z.string().optional(),
  caution: z.string().nullable().optional(),
  restrictions: z.array(z.string()).optional(),
  env_allowlist: z.array(z.string()).optional(),
});

export const RoleTransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  condition: z.enum(['always', 'on_handoff', 'on_vote', 'on_verdict']).optional(),
});

export const TeamConfigSchema = z.object({
  name: z.string(),
  strategy: z.enum(['serial', 'parallel', 'adaptive']),
  transitions: z.array(RoleTransitionSchema),
  total_budget: z.object({
    max_turns: z.number(),
    timeout_ms: z.number(),
  }),
  roles: z.array(RoleConfigSchema),
});

export const TeamsConfigSchema = z.object({
  teams: z.record(z.string(), TeamConfigSchema),
});

export const CliConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  cwd_mode: z.string(),
  event_parser: z.string(),
  prompt_via: z.string(),
  env: z.record(z.string(), z.string()),
});

export const CliProvidersConfigSchema = z.object({
  providers: z.record(z.string(), CliConfigSchema),
});

export const IntentRuleSchema = z.object({
  intent: z.string(),
  patterns: z.array(z.string()),
  team: z.string(),
});

export const RoutingConfigSchema = z.object({
  intent_rules: z.array(IntentRuleSchema),
  default_team: z.string(),
});
