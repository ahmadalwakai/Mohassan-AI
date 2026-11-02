export type Language = "ar" | "en";
export type ChatMode = "auto" | "live_web" | "local";
export interface Source {
  id?: string;
  title: string;
  url: string | null;
  snippet?: string;
  retrieved_at?: string;
  published_at?: string;
}
export interface Evidence { level: "grounded" | "limited" | "unverified"; note?: string }
export interface ChatResponse {
  content: string;
  route: string;
  model?: string;
  sources?: Source[];
  evidence?: Evidence;
  warnings?: string[];
  timing_ms?: number;
  cache_hit?: boolean;
  usage?: Record<string, unknown>;
  memory_saved?: boolean;
  conversation_id?: string;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  delivery?: "pending" | "sent" | "failed";
  response?: ChatResponse;
}
export interface ChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  mode: ChatMode;
  remember: boolean;
  use_memory: boolean;
  allow_cloud: boolean;
  request_id: string;
  conversation_id?: string;
}
export interface Status {
  configured: boolean;
  paired: boolean;
  name?: string;
  model?: string;
  busy?: string | boolean | null;
  capabilities?: { local?: boolean; live_web?: boolean; knowledge?: boolean; memory?: boolean };
  app_actions_enabled?: boolean;
  cloud_configured?: boolean;
  storage?: "sqlite" | "neon";
}
export interface KnowledgeItem { id: string; title: string; content?: string; created_at?: string }
export interface Conversation { id: string; title: string; updated_at?: string }
export interface ConversationDetail extends Conversation { messages: { role: string; content: string }[] }
export interface Metrics {
  requests?: number;
  local_requests?: number;
  web_requests?: number;
  latency_ms?: number;
  memory_items?: number;
  [key: string]: unknown;
}
