/**
 * App configuration from `EXPO_PUBLIC_*` environment variables (see .env.example).
 *
 * Only public values belong here: the Supabase URL, the Supabase anon /
 * publishable key (row level security protects the data) and the serve URL.
 * Never put an LLM key, the Supabase service role key or the serve API key in
 * the app: anything bundled can be extracted.
 *
 * Expo inlines `process.env.EXPO_PUBLIC_X` at build time only for direct
 * property access, hence no dynamic lookups below.
 */

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  serveUrl: string;
  workflowName: string;
  /** Previous exchanges sent as sys.history (serve keeps at most 8). */
  historyTurns: number;
}

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; problems: string[] };

/**
 * Validate raw environment values.
 *
 * @param environment - Raw values, normally from readEnvironment() (Record<string, string | undefined>)
 * @returns The config, or the list of problems to show (ConfigResult)
 */
export function parseConfig(environment: Record<string, string | undefined>): ConfigResult {
  const problems: string[] = [];
  const supabaseUrl = requireUrl(environment, 'EXPO_PUBLIC_SUPABASE_URL', problems);
  const serveUrl = requireUrl(environment, 'EXPO_PUBLIC_SERVE_URL', problems);
  const supabaseAnonKey = environment.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';
  if (!supabaseAnonKey) {
    problems.push('EXPO_PUBLIC_SUPABASE_ANON_KEY is not set.');
  }
  const workflowName = environment.EXPO_PUBLIC_WORKFLOW?.trim() || 'agent';
  const historyTurns = Number(environment.EXPO_PUBLIC_HISTORY_TURNS?.trim() || '8');
  if (!Number.isInteger(historyTurns) || historyTurns < 0 || historyTurns > 50) {
    problems.push('EXPO_PUBLIC_HISTORY_TURNS must be an integer from 0 to 50.');
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, config: { supabaseUrl, supabaseAnonKey, serveUrl, workflowName, historyTurns } };
}

/** The run endpoint, e.g. https://chat.example.com/v1/workflows/agent/runs */
export function buildRunUrl(config: AppConfig): string {
  return `${config.serveUrl}/v1/workflows/${encodeURIComponent(config.workflowName)}/runs`;
}

export function readEnvironment(): Record<string, string | undefined> {
  return {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    EXPO_PUBLIC_SERVE_URL: process.env.EXPO_PUBLIC_SERVE_URL,
    EXPO_PUBLIC_WORKFLOW: process.env.EXPO_PUBLIC_WORKFLOW,
    EXPO_PUBLIC_HISTORY_TURNS: process.env.EXPO_PUBLIC_HISTORY_TURNS,
  };
}

function requireUrl(environment: Record<string, string | undefined>, name: string, problems: string[]): string {
  const value = environment[name]?.trim().replace(/\/+$/, '') ?? '';
  if (!/^https?:\/\/[^\s/]+/.test(value)) {
    problems.push(`${name} must be an http(s) URL.`);
  }
  return value;
}
