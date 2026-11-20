export type Lang = 'ar' | 'en';
export type Intent =
  | 'identity' | 'smalltalk' | 'compute' | 'memory_recall' | 'memory_save'
  | 'open_site' | 'site_check' | 'site_question' | 'fact_question' | 'compare'
  | 'explain' | 'write' | 'ads' | 'coding' | 'computer' | 'unknown';
export type AnswerType = 'date' | 'number' | 'money' | 'name' | 'place' | 'yes_no'
  | 'definition' | 'list' | 'steps' | 'text';
export type Source = 'fixed' | 'computed' | 'memory' | 'knowledge' | 'site' | 'index' | 'web';
export type SiteObservation =
  | { kind: 'http_status'; status: number }
  | { kind: 'redirect'; status: number; to: string }
  | { kind: 'metadata'; field: 'protocol' | 'title' | 'language' | 'last_modified' | 'page_date' | 'content_type' | 'content_hash' | 'identity'; value: string };

export interface Frame {
  lang: Lang;
  intent: Intent;
  /** Matching rules in priority order for the lab. The first one determines the intent. */
  matched: { intent: Intent; rule: string }[];
  text: string;
  urls: string[];
  focus: string[];
  answerType: AnswerType | null;
  timeSensitive: boolean;
  /** Personal requests are restricted to memory. */
  personal: boolean;
  valueOnly: boolean;
  /** Missing information to ask for together. */
  missing: string[];
}

export interface Evidence {
  id: string;
  source: Source;
  /** Final URL read in this run. */
  url?: string;
  fetchedAt?: string;
  /** Date stated by the page itself. */
  pageDate?: string | null;
  /** Verbatim excerpt from the source. */
  quote: string;
  /** Transport or page metadata attributable to this response URL. */
  observation?: SiteObservation;
  value?: string;
  /** Site named by the user or identified as official by a source. */
  official?: boolean;
}

export interface Claim {
  text: string;
  /** Evidence IDs, empty only for fixed text. */
  support: string[];
  status: 'confirmed' | 'single_source' | 'conflict' | 'not_found' | 'fixed';
}

export interface MindReply {
  status: 'completed' | 'partial' | 'blocked' | 'waiting_user';
  text: string;
  claims: Claim[];
  evidence: Evidence[];
  question?: { prompt: string; fields?: unknown[] };
  frame: Frame;
  /** Elapsed milliseconds per phase. */
  timings: Record<string, number>;
}

export interface MindDeps {
  search(query: string, limit: number, signal: AbortSignal): Promise<{ title: string; url: string; snippet: string }[]>;
  read(url: string, signal: AbortSignal): Promise<{ url: string; status: number; text: string; html: string; headers: Record<string, string>; fetchedAt?: string }>;
  memory?(query: string): Promise<readonly string[]>;
  saveMemory?(text: string, signal: AbortSignal): Promise<void>;
  knowledge?(query: string): Promise<{ title: string; text: string; source: string }[]>;
  siteSnapshot?(url: string): Promise<{ sourceHash: string; fetchedAt: string } | null>;
  now(): Date;
  step(label: string): Promise<void>;
}

export interface Mind {
  handle(request: string, deps: MindDeps, signal: AbortSignal, resume?: { frame: Frame; answer: string }): Promise<MindReply>;
}
