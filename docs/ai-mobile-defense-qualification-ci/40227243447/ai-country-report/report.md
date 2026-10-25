# AI country tournament

Candidate `356d35b7271d14a37380585f4f809ccd19703757` vs `c18f77650e40b668064bdb913a75bebfa278f42b`.

432 valid games: 275 wins, 133 losses, 24 draws. Win rate including draws: 63.7%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 4/2/0 | 4/2/0 | 4/2/0 | 3/2/1 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 韩国 | 2/4/0 | — | 3/3/0 | 3/3/0 | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 法国 | 2/4/0 | 3/3/0 | — | 3/3/0 | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 德国 | 2/4/0 | 3/3/0 | 3/3/0 | — | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 英国 | 2/3/1 | 3/3/0 | 3/3/0 | 3/3/0 | — | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 利比亚 | 4/1/1 | 5/1/0 | 4/1/1 | 5/1/0 | 4/1/1 | — | 2/4/0 | 2/2/2 | 2/1/3 |
| 伊拉克 | 3/3/0 | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | — | 4/2/0 | 4/2/0 |
| 古巴 | 4/1/1 | 5/1/0 | 4/1/1 | 5/1/0 | 4/1/1 | 2/2/2 | 2/4/0 | — | 2/1/3 |
| 苏俄 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 1/2/3 | 2/4/0 | 1/2/3 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 35/12/1 | 72.9% |
| 韩国 | 31/17/0 | 64.6% |
| 法国 | 31/17/0 | 64.6% |
| 德国 | 31/17/0 | 64.6% |
| 英国 | 31/16/1 | 64.6% |
| 利比亚 | 28/12/8 | 58.3% |
| 伊拉克 | 31/17/0 | 64.6% |
| 古巴 | 28/12/8 | 58.3% |
| 苏俄 | 29/13/6 | 60.4% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 88/52/4 | 61.1% |
| mp11t2.map | 81/55/8 | 56.2% |
| tn01t2.map | 106/26/12 | 73.6% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 51 | 25 | 432/432 |
| desolatorDeployments | 0 | 0 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 11 | 11 | 432/432 |
| enemyCrushKills | 2915 | 294 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 3 | 3 | 432/432 |
| grandCannonShots | 0 | 0 | 432/432 |
| grandCannonsReady | 0 | 0 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToBaseline | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 0 | 0 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.


## Direct comparison with current bot

Verdict: **development-positive**. Score with half draws: 66.44%. Primary wins/valid games: 63.66%.

Development-positive only passes the development screen. Qualification requires all registered seed sets and a score interval lower bound above 50%; partial results cannot prove the tactic is stronger.
