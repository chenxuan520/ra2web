# AI country tournament

Candidate `356d35b7271d14a37380585f4f809ccd19703757` vs `635c3f08f1e7117bd8b50f96e91d4c03a059f00a`.

432 valid games: 208 wins, 175 losses, 49 draws. Win rate including draws: 48.1%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 4/1/1 | 2/1/3 | 4/1/1 | 3/1/2 |
| 韩国 | 2/4/0 | — | 3/3/0 | 3/3/0 | 3/3/0 | 1/5/0 | 0/3/3 | 1/5/0 | 1/5/0 |
| 法国 | 2/4/0 | 3/3/0 | — | 3/3/0 | 3/3/0 | 1/4/1 | 0/3/3 | 1/4/1 | 1/4/1 |
| 德国 | 2/4/0 | 3/3/0 | 3/3/0 | — | 3/3/0 | 1/5/0 | 0/3/3 | 1/5/0 | 1/5/0 |
| 英国 | 2/4/0 | 3/3/0 | 3/3/0 | 3/3/0 | — | 1/4/1 | 0/5/1 | 1/4/1 | 1/5/0 |
| 利比亚 | 3/1/2 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | — | 3/1/2 | 4/1/1 | 4/1/1 |
| 伊拉克 | 1/5/0 | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 3/1/2 | — | 3/1/2 | 3/0/3 |
| 古巴 | 3/1/2 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 4/1/1 | 3/1/2 | — | 4/1/1 |
| 苏俄 | 3/2/1 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 2/2/2 | 2/1/3 | 2/2/2 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 29/12/7 | 60.4% |
| 韩国 | 14/31/3 | 29.2% |
| 法国 | 14/28/6 | 29.2% |
| 德国 | 14/31/3 | 29.2% |
| 英国 | 14/31/3 | 29.2% |
| 利比亚 | 34/8/6 | 70.8% |
| 伊拉克 | 26/15/7 | 54.2% |
| 古巴 | 34/8/6 | 70.8% |
| 苏俄 | 29/11/8 | 60.4% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 79/52/13 | 54.9% |
| mp11t2.map | 55/58/31 | 38.2% |
| tn01t2.map | 74/65/5 | 51.4% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 166 | 19 | 432/432 |
| desolatorDeployments | 2 | 1 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 19 | 14 | 432/432 |
| enemyCrushKills | 2774 | 254 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 4 | 4 | 432/432 |
| grandCannonShots | 13 | 1 | 432/432 |
| grandCannonsReady | 1 | 1 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 4 | 4 | 432/432 |
| ownerlessRadiationDamageToBaseline | 74 | 3 | 432/432 |
| ownerlessRadiationDamageToCandidate | 792 | 5 | 432/432 |
| surplusRaidDetachments | 3 | 3 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.


## Direct comparison with current bot

Verdict: **development-positive**. Score with half draws: 53.82%. Primary wins/valid games: 48.15%.

Development-positive only passes the development screen. Qualification requires all registered seed sets and a score interval lower bound above 50%; partial results cannot prove the tactic is stronger.
