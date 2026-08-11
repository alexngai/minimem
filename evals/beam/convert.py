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


def _msg(m: dict) -> dict:
    return {
        "id": m["id"],
        "role": m["role"],
        "content": m["content"],
        "time_anchor": m.get("time_anchor"),
    }


def _messages_from_chat(chat) -> list:
    """Flatten a BEAM `chat` column to a flat message list.

    Two schemas exist and they nest differently:

    100K / 500K / 1M (`Mohammadta/BEAM`)
        chat = list[ list[message] ]            -- batches of messages

    10M (`Mohammadta/BEAM-10M`)
        chat = list[ {plan-N: list[batch]} ]    -- one non-null plan per element,
        batch = {batch_number, time_anchor, turns}
        turns = list[ list[message] ]           -- one extra nesting level

    The 10M tier reaches its scale by carrying ten conversation plans per
    conversation. Arrow expands the plan struct so every element exposes all ten
    `plan-*` keys with only one populated; iterating the list in order preserves
    plan-1..plan-10 sequence, which lexicographic key order would not (plan-10
    sorts before plan-2).
    """
    messages = []
    for entry in (chat or []):
        if isinstance(entry, dict):  # 10M
            for _key, batches in entry.items():
                if not batches:
                    continue
                for b in batches:
                    for group in (b.get("turns") or []):
                        if isinstance(group, dict):  # defensive: unwrapped turn
                            messages.append(_msg(group))
                            continue
                        for m in (group or []):
                            messages.append(_msg(m))
        else:  # 100K / 500K / 1M
            for m in (entry or []):
                messages.append(_msg(m))
    return messages


def convert(src: str, dst: str) -> None:
    """Stream row-by-row. The 10M parquet is 327MB and `to_pylist()` on the whole
    table expands to several GB of Python objects, which will contend with any
    eval run holding an embedding model."""
    pf = pq.ParquetFile(src)
    cols = ["conversation_id", "chat", "probing_questions"]
    n = 0
    with open(dst, "w") as f:
        f.write("[")
        for batch in pf.iter_batches(batch_size=1, columns=cols):
            for row in batch.to_pylist():
                raw_probes = row["probing_questions"]
                probes = ast.literal_eval(raw_probes) if isinstance(raw_probes, str) else raw_probes
                rec = {
                    "conversation_id": row["conversation_id"],
                    "messages": _messages_from_chat(row["chat"]),
                    "probing_questions": probes,
                }
                if n:
                    f.write(",")
                json.dump(rec, f)
                n += 1
                print(f"  conv {rec['conversation_id']}: {len(rec['messages'])} messages", flush=True)
        f.write("]")
    print(f"wrote {n} conversations -> {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: convert.py <in.parquet> <out.json>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
