# AI country tournament

Candidate `c18f77650e40b668064bdb913a75bebfa278f42b` vs `0a46d527995adc2411c04484de7336d63d4b0c5f`.

432 valid games: 381 wins, 23 losses, 28 draws. Win rate including draws: 88.2%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 5/1/0 | 6/0/0 | 5/1/0 | 5/1/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 |
| 韩国 | 4/2/0 | — | 6/0/0 | 5/1/0 | 5/1/0 | 5/0/1 | 5/0/1 | 5/0/1 | 5/0/1 |
| 法国 | 4/2/0 | 5/1/0 | — | 5/1/0 | 5/1/0 | 5/0/1 | 5/0/1 | 5/0/1 | 5/0/1 |
| 德国 | 4/2/0 | 5/1/0 | 6/0/0 | — | 5/1/0 | 5/0/1 | 5/0/1 | 5/0/1 | 5/0/1 |
| 英国 | 4/2/0 | 4/2/0 | 5/1/0 | 4/2/0 | — | 5/0/1 | 5/0/1 | 5/0/1 | 5/0/1 |
| 利比亚 | 5/0/1 | 5/0/1 | 6/0/0 | 5/0/1 | 5/0/1 | — | 6/0/0 | 6/0/0 | 6/0/0 |
| 伊拉克 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — | 6/0/0 | 6/0/0 |
| 古巴 | 5/0/1 | 5/0/1 | 6/0/0 | 5/0/1 | 5/0/1 | 6/0/0 | 6/0/0 | — | 6/0/0 |
| 苏俄 | 5/0/1 | 5/0/1 | 6/0/0 | 5/0/1 | 5/0/1 | 6/0/0 | 6/0/0 | 6/0/0 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 45/3/0 | 93.8% |
| 韩国 | 40/4/4 | 83.3% |
| 法国 | 39/5/4 | 81.2% |
| 德国 | 40/4/4 | 83.3% |
| 英国 | 37/7/4 | 77.1% |
| 利比亚 | 44/0/4 | 91.7% |
| 伊拉克 | 48/0/0 | 100.0% |
| 古巴 | 44/0/4 | 91.7% |
| 苏俄 | 44/0/4 | 91.7% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 128/16/0 | 88.9% |
| mp11t2.map | 121/7/16 | 84.0% |
| tn01t2.map | 132/0/12 | 91.7% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 918 | 47 | 432/432 |
| desolatorDeployments | 0 | 0 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 0 | 0 | 432/432 |
| enemyCrushKills | 2377 | 255 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 0 | 0 | 432/432 |
| grandCannonShots | 0 | 0 | 432/432 |
| grandCannonsReady | 0 | 0 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 23 | 23 | 432/432 |
| ownerlessRadiationDamageToBaseline | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 0 | 0 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.

Strength thresholds (wins including draws): overall 80%, each country 70%, each map 70%.
Strength assessment: passed.
