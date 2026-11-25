import { describe, expect, it } from 'vitest';
import { recognizeLiveData } from '../apps/server/src/live-data/recognize.js';

describe('English and Arabic currency conversions', () => {
  it.each([
    ['Convert 123.45 USD to GBP.', '123.45', 'USD', 'GBP'],
    ['Exchange €50.50 into INR.', '50.50', 'EUR', 'INR'],
    ['How much is 1,000.25 US dollars in Japanese yen?', '1000.25', 'USD', 'JPY'],
    ['How many euros is 20 Swiss francs?', '20', 'CHF', 'EUR'],
    ['How much in EUR is 5 British pounds?', '5', 'GBP', 'EUR'],
    ['What is 500 Argentine pesos in Canadian dollars?', '500', 'ARS', 'CAD'],
    ['I have zero yen.', null, null, null],
    ['حوّل ١٢٣٫٤٥ دولار إلى جنيه إسترليني.', '123.45', 'USD', 'GBP'],
    ['اصرف ١٬٠٠٠ ريال سعودي مقابل يورو اليوم.', '1000', 'SAR', 'EUR'],
    ['كم يورو يساوي ٥٠ دولار؟', '50', 'USD', 'EUR'],
    ['كم سعر ۵۰۰ درهم إماراتي بالريال العماني؟', '500', 'AED', 'OMR'],
    ['عندي ٧٥ ريال سعودي كم بالريال القطري؟', '75', 'SAR', 'QAR'],
    ['تحويل ٣٠٠ فرنك سويسري إلى دينار بحريني', '300', 'CHF', 'BHD'],
  ])('handles the full conversion phrasing %s', (text, amount, from, to) => {
    const intent = recognizeLiveData(text);
    if (amount === null) expect(intent).toBeNull();
    else expect(intent).toMatchObject({ kind: 'exchange', amount, from, to, rateOnly: false });
  });

  it.each([
    ['What is the foreign exchange rate between USD and EUR as of today?', 'USD', 'EUR'],
    ['USD/GBP', 'USD', 'GBP'],
    ['Forex quote EURJPY', 'EUR', 'JPY'],
    ['Exchange USD to CHF', 'USD', 'CHF'],
    ['What is the EUR to USD exchange rate?', 'EUR', 'USD'],
    ['ما سعر الصرف بين الدولار واليورو اليوم؟', 'USD', 'EUR'],
    ['ما سعر صرف الين الياباني مقابل الفرنك السويسري؟', 'JPY', 'CHF'],
    ['سعر الدولار بالجنيه المصري', 'USD', 'EGP'],
    ['سعر الريال السعودي مقابل الدينار الكويتي الآن', 'SAR', 'KWD'],
  ])('recognizes a rate without an amount in %s', (text, from, to) => {
    expect(recognizeLiveData(text)).toMatchObject({ kind: 'exchange', amount: '1', from, to, rateOnly: true });
  });

  it.each([
    ['What is the exchange rate for the Japanese yen?', 'JPY'],
    ['How much is a euro today?', 'EUR'],
    ['Swiss franc price', 'CHF'],
    ['CAD price today', 'CAD'],
    ['كم سعر الدولار اليوم؟', 'USD'],
    ['ما سعر صرف الدرهم الإماراتي الآن؟', 'AED'],
    ['بكم اليورو؟', 'EUR'],
  ])('recognizes a quote that needs a counterpart in %s', (text, from) => {
    expect(recognizeLiveData(text)).toMatchObject({ kind: 'exchange-quote', from });
  });
});

describe('market questions with no configured source', () => {
  it.each([
    ['Bitcoin price in USD', 'crypto'],
    ['Convert 1 ETH to EUR.', 'crypto'],
    ['What is the spot gold price today?', 'gold'],
    ['Price of a gram of gold in USD', 'gold'],
    ['Stock price AAPL', 'stocks'],
    ['AAPL price today', 'stocks'],
    ['What is the BRK.B price in USD?', 'stocks'],
    ['Price of $F', 'stocks'],
    ['What is the stock price of Apple today?', 'stocks'],
    ['What is the exchange rate from USD to ZZZ?', 'currency'],
    ['ما سعر جرام الذهب عيار ٢١ اليوم؟', 'gold'],
    ['سعر البيتكوين بالدولار الآن', 'crypto'],
    ['حوّل ٥٠ دولار إلى بيتكوين', 'crypto'],
    ['كم سعر سهم أبل الآن؟', 'stocks'],
    ['سعر صرف اليورو مقابل ZZZ', 'currency'],
  ])('flags %s without handing it to a market provider', (text, asset) => {
    expect(recognizeLiveData(text)).toMatchObject({ kind: 'unsupported-market', asset });
  });

  it.each([
    'What is Bitcoin?',
    'What is gold?',
    'What is USD?',
    'What is the exchange rate history of 1920?',
    'What is the exchange rate policy between Japan and Spain?',
    'Explain the exchange rate between USD and GBP.',
    'Stock price history for AAPL',
    'Price of a cat',
    'Chair price today',
    'US price today',
    'Compare the dollar and euro as reserve currencies.',
    'The exchange rate API',
    'EUR and GBP',
    'ما معنى سعر الصرف؟',
    'ما هو الذهب؟',
    'ما معنى بيتكوين؟',
    'صَرَف الطالبَ من المدرسة',
    'اشرح سياسة سعر صرف الدولار',
    'قارن الدولار واليورو كعملتين احتياطيتين',
  ])('leaves the look-alike %s on its existing path', text => {
    expect(recognizeLiveData(text)).toBeNull();
  });
});
