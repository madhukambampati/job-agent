# Eval results

Run: `npm run eval -- --llm` · 2026-11-07

## Honesty guard
_26 fabricated + 13 legitimate edits to the example résumé_

| Metric | Value |
|---|---|
| fabrications caught % | 96.2 |
| term/number fabrications caught % | 100 |
| scope/scale inflation caught % | 87.5 |
| held-out hard cases caught % | 75 |
| legit edits wrongly rejected % | 0 |

<details><summary>1 note(s)</summary>

- missed (heldout-expert): "Became the go-to expert for LLM testing, building an evaluation harness with a golden dataset."

</details>

## Requirement extraction
_17 sandbox postings_

| Metric | Value |
|---|---|
| precision % | 100 |
| recall % | 100 |
| must/nice labelled right % | 100 |

## Evidence retrieval (local:tfidf)
_15 requirements with evidence (5 paraphrased) + 6 with none, example résumé_

| Metric | Value |
|---|---|
| hit@1 % | 80 |
| recall@3 % | 86.7 |
| MRR | 0.822 |
| paraphrase recall@3 % | 60 |
| supported when evidence exists % | 66.7 |
| 'no evidence' correctly reported % | 100 |

<details><summary>7 note(s)</summary>

- no relevant hit in top 3 for "Keep the build pipeline green and fast" (got summary, skills.1, skills.2)
- evidence found but below threshold for "Keep the build pipeline green and fast" (0.051)
- evidence found but below threshold for "Assess the quality of generative model outputs" (0.061)
- no relevant hit in top 3 for "Make sure our apps work on phones" (got summary, skills.1, skills.2)
- evidence found but below threshold for "Make sure our apps work on phones" (0)
- evidence found but below threshold for "Write automated checks for web user interfaces" (0.047)
- evidence found but below threshold for "Reduce the time it takes to run the full regression" (0.086)

</details>

## Evidence retrieval (cohere:embed-v4.0 + cohere:rerank-v3.5)
_15 requirements with evidence (5 paraphrased) + 6 with none, example résumé_

| Metric | Value |
|---|---|
| hit@1 % | 93.3 |
| recall@3 % | 100 |
| MRR | 0.967 |
| paraphrase recall@3 % | 100 |
| supported when evidence exists % | 66.7 |
| 'no evidence' correctly reported % | 100 |

<details><summary>5 note(s)</summary>

- evidence found but below threshold for "Experience with Docker" (0.118)
- evidence found but below threshold for "Keep the build pipeline green and fast" (0.143)
- evidence found but below threshold for "Assess the quality of generative model outputs" (0.05)
- evidence found but below threshold for "Make sure our apps work on phones" (0.169)
- evidence found but below threshold for "Write automated checks for web user interfaces" (0.139)

</details>

## Form answers (sandbox employers, real browser)
_Greenhouse/Lever/Ashby-style forms for 16 sandbox postings, example profile, dry run_

| Metric | Value |
|---|---|
| known fields answered correctly % | 100 |
| unanswerable questions left blank % | 100 |
| runs stopped for a human when they should % | 100 |

## Fit scoring (Claude)
_8 sandbox postings with maintainer-labelled bands, example résumé_

| Metric | Value |
|---|---|
| in expected band % | 87.5 |
| pairwise order correct % | 73.7 |

<details><summary>2 note(s)</summary>

- Aurora Labs: scored 8, expected mid (Core QA fits; mentoring not shown; Go/Bazel nice-to-haves missing)
- scores: maplewave=8, evalforge=8, northpine=8, quillmind=7, auroralabs=8, cedarloop=5, polarisdefence=7, lakeshore-analytics=4

</details>
