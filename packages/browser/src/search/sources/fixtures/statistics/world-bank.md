# World Bank Indicators API fixtures

These recorded JSON responses come from the [World Bank Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api). Checked and retrieved on 2026-11-27. The World Bank publishes World Development Indicators under CC BY 4.0 with its [dataset terms](https://www.worldbank.org/ext/en/legal/terms-conditions/datasets). The [WDI catalog entry](https://datacatalog.worldbank.org/infrastructure-data/search/dataset/0037712/world-development-indicators) and the individual indicator pages identify the applicable license and upstream sources.

| Fixture | Request URL |
| --- | --- |
| `world-bank-aus-population.json` | <https://api.worldbank.org/v2/country/AUS/indicator/SP.POP.TOTL?format=json&source=2&mrnev=1> |
| `world-bank-ata-population.json` | <https://api.worldbank.org/v2/country/ATA/indicator/SP.POP.TOTL?format=json&source=2&mrnev=1> |
| `world-bank-can-population.json` | <https://api.worldbank.org/v2/country/CAN/indicator/SP.POP.TOTL?format=json&source=2&mrnev=1> |
| `world-bank-sau-population.json` | <https://api.worldbank.org/v2/country/SAU/indicator/SP.POP.TOTL?format=json&source=2&mrnev=1> |
| `world-bank-egy-gdp.json` | <https://api.worldbank.org/v2/country/EGY/indicator/NY.GDP.MKTP.CD?format=json&source=2&mrnev=1> |
| `world-bank-jpn-gdp.json` | <https://api.worldbank.org/v2/country/JPN/indicator/NY.GDP.MKTP.CD?format=json&source=2&mrnev=1> |
| `world-bank-tur-inflation.json` | <https://api.worldbank.org/v2/country/TUR/indicator/FP.CPI.TOTL.ZG?format=json&source=2&mrnev=1> |
| `world-bank-tur-inflation-2025.json` | <https://api.worldbank.org/v2/country/TUR/indicator/FP.CPI.TOTL.ZG?format=json&source=2&date=2025> |
| `world-bank-sau-unemployment.json` | <https://api.worldbank.org/v2/country/SAU/indicator/SL.UEM.TOTL.ZS?format=json&source=2&mrnev=1> |
| `world-bank-usa-life-expectancy.json` | <https://api.worldbank.org/v2/country/USA/indicator/SP.DYN.LE00.IN?format=json&source=2&mrnev=1> |
| `world-bank-usa-life-expectancy-2024-2025.json` | <https://api.worldbank.org/v2/country/USA/indicator/SP.DYN.LE00.IN?format=json&source=2&date=2024:2025> |
| `world-bank-usa-life-expectancy-2025.json` | <https://api.worldbank.org/v2/country/USA/indicator/SP.DYN.LE00.IN?format=json&source=2&date=2025> |

The World Bank's [API call documentation](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures) defines `mrnev=1` as the most recent non-empty value. The 2024–2025 response records a null in 2025 and a value in 2024. The `mrnev=1` response contains the 2024 observation, while the request for 2025 contains a null.

The Antarctica lookup records API code 120 for a territory absent from WDI. [World Bank API error codes](https://datahelpdesk.worldbank.org/knowledgebase/articles/898620-api-error-codes)
