# Public dataset cards

The catalog pins publisher data files by SHA-256. The loader downloads the files selected by a training job into its cache and verifies cached files on every load. Reports can record the publisher URL, release, license evidence, attribution, cache time in UTC, file size and SHA-256, normalized example fingerprint, and loader and catalog SHA-256. The cache time reflects the cached file's modification time. The fingerprint covers the pinned inputs and normalized records and is independent of the cache directory or time.

| Source | Annotation and supported heads | Languages used | License evidence |
| --- | --- | --- | --- |
| CLINC150 | Crowdworker utterances, intent and domain labels, and explicit in-scope and out-of-scope splits. `intent`, `route`, `out_of_scope` | English | CC BY 3.0 for the pinned publisher release. [Clinc license](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/LICENSE) |
| MASSIVE 1.1 | SLURP voice-assistant utterances localized by professional translators with intent and scenario labels. `intent`, `route` | US English and Saudi Arabic | CC BY 4.0. [Amazon dataset notice](https://github.com/alexa/massive/blob/main/NOTICE.md) |
| CANARD | Crowdworkers wrote standalone rewrites of contextual QuAC questions. `turn_type`, `rewrite` | English | CC BY-SA 4.0. [Authors' dataset card](https://qanta-org.github.io/research/projects/canard.html) [University of Maryland release](https://doi.org/10.13016/zcop-ns5d) |
| QuAC 0.2 | Human information-seeking dialogues with teacher follow-up judgments. `turn_type` | English | CC BY-SA 4.0. [QuAC downloads and license](https://quac.ai/#getting-started) |
| XQuAD | Crowdworker SQuAD questions and professionally translated, answer-aligned examples. `sentence_selection` | English and Arabic | CC BY-SA 4.0. [DeepMind release and license](https://github.com/google-deepmind/xquad/tree/7d30520c717524000f0d9d2f9c10a069acd9d285) |
| MLQA 1.0 | Crowdworkers wrote QA pairs and professional translators aligned them across languages. Uses the original same-language files. `sentence_selection` | English and Arabic | CC BY-SA 3.0 for the dataset. [MLQA release and license](https://github.com/facebookresearch/MLQA#license) |
| TyDiQA-GoldP 1.1 | Crowdworkers wrote questions directly in each language and annotated answer spans. Uses Google's pinned secondary-task Parquet release. `sentence_selection` | English and Arabic | Apache 2.0 as published for the dataset. Preserve attribution for Wikipedia passages. [Google dataset card](https://huggingface.co/datasets/google-research-datasets/tydiqa/blob/da78f23f9119363459acbaf46bf89426ff26c259/README.md) |
| ARCD | Crowdworker questions and answers on Arabic Wikipedia from the SOQAL repository. `sentence_selection` | Arabic | MIT for the authors' SOQAL release. Wikipedia passage attribution and terms still apply. [Pinned SOQAL license](https://github.com/husseinmozannar/SOQAL/blob/1229d34aa2b7a0b9a2e4858c9268e68f45d7e3c4/LICENSE) [Wikimedia terms](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content) |
| SQuAD 2.0 | Crowdworker QA spans and deliberately unanswerable questions. `sentence_selection`, `sufficiency` | English | CC BY-SA 4.0. [Stanford SQuAD release](https://rajpurkar.github.io/SQuAD-explorer/) |
| AMI 1.6.2 manual annotations | Human-transcribed meetings and human-coded dialogue acts. `speech_act` | English | CC BY 4.0. [AMI annotation download and license](https://groups.inf.ed.ac.uk/ami/download/) [Annotation specification](https://groups.inf.ed.ac.uk/ami/corpus/annotation.shtml) |

## Label mappings and limits

- Route supervision uses CLINC domains and MASSIVE scenarios. Assignment to the 14 production routes needs an explicit label map or owner labels. CLINC out-of-scope supervision describes queries outside CLINC's 150 intents. The owner's refusal policy needs its own evidence.
- CANARD turn-type supervision records whether the input differs from the human rewrite after case, Unicode, and whitespace normalization. Rewrite training ranks an existing human rewrite against other turns in the same dialogue and the original question where it differs. QuAC provides human judgments on whether a follow-up is advised. Production turn types such as correction and pending-card replies need the owner's task-specific labels.
- Sentence selection uses all annotated, literal answer spans that fit within a candidate sentence. The loader keeps same-passage negatives, collapses repeated sentences, and excludes rows without both a positive and a negative. For inconsistent offsets it uses an unambiguous literal match, if present.
- SQuAD sufficiency learns passage answerability from the native `is_impossible` annotation. H5 promotion still needs evidence from H4's actual selected text and the owner's maximum allowed loss of correct answers.
- AMI uses the manual annotations' act ontology and joins annotated references to the manual word transcript. Meeting-series grouping keeps related sessions together. Labels reflect human meetings, so an assistant's act taxonomy requires its own mapping and evaluation.

## Partition lineage

The normalized records keep the original source partition separately from the kit's split input. MASSIVE localizations are grouped by shared utterance ID. CANARD and QuAC share dialogue IDs. QA examples are grouped by Wikipedia article, including cross-language XQuAD and MLQA alignments. AMI uses meeting series. ARCD's upstream test stays outside fitting and tuning.

XQuAD was previously used as an independent benchmark. This kit allows group assignment of XQuAD and MLQA to training, development, or calibration. A score on either source after fitting is development evidence. The promotion gate uses a new owner-authored or owner-reviewed sealed set under the development plan. Run reports record which authorized public sources were used.

The v2 capability benchmark exclusion registry is verified before a loader
reads training material. Each loaded card records the manifest SHA-256 and
its input and dropped row counts. Public data cards in run manifests contain
these counts per dataset and task. `prefetch` prints the same counts before a
training run. A match on any model-visible text field, native source ID, or
verified alias drops the entire example before job splitting. Exact text
checks use the registry's normalization. Near-duplicate analysis is a separate
part of the capability audit.

QuAC alias verification also reads the pinned CANARD release and records that
file's provenance. A QuAC question receives the CANARD alias when its dialogue
ID, question number and exact question text agree. MASSIVE retains the full
locale and TyDi QA converts the secondary-task ID to the registry's advertised
key. The filter records aggregate counts. [Capability v2 contamination audit](https://github.com/ahmadalwakai/Mohassan-AI/blob/a1e1cb020b7ba093885edbf501149e7b8252c0cb/docs/V2-CONTAMINATION-AUDIT-2026-11-25.md)

The release files are fetched on demand. The loader reads the publisher data formats directly. It uses only the crowdworker ARCD files from SOQAL, the original MLQA files, and the manual AMI annotations.
