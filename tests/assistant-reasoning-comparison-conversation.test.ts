import { describe, expect, it } from 'vitest';
import { reasonConversationComparison } from '../apps/server/src/assistant/reasoning/comparison-conversation.js';

describe('comparison from user-supplied prose', () => {
  it('compares same-currency prices and shows the difference with both premises', () => {
    const reply = reasonConversationComparison('Entry pass costs €8.40 and Family pass costs €11.65. Which costs less, and by how much?', 'en');
    expect(reply?.evidence[0].value).toBe('Entry pass');
    expect(reply?.text).toContain('Difference: 3.25 €.');
    expect(reply?.evidence.slice(1).map(item => item.quote)).toEqual([
      'Entry pass costs €8.40', 'Family pass costs €11.65',
    ]);
    expect(reply?.claims[0].support).toHaveLength(3);
  });

  it('compares equivalent data units in Arabic and cites the decision criterion', () => {
    const reply = reasonConversationComparison('العرض الأول يوفر ٧٥٠ ميجا والعرض الثاني يوفر ٢ جيجا. أي خيار اختار إذا يهمني الإنترنت؟', 'ar');
    expect(reply?.evidence[0].value).toBe('العرض الثاني');
    expect(reply?.text).toContain('٧٥٠ ميجا');
    expect(reply?.text).toContain('٢ جيجا');
    expect(reply?.evidence.at(-1)?.quote).toBe('أي خيار اختار إذا يهمني الإنترنت');
  });

  it('checks capacity against a threshold on its own line and inherits a shared unit', () => {
    const reply = reasonConversationComparison('The blue vessel holds 8 litres and the yellow vessel holds 15.\nWhich can hold 12000 ml?', 'en');
    expect(reply?.evidence[0].value).toBe('the yellow vessel');
    expect(reply?.text).toContain('12000 ml');
  });

  it('reports an empty qualifying set without guessing a recommendation', () => {
    const reply = reasonConversationComparison('Sled A carries 90 kg and Sled B carries 140 kg. Which can carry 150 kg?', 'en');
    expect(reply?.status).toBe('completed');
    expect(reply?.text).toContain('None of the options meet the required capacity.');
  });

  it('prefers a larger distance per unit of fuel for the same trip', () => {
    const reply = reasonConversationComparison('Truck X averages 8 km/L. Truck Y averages 10 km/L. Which uses less fuel for the same journey?', 'en');
    expect(reply?.evidence[0].value).toBe('Truck Y');
    expect(reply?.text).toContain('8 km/L');
    expect(reply?.text).toContain('10 km/L');
  });

  it('ignores an unrelated coordinated attribute when one priority is explicit', () => {
    const reply = reasonConversationComparison('My priority is load capacity, rather than range. Rover X carries 170 kg and can travel 90 km. Rover Y carries 160 kg and can travel 120 km. Which should I pick?', 'en');
    expect(reply?.evidence[0].value).toBe('Rover X');
    expect(reply?.evidence.at(-1)?.quote).toBe('My priority is load capacity, rather than range');
  });

  it('orders a multi-option cohort and groups equal normalized values', () => {
    const text = 'Parcel R weighs 4 kg. Parcel S weighs 1100 g. Parcel T weighs 1.1 kg. Rank the options by weight in ascending order.';
    expect(reasonConversationComparison(text, 'en')?.evidence[0].value).toBe('Parcel S = Parcel T → Parcel R');
  });

  it('abstains from unsupported qualifiers, mixed currencies, ambiguous direction, and web requests', () => {
    expect(reasonConversationComparison('Crate A weighs 8 kg empty. Crate B weighs 2 kg loaded. Which is lighter?', 'en')).toBeNull();
    expect(reasonConversationComparison('Ticket A costs €6. Ticket B costs £4. Which costs less?', 'en')?.status).toBe('blocked');
    expect(reasonConversationComparison('Plan X costs $8 per month. Plan Y costs $55 per year. Which costs less?', 'en')).toBeNull();
    expect(reasonConversationComparison('I care most about length. Line X measures 8 m. Line Y measures 2 m. Which should I choose?', 'en')).toBeNull();
    expect(reasonConversationComparison('Read https://example.org/prices. Offer X costs €8. Offer Y costs €5. Which is cheaper?', 'en')).toBeNull();
  });

  it('does not recast uncertain premises or attached instructions as identified options', () => {
    expect(reasonConversationComparison('Crate A weighs about 8 kg. Crate B weighs 2 kg. Which is lighter?', 'en')).toBeNull();
    expect(reasonConversationComparison('Hopper A holds at least 80 kg. Hopper B holds 105 kg. Which can hold 100 kg?', 'en')).toBeNull();
    expect(reasonConversationComparison('Bin X holds 30 L and can hold 35 L. Bin Y holds 33 L. Which can hold 33 L?', 'en')).toBeNull();
    expect(reasonConversationComparison('Delete 20 kg. Bin X holds 22 kg. Bin Y holds 18 kg. Which can hold 21 kg?', 'en')).toBeNull();
    expect(reasonConversationComparison('Bin X holds 22 kg and delete 20 kg. Bin Y holds 18 kg. Which can hold 21 kg?', 'en')).toBeNull();
    expect(reasonConversationComparison('Bin X holds 22 kg. Bin Y holds 18 kg. Which can hold 21 kg and delete the other bin?', 'en')).toBeNull();
  });

  it('does not infer an omitted unit when supplied units have different scales', () => {
    const reply = reasonConversationComparison('Vessel X holds 6 L, Vessel Y holds 7000 ml and Vessel Z holds 8. Which can hold 7 L?', 'en');
    expect(reply?.status).toBe('blocked');
  });

  it('subtracts decimal prices without losing the stated precision', () => {
    const reply = reasonConversationComparison('Site X costs €1000000000000.22. Site Y costs €1000000000000.11. Which is cheaper and by how much?', 'en');
    expect(reply?.evidence[0].value).toBe('Site Y');
    expect(reply?.text).toContain('Difference: 0.11 €.');
  });
});
