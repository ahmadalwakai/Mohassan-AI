// Published Brave Web Search response excerpt, retrieved 2026-11-27. The
// description is shortened and fields unused by the adapter are omitted.
// https://brave.com/search/api/
export const englishQuery = 'greek restaurants in san francisco';
export const englishResult = {
  title: 'THE 10 BEST Greek Restaurants in San Francisco (Updated 2025)',
  url: 'https://www.tripadvisor.com/Restaurants-g60713-c23-San_Francisco_California.html',
  description: 'Best <strong>Greek</strong> <strong>Restaurants</strong> <strong>in</strong> <strong>San</strong> <strong>Francisco</strong>, California: Find Tripadvisor traveller reviews of <strong>San</strong> <strong>Francisco</strong>',
};

// Arabic title, excerpt, URL and publication date from the publisher, retrieved
// 2026-11-27. The date is rendered as ISO calendar date. Tests wrap this record
// in the documented Brave shape since an authenticated Arabic capture needs a key.
// https://www.rcu.gov.sa/media-resources/news-press/15
export const arabicQuery = 'ابحث لي عن كلية فيراندي باريس فرع العلا';
export const arabicResult = {
  title: 'كلية فيراندي باريس | الهيئة الملكية لمحافظة العلا',
  url: 'https://www.rcu.gov.sa/media-resources/news-press/15',
  description: 'أعلنت الهيئة الملكية لمحافظة العلا عن إنشاء كلية "فيراندي باريس (فرع العلا)"',
  page_age: '2024-10-31',
};

// Brave's published example response headers, retrieved 2026-11-27.
// https://api-dashboard.search.brave.com/documentation/guides/rate-limiting#example-response-headers
export const rateLimitHeaders = {
  'x-ratelimit-limit': '1, 15000',
  'x-ratelimit-policy': '1;w=1, 15000;w=2592000',
  'x-ratelimit-remaining': '0, 14523',
  'x-ratelimit-reset': '1, 1234567',
};
