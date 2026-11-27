# AlQuran Cloud recordings

Retrieved 2026-11-27. Arabic text and edition metadata come from AlQuran Cloud. The source credits Tanzil for Quran texts, Saheeh International for the English translation, and the King Fahd Quran Complex for Tafsir al-Muyassar. [Credits](https://alquran.cloud/credits) · [AlQuran Cloud terms](https://alquran.cloud/terms-and-conditions) · [Tanzil text license](https://tanzil.net/docs/Text_License)

| Fixture | Request |
| --- | --- |
| `quran-surahs.json` | [Surah catalog](https://api.alquran.cloud/v1/surah) |
| `quran-verse-editions.json` | [2:255 in Uthmani script and the Saheeh International translation](https://api.alquran.cloud/v1/ayah/2:255/editions/quran-uthmani,en.sahih) |
| `quran-verse-uthmani.json` | [2:255 in Uthmani script](https://api.alquran.cloud/v1/ayah/2:255/quran-uthmani) |
| `quran-tafsir-editions.json` | [2:255 in Uthmani script and Tafsir al-Muyassar](https://api.alquran.cloud/v1/ayah/2:255/editions/quran-uthmani,ar.muyassar) |
| `quran-chapter-editions.json` | [Al-Faatiha in both editions](https://api.alquran.cloud/v1/surah/1/editions/quran-uthmani,en.sahih?offset=0&limit=7) |
| `quran-english-search.json` | [Translation phrase search](https://api.alquran.cloud/v1/search/the%20Ever-Living/all/en.sahih?limit=3) |
| `quran-empty-search.json` | [No-match response (404)](https://api.alquran.cloud/v1/search/qftqftzx/all/en.sahih?limit=3) |
| `quran-robots-404.json` | [Robots response (404)](https://api.alquran.cloud/robots.txt) |
| `quran-simple-excerpt.json` | [Simple-script corpus](https://api.alquran.cloud/v1/quran/quran-simple), reduced to five complete verse records. The strings in those records are verbatim. |

The offline tests reproduce a 429 and a robots denial through their fake network.
