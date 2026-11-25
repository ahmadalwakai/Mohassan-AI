import { evaluateWordExpression, operation, quantity, type WordExpression } from './word-problem-graph.js';
import { numberSource, parseNumber, unitKey } from './word-problem-quantities.js';

const number = `(?:${numberSource})`;
const currencyWord = String.raw`dollars?|pounds?|euros?`;
const money = String.raw`(?:[$£€] ?${number}|${number} (?:${currencyWord}))`;
const owner = String.raw`[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,3}?`;
const item = String.raw`[a-z][a-z'-]*(?: [a-z][a-z'-]*){0,5}?`;
const buyVerb = String.raw`(?:buys?|bought|purchases?|purchased|orders?|ordered|will buy|will purchase)`;
const total = String.raw`(?: in total| in all| altogether)?`;
const pattern = (source: string) => new RegExp(`^${source}$`, 'iu');

const moneyParts = pattern(String.raw`(?:(?<symbol>[$£€]) ?(?<symbolAmount>${number})|(?<wordAmount>${number}) (?<currency>${currencyWord}))`);
const unitPrice = pattern(String.raw`(?:(?<article>each|an?) )?(?<item>${item}) (?:costs?|is priced at|are priced at|sells? for) (?<money>${money})(?: (?<each>each|apiece)| per (?<per>${item}))?`);
const purchase = pattern(String.raw`(?:if )?(?<owner>${owner}) (?:also )?${buyVerb} (?<items>.+)`);
const itemLine = pattern(String.raw`(?<count>${number}) (?<item>${item})(?: (?:at|for) (?<rate>${money})(?: (?:each|apiece)| per (?<per>${item}))| for a total of (?<flat>${money}))?`);
const balance = pattern(String.raw`(?<owner>${owner}) (?:has|had|starts? with|started with|begins? with|began with|has a budget of|had a budget of) (?<money>${money})`);
const tender = pattern(String.raw`(?<owner>${owner}) (?:pays? with|paid with|hands? over|handed over|gives? the cashier|gave the cashier) (?:a )?(?<money>${money})(?: bill)?`);
const subjectTotal = pattern(String.raw`how much(?: (?<currency>money|${currencyWord}))? (?:does|did|will|would) (?<owner>${owner}) (?:spend|pay|have to pay|need to pay)${total}`);
const globalTotal = pattern(String.raw`what (?:is|was|will be) the total (?:cost|price)(?: of (?:the|these) (?:items|purchases))?`);
const listTotal = pattern(String.raw`(?:what (?:is|was|will be) the (?:total )?(?:cost|price) of|how much (?:does|will|would) it cost to (?:buy|purchase|order)) (?<items>.+?)${total}`);
const inlineListTotal = pattern(String.raw`how much (?:does|do|did|will|would) (?<items>.+?) cost${total}`);
const balanceQuery = pattern(String.raw`how much(?: (?<currency>money|${currencyWord}))? (?:does|did|will|would) (?<owner>${owner}) have (?:remaining|left)(?: after (?:the|these) purchases)?`);
const changeQuery = pattern(String.raw`how much change (?:does|did|will|would) (?<owner>${owner}) (?:get|receive)(?: back)?`);
const reservedItemWords = /\b(?:and|or|each|per|for|at|than|cost|costs|buy|bought|which|with|dollars?|euros?)\b/iu;
const reservedOwnerWords = /\b(?:and|or|of|to|than|has|have|had|is|are|was|were)\b/iu;
const pronoun = /^(?:he|she|they)$/iu;
const itemSeparator = new RegExp(String.raw`(?:, *(?:and +)?|(?<!\bhundred) and )(?=${number} [a-z])`, 'iu');
const priceSeparator = /, and |(?<!\bhundred) and /iu;

type Currency = '$' | '£' | '€';
type Money = { currency: Currency; value: string };

function currencyKey(word: string): Currency | null {
  switch (unitKey(word)) {
    case 'dollar': return '$';
    case 'pound': return '£';
    case 'euro': return '€';
    default: return null;
  }
}

function readMoney(source: string): Money | null {
  const parts = moneyParts.exec(source)?.groups;
  if (!parts) return null;
  const currency = (parts.symbol as Currency | undefined) ?? currencyKey(parts.currency!);
  const value = parseNumber(parts.symbolAmount ?? parts.wordAmount!);
  return currency && value !== null && !value.startsWith('-') ? { currency, value } : null;
}

function itemKey(source: string): string | null {
  return reservedItemWords.test(source) ? null : source.split(/ of /iu).map(unitKey).join(' of ');
}

function matchingUnit(item: string, basis: string): boolean {
  const target = itemKey(basis);
  return target !== null && [itemKey(item), itemKey(item.split(/ of /iu)[0]!)].includes(target);
}

