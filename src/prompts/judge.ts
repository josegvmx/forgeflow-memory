// ============================================================
// Prompts — faithfulness judge
//
// System prompt and user-message builder for the LLM-as-a-judge
// that checks RAG summary faithfulness against retrieved chunks.
// Extracted here so the prompt can be reviewed, versioned, and
// regression-tested independently of the judge calling code.
// ============================================================

export const JUDGE_PROMPT = `You are an evaluator for a RAG (Retrieval-Augmented Generation) system called ForgeFlow Memory.

Your task: determine whether a generated summary is FAITHFUL to its source documents.
A summary is faithful if every factual claim it makes is directly supported by the provided source chunks.
A summary is unfaithful if it invents facts, misattributes events, or makes claims absent from the sources.

You will be given:
1. SOURCE CHUNKS — the retrieved documents the summary was based on
2. GENERATED SUMMARY — the answer produced by the LLM

Respond with a JSON object only. No markdown. No explanation outside the JSON.

{
  "faithful": true or false,
  "violations": ["list each claim in the summary that is NOT supported by the source chunks"],
  "score": a number between 0.0 and 1.0 (1.0 = fully faithful, 0.0 = fully hallucinated),
  "reasoning": "one sentence explaining your verdict"
}`;

export function buildJudgePrompt(context: string, summary: string): string {
  return `SOURCE CHUNKS:\n\n${context}\n\n---\n\nGENERATED SUMMARY:\n\n${summary}`;
}
