#!/usr/bin/env python3
"""Convert a BEAM scale parquet (HuggingFace `Mohammadta/BEAM`) into the
normalized JSON that swarmkit-eval's `loadBeam` consumes.

Each parquet row's `chat` (list of batches of message structs) is flattened to a
`messages` list, and `probing_questions` (a Python-repr string) is literal-eval'd
to a dict keyed by the 10 memory dimensions.

Usage (see README.md):
  python3 -m venv evals/beam/.venv && evals/beam/.venv/bin/pip install pyarrow
  curl -sL "https://huggingface.co/api/datasets/Mohammadta/BEAM/parquet/default/100K/0.parquet" \
    -o evals/beam/cache/beam-100K.parquet
  evals/beam/.venv/bin/python evals/beam/convert.py \
    evals/beam/cache/beam-100K.parquet evals/beam/cache/beam-100K.json
"""
import sys
import ast
import json
import pyarrow.parquet as pq


def convert(src: str, dst: str) -> None:
    rows = pq.read_table(src).to_pylist()
    out = []
    for row in rows:
        raw_probes = row["probing_questions"]
        probes = ast.literal_eval(raw_probes) if isinstance(raw_probes, str) else raw_probes
        messages = []
        for batch in (row["chat"] or []):
            for m in batch:
                messages.append(
                    {
                        "id": m["id"],
                        "role": m["role"],
                        "content": m["content"],
                        "time_anchor": m.get("time_anchor"),
                    }
                )
        out.append(
            {
                "conversation_id": row["conversation_id"],
                "messages": messages,
                "probing_questions": probes,
            }
        )
    with open(dst, "w") as f:
        json.dump(out, f)
    print(f"wrote {len(out)} conversations -> {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: convert.py <in.parquet> <out.json>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
