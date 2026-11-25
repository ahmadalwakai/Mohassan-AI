from corpus_pipeline.inputs import load_config, source_rows
from scripts.benchmark import generate_config


def test_benchmark_writes_reproducible_pinned_fixtures(tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    minimum = 128 * 1024

    config_path, stats = generate_config(first, minimum)
    _, second_stats = generate_config(second, minimum)

    assert stats == second_stats
    assert stats["total_text_bytes"] >= minimum
    assert {file.name for file in first.iterdir()} == {file.name for file in second.iterdir()}
    assert all(file.read_bytes() == (second / file.name).read_bytes() for file in first.iterdir())
    config = load_config(config_path)
    assert config.fixture_mode
    for source in config.sources:
        rows = list(source_rows(source))
        assert len(rows) == stats["rows_by_source"][source.id]
        assert sum(len(row["text"].encode("utf-8")) for _, row in rows) == stats["text_bytes_by_source"][source.id]
