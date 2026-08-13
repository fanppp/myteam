export type AgentEvent =
  | { type: 'session_init'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; tool: string; input: unknown; toolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; output: unknown }
  | { type: 'status'; status: 'thinking' | 'running' }
  | { type: 'done'; isFinal: boolean; error?: string };

export function parseEvent(parser: string, raw: any): AgentEvent | null {
  switch (parser) {
    case 'opencode': return parseOpencode(raw);
    case 'codex': return parseCodex(raw);
    case 'claude': return parseClaude(raw);
    default: return parseGeneric(raw);
  }
}

function parseOpencode(raw: any): AgentEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type ?? raw.event;
  const part = raw.part ?? {};
  const partType = part.type;

  if (type === 'step_start') {
    return { type: 'status', status: 'thinking' };
  }
  if (partType === 'reasoning' || partType === 'thinking' || type === 'reasoning' || type === 'thinking') {
    const content = part.text ?? part.reasoning ?? raw.reasoning ?? raw.text ?? '';
    if (content) return { type: 'text', content: '[思考] ' + content };
    return { type: 'status', status: 'thinking' };
  }
  if (type === 'text' || type === 'message' || partType === 'text') {
    const content = part.text ?? raw.content?.text ?? raw.text ?? raw.message ?? part.content ?? '';
    if (content) return { type: 'text', content };
    return { type: 'status', status: 'thinking' };
  }
  if (type === 'tool_call' || type === 'tool_use' || partType === 'tool_use') {
    return { type: 'tool_use', tool: part.name ?? raw.name ?? part.tool ?? 'unknown', input: part.input ?? raw.input ?? {}, toolUseId: part.id ?? raw.id };
  }
  if (type === 'tool_result' || type === 'tool_call_output' || partType === 'tool_result') {
    return { type: 'tool_result', toolUseId: part.id ?? raw.id ?? '', output: part.output ?? raw.output ?? part.content ?? raw.content ?? {} };
  }
  if (type === 'step_finish') {
    return { type: 'status', status: 'running' };
  }
  if (type === 'error') {
    return { type: 'done', isFinal: true, error: raw.error ?? raw.message ?? part.error ?? 'unknown error' };
  }
  if (type === 'done' || type === 'complete' || type === 'finished') {
    return { type: 'done', isFinal: true };
  }
  return parseGeneric(raw);
}

function parseCodex(raw: any): AgentEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type ?? raw.event;
  const item = raw.item ?? {};

  if (type === 'thread.started' || type === 'session' || type === 'session_init') {
    return { type: 'session_init', sessionId: raw.thread_id ?? raw.sessionId ?? raw.session_id ?? '' };
  }
  if (type === 'turn.started') {
    return { type: 'status', status: 'running' };
  }
  if (type === 'item.completed' || type === 'item.created') {
    if (item.type === 'reasoning' || item.type === 'thinking') {
      const content = item.text ?? item.content ?? item.reasoning ?? '';
      if (content) return { type: 'text', content: '[思考] ' + content };
      return null;
    }
    if (item.type === 'agent_message' || item.type === 'message' || item.type === 'text') {
      const content = item.text ?? item.content ?? '';
      if (content) return { type: 'text', content };
    }
    if (item.type === 'error') {
      return null;
    }
    if (item.type === 'tool_call' || item.type === 'function_call') {
      return { type: 'tool_use', tool: item.name ?? item.tool ?? 'unknown', input: item.input ?? item.arguments ?? {}, toolUseId: item.id ?? item.call_id };
    }
    if (item.type === 'tool_call_output' || item.type === 'function_call_output') {
      return { type: 'tool_result', toolUseId: item.call_id ?? item.id ?? '', output: item.output ?? item.content ?? {} };
    }
    return null;
  }
  if (type === 'turn.completed') {
    return { type: 'done', isFinal: true };
  }
  if (type === 'message' || type === 'text' || type === 'assistant_message') {
    const content = typeof raw.content === 'string' ? raw.content : raw.content?.text ?? raw.text ?? raw.message ?? '';
    if (content) return { type: 'text', content };
    return { type: 'status', status: 'thinking' };
  }
  if (type === 'error') {
    return null;
  }
  if (type === 'done' || type === 'complete' || type === 'finished') {
    return { type: 'done', isFinal: true };
  }
  return parseGeneric(raw);
}

function parseClaude(raw: any): AgentEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;

  if (type === 'system' && raw.subtype === 'init') {
    return { type: 'session_init', sessionId: raw.session_id ?? raw.sessionId ?? '' };
  }
  if (type === 'assistant') {
    const content = raw.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'thinking') {
          const text = part.thinking ?? '';
          if (text) return { type: 'text', content: '[思考] ' + text };
          return { type: 'status', status: 'thinking' };
        }
        if (part.type === 'text') {
          const text = part.text ?? '';
          if (text) return { type: 'text', content: text };
          return { type: 'status', status: 'thinking' };
        }
        if (part.type === 'tool_use') {
          return { type: 'tool_use', tool: part.name ?? 'unknown', input: part.input ?? {}, toolUseId: part.id };
        }
      }
    }
    return null;
  }
  if (type === 'user') {
    const content = raw.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'tool_result') {
          return { type: 'tool_result', toolUseId: part.tool_use_id ?? '', output: part.content ?? part.output ?? {} };
        }
      }
    }
    return null;
  }
  if (type === 'result') {
    return { type: 'done', isFinal: true, error: raw.is_error ? String(raw.result ?? 'error') : undefined };
  }
  return parseGeneric(raw);
}

function parseGeneric(raw: any): AgentEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.sessionId || raw.session_id) {
    return { type: 'session_init', sessionId: raw.sessionId ?? raw.session_id };
  }
  if (raw.content || raw.text || raw.message) {
    const content = typeof raw.content === 'string' ? raw.content
      : raw.content?.text ?? raw.text ?? raw.message ?? '';
    if (content) return { type: 'text', content };
  }
  if (raw.tool || raw.name || raw.function) {
    return { type: 'tool_use', tool: raw.tool ?? raw.name ?? raw.function ?? 'unknown', input: raw.input ?? raw.arguments ?? {} };
  }
  if (raw.error) {
    return { type: 'done', isFinal: true, error: String(raw.error) };
  }
  return null;
}
