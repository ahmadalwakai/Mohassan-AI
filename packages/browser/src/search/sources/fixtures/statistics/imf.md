# IMF DataMapper fixtures

Recorded on 2026-11-27. `imf.json` includes each exact request URL and the response's original indicator metadata and values for the requested ISO3 country and years. DataMapper returned other territories and years for these bounded requests. The excerpts retain only the requested data. The 2026 unemployment value for Saudi Arabia is absent from the IMF response.

- Türkiye inflation, latest and explicit 2025. [Latest](https://www.imf.org/external/datamapper/api/v2/PCPIPCH/TUR?periods=2026,2025,2024,2023,2022) · [2025](https://www.imf.org/external/datamapper/api/v2/PCPIPCH/TUR?periods=2025)
- Türkiye inflation projections. [2027–2031](https://www.imf.org/external/datamapper/api/v2/PCPIPCH/TUR?periods=2027,2028,2029,2030,2031)
- Egypt GDP. [2022–2026](https://www.imf.org/external/datamapper/api/v2/NGDPD/EGY?periods=2026,2025,2024,2023,2022)
- Saudi Arabia unemployment. [2022–2026](https://www.imf.org/external/datamapper/api/v2/LUR/SAU?periods=2026,2025,2024,2023,2022)
- Australia population. [2022–2026](https://www.imf.org/external/datamapper/api/v2/LP/AUS?periods=2026,2025,2024,2023,2022)

Data come from the International Monetary Fund’s October 2026 World Economic Outlook. The DataMapper v2 response carries the first projection year, and the WEO FAQ explains that the latest actual observation varies by series. [API documentation](https://www.imf.org/external/datamapper/api/help) · [WEO DataMapper](https://www.imf.org/external/datamapper/datasets/WEO) · [WEO FAQ](https://www.imf.org/en/Publications/WEO/frequently-asked-questions)

The IMF terms permit attributed statistical data extraction and require permission for potential commercial reuse. The origin returned HTTP 404 for `robots.txt` on the recording date. [Terms](https://www.imf.org/en/about/copyright-and-terms) · [robots.txt](https://www.imf.org/robots.txt)
