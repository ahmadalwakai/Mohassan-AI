"""Source releases and license evidence for the public supervision used by the kit."""

from dataclasses import dataclass

from .v2_exclusion import ExclusionReceipt


@dataclass(frozen=True)
class SourceSpec:
    filename: str
    url: str
    sha256: str


@dataclass(frozen=True)
class DatasetCard:
    name: str
    revision: str
    license: str
    license_url: str
    homepage: str
    attribution: str
    tasks: tuple[str, ...]
    files: tuple[SourceSpec, ...]
    notes: str
    approval: str = "Owner's 2026-11-25 head-training task authorizes public human-labelled supervision with verified licenses."
    exclusion: ExclusionReceipt | None = None


_CLINC = "828f8093932c8fe6ca7936c3d2e52903b1c523de"
_XQUAD = "7d30520c717524000f0d9d2f9c10a069acd9d285"
_TYDI = "da78f23f9119363459acbaf46bf89426ff26c259"
_ARCD = "1229d34aa2b7a0b9a2e4858c9268e68f45d7e3c4"
_STANFORD = "https://rajpurkar.github.io/SQuAD-explorer/"
_TYDI_SOURCE = f"https://huggingface.co/datasets/google-research-datasets/tydiqa/resolve/{_TYDI}/secondary_task/"