function readPrice(statement: string): { item: string; amount: Money } | null {
  const input = unitPrice.exec(statement)?.groups;
  if (!input || (!input.article && !input.each && !input.per)) return null;
  const item = itemKey(input.item!);
  const amount = readMoney(input.money!);
  if (!item || !amount || input.per && !matchingUnit(input.item!, input.per)) return null;
  return { item, amount };
}

interface PurchaseLine {
  currency: Currency;
  cost: WordExpression;
}

function readItems(source: string, prices: ReadonlyMap<string, Money>): PurchaseLine[] | null {
  const lines = source.split(itemSeparator);
  if (lines.length > 10) return null;
  const costs: PurchaseLine[] = [];
  for (const line of lines) {
    const input = itemLine.exec(line)?.groups;
    if (!input) return null;
    const item = itemKey(input.item!);
    const count = parseNumber(input.count!);
    if (!item || count === null || count.startsWith('-') || input.per && !matchingUnit(input.item!, input.per)) return null;
    const knownPrice = prices.get(item);
    // An inline price and a catalogue price for the same line could describe different terms.
    if (knownPrice && (input.rate || input.flat)) return null;
    const price = input.rate || input.flat ? readMoney((input.rate ?? input.flat)!) : knownPrice;
    if (!price) return null;
    const cost = input.flat ? quantity(price.value)
      : operation('*', quantity(count), quantity(price.value), `Cost of ${input.item}`);
    costs.push({ currency: price.currency, cost });
  }
  return costs;
}

/** Combine item costs only when all quantities, price bases, currencies and the buyer agree. */
export function parseItemCosts(statements: readonly string[], question: string): WordExpression | null {
  const costQuestion = subjectTotal.exec(question)?.groups;
  const globalCost = globalTotal.test(question);
  const listedQuestion = globalCost ? null : (listTotal.exec(question) ?? inlineListTotal.exec(question))?.groups;
  const leftQuestion = balanceQuery.exec(question)?.groups;
  const backQuestion = changeQuery.exec(question)?.groups;
  if (!(costQuestion || listedQuestion || leftQuestion || backQuestion || globalCost)) return null;

  const prices = new Map<string, Money>();
  const purchases: string[] = [];
  let buyer: string | null = null;
  let openingFunds: Money | null = null;
  let paidWith: Money | null = null;

  function sameBuyer(source: string): boolean {
    const key = source.toLowerCase();
    if (reservedOwnerWords.test(key)) return false;
    if (buyer === null) buyer = key;
    return key === buyer || pronoun.test(key) && !pronoun.test(buyer);
  }

  for (const statement of statements) {
    const shopping = purchase.exec(statement)?.groups;
    if (shopping) {
      if (listedQuestion || !sameBuyer(shopping.owner!)) return null;
      purchases.push(shopping.items!);
      continue;
    }
    const funds = balance.exec(statement)?.groups;
    const cash = tender.exec(statement)?.groups;
    if (funds || cash) {
      if (!sameBuyer((funds ?? cash)!.owner!)) return null;
      const amount = readMoney((funds ?? cash)!.money!);
      if (!amount) return null;
      if (funds) {
        if (openingFunds || paidWith || purchases.length) return null;
        openingFunds = amount;
      } else {
        if (paidWith || !purchases.length) return null;
        paidWith = amount;
      }
      continue;
    }
    const onePrice = readPrice(statement);
    const priceStatements = onePrice ? [onePrice] : statement.split(priceSeparator).map(readPrice);
    for (const price of priceStatements) {
      if (!price || prices.has(price.item)) return null;
      prices.set(price.item, price.amount);
    }
  }

  if (listedQuestion) purchases.push(listedQuestion.items!);
  const subject = costQuestion ?? leftQuestion ?? backQuestion;
  if (subject && (buyer === null || !sameBuyer(subject.owner!))) return null;

  const lines: PurchaseLine[] = [];
  for (const source of purchases) {
    const parsed = readItems(source, prices);
    if (!parsed) return null;
    lines.push(...parsed);
  }
  const first = lines[0];
  if (!first || lines.some(line => line.currency !== first.currency)) return null;
  if (subject?.currency && subject.currency.toLowerCase() !== 'money' && currencyKey(subject.currency) !== first.currency) return null;
  const cost = lines.slice(1).reduce((sum, line) => operation('+', sum, line.cost, 'Add the item costs'), first.cost);
  if (!leftQuestion && !backQuestion) return cost;

  const startingMoney = backQuestion ? paidWith : openingFunds;
  if (!startingMoney || startingMoney.currency !== first.currency) return null;
  const remainder = operation('-', quantity(startingMoney.value), cost, backQuestion ? 'Change' : 'Remaining balance');
  const result = evaluateWordExpression(remainder);
  return result && !result.value.startsWith('-') ? remainder : null;
}
