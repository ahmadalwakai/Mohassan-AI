import type { SiteKind } from '@mohassan/contracts';

/**
 * A sentence bank: for each slot key, either one list for every kind or a list per kind.
 * Sentences carry placeholders ({name}, {city}, {first}, {item}) filled with the user's own words;
 * a sentence that needs a missing value is skipped at pick time. Banks never contain digits or claims
 * (tests enforce it): they are invitations and labels, not facts.
 */
export type SentenceList = readonly string[];
export type KindLists = Partial<Record<SiteKind, SentenceList>> & { default?: SentenceList };
export type Bank = Readonly<Record<string, SentenceList | KindLists>>;
export interface Labels {
  nav: Readonly<Record<'home' | 'about' | 'contact' | 'gallery' | 'hours', string>> & { items: Readonly<Record<SiteKind, string>> };
  buttons: Readonly<Record<'call' | 'whatsapp' | 'email' | 'order' | 'book' | 'directions' | 'menu' | 'close' | 'viewAll' | 'backHome', string>>;
  fields: Readonly<Record<'phone' | 'whatsapp' | 'email' | 'address' | 'hours' | 'follow' | 'price', string>>;
  messages: Readonly<Record<'enquiry' | 'order' | 'book', string>>;
  form: Readonly<Record<'name' | 'contact' | 'message' | 'send' | 'noteWhatsapp' | 'noteEmail' | 'noteEndpoint' | 'subject', string>>;
  skip: string;
}
export interface Copy { bank: Bank; labels: Labels }