CATALOG = {
    "clinc150": DatasetCard(
        "clinc150",
        _CLINC,
        "CC-BY-3.0",
        f"https://github.com/clinc/oos-eval/blob/{_CLINC}/LICENSE",
        "https://github.com/clinc/oos-eval",
        "Stefan Larson et al., An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction (2019)",
        ("intent", "route", "out_of_scope"),
        (
            SourceSpec(
                "clinc.json",
                f"https://raw.githubusercontent.com/clinc/oos-eval/{_CLINC}/data/data_full.json",
                "36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0",
            ),
            SourceSpec(
                "clinc-domains.json",
                f"https://raw.githubusercontent.com/clinc/oos-eval/{_CLINC}/data/domains.json",
                "b947b579d3b8e74b06f93b01083d8efaff2888b43a3e362533bd88a6e1211b3a",
            ),
        ),
        "English crowdworker queries. Route uses the upstream domain taxonomy. Out-of-scope labels describe CLINC.",
    ),
    "massive": DatasetCard(
        "massive",
        "1.1",
        "CC-BY-4.0",
        "https://github.com/alexa/massive/blob/main/NOTICE.md",
        "https://www.amazon.science/code-and-datasets/massive",
        "Jack FitzGerald et al., MASSIVE (2023), copyright Amazon.com Inc. or its affiliates",
        ("intent", "route"),
        (
            SourceSpec(
                "massive.tar.gz",
                "https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz",
                "4cba5faa11c71437928e17cb1b9b3d8b8e727e7ea363a3a9a8045e19c0491577",
            ),
        ),
        "English SLURP and professional Arabic localizations. Route uses the labelled scenario. Locales ar-SA and en-US.",
    ),
    "canard": DatasetCard(
        "canard",
        "UMD DRUM 2019",
        "CC-BY-SA-4.0",
        "https://qanta-org.github.io/research/projects/canard.html",
        "https://doi.org/10.13016/zcop-ns5d",
        "Ahmed Elgohary, Denis Peskov and Jordan Boyd-Graber, Can You Unpack That? (2019)",
        ("turn_type", "rewrite"),
        (
            SourceSpec(
                "canard.zip",
                "https://drum.lib.umd.edu/bitstreams/7bce2c7e-9df3-4134-a5cc-78d0784c5f45/download",
                "ec5fa4c580b5b3759401d691d6035fdc5caf5c481d4a735410e86b8664288110",
            ),
        ),
        "English crowdworker rewrites of QuAC questions. Turn type uses change from the original as a proxy.",
    ),
    "quac": DatasetCard(
        "quac",
        "0.2",
        "CC-BY-SA-4.0",
        "https://quac.ai/#getting-started",
        "https://quac.ai/",
        "Eunsol Choi et al., QuAC: Question Answering in Context (2018), and Wikipedia contributors",
        ("turn_type",),
        (
            SourceSpec(
                "quac-train.json",
                "https://s3.amazonaws.com/my89public/quac/train_v0.2.json",
                "ff5cca5a2e4b4d1cb5b5ced68b9fce88394ef6d93117426d6d4baafbcc05c56a",
            ),
            SourceSpec(
                "quac-dev.json",
                "https://s3.amazonaws.com/my89public/quac/val_v0.2.json",
                "09e622916280ba04c9352acb1bc5bbe80f11a2598f6f34e934c51d9e6570f378",
            ),
        ),
        "English crowdworker conversations and teacher follow-up judgments. Follow-up judgment is a proxy for H2.",
    ),
    "xquad": DatasetCard(
        "xquad",
        _XQUAD,
        "CC-BY-SA-4.0",
        f"https://github.com/google-deepmind/xquad/blob/{_XQUAD}/CC-BY-SA4.0.txt",
        "https://github.com/google-deepmind/xquad",
        "Mikel Artetxe, Sebastian Ruder and Dani Yogatama, XQuAD (2020), SQuAD and Wikipedia contributors",
        ("sentence_selection",),
        (
            SourceSpec(
                "xquad-ar.json",
                f"https://raw.githubusercontent.com/google-deepmind/xquad/{_XQUAD}/xquad.ar.json",
                "abdabd7afed5c635d99cca0f3f0d0c9d9ed0bc77451e963c2e4e0638c29e486d",
            ),
            SourceSpec(
                "xquad-en.json",
                f"https://raw.githubusercontent.com/google-deepmind/xquad/{_XQUAD}/xquad.en.json",
                "e4c57d1c9143aaa1c5d265ba5987a65f4e69528d2a98f29d6e75019b10344f29",
            ),
        ),
        "English SQuAD questions and professional Arabic translation. Historical benchmark reused for development.",
    ),
    "mlqa": DatasetCard(
        "mlqa",
        "1.0",
        "CC-BY-SA-3.0",
        "https://github.com/facebookresearch/MLQA#license",
        "https://github.com/facebookresearch/MLQA",
        "Patrick Lewis et al., MLQA (2020), and Wikipedia contributors",
        ("sentence_selection",),
        (
            SourceSpec(
                "mlqa.zip",
                "https://dl.fbaipublicfiles.com/MLQA/MLQA_V1.zip",
                "246e8089933d13007fe80684d5c5c0713d6834cf8b3b4a0ec7c66f0a0d2baac8",
            ),
        ),
        "Crowdworker QA and human translation. Uses same-language ar/en from the original benchmark archive.",
    ),
    "tydiqa": DatasetCard(
        "tydiqa",
        f"GoldP v1.1 ({_TYDI})",
        "Apache-2.0",
        f"https://huggingface.co/datasets/google-research-datasets/tydiqa/blob/{_TYDI}/README.md",
        "https://github.com/google-research-datasets/tydiqa",
        "Jonathan H. Clark et al., TyDi QA (2020), and Wikipedia contributors",
        ("sentence_selection",),
        (
            SourceSpec(
                "tydiqa-train.parquet",
                f"{_TYDI_SOURCE}train-00000-of-00001.parquet",
                "8139944554bcd89f6c4b167b93c9a63ec44a6d97b8caebe049061f78fcc0e786",
            ),
            SourceSpec(
                "tydiqa-validation.parquet",
                f"{_TYDI_SOURCE}validation-00000-of-00001.parquet",
                "38760fbfc8fa4d0765026d56cfbb65a39231ad8cf5afef40f9c962a26bd3f94d",
            ),
        ),
        "Crowdworker QA collected directly in each language. Uses ar/en from the publisher's GoldP parquet.",
    ),
    "arcd": DatasetCard(
        "arcd",
        _ARCD,
        "MIT (SOQAL release); Wikipedia passage terms apply",
        f"https://github.com/husseinmozannar/SOQAL/blob/{_ARCD}/LICENSE",
        "https://github.com/husseinmozannar/SOQAL/tree/master/data",
        "Hussein Mozannar, Karl El Hajal, Elie Maamary and Hazem Hajj (2019), and Wikipedia contributors",
        ("sentence_selection",),
        (
            SourceSpec(
                "arcd-train.json",
                f"https://raw.githubusercontent.com/husseinmozannar/SOQAL/{_ARCD}/data/arcd-train.json",
                "6a973fda9f0b066e0547a85a3396e7294fa917e24b6efd7ce430769033a6ce15",
            ),
            SourceSpec(
                "arcd-test.json",
                f"https://raw.githubusercontent.com/husseinmozannar/SOQAL/{_ARCD}/data/arcd-test.json",
                "b4ba4fb4227841bbce71e01b3eaecb33e9f17a08cde1ec91e5bc335da2c75135",
            ),
        ),
        "Crowdworker questions on Arabic Wikipedia. Uses ARCD only. The authors' translated Arabic-SQuAD is excluded.",
    ),
    "squad2": DatasetCard(
        "squad2",
        "2.0",
        "CC-BY-SA-4.0",
        _STANFORD,
        _STANFORD,
        "Pranav Rajpurkar, Robin Jia and Percy Liang, SQuAD 2.0 (2018), and Wikipedia contributors",
        ("sentence_selection", "sufficiency"),
        (
            SourceSpec(
                "squad2-train.json",
                f"{_STANFORD}dataset/train-v2.0.json",
                "68dcfbb971bd3e96d5b46c7177b16c1a4e7d4bdef19fb204502738552dede002",
            ),
            SourceSpec(
                "squad2-dev.json",
                f"{_STANFORD}dataset/dev-v2.0.json",
                "80a5225e94905956a6446d296ca1093975c4d3b3260f1d6c8f68bc2ab77182d8",
            ),
        ),
        "English crowdworker questions, gold spans and adversarially written unanswerable examples.",
    ),
    "ami": DatasetCard(
        "ami",
        "manual annotations 1.6.2",
        "CC-BY-4.0",
        "https://groups.inf.ed.ac.uk/ami/download/",
        "https://groups.inf.ed.ac.uk/ami/corpus/",
        "AMI Consortium, AMI Meeting Corpus",
        ("speech_act",),
        (
            SourceSpec(
                "ami.zip",
                "https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip",
                "b56e5babb2496b8795deeeda7e71178d7fbc9963f94276cf2a3f4b56ebbc9f9d",
            ),
        ),
        "English meetings. Manual transcription and dialog acts only. Uses dialogue-act codes in the AMI ontology.",
    ),
}

TASKS = frozenset(task for card in CATALOG.values() for task in card.tasks)
