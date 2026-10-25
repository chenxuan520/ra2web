# AI country tournament

Candidate `356d35b7271d14a37380585f4f809ccd19703757` vs `c18f77650e40b668064bdb913a75bebfa278f42b`.

432 valid games: 280 wins, 133 losses, 19 draws. Win rate including draws: 64.8%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 3/3/0 | 3/3/0 | 3/3/0 | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 韩国 | 3/3/0 | — | 3/3/0 | 3/3/0 | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 法国 | 3/3/0 | 3/3/0 | — | 3/3/0 | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 德国 | 3/3/0 | 3/3/0 | 3/3/0 | — | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 英国 | 3/3/0 | 3/3/0 | 3/3/0 | 3/3/0 | — | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 利比亚 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | — | 2/3/1 | 2/2/2 | 2/2/2 |
| 伊拉克 | 2/3/1 | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 3/2/1 | — | 3/2/1 | 3/2/1 |
| 古巴 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 2/2/2 | 2/3/1 | — | 2/2/2 |
| 苏俄 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 2/2/2 | 2/3/1 | 2/2/2 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 32/16/0 | 66.7% |
| 韩国 | 32/16/0 | 66.7% |
| 法国 | 32/16/0 | 66.7% |
| 德国 | 32/16/0 | 66.7% |
| 英国 | 32/16/0 | 66.7% |
| 利比亚 | 31/12/5 | 64.6% |
| 伊拉克 | 27/17/4 | 56.2% |
| 古巴 | 31/12/5 | 64.6% |
| 苏俄 | 31/12/5 | 64.6% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 88/50/6 | 61.1% |
| mp11t2.map | 87/57/0 | 60.4% |
| tn01t2.map | 105/26/13 | 72.9% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 28 | 19 | 432/432 |
| desolatorDeployments | 0 | 0 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 8 | 8 | 432/432 |
| enemyCrushKills | 2738 | 322 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| grandCannonShots | 0 | 0 | 432/432 |
| grandCannonsReady | 0 | 0 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToBaseline | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 0 | 0 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.


## Direct comparison with current bot

Verdict: **development-positive**. Score with half draws: 67.01%. Primary wins/valid games: 64.81%.

Development-positive only passes the development screen. Qualification requires all registered seed sets and a score interval lower bound above 50%; partial results cannot prove the tactic is stronger.
