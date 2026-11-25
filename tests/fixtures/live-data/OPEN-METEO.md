# Recorded Open-Meteo responses

The JSON files are unchanged public API responses retrieved on 2026-11-25 UTC. Tests replay them offline.

- `open-meteo-geocoding.json` records the Arabic localization of a lookup for London. [Lookup URL](https://geocoding-api.open-meteo.com/v1/search?name=London&count=10&language=ar)
- `open-meteo-geocoding-london-canada.json` records a qualified Arabic lookup that distinguishes London in Canada. [Lookup URL](https://geocoding-api.open-meteo.com/v1/search?name=%D9%84%D9%86%D8%AF%D9%86%2C%20%D9%83%D9%86%D8%AF%D8%A7&count=10&language=ar)
- `open-meteo-geocoding-london-uk-empty.json` records an empty lookup using the alias UK. [Lookup URL](https://geocoding-api.open-meteo.com/v1/search?name=London%2C%20UK&count=10&language=en)
- `open-meteo-geocoding-london-gb.json` records its successful lookup with the explicit country code GB. [Lookup URL](https://geocoding-api.open-meteo.com/v1/search?name=London&count=10&language=en&countryCode=GB)
- `open-meteo-geocoding-riyadh.json` records an Arabic lookup for Riyadh whose first result has a directional mark in an administrative-area name. [Lookup URL](https://geocoding-api.open-meteo.com/v1/search?name=%D8%A7%D9%84%D8%B1%D9%8A%D8%A7%D8%B6&count=10&language=ar)
- `open-meteo-forecast.json` records the current, hourly, and daily metric forecast for the first location returned by the lookup. [Forecast URL](https://api.open-meteo.com/v1/forecast?latitude=51.50853&longitude=-0.12574&timezone=Europe%2FLondon&timeformat=unixtime&current=temperature_2m%2Capparent_temperature%2Crelative_humidity_2m%2Cprecipitation%2Cweather_code%2Cwind_speed_10m&hourly=temperature_2m%2Cprecipitation_probability%2Cweather_code&daily=weather_code%2Ctemperature_2m_max%2Ctemperature_2m_min%2Cprecipitation_probability_max&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm&forecast_days=7)

Weather data by [Open-Meteo](https://open-meteo.com/) and location data by [GeoNames](https://www.geonames.org/). [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
