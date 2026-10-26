# AI country tournament

Candidate `356d35b7271d14a37380585f4f809ccd19703757` vs `635c3f08f1e7117bd8b50f96e91d4c03a059f00a`.

432 valid games: 196 wins, 185 losses, 51 draws. Win rate including draws: 45.4%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 4/2/0 | 4/2/0 | 4/2/0 | 3/2/1 | 3/0/3 | 3/2/1 | 3/0/3 | 3/0/3 |
| 韩国 | 2/4/0 | — | 3/3/0 | 3/3/0 | 3/3/0 | 0/5/1 | 0/6/0 | 0/5/1 | 0/5/1 |
| 法国 | 2/4/0 | 3/3/0 | — | 3/3/0 | 3/3/0 | 0/5/1 | 0/6/0 | 0/5/1 | 0/5/1 |
| 德国 | 2/4/0 | 3/3/0 | 3/3/0 | — | 3/3/0 | 0/5/1 | 0/6/0 | 0/5/1 | 0/5/1 |
| 英国 | 2/3/1 | 3/3/0 | 3/3/0 | 3/3/0 | — | 0/5/1 | 0/5/1 | 0/5/1 | 0/5/1 |
| 利比亚 | 4/1/1 | 5/1/0 | 4/1/1 | 5/1/0 | 4/1/1 | — | 2/1/3 | 4/1/1 | 4/1/1 |
| 伊拉克 | 3/3/0 | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 3/2/1 | — | 3/2/1 | 3/2/1 |
| 古巴 | 4/1/1 | 5/1/0 | 4/1/1 | 5/1/0 | 4/1/1 | 4/1/1 | 2/1/3 | — | 4/1/1 |
| 苏俄 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 3/1/2 | 2/1/3 | 3/1/2 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 27/10/11 | 56.2% |
| 韩国 | 11/34/3 | 22.9% |
| 法国 | 11/34/3 | 22.9% |
| 德国 | 11/34/3 | 22.9% |
| 英国 | 11/32/5 | 22.9% |
| 利比亚 | 32/8/8 | 66.7% |
| 伊拉克 | 28/17/3 | 58.3% |
| 古巴 | 32/8/8 | 66.7% |
| 苏俄 | 33/8/7 | 68.8% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 79/53/12 | 54.9% |
| mp11t2.map | 41/68/35 | 28.5% |
| tn01t2.map | 76/64/4 | 52.8% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 523 | 44 | 432/432 |
| desolatorDeployments | 0 | 0 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 14 | 14 | 432/432 |
| enemyCrushKills | 2557 | 267 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| grandCannonShots | 0 | 0 | 432/432 |
| grandCannonsReady | 0 | 0 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 12 | 12 | 432/432 |
| ownerlessRadiationDamageToBaseline | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 0 | 0 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.


## Direct comparison with current bot

Verdict: **development-positive**. Score with half draws: 51.27%. Primary wins/valid games: 45.37%.

Development-positive only passes the development screen. Qualification requires all registered seed sets and a score interval lower bound above 50%; partial results cannot prove the tactic is stronger.
