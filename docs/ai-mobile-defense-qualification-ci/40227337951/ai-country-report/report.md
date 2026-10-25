# AI country tournament

Candidate `356d35b7271d14a37380585f4f809ccd19703757` vs `c18f77650e40b668064bdb913a75bebfa278f42b`.

432 valid games: 267 wins, 130 losses, 35 draws. Win rate including draws: 61.8%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 韩国 | 2/4/0 | — | 3/3/0 | 3/3/0 | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 法国 | 2/4/0 | 3/3/0 | — | 3/3/0 | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 德国 | 2/4/0 | 3/3/0 | 3/3/0 | — | 3/3/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 英国 | 2/4/0 | 3/3/0 | 3/3/0 | 3/3/0 | — | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 |
| 利比亚 | 3/1/2 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | — | 2/3/1 | 1/1/4 | 1/1/4 |
| 伊拉克 | 1/5/0 | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 3/2/1 | — | 3/2/1 | 3/2/1 |
| 古巴 | 3/1/2 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 1/1/4 | 2/3/1 | — | 1/1/4 |
| 苏俄 | 3/2/1 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 1/1/4 | 2/3/1 | 1/1/4 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 36/12/0 | 75.0% |
| 韩国 | 31/17/0 | 64.6% |
| 法国 | 31/17/0 | 64.6% |
| 德国 | 31/17/0 | 64.6% |
| 英国 | 31/17/0 | 64.6% |
| 利比亚 | 27/10/11 | 56.2% |
| 伊拉克 | 26/19/3 | 54.2% |
| 古巴 | 27/10/11 | 56.2% |
| 苏俄 | 27/11/10 | 56.2% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 87/55/2 | 60.4% |
| mp11t2.map | 78/51/15 | 54.2% |
| tn01t2.map | 102/24/18 | 70.8% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 25 | 17 | 432/432 |
| desolatorDeployments | 2 | 1 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 16 | 11 | 432/432 |
| enemyCrushKills | 2677 | 308 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| grandCannonShots | 0 | 0 | 432/432 |
| grandCannonsReady | 0 | 0 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToBaseline | 50 | 1 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 3 | 3 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.


## Direct comparison with current bot

Verdict: **development-positive**. Score with half draws: 65.86%. Primary wins/valid games: 61.81%.

Development-positive only passes the development screen. Qualification requires all registered seed sets and a score interval lower bound above 50%; partial results cannot prove the tactic is stronger.
