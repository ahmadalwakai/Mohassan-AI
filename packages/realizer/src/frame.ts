export type Language = "ar" | "en";
export type ArabicGender = "masculine" | "feminine";
export type GrammaticalNumber = "singular" | "dual" | "plural";

export interface LocalizedText {
  readonly ar: string;
  readonly en: string;
}

export interface ArabicNoun {
  readonly gender: ArabicGender;
  readonly singular: string;
  readonly dual?: {
    readonly nominative: string;
    readonly oblique: string;
    readonly constructNominative: string;
    readonly constructOblique: string;
  };
  readonly plural?: string;
  readonly obliquePlural?: string;
  readonly constructPlural?: string;
  readonly constructObliquePlural?: string;
  readonly accusativeSingular?: string;
  readonly definiteSingular?: string;
  readonly definiteDual?: { readonly nominative: string; readonly oblique: string };
  readonly definitePlural?: string;
  readonly rational?: boolean;
}

export interface ArabicAgreement {
  readonly gender: ArabicGender;
  readonly number: GrammaticalNumber;
  readonly rational?: boolean;
}

export type ArabicForms = Readonly<Record<ArabicGender, Readonly<Record<GrammaticalNumber, string>>>>;

export interface Noun {
  readonly ar: ArabicNoun;
  readonly en: {
    readonly singular: string;
    readonly plural?: string;
    /** Override for words such as hour, URL, and initialisms. */
    readonly article?: "a" | "an";
    readonly mass?: boolean;
  };
}

export type Entity =
  | {
      readonly kind: "name";
      readonly name: LocalizedText;
      readonly agreement?: Partial<ArabicAgreement>;
    }
  | {
      readonly kind: "noun";
      readonly noun: Noun;
      readonly number?: GrammaticalNumber;
      readonly definite?: boolean;
      readonly owner?: Entity;
      readonly adjective?: {
        readonly ar: ArabicForms;
        readonly arDefinite?: ArabicForms;
        readonly en: string;
      };
    };

export type CalendarDate = {
  readonly calendar: "gregorian" | "hijri";
  readonly year: number;
} & (
  | { readonly month?: never; readonly day?: never }
  | { readonly month: number; readonly day?: number }
);

export type Value =
  | { readonly kind: "text"; readonly text: LocalizedText }
  /** A display value already verified and formatted by its producer. */
  | { readonly kind: "literal"; readonly text: LocalizedText }
  | { readonly kind: "entity"; readonly entity: Entity }
  | { readonly kind: "number"; readonly amount: number; readonly unit?: Noun; readonly display?: LocalizedText }
  | { readonly kind: "range"; readonly min: number; readonly max: number; readonly unit?: Noun }
  | { readonly kind: "date"; readonly date: CalendarDate };

export interface Source {
  readonly label: LocalizedText;
  readonly url?: string;
}

export type Certainty = "verified" | "single-source" | "approximate" | "single-source-approximate";

export interface Presentation {
  readonly language: Language;
  readonly conversationSeed: string;
  readonly replyIndex?: number;
  readonly length?: "short" | "detailed";
  readonly digits?: "western" | "arabic-indic";
  readonly numberStyle?: "digits" | "words";
  readonly dateStyle?: "long" | "day-first" | "iso";
  readonly sources?: readonly Source[];
}

export type DeclineReason = "missing-evidence" | "unsupported" | "unverified" | "not-allowed";

export type AnswerFrame = Presentation & (
  | {
      readonly intent: "fact";
      readonly subject: Entity;
      /** A property such as the capital or the population, possessed by the subject. */
      readonly property?: Noun;
      readonly value: Value;
      readonly asOf?: CalendarDate;
      readonly certainty?: Certainty;
    }
  | {
      readonly intent: "disagreement";
      readonly subject: Entity;
      readonly property?: Noun;
      readonly claims: readonly [Claim, Claim, ...Claim[]];
    }
  | {
      readonly intent: "compare";
      readonly left: Entity;
      readonly right: Entity;
      readonly relation: "greater" | "less" | "equal";
      readonly property?: Noun;
      readonly values?: readonly [Value, Value];
      readonly certainty?: Certainty;
    }
  | {
      readonly intent: "rank";
      readonly entries: readonly [{ readonly entity: Entity; readonly rank: number; readonly value?: Value },
        ...{ readonly entity: Entity; readonly rank: number; readonly value?: Value }[]];
      readonly certainty?: Certainty;
    }
  | {
      readonly intent: "calculation";
      readonly value: Value;
      readonly label?: LocalizedText;
      readonly expression?: LocalizedText;
      readonly relation?: "equals" | "conversion" | "weekday" | "interval";
      readonly certainty?: Certainty;
    }
  | {
      readonly intent: "plan";
      readonly plan: Entity;
      readonly status: "completed" | "partial" | "failed" | "blocked";
      readonly steps?: readonly {
        readonly step: Entity;
        readonly status: "completed" | "failed" | "skipped" | "unverified";
        readonly value?: Value;
      }[];
      readonly certainty?: Certainty;
    }
  | {
      readonly intent: "memory";
      readonly subject: Entity;
      readonly property?: Noun;
      readonly value: Value;
      readonly recordedOn?: CalendarDate;
      readonly validity?: { readonly since?: CalendarDate; readonly until?: CalendarDate };
      readonly certainty?: Certainty;
    }
  | {
      readonly intent: "decline";
      readonly reason: DeclineReason;
      readonly subject?: Entity;
    }
);

interface Claim {
  readonly source: Source;
  readonly value: Value;
  readonly approximate?: boolean;
  readonly asOf?: CalendarDate;
}
