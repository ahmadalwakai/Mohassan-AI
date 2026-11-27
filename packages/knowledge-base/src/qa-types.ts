import type { LinkedEntityCandidate } from './entity-linking.ts';
import type { Fact, WikidataSource } from './query.ts';
import type { EntityCategory, Language, WikidataReference, WikidataSnak } from './types.ts';

export type KnowledgeAnswerType = 'entity' | 'quantity' | 'date' | 'text';
export type KnowledgeTime = { year?: number; order?: 'latest' | 'earliest' };

export interface KnowledgeMention {
  text: string;
  category?: EntityCategory;
  /** Generic descriptors can be removed after the full mention has no match. */
  alternatives?: readonly string[];
}

export interface KnowledgeProperty {
  id: string;
  label: Record<Language, string>;
  answerType: KnowledgeAnswerType;
  unit?: string;
}

type QuestionBase = {
  language: Language;
  property: KnowledgeProperty;
  expected: KnowledgeAnswerType;
  time?: KnowledgeTime;
};

export type KnowledgeQuestion = QuestionBase & (
  | { kind: 'lookup' | 'count'; entity: KnowledgeMention; multiple?: boolean }
  | { kind: 'path'; entity: KnowledgeMention; hops: readonly KnowledgeProperty[]; countryOfBirth?: boolean; multiple?: boolean }
  | { kind: 'compare'; entities: readonly [KnowledgeMention, KnowledgeMention, ...KnowledgeMention[]]; direction?: 'max' | 'min' }
  | { kind: 'superlative'; category: EntityCategory; direction: 'max' | 'min'; entities?: readonly [KnowledgeMention, KnowledgeMention, ...KnowledgeMention[]] }
);

export type KnowledgeValue =
  | { kind: 'entity'; id: string; label: string }
  | { kind: 'quantity'; amount: string; unit: string }
  | { kind: 'date'; year: number; month?: number; day?: number; calendar: string; raw: string; precision: number }
  | { kind: 'text'; text: string; language?: string };

export interface KnowledgeFact extends Fact {
  references: WikidataReference[];
  dates: {
    snapshot: string;
    qualifiers: WikidataSnak[];
    references: WikidataSnak[];
  };
}

type AnswerBase = { language: Language; text: string; searched: string[] };
export type KnowledgeAnswer = AnswerBase & (
  | { status: 'answered'; question: KnowledgeQuestion; values: KnowledgeValue[]; facts: KnowledgeFact[];
      scope?: { kind: 'indexed-category'; category: EntityCategory; entities: number; comparable: number }
        | { kind: 'recorded-values' } }
  | { status: 'choice'; question: KnowledgeQuestion; mention: string; candidates: LinkedEntityCandidate[] }
  | { status: 'abstained'; question?: KnowledgeQuestion; reason: string }
);

export type KnowledgeSnapshot = Pick<WikidataSource, 'dataset' | 'dumpSource' | 'dumpDate' | 'fingerprint' | 'license'>;
