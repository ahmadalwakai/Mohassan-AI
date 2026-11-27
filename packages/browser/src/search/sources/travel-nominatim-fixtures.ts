// Public Nominatim robots.txt captured on 2026-11-27.
// https://nominatim.openstreetmap.org/robots.txt
export const publicRobots = `User-agent: ia_archiver
Allow: /

User-agent: *
Disallow: /search.php
Disallow: /search
Disallow: /details.php
Disallow: /details
Disallow: /reverse.php
Disallow: /reverse
Disallow: /lookup
Disallow: /lookup.php
Disallow: /status
Disallow: /status.php
`;

// London output example in the Nominatim manual, checked 2026-11-27. Only the
// fields read by the provider and a few address fields it excludes are kept.
// https://nominatim.org/release-docs/latest/api/Output/#json
export const london = {
  osm_type: 'node',
  osm_id: '107775',
  lat: '51.5073219',
  lon: '-0.1276474',
  display_name: 'London, Greater London, England, SW1A 2DU, United Kingdom',
  address: {
    city: 'London', state_district: 'Greater London', state: 'England',
    postcode: 'SW1A 2DU', country: 'United Kingdom', country_code: 'gb',
  },
};

// Nominatim-shaped Arabic parser fixture, not a recording of the blocked endpoint.
// The labels and city/country relation are from the OSM Egypt wiki page and the
// point is from the Cairo wiki page's map link. Both checked 2026-11-27.
// https://wiki.openstreetmap.org/wiki/Egypt
// https://wiki.openstreetmap.org/wiki/Cairo
export const cairo = {
  lat: '30.0445',
  lon: '31.2388',
  display_name: 'القاهرة, مصر',
  address: { city: 'القاهرة', country: 'مصر' },
};

// Upstream test scenario "Empty search for json like" checked 2026-11-27.
// https://github.com/osm-search/Nominatim/blob/6f81fa6a1bc46ddb1da94fdd60e3f64b152784b5/test/bdd/features/api/search/simple.feature
export const missing = { query: 'YHlERzzx', results: [] };
