# Building an offline knowledge snapshot for production

The answer path reads a dated Wikidata SQLite snapshot. A supported question with a single resolved entity and a sourced value can be answered directly. The Wikipedia importer builds a separate Arabic and English article index for offline querying and shadow evaluation.

## Disk and build location

The production VM is Ubuntu ARM64 (`aarch64`), with 2 CPUs and 11 GB RAM available in the task specification. The deployment runbook records a 50 GB nominal disk. Check actual free space using `df -B1` on the download, build and final snapshot filesystems. Budget for the compressed inputs, new SQLite files, transient SQLite journals and index work, and any snapshot retained for rollback. Reserve space for PostgreSQL, backups and the API independently. [Production deployment runbook](../scripts/cloud-linux/README.md#current-production-deployment-2026-11-08)

The table lists compressed input sizes confirmed from Wikimedia's `Content-Length` on 2026-11-27. Choosing fewer Wikidata categories reduces the work stored in SQLite. The importer still reads the complete input archive.

| Source | Dump date | Compressed bytes |
| --- | --- | ---: |
| Wikidata JSON | 2026-11-16 | 157,184,992,349 |
| Arabic Wikipedia articles XML | 2026-11-01 | 2,039,166,669 |
| English Wikipedia articles XML | 2026-11-01 | 25,899,045,155 |

[Wikidata archive](https://dumps.wikimedia.org/wikidatawiki/entities/20261116/wikidata-20261116-all.json.gz) · [Arabic archive](https://dumps.wikimedia.org/arwiki/20261101/arwiki-20261101-pages-articles.xml.bz2) · [English archive](https://dumps.wikimedia.org/enwiki/20261101/enwiki-20261101-pages-articles.xml.bz2)

Build the full Wikidata snapshot on a separate machine with staging space, or use a dedicated filesystem on the VM sized for the input, build and SQLite output. The Wikidata archive alone exceeds the VM's root disk capacity. Transfer the completed store and both receipts to the VM after checking that the retained snapshots and new snapshot fit. Full-dump build time, output size and peak resources on aarch64 were unmeasured in this run.

## Build

Use the reviewed source and the project's locked Node.js 24 dependencies. Install `bzip2` if importing compressed Wikipedia XML. Stage an immutable, dated dump from the official source. For example, free space permitting, use `curl --fail --location --output FILE.part URL`, then rename to `FILE` after download succeeds. The build command reads a local input and streams the archive through the importer.

Run from the deployed checkout or the same revision on the build host. Replace `/mnt/knowledge-build` with the checked staging path. The example selects country and city records. Omit the `--category` options for the full set of indexed categories. Use a new output name for a different snapshot.

```sh
node scripts/knowledge-base/build.ts wikidata \
  --input /mnt/knowledge-build/wikidata-20261116-all.json.gz \
  --output /mnt/knowledge-build/wikidata-20261116.sqlite \
  --source https://dumps.wikimedia.org/wikidatawiki/entities/20261116/wikidata-20261116-all.json.gz \
  --dump-date 2026-11-16 --category countries --category cities
```

If an interrupted Wikidata import already wrote a checkpoint, resume with the same input, output, date and categories. Build a fresh Wikipedia output for each attempt. On the shared VM, schedule any large build away from production load.

For a separate bilingual Wikipedia index, stage the dated XML dumps from the table and run the following command. Each language takes its own URL and date.

```sh
node scripts/knowledge-base/build.ts wikipedia \
  --output /mnt/knowledge-build/wikipedia-20261101.sqlite \
  --ar-input /mnt/knowledge-build/arwiki-20261101-pages-articles.xml.bz2 \
  --ar-source https://dumps.wikimedia.org/arwiki/20261101/arwiki-20261101-pages-articles.xml.bz2 \
  --ar-dump-date 2026-11-01 \
  --en-input /mnt/knowledge-build/enwiki-20261101-pages-articles.xml.bz2 \
  --en-source https://dumps.wikimedia.org/enwiki/20261101/enwiki-20261101-pages-articles.xml.bz2 \
  --en-dump-date 2026-11-01
```

Each build writes `STORE.data-card.json` with importer metadata and `STORE.manifest.json` with the source URLs, dump dates, byte sizes and SHA-256 digests. The manifest hashes exact input files and the completed SQLite output. The Wikipedia data card additionally hashes the decompressed XML. Use ignored `.data/` for local builds and a persistent path outside the deployed source for production.

## Verify and stage a snapshot

Transfer the store and matching receipts to a dated file under a directory readable by `mohassan`, for example `/var/lib/mohassan/knowledge-base/`. Compare the transferred SQLite checksum to its manifest before pointing the service at it.

```sh
cd /var/lib/mohassan/knowledge-base
node -e 'const { store } = require("./wikidata-20261116.sqlite.manifest.json"); console.log(store.sha256 + "  " + store.file)' \
  | sha256sum --check -
```

The server flag defaults off. If the development benchmarks support rollout, set the two values below in `/etc/mohassan/server.env` and restart `mohassan.service` during the normal release window. After staging, verify that a supported question returns Wikidata with the dump date and that an unsupported question reaches the search path. To revert the serving change, set `MOHASSAN_OFFLINE_KNOWLEDGE=0` and restart the service. [systemd unit](../scripts/cloud-linux/mohassan.service)

```text
MOHASSAN_OFFLINE_KNOWLEDGE=1
MOHASSAN_OFFLINE_KNOWLEDGE_STORE=/var/lib/mohassan/knowledge-base/wikidata-20261116.sqlite
```

## Measured on 2026-11-27

These are build CLI times on the x86_64 development environment with Node.js 24.22.3. The interval covers import and receipt generation after Node starts, excluding downloads and excerpt preparation. Both runs exited successfully. The Wikidata projection has partial coverage and the Wikipedia inputs are archive excerpts. Keep those development stores out of the production snapshot path.

| Input | Input bytes | Records read | SQLite bytes | Build time |
| --- | ---: | ---: | ---: | ---: |
| Wikidata fixture, snapshot 2026-11-16 | 275,156 | 240 | 212,992 | 0.098 s |
| Arabic and English Wikipedia archive excerpts, snapshot 2026-11-01 | 7,452,924 | 600 | 2,256,896 | 2.177 s |

The Wikidata run used all enabled importer categories and stored 94 entities with 248 claims. Its input is described in the [fixture data card](../tests/fixtures/knowledge-base/WIKIDATA.md).

For Wikipedia, range requests on 2026-11-27 returned bytes `0-3464620` (Arabic) and `0-3998665` (English) of the official first multistream files. Each range was decompressed through its last complete page, closed with the XML root tag and recompressed. The CLI indexed 191 Arabic and 178 English articles. [Arabic range source](https://dumps.wikimedia.org/arwiki/20261101/arwiki-20261101-pages-articles-multistream1.xml-p1p340838.bz2) · [English range source](https://dumps.wikimedia.org/enwiki/20261101/enwiki-20261101-pages-articles-multistream1.xml-p1p41242.bz2)
