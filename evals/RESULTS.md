# Eval results

Run: `npm run eval` · 2026-11-05

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

## Form answers (sandbox employers, real browser)
_Greenhouse/Lever/Ashby-style forms for 16 sandbox postings, example profile, dry run_

| Metric | Value |
|---|---|
| known fields answered correctly % | 100 |
| unanswerable questions left blank % | 100 |
| runs stopped for a human when they should % | 100 |
