# AI country tournament

Candidate `356d35b7271d14a37380585f4f809ccd19703757` vs `635c3f08f1e7117bd8b50f96e91d4c03a059f00a`.

432 valid games: 221 wins, 158 losses, 53 draws. Win rate including draws: 51.2%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 3/3/0 | 3/3/0 | 3/3/0 | 3/3/0 | 4/1/1 | 4/0/2 | 4/1/1 | 4/0/2 |
| 韩国 | 3/3/0 | — | 3/3/0 | 3/3/0 | 3/3/0 | 1/4/1 | 0/3/3 | 1/4/1 | 1/5/0 |
| 法国 | 3/3/0 | 3/3/0 | — | 3/3/0 | 3/3/0 | 1/4/1 | 1/3/2 | 1/4/1 | 1/4/1 |
| 德国 | 3/3/0 | 3/3/0 | 3/3/0 | — | 3/3/0 | 1/4/1 | 0/3/3 | 1/4/1 | 1/5/0 |
| 英国 | 3/3/0 | 3/3/0 | 3/3/0 | 3/3/0 | — | 1/4/1 | 0/5/1 | 1/4/1 | 1/4/1 |
| 利比亚 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | — | 3/2/1 | 4/0/2 | 4/0/2 |
| 伊拉克 | 2/3/1 | 4/2/0 | 4/2/0 | 4/2/0 | 4/2/0 | 3/0/3 | — | 3/0/3 | 3/0/3 |
| 古巴 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 4/0/2 | 3/2/1 | — | 4/0/2 |
| 苏俄 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 3/0/3 | 2/2/2 | 3/0/3 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 28/14/6 | 58.3% |
| 韩国 | 15/28/5 | 31.2% |
| 法国 | 16/27/5 | 33.3% |
| 德国 | 15/28/5 | 31.2% |
| 英国 | 15/29/4 | 31.2% |
| 利比亚 | 36/7/5 | 75.0% |
| 伊拉克 | 27/11/10 | 56.2% |
| 古巴 | 36/7/5 | 75.0% |
| 苏俄 | 33/7/8 | 68.8% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 84/38/22 | 58.3% |
| mp11t2.map | 59/65/20 | 41.0% |
| tn01t2.map | 78/55/11 | 54.2% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 212 | 36 | 432/432 |
| desolatorDeployments | 0 | 0 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 8 | 8 | 432/432 |
| enemyCrushKills | 2898 | 281 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| grandCannonShots | 29 | 4 | 432/432 |
| grandCannonsReady | 5 | 5 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 4 | 4 | 432/432 |
| ownerlessRadiationDamageToBaseline | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 0 | 0 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.


## Direct comparison with current bot

Verdict: **development-positive**. Score with half draws: 57.29%. Primary wins/valid games: 51.16%.

Development-positive only passes the development screen. Qualification requires all registered seed sets and a score interval lower bound above 50%; partial results cannot prove the tactic is stronger.
