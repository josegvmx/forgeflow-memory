# ADR 002 — Use LLM-as-a-judge (Claude Haiku) for faithfulness evaluation

**Status:** Accepted

## Context

The eval pipeline needs to verify that summaries produced by the synthesis layer are *faithful* to the retrieved context — i.e., that they do not invent facts absent from the source chunks. Two approaches were considered:

- **String matching / keyword overlap** (e.g., ROUGE, BERTScore, or exact substring checks): compare the summary text against the retrieved chunks using automated metrics.
- **LLM-as-a-judge**: a second LLM call is used to evaluate whether each claim in the summary is grounded in the retrieved context, returning a structured JSON verdict.

## Decision

Use **Claude Haiku as the faithfulness judge**, with a threshold score of **≥ 0.7** to pass.

## Rationale

**String matching is not sufficient for faithfulness.** A summary that paraphrases correctly scores low on exact-match metrics even when fully faithful; a summary that copies phrases verbatim scores high even when it inserts invented claims between copied spans. ROUGE and BERTScore measure surface similarity, not semantic grounding.

**Haiku over GPT-4o-mini.** The judge task — "does every claim in this paragraph appear in this set of source documents?" — is a structured classification problem, not a creative generation problem. Haiku handles it accurately at roughly 1/10th the cost of GPT-4o-mini per call, and the output format is constrained JSON, which Haiku reliably produces. The eval suite runs against a fixed fixture set, so the absolute dollar cost is low regardless of model choice.

**Score threshold of 0.7.** A threshold of 1.0 would be too strict: minor paraphrase deviations that are clearly grounded (e.g., "four cycles" vs "4 cycles") would fail. A threshold below 0.5 would let hallucinated summaries pass. 0.7 was calibrated empirically against hand-labelled examples from the golden fixture set: it correctly rejected hallucinated summaries and accepted faithful ones with appropriate paraphrasing.

**Ollama fallback.** The judge accepts `SYNTHESIS_PROVIDER=ollama` to enable fully local evaluation without an Anthropic API key. This degrades score accuracy on ambiguous cases but keeps the eval runnable in air-gapped environments.

## Consequences

- **Positive:** Faithfulness evaluation catches hallucinations that string overlap metrics miss.
- **Positive:** Structured JSON output (violations list, score, reasoning) gives actionable debug information when a test fails.
- **Positive:** Haiku cost per eval run is < $0.01 for the current 5-query fixture set.
- **Negative:** Each judge call adds ~500ms to eval runtime; the full suite takes ~10–15s instead of < 1s.
- **Negative:** The judge itself can make mistakes on subtle cases. The 0.7 threshold was chosen to tolerate minor judge errors; it should be re-calibrated if the fixture set grows significantly.
- **Negative:** Eval results are not fully deterministic (LLM temperature > 0). Scores near the 0.7 boundary may flap between runs.
