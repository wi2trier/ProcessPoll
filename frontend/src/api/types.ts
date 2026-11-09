export type QuestionType = 'trace' | 'single_choice' | 'multiple_choice' | 'number' | 'text';

export interface TraceConfig {
  mode: 'free' | 'select_sort';
  allow_repeats: boolean;
  allow_skip: boolean;
  min_steps: number;
  max_steps: number;
  activities: string[];
  allow_custom: boolean;
  suggest_existing: boolean;
  max_label_length: number;
}
export interface ChoiceConfig {
  options: string[];
  max_selected?: number | null;
}
export interface NumberConfig {
  min?: number | null;
  max?: number | null;
  integer: boolean;
  bins?: number[] | null;
}
export interface TextConfig {
  max_length: number;
}
export type QuestionConfig = TraceConfig | ChoiceConfig | NumberConfig | TextConfig;

export interface Question {
  id: string;
  position: number;
  type: QuestionType;

  prompt: string;

  label?: string | null;
  help: string | null;
  required: boolean;
  config: QuestionConfig;
}
export interface QuestionIn {
  id?: string;
  type: QuestionType;
  prompt: string;
  label?: string | null;
  help: string | null;
  required: boolean;
  config: QuestionConfig;
}

export type SessionStatus = 'draft' | 'open' | 'paused' | 'closed';

export interface Settings {
  results_public: boolean;
  allow_resubmit: boolean;
  retention_days: number;
  k_min: number;
}

export interface PublicSession {
  code: string;
  title: string;

  description?: string | null;
  status: SessionStatus;
  questions: Question[];
  settings: Pick<Settings, 'results_public' | 'allow_resubmit'>;
}
export interface AdminSession extends Omit<PublicSession, 'settings'> {
  settings: Settings;
  joined: number;
  submitted: number;
  version: number;
  created_at: string;
  opened_at: string | null;
  closed_at: string | null;
  expires_at: string | null;
  display_key: string;
}

export type AnswerValue =
  | { steps: string[] }
  | { value: string }
  | { values: string[] }
  | { value: number };
export interface AnswerIn {
  question_id: string;
  value: AnswerValue | null;
}

export interface CreateSessionIn {
  title: string;
  description?: string | null;
  questions: QuestionIn[];
  settings?: Partial<Settings>;
}
export interface CreateSessionOut {
  code: string;
  admin_key: string;
  display_key: string;
  session: AdminSession;
}
export interface PatchSessionIn {
  status?: SessionStatus;
  title?: string;

  description?: string | null;
  settings?: Partial<Settings>;
}

export interface JoinOut {
  participant_token: string;
  has_submitted: boolean;
}
export interface PatchQuestionIn {
  prompt?: string;
  help?: string | null;

  label?: string | null;
}
export interface SubmitOut {
  response_id: string;
}

export interface LabelRow {
  raw_key: string;
  display: string;
  count: number;
  canonical: string | null;
  hidden: boolean;
}
export interface MergeSuggestion {
  raw_keys: string[];
  similarity: number;
  proposed_canonical: string;
}
export interface LabelsOut {
  question_id: string;
  labels: LabelRow[];
  suggestions: MergeSuggestion[];
}
export interface AliasIn {
  raw_key: string;
  canonical: string | null;
  hidden: boolean;
}

export type NodeKind = 'start' | 'end' | 'activity';
export interface DfgNode {
  id: string;
  label: string;
  kind: NodeKind;
  count: number;
  case_count: number;
}
export interface DfgEdge {
  source: string;
  target: string;
  count: number;
  case_count: number;
}
export interface Dfg {
  nodes: DfgNode[];
  edges: DfgEdge[];
}
export interface Variant {
  steps: string[];
  count: number;
  share: number;
  cumulative_share: number;
}
export interface ActivityStat {
  label: string;
  count: number;
  case_count: number;
  repeat_traces: number;
  mean_position: number;
  start_count: number;
  end_count: number;
}
export interface Kpis {
  n: number;
  n_variants: number;
  variant_ratio: number;
  top_variant_share: number;
  coverage_top5: number;
  mean_length: number;
  start_agreement: number;
  end_agreement: number;
}
export interface StrongEdge {
  source: string;
  target: string;
  support: number;
  share: number;
  ci_low: number;
  ci_high: number;
}
export interface Hotspot {
  activity: string;
  support: number;
  dominant_share: number;
  ci_low: number;
  ci_high: number;
  entropy_norm: number;
  disagreement_mass: number;
  continuations: { target: string; count: number; share: number }[];
}
export interface Consensus {
  min_support: number;
  theta: number;
  strong: StrongEdge[];
  hotspots: Hotspot[];
  low_support: string[];
  medoid: { steps: string[]; mean_distance: number; approximate?: boolean } | null;
}
export interface Analytics {
  version: number;
  question_id: string;
  n: number;
  filter: { question_id: string; value: string } | null;
  kpis: Kpis;
  variants: Variant[];
  activities: ActivityStat[];
  dfg: Dfg;
  consensus: Consensus;

  suppressed?: true;
}

export interface CompareGroup {
  value: string;
  n: number;
  analytics: Analytics;
}
export interface DiffEdge {
  source: string;
  target: string;
  shares: Record<string, number>;
  delta: number;
  p_value: number | null;
  q_value: number | null;
}
export interface Compare {
  version: number;
  question_id: string;
  group_by: { question_id: string; prompt: string; label?: string | null };
  groups: CompareGroup[];
  hidden_groups: { value: string; n: number }[];
  pairwise: { a: string; b: string; js_edges: number; js_variants: number }[];
  diff_edges: DiffEdge[];
  warnings: string[];
}

export interface Tick {
  version: number;
  joined: number;
  submitted: number;
  status: SessionStatus;
}

export interface ApiErrorBody {
  detail?: string;
  message?: string;
  errors?: { question_id?: string; field?: string; message: string }[];
}

export interface Meta {
  version: string;
  demo_mode: boolean;
}

export const START_ID = '__start__';
export const END_ID = '__end__';

export interface StoredSession {
  code: string;
  admin_key: string;
  display_key: string;
  title: string;
  created_at: string;
}
