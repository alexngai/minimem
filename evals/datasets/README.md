# BEIR Dataset Loaders

Dev-only dataset loaders for the minimem retrieval eval harness (P0).
These files are **not part of the published package** — they live under `evals/`
and are run directly with `tsx`.

## Supported Datasets

| Name | Corpus | Regime |
|---|---|---|
| `scifact` | ~5k docs | Short, exact-term — BM25-favoring |
| `nfcorpus` | ~3.6k docs | Medical, expert judgments, multi-relevant |
| `arguana` | ~8.7k docs | Paraphrase-heavy — vector-favoring; long queries |

## Usage

```ts
import { loadBeirDataset } from "./evals/datasets/beir.js";

const ds = await loadBeirDataset("scifact");
console.log(ds.name);          // "scifact"
console.log(ds.corpus.size);   // 5183
console.log(ds.queries.size);  // 300
console.log(ds.qrels.size);    // 300

// Look up a relevance judgment:
const score = ds.qrels.get("queryId")?.get("docId"); // number | undefined
```

Run directly with tsx:

```bash
npx tsx -e "
import { loadBeirDataset } from './evals/datasets/beir.js';
const ds = await loadBeirDataset('scifact');
console.log('corpus:', ds.corpus.size, 'queries:', ds.queries.size);
"
```

### Options

```ts
const ds = await loadBeirDataset("scifact", {
  cacheDir: "/path/to/my/cache",  // default: evals/datasets/cache/
  split: "dev",                   // default: "test"
});
```

## Network Requirement

`loadBeirDataset` requires internet access **on first run** to download from:

```
https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/<name>.zip
```

Subsequent runs use the on-disk cache and work fully offline.

The `unzip` system binary must be available (present on all macOS/Linux systems).

## Cache Layout

```
evals/datasets/cache/
├── .gitignore          ← ignores everything (cache excluded from git)
├── scifact/
│   ├── corpus.jsonl
│   ├── queries.jsonl
│   └── qrels/
│       └── test.tsv
├── nfcorpus/
│   └── ...
└── arguana/
    └── ...
```

The cache directory is gitignored via `evals/datasets/cache/.gitignore`.
Downloaded zip files are deleted after extraction.

## Public API

### `loadBeirDataset(name, opts?): Promise<BeirDataset>`

Downloads (if needed), caches, and parses a BEIR dataset.

### `parseBeirDir(dir, split?): Promise<Omit<BeirDataset, "name">>`

Pure function — parses an already-extracted BEIR directory without any network
or side effects. Used by tests with the committed fixture at
`evals/datasets/__fixtures__/mini/`.

### `parseCorpus(filePath): Promise<Map<string, {title, text}>>`
### `parseQueries(filePath): Promise<Map<string, string>>`
### `parseQrels(filePath): Promise<Map<string, Map<string, number>>>`

Individual file parsers, exported for composability.

## Running Tests

The fixture tests run fully offline:

```bash
npx vitest run --config evals/vitest.config.ts
```

## BEIR Format Reference

- `corpus.jsonl` — one JSON object per line: `{"_id": "...", "title": "...", "text": "..."}`
- `queries.jsonl` — one JSON object per line: `{"_id": "...", "text": "..."}`
- `qrels/<split>.tsv` — TSV with header `query-id\tcorpus-id\tscore`, then data rows
