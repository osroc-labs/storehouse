// Environment variables coding agents set in the shells they run commands in. Any one, set and
// non-empty, means an agent may be at the wheel, so a protected env refuses outright.
const detectAgent = 'github.com/vercel/vercel packages/detect-agent';
const isAiAgent = 'docs.rs/is-ai-agent';

export const agentMarkers = [
  { name: 'CLAUDECODE', agent: 'Claude Code', source: detectAgent },
  { name: 'CLAUDE_CODE', agent: 'Claude Code', source: detectAgent },
  {
    name: 'CLAUDE_CODE_ENTRYPOINT',
    agent: 'Claude Code',
    source: 'set in every Claude Code shell',
  },
  { name: 'CODEX_SANDBOX', agent: 'Codex CLI', source: detectAgent },
  { name: 'CODEX_CI', agent: 'Codex CLI', source: detectAgent },
  { name: 'CODEX_THREAD_ID', agent: 'Codex CLI', source: detectAgent },
  { name: 'CURSOR_AGENT', agent: 'Cursor', source: detectAgent },
  {
    name: 'CURSOR_EXTENSION_HOST_ROLE',
    agent: 'Cursor',
    value: 'agent-exec',
    source: detectAgent,
  },
  { name: 'GEMINI_CLI', agent: 'Gemini CLI', source: detectAgent },
  { name: 'ANTIGRAVITY_AGENT', agent: 'Antigravity', source: detectAgent },
  { name: 'AUGMENT_AGENT', agent: 'Augment', source: detectAgent },
  { name: 'CLINE_ACTIVE', agent: 'Cline', source: isAiAgent },
  { name: 'OPENCODE', agent: 'OpenCode', source: detectAgent },
  { name: 'OPENCODE_CLIENT', agent: 'OpenCode', source: detectAgent },
  { name: 'TRAE_AI_SHELL_ID', agent: 'TRAE', source: isAiAgent },
  { name: 'GOOSE_TERMINAL', agent: 'Goose', source: isAiAgent },
  // the cross-agent conventions: their value names the agent
  { name: 'AI_AGENT', agent: '', source: detectAgent },
  {
    name: 'AGENT',
    agent: '',
    source: 'github.com/agentsmd/agents.md issue 136',
  },
] as const satisfies readonly {
  name: string;
  agent: string;
  source: string;
  value?: string;
}[];

// Markers a person's own terminal sets too, so they'd refuse people. Aider sets none at all.
export const ignoredAgentMarkers = [
  { name: 'CURSOR_TRACE_ID', reason: 'set in every Cursor terminal' },
  { name: 'REPL_ID', reason: 'set in every Replit shell' },
  { name: 'COPILOT_MODEL', reason: 'a Copilot CLI setting a person exports' },
  {
    name: 'COPILOT_ALLOW_ALL',
    reason: 'a Copilot CLI setting a person exports',
  },
  {
    name: 'COPILOT_GITHUB_TOKEN',
    reason: 'a Copilot CLI setting a person exports',
  },
] as const;

// the first agent marker set in env, with the agent it means
export const getAgentMarker = (
  env: Readonly<Record<string, string | undefined>>,
) => {
  for (const marker of agentMarkers) {
    const value = env[marker.name]?.trim();
    if (value && (!('value' in marker) || value === marker.value)) {
      return { name: marker.name, agent: marker.agent || value };
    }
  }
  return undefined;
};
