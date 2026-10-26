# AI country tournament

Candidate `c18f77650e40b668064bdb913a75bebfa278f42b` vs `0a46d527995adc2411c04484de7336d63d4b0c5f`.

432 valid games: 364 wins, 49 losses, 19 draws. Win rate including draws: 84.3%.

Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).

| New / old | 美国 | 韩国 | 法国 | 德国 | 英国 | 利比亚 | 伊拉克 | 古巴 | 苏俄 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 美国 | — | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 |
| 韩国 | 3/2/1 | — | 5/1/0 | 4/2/0 | 4/2/0 | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 法国 | 3/2/1 | 4/2/0 | — | 4/2/0 | 4/2/0 | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 德国 | 3/2/1 | 4/2/0 | 5/1/0 | — | 4/2/0 | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 英国 | 3/3/0 | 4/2/0 | 5/1/0 | 4/2/0 | — | 4/1/1 | 4/1/1 | 4/1/1 | 4/1/1 |
| 利比亚 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — | 6/0/0 | 6/0/0 | 6/0/0 |
| 伊拉克 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 5/1/0 | — | 5/1/0 | 5/1/0 |
| 古巴 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — | 6/0/0 |
| 苏俄 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | 6/0/0 | — |

## Country and map results

| Candidate country | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| 美国 | 48/0/0 | 100.0% |
| 韩国 | 32/11/5 | 66.7% |
| 法国 | 31/12/5 | 64.6% |
| 德国 | 32/11/5 | 66.7% |
| 英国 | 32/12/4 | 66.7% |
| 利比亚 | 48/0/0 | 100.0% |
| 伊拉克 | 45/3/0 | 93.8% |
| 古巴 | 48/0/0 | 100.0% |
| 苏俄 | 48/0/0 | 100.0% |

| Map | W/L/D | Win rate including draws |
| --- | ---: | ---: |
| mp08t2.map | 115/29/0 | 79.9% |
| mp11t2.map | 124/1/19 | 86.1% |
| tn01t2.map | 125/19/0 | 86.8% |

## Observed feature events

Candidate-side events unless a victim is specified. Detachments and Capture orders are triggers, not proven raid damage or engineer captures. Ownership changes have no cause attribution. Radiation is ownerless and cannot be credited to either bot.

| Metric | Events | Games with events | Games with instrumentation |
| --- | ---: | ---: | ---: |
| captureOrders | 654 | 27 | 432/432 |
| desolatorDeployments | 0 | 0 | 432/432 |
| desolatorUnloadsFromIntactTransport | 0 | 0 | 432/432 |
| desolatorsBoarded | 0 | 0 | 432/432 |
| desolatorsProduced | 0 | 0 | 432/432 |
| enemyCrushKills | 2417 | 266 | 432/432 |
| enemyObjectsAcquiredCauseUnspecified | 3 | 3 | 432/432 |
| grandCannonShots | 0 | 0 | 432/432 |
| grandCannonsReady | 0 | 0 | 432/432 |
| neutralObjectsAcquiredCauseUnspecified | 15 | 15 | 432/432 |
| ownerlessRadiationDamageToBaseline | 0 | 0 | 432/432 |
| ownerlessRadiationDamageToCandidate | 0 | 0 | 432/432 |
| surplusRaidDetachments | 0 | 0 | 432/432 |

Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.

Strength thresholds (wins including draws): overall 80%, each country 70%, each map 70%.
Strength assessment: failed: Country Alliance: 66.7% < 70.0%; Country French: 64.6% < 70.0%; Country Germans: 66.7% < 70.0%; Country British: 66.7% < 70.0%
