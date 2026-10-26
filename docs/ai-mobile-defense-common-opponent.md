# 冻结356与C18：主共同对手资格比较

2026-10-26，在[上一原型资格及历史回归](ai-mobile-defense-next-gates-ci/report.md)完整核验后登记。候选仍为`356d35b7271d14a37380585f4f809ccd19703757`（brutal），控制为当前C18 `c18f77650e40b668064bdb913a75bebfa278f42b`（brutal），共同对手为计划的主历史基线`0a46d527995adc2411c04484de7336d63d4b0c5f`（brutal）。不修改AI，不根据已见结果调参。

本阶段补齐既有[测评计划](ai-vanilla-evaluation-plan.json)的`scouted_air_counter`主共同对手比较。356与C18各在qualification_a/b/c跑完整432局，共六条2592局。比较两组各1296局的同身份对局，不把两组或不同对手混成一组胜率；本轮不是356与C18直接交手。

| 集合 | 短图 | 中图 | 长图 | 每个参赛版本局数 |
| --- | --- | --- | --- | ---: |
| qualification_a | mp08t2:710101 | tn01t2:710202 | mp11t2:710303 | 432 |
| qualification_b | mp08t2:720101 | tn01t2:720202 | mp11t2:720303 | 432 |
| qualification_c | mp08t2:730101 | tn01t2:730202 | mp11t2:730303 | 432 |

九国对其余八国、每对6局、每国48/每图144/每条432唯一局。每一对交换物理出生和玩家槽；10k资金、0额外兵、engineDifficulty4、27000tick、两边brutal，同一个冻结公共引擎、资源INI与map/terrain。两组之间除参赛AI策略版本外的配置、同身份地图/地形/起点/玩家槽必须一致。不同seed不要求相同出生坐标。

A/B/C已在同一冻结356的前两项直接资格中见过，此处是同一未调参候选对另一个预先规定对手的配对比较；不能宣称是新候选的新未见资格。若之后依据它改AI，必须另外登记新的未见种子。

使用仓库`compare-ai-evaluations.py`的既有判定，不修改计划门槛：

- 每组先独立验证所有raw、manifest与verified receipt，禁止错误/缺局填平局；平局只允许27000tick的tick-limit。
- 同身份逐局比较胜÷全部的变化。保留九个地图/seed整块及全部国别与换边，按地图内整seed块重采样5000次，固定seed20261025，95%区间。
- 356仍须总胜率≥80%、每国与每图≥70%；每国/每图相对C18不回退超过5个百分点，总体变化及其区间下限≥−2个百分点。
- 苏军四国目标组改善≥3个百分点，且目标变化区间下限>0，才满足主共同对手的`promising`判定。总体或目标没有改善如实记为非退步或不确定，不能以历史高胜率代替本项增益。

本轮也用于检验“只增加可见空军后HTK供应”的增益是否依赖对手。C18为未加此供应的控制，双方工厂实际出厂、履带对空实射、飞行兵对矿车HP/击毁、地面首坦克/首射、坦克净库存减少和角色采样分别比较。C18与356间新增的狗/守家任务未在DefaultStrategy启用，mobility probe是只读；共同对手比较不等于精确同单位的机制消融，后者仍单独保留。

三组历史regression种子已经过门槛，但不能替代本阶段九块资格与配对差分。剩余原始14/04共同对手非退步、独立战术对手、消融、镜像、普通难度与未来合并引擎验证不由本项自动豁免。master继续保留C18及他人2c51e68改动，不因开发绿灯或本项完成自动发布。

沿用“RA2 对战完成汇报”同一任务，正常运行静默；六条完整后统一归档、报告差分与所有不利样本，继续下一必要项目。精确run在实际派发并核对输入后补入本文件。

## 精确派发记录

共同workflow/engine `55bb8d8685147ab05a344397de7cf7c21f8969a3`，其ts-redalert2树仍为`ae5e9e32216d37c9c8bdcd2594656b0d39a948b6`；不是新AI候选。首轮连接GitHub检查六条均已进入regression，实际日志输入及最终manifest仍待完成时独立核验。

| 参赛版本 | 集合 | CI |
| --- | --- | --- |
| 356/brutal | qualification_a | [40255109057](https://github.com/chenxuan520/ra2web/actions/runs/40255109057) |
| 356/brutal | qualification_b | [40255119452](https://github.com/chenxuan520/ra2web/actions/runs/40255119452) |
| 356/brutal | qualification_c | [40255129951](https://github.com/chenxuan520/ra2web/actions/runs/40255129951) |
| C18/brutal | qualification_a | [40255141406](https://github.com/chenxuan520/ra2web/actions/runs/40255141406) |
| C18/brutal | qualification_b | [40255152490](https://github.com/chenxuan520/ra2web/actions/runs/40255152490) |
| C18/brutal | qualification_c | [40255163614](https://github.com/chenxuan520/ra2web/actions/runs/40255163614) |
