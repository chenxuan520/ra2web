# AI country tournament

Candidate `356d35b7271d14a37380585f4f809ccd19703757` vs `04a9f7ae57053e3f7f108afd14f830c293cac47a`.

432 valid games: 380 wins, 36 losses, 16 draws. Win rate including draws: 88.0%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 |
| 韩国 | 5/1/0 | — | 5/1/0 | 5/1/0 | 5/1/0 | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 法国 | 5/1/0 | 5/1/0 | — | 5/1/0 | 5/1/0 | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 德国 | 5/1/0 | 5/1/0 | 5/1/0 | — | 5/1/0 | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 英国 | 5/1/0 | 5/1/0 | 5/1/0 | 5/1/0 | — | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 利比亚 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — | 6/0/0 | 6/0/0 | 6/0/0 |
| 伊拉克 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — | 6/0/0 | 6/0/0 |
| 古巴 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — | 6/0/0 |
| 苏俄 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 44/4/0 | 91.7% |
| 韩国 | 36/8/4 | 75.0% |
| 法国 | 36/8/4 | 75.0% |
| 德国 | 36/8/4 | 75.0% |
| 英国 | 36/8/4 | 75.0% |
| 利比亚 | 48/0/0 | 100.0% |
| 伊拉克 | 48/0/0 | 100.0% |
| 古巴 | 48/0/0 | 100.0% |
| 苏俄 | 48/0/0 | 100.0% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 120/20/4 | 83.3% |
| mp11t2.map | 128/16/0 | 88.9% |
| tn01t2.map | 132/0/12 | 91.7% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 201 | 21 | 432/432 |
| desolatorDeployments | 0 | 0 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 0 | 0 | 432/432 |
| enemyCrushKills | 1991 | 281 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| grandCannonShots | 24 | 4 | 432/432 |
| grandCannonsReady | 4 | 4 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 3 | 3 | 432/432 |
| ownerlessRadiationDamageToBaseline | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 0 | 0 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.

Strength thresholds (wins including draws): overall 80%, each country 70%, each map 70%.
Strength assessment: passed.
