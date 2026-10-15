// Mirrors common/schema/*.json and common/python/stunfisk_plugin_common. Keep the three in step.

export type RunMode = 'local' | 'remote';
export type AnalysisMode = 'fast' | 'standard' | 'deep';
export type Side = 'p1' | 'p2';
export type Phase = 'waiting' | 'preview' | 'turn' | 'switch' | 'ended';

export interface Settings {
  email: string;
  model: string;
  engine: string;
  run_mode: RunMode;
  local_url: string;
  remote_url: string;
  analysis_mode: AnalysisMode;
}

export interface Choice {
  action: string;
  choice: string;
  win?: number | null;
  likelihood?: number | null;
}

export interface Analysis {
  phase: Phase;
  turn: number;
  side?: Side | null;
  win?: number | null;
  recommended?: Choice | null;
  choices?: Choice[];
  expected_opponent?: Choice[];
  notes: string[];
  model?: string;
  engine?: string;
}

export interface AdapterInfo {
  id: string;
  name: string;
  level: string;
  formats: string[];
  available: boolean;
  reason: string;
}

export interface Capabilities {
  models: AdapterInfo[];
  engines: AdapterInfo[];
}

export interface SessionStatus {
  id: string;
  status: 'idle' | 'analysing' | 'ready' | 'error' | 'closed';
  revision: number;
  lines: number;
  analysis: Analysis | null;
  error: string | null;
}
