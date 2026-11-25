import { describe, expect, it } from 'vitest';
import { evaluateWordExpression } from '../apps/server/src/assistant/word-problem-graph.js';
import { parseEnglishRelations } from '../apps/server/src/assistant/word-problem-relations.js';

function solve(statements: string[], question: string) {
  const graph = parseEnglishRelations(statements, question);
  return graph ? evaluateWordExpression(graph) : null;
}

describe('English word-problem relations', () => {
  it.each([
    ['five more pins than Bea', '14'],
    ['4 fewer pins than Bea', '5'],
    ['2 less pins than Bea', '7'],
    ['three times as many pins as Bea', '27'],
    ['twice as many pins as Bea', '18'],
    ['half as many pins as Bea', '4.5'],
  ])('resolves %s against the named owner', (comparison, expected) => {
    expect(solve(['Bea owns 9 pins', `Lou has ${comparison}`], 'How many pins does Lou have')?.value).toBe(expected);
  });

  it('preserves exact fractions through inventory changes', () => {
    const result = solve(['Nico has 36 truffles', 'Nico donated one-third of his truffles', 'Then he bought 5 more truffles'],
      'How many truffles does Nico have left');
    expect(result?.value).toBe('29');
    expect(result?.steps.map(step => step.value)).toEqual(['1/3', '12', '24', '29']);
  });

  it('derives a named subset with a decimal percent', () => {
    const result = solve(['Aly has 80 tiles', '12.5% of her tiles are glass tiles'], 'How many glass tiles does Aly own');
    expect(result?.value).toBe('10');
    expect(result?.steps.map(step => step.value)).toEqual(['0.125', '10']);
  });

  it('tracks a changing remainder when each subsequent part refers to unclassified items', () => {
    const facts = ['Tess owns 96 postcards', '25 percent of them had black ink, three quarters of the remaining postcards had blue ink, and the rest had gold foil'];
    const result = solve(facts, 'How many of the postcards had gold foil on them');
    expect(result?.value).toBe('18');
    expect(result?.steps.map(step => step.value)).toEqual(['0.25', '24', '72', '0.75', '54', '18']);
    expect(solve(['Tess owns 96 postcards', '25 percent of them had black ink, three quarters of the postcards had blue ink, and the rest had gold foil'],
      'How many of the postcards had gold foil on them')).toBeNull();
  });

  it('preserves both owners in a coordinated amount and computes a total', () => {
    expect(solve(['June has 8 shells and Caleb has 12 shells'], 'How many shells do they have in total')?.value).toBe('20');
    expect(solve(['Frida owns 11 tulips and Arlo has 13 tulips'], 'How many tulips are there altogether')?.value).toBe('24');
  });

  it('separates adding and removing from the same inventory', () => {
    expect(solve(['Noor had 15 buttons and then bought 3 more', 'Noor lost 2 buttons'],
      'How many buttons does Noor have remaining')?.value).toBe('16');
  });

  it('carries a proven owner across coordinated additions and removals', () => {
    expect(solve(['Fatima owned 22 stamps and bought 6 more and lost 4 stamps'],
      'How many stamps does Fatima have now')?.value).toBe('24');
  });

  it('resolves chained dependent comparisons independently of their declaration order', () => {
    const facts = ['Otto has four more pencils than Jo', 'Jo has twice the number of pencils that Alice owns', 'Alice owns 7 pencils'];
    expect(solve(facts, 'How many pencils does Otto have')?.value).toBe('18');
    expect(solve(['Ari has three times as many as Chu', 'Chu owns 4 disks'], 'How many disks does Ari have')?.value).toBe('12');
    expect(solve(['Ari has three times as many as Chu', 'Chu owns 4 disks', 'Chu owns 3 kites'],
      'How many disks does Ari have')).toBeNull();
    expect(solve(['Chu owns 4 disks', 'Ari has three times as many as Chu', 'Chu owns 3 kites'],
      'How many disks does Ari have')).toBeNull();
    expect(solve(['Otto has four more pencils than Jo', 'Jo has twice as many pencils as Otto'],
      'How many pencils does Otto have')).toBeNull();
  });

  it('removes each transfer from the sender and credits the recipient with a known balance', () => {
    const facts = ['Xena has 31 tokens', 'Hal has 6 tokens', 'Xena handed 4 tokens to Hal and 7 to Peri'];
    expect(solve(facts, 'How many tokens does Xena have left')?.value).toBe('20');
    expect(solve(facts, 'How many tokens does Hal have now')?.value).toBe('10');
    expect(solve(facts, 'How many tokens did Peri receive')?.value).toBe('7');
    expect(solve(facts, 'How many tokens does Peri have now')).toBeNull();
    expect(solve(facts, 'How many tokens are there in total')).toBeNull();
    expect(solve([facts[0], facts[2]], 'How many tokens do they have in total')).toBeNull();
  });

  it('computes a directed comparison and a symmetric difference', () => {
    const facts = ['Enzo owns 9 maps', 'Toby has 14 maps'];
    expect(solve(facts, 'How many fewer maps does Enzo have than Toby')?.value).toBe('5');
    expect(solve(facts, 'What is the difference in maps between Enzo and Toby')?.value).toBe('5');
    expect(solve(facts, 'How many more maps does Enzo have than Toby')).toBeNull();
  });

  it('uses equal named periods for an average while retaining the counts per period', () => {
    const facts = ['On Monday, Mia read 7 pages', 'Mia read 10 pages on Tuesday', 'On Wednesday Mia read 14 pages'];
    expect(solve(facts, 'How many pages did Mia read on Tuesday')?.value).toBe('10');
    expect(solve(facts, 'How many pages did Mia read in all')?.value).toBe('31');
    expect(solve(facts, 'What is the average number of pages Mia read per day')?.value).toBe('31/3');
    expect(solve(facts, 'What is the average number of pages Mia read per month')).toBeNull();
  });

  it('requires an explicit sample when a period falls between stated amounts', () => {
    const facts = ['Yara ran 7 miles on Monday', 'On Friday, she ran 5 miles'];
    expect(solve(facts, 'What is the average number of miles Yara ran per day')).toBeNull();
    expect(solve(facts, 'What is the average number of miles Yara ran per day on those days')?.value).toBe('6');
  });

  it('averages comparable amounts from explicitly named owners', () => {
    expect(solve(['Adam has 24 badges', 'Omar has 12 badges'],
      'What is the average number of badges Adam and Omar have')?.value).toBe('18');
  });

  it('resolves the initial count and a later fraction only when the reference is explicit', () => {
    const facts = ['Alvo had 26 carrots', 'Alvo sold 6 carrots'];
    expect(solve(facts, 'How many carrots did Alvo have')).toBeNull();
    expect(solve(facts, 'How many carrots did Alvo have at first')?.value).toBe('26');
    expect(solve([...facts, 'Alvo used half of his carrots'], 'How many carrots does Alvo have now')).toBeNull();
    expect(solve([...facts, 'Alvo used half of his remaining carrots'], 'How many carrots does Alvo have now')?.value).toBe('10');
  });

  it.each([
    [['Elif has 12 coins', 'Tariq has 15 coins', 'She sold 2 coins'], 'How many coins does Elif have left'],
    [['Zara has 12 beads', 'Zara has 15 beads'], 'How many beads does Zara have'],
    [['Tomas has 12 grapes', 'Some of these are spoiled'], 'How many grapes does Tomas have left'],
    [['Uma has 18 ribbons', 'Eli has 4 apples'], 'How many ribbons do they have in total'],
    [['Tia owned 10 nails', 'She used some of them'], 'How many nails does she have left'],
    [['Dana bought 5 plates'], 'How many plates does Dana own'],
    [['Sana has 17 cards', 'Yasmin has 6 fewer tickets than Sana'], 'How many tickets does Yasmin have'],
    [['Owen had 17 pins', 'Owen donated 21 pins'], 'How many pins does Owen have left'],
    [['Dina has 20 cards', '125 percent of her cards are bronze cards'], 'How many bronze cards does Dina have'],
    [['Mei has 19 books', 'Mei read 4 books'], 'How many books does Mei have left'],
  ])('abstains from an unbound count, inconsistent unit, or incomplete clause %#', (facts, question) => {
    expect(solve(facts, question)).toBeNull();
  });
});
