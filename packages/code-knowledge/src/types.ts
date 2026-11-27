export interface Attribution {
  name: string;
  url?: string;
}

export interface SourceCard {
  id: string;
  title: string;
  kind: 'documentation' | 'qa';
  url: string;
  license: string;
  licenseUrl: string;
  version: string;
  fingerprint: string;
  retrievedOn?: string;
  copyrightNotice?: string;
}

export interface CodeBlock {
  text: string;
  language?: string;
  role?: 'fix' | 'failure';
  license?: string;
  licenseUrl?: string;
  copyrightNotice?: string;
}

export interface Passage {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  questionUrl?: string;
  text: string;
  code: readonly CodeBlock[];
  tags: readonly string[];
  symbols?: readonly string[];
  attribution?: readonly Attribution[];
  license?: string;
  licenseUrl?: string;
  copyrightNotice?: string;
}

export interface Corpus {
  sources: readonly SourceCard[];
  passages: readonly Passage[];
}

export const questionTypes = ['how-to', 'error', 'api-usage', 'concept', 'comparison'] as const;
export type QuestionType = typeof questionTypes[number];

export interface Citation {
  title: string;
  url: string;
  questionUrl?: string;
  sourceTitle: string;
  sourceKind?: SourceCard['kind'];
  sourceUrl: string;
  version: string;
  fingerprint: string;
  retrievedOn?: string;
  license: string;
  licenseUrl: string;
  attribution: readonly Attribution[];
  copyrightNotice?: string;
}

export interface Excerpt {
  sentences: readonly string[];
  code: readonly CodeBlock[];
  citation: Citation;
}

export type CodeAnswer =
  | { status: 'answered'; intent: QuestionType; excerpts: readonly Excerpt[] }
  | { status: 'abstained'; intent: QuestionType; reason: 'insufficient-evidence' | 'unsupported-request' };
