# Remote embedding endpoints for the eval

The vector/hybrid arms need an embedding endpoint. **Local works out of the box**
(`--embedding local` → embeddinggemma-300M via node-llama-cpp, Metal-accelerated; ~147 emb/s on a
fresh process). This doc covers **managed/remote** endpoints (Modal-served TEI, or Bedrock via a
gateway) for batched/faster embeddings and machine-independent runs.

> **Status:** the eval *seam* and the *local* path are verified (`eval:ci`, the SciFact local matrix).
> The remote deploy snippets below are **reference** — they require *your* cloud account and aren't
> deployed/verified from this repo. Once you have a live base-url, the run command produces the full
> vector matrix; **ResourceCache makes re-runs free** (embeddings computed once per dataset+arm+model).

## The seam (any OpenAI-compatible `/v1/embeddings`)
minimem's `openai` provider POSTs `{ model, input }` with `Authorization: Bearer $OPENAI_API_KEY` to
`${baseUrl}/embeddings`. So any OpenAI-compatible endpoint plugs in unchanged:

```sh
OPENAI_API_KEY=<token> npm run eval -- --dataset scifact \
  --embedding openai:<model> --base-url <endpoint>/v1 --ks 1,5,10,20 \
  --out scifact-full.md --json scifact-full.json
```

## Option 1 — Modal-served TEI (open models, serverless GPU)
HuggingFace **Text Embeddings Inference** serves an OpenAI-compatible `/v1/embeddings`. Run it on
Modal (GPU, scale-to-zero). Sketch (verify against current Modal docs — the API moves):

```python
# modal_tei.py  (reference)
import modal
MODEL = "BAAI/bge-large-en-v1.5"
image = (modal.Image.from_registry("ghcr.io/huggingface/text-embeddings-inference:1.6")
         .env({"MODEL_ID": MODEL}))
app = modal.App("tei-bge")

@app.function(image=image, gpu="A10G", scaledown_window=300, timeout=600)
@modal.web_server(port=80, startup_timeout=180)
def serve():
    import subprocess
    subprocess.Popen(["text-embeddings-router", "--model-id", MODEL, "--port", "80"])
```

```sh
modal deploy modal_tei.py            # → https://<you>--tei-bge-serve.modal.run
OPENAI_API_KEY=unused npm run eval -- --dataset scifact \
  --embedding openai:bge-large-en-v1.5 --base-url https://<you>--tei-bge-serve.modal.run/v1 --ks 1,5,10,20
```

- Auth: Modal web endpoints can require proxy-auth tokens, or front with a thin bearer check; TEI
  itself has no auth. For a private run the obscured URL + Modal proxy auth is usually enough.
- Recommended model: **`bge-large-en-v1.5`** — strong and ~symmetric (see caveat).

## Option 2 — Bedrock via LiteLLM gateway (managed Titan/Cohere)
LiteLLM exposes OpenAI-compat `/v1/embeddings` and signs SigV4 to Bedrock:

```yaml
# litellm.config.yaml
model_list:
  - model_name: titan-embed
    litellm_params: { model: bedrock/amazon.titan-embed-text-v2:0, aws_region_name: us-east-1 }
  - model_name: cohere-embed
    litellm_params: { model: bedrock/cohere.embed-english-v3, aws_region_name: us-east-1 }
```

```sh
litellm --config litellm.config.yaml --port 4000      # AWS creds via env/role
OPENAI_API_KEY=<litellm-key> npm run eval -- --dataset scifact \
  --embedding openai:titan-embed --base-url http://localhost:4000/v1 --ks 1,5,10,20
```

## Caveat — asymmetric models + `input_type`
minimem's `openai` provider sends only `{model, input}` — **no `input_type`** (Cohere/Titan) or
query/passage instruction (e5/bge). Asymmetric models lose quality without it. Two paths:
- **Symmetric-friendly model** (`bge-large-en-v1.5`) — minor hit, zero code. *(recommended to start)*
- **Add query/doc signaling** to the `openai` provider — it already distinguishes `embedQuery`
  (query) vs `embedBatch` (docs), so it can send the right `input_type`/instruction. A ~½-day src
  enhancement that unlocks Cohere/Titan at full quality.

Note: this only depresses *absolute* scores; **config-relative deltas (RRF vs weighted, weight
sweep) are unaffected**, since the embedding is constant across arms.

## Decision summary
| Want | Use |
|---|---|
| No infra, now | `--embedding local` (works; ResourceCache makes re-runs free) |
| Managed open model, serverless GPU | Modal-TEI + `bge-large-en-v1.5` |
| AWS-managed (Titan/Cohere) | Bedrock via LiteLLM (+ add `input_type` for full quality) |
