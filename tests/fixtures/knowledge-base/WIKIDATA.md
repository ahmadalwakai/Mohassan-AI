# Wikidata dump fixture

`wikidata-20261116-projected.json` is a development fixture with the first 240
complete records of the Wikidata JSON dump dated 2026-11-16. The fixture keeps
the order, item type, Q-ID, revision, and available Arabic and English terms
from the dump. It keeps the main snaks, statement IDs and ranks of P31 and
P279, the full P1082 statements for Belgium (Q31) dated 2020, 2022 and 2025,
and the full P2046 statements for Portugal (Q45), China (Q148), and Brazil
(Q155). Each selected record was reserialized as one UTF-8 JSON line. The
fixture has partial, date-bound coverage.

The source was the byte range `0-8388607` of the compressed dump (8,388,608
bytes, SHA-256 `1e0c025841512bac892f4b44120bb5a7eede16981acbd9595c8ed0d3be4f04ea`).
The gzip prefix was decompressed through the first 240 newline-terminated
records. The projected fixture is 275,156 bytes and its SHA-256 is
`4156507f1477a3c33df2ac642cdca067f8845a358b0d2f255a53b4623e7d4ff4`.
The Wikidata structured data is published under CC0 1.0.
[Source dump](https://dumps.wikimedia.org/wikidatawiki/entities/20261116/wikidata-20261116-all.json.gz)
· [Wikidata licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)
