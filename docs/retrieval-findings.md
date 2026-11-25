# Retrieval on real data — findings (R14 phase 3)

What forgeflow-memory's retrieval does on real simulation data, measured, and the gate that keeps it there.
Numbers: `docs/retrieval-eval.md` (live store) and `docs/retrieval-eval-spaces.md` (embedding spaces);
definitions: `src/eval/retrievalMetrics.ts`.

## Data and ground truth
- **Store**: 730 seeded, AI-off eval runs from forgeflow-sim (`npm run eval:export`: 3 scenarios × 3 flag
  settings × 0/3/10 % breakdowns × 20 seeds, plus 190 fault runs) → 19,167 episodes, plus 1,722 demo events.
  Embedded with `voyage-code-2`; 8,671 distinct texts (one vector per distinct text, `embedding_cache`).
- **Golden set** (`npm run golden:build`, 100 queries): ground truth from injected faults (`fault.*` labels,
  never embedded) and machine histories — not hand-picked, not LLM-judged. Relevance is a predicate
  (scenario + event types + metadata), so the same fault's identical sentence in every seed counts.
  Runs where the fault changed nothing are ignored when scoring. `bad_flag` faults are left out (their text
  never mentions the flag).
- **Styles**: *specific* (ids and cycles, 54), *operator* (operation names, 30), *vague* (roles only, 16).
- **Metrics**: recall@k ÷ min(k, |relevant|) and MRR@10.

## Results (voyage-code-2, 2026-11-24)

| strategy | recall@5 | MRR@10 | specific | operator | vague |
|---|---|---|---|---|---|
| vector (what `/query` does today) | 0.26 | 0.28 | 0.44 | 0.05 | 0.06 |
| fulltext (any word, `content_tsv`) | 0.17 | 0.20 | 0.20 | 0.17 | 0.06 |
| hybrid (vector + full text, RRF) | 0.23 | 0.31 | 0.37 | 0.07 | 0.06 |
| vector + scenario filter | 0.51 | 0.53 | 0.70 | 0.26 | 0.31 |
| hybrid + scenario filter | 0.48 | 0.54 | 0.63 | 0.40 | 0.14 |
| **structured** (hints read from the question) | **0.85** | **0.84** | **0.97** | **0.89** | 0.33 |

Embedding spaces, searched exactly (same vectors and question set):

| text embedded | vector + scenario | hybrid + scenario | structured |
|---|---|---|---|
| default (scenario, node, cycle, type, mode, sentence, metadata) | **0.58** / 0.59 | 0.55 / **0.62** | **0.85** / 0.83 |
| no-scenario (without the `Scenario: <hash>` line) | 0.53 / 0.56 | 0.51 / 0.58 | 0.83 / 0.82 |
| content-only (the sentence alone) | 0.49 / 0.50 | 0.50 / 0.56 | 0.83 / 0.83 |

(recall@5 / MRR@10)

## Findings
1. **Filter by scenario.** The same kind of event reads almost the same in every scenario; the filter roughly
   doubles every strategy.
2. **Embeddings don't see numbers.** One machine has hundreds of breakdowns per scenario; what separates the
   right one is its cycle and duration. Questions about a specific incident scored ~0 with any vector or text
   strategy. Reading ids, cycles and the kind of event from the question (`structured`) takes the specific
   tier from 0.70 to 0.97.
3. **Full text and hybrid don't help here**: matching any word is too loose on templated sentences, and fusing
   it with vectors lowers recall (MRR rises slightly).
4. **Keep the labelled metadata in the embedded text**: dropping the scenario line or keeping only the sentence
   lowers vector recall (0.58 → 0.53 → 0.49). `structured` barely depends on it (0.83–0.85).
5. **The HNSW index costs recall under a filter**: the same vectors give 0.58 searched exactly but 0.51 through
   the index with the scenario filter (it takes its nearest candidates first, then filters). At ~21k events an
   exact or per-scenario search is affordable.
6. **Vague questions stay hard** (≤ 0.33): no event says "bottleneck" or "has a backup". Reported, not gated.

## Caveats
- `structured`'s rules were written knowing the golden set's question templates: its numbers are optimistic.
  On 11 paraphrases outside the golden set the event-type rules first got 9 right (both misses fixed; those
  paraphrases are now tests).
- machine-history is near-trivial once a strategy filters by machine and event type.
- **Not measured**: OpenAI `text-embedding-3-small` (no API credit on 2026-11-24). Fill its spaces with
  `npm run embed:variant -- --model text-embedding-3-small --variant <v>` and re-run the spaces eval.
- One golden set from one simulator: no claim about other domains.

## Gate
`tests/evals/fixtures/retrieval-gates.json` (measured minus 0.05–0.07): `structured` recall@5 ≥ 0.80,
MRR ≥ 0.78, specific ≥ 0.90, operator ≥ 0.80, disruption and machine-history ≥ 0.90; `vector+scenario`
recall@5 ≥ 0.45. Run against a store holding the import:

```bash
DATABASE_URL=<store with the sim export> npm run eval:gate
```

## Next (phase 4)
`/query` still uses plain vector search (the weakest row above). Candidates: scenario filter by default,
`structured` hints when the question names machines or cycles, exact search within a scenario.
