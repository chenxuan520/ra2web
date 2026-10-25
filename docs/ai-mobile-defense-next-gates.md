# 同一冻结候选：上一原型资格与历史回归

2026-10-26。[356直接对C18的1296局资格项目](ai-mobile-defense-qualification-ci/report.md)已完整核验通过。**候选仍冻结为`356d35b7271d14a37380585f4f809ccd19703757`，不根据刚看过的资格结果修改AI。** 本阶段并行完成既有发布条件中的两部分，不是发布授权。

| 用途 | 对手 | 对手profile | 登记场景集合 | 局数 | 判定 |
| --- | --- | --- | --- | ---: | --- |
| 上一原型资格A | `635c3f08f1e7117bd8b50f96e91d4c03a059f00a` | brutal | qualification_a | 432 | 三套合并、九个地图/seed块95%半平得分区间下限>50% |
| 上一原型资格B | 同635 | brutal | qualification_b | 432 | 同上 |
| 上一原型资格C | 同635 | brutal | qualification_c | 432 | 同上 |
| 最原始Bot历史回归 | `14ffd3613663a0e1a373593922e0f5e1c5f20f40` | **normal** | regression | 432 | 胜÷全部≥80%、每国每图≥70%、零错 |
| 04历史回归 | `04a9f7ae57053e3f7f108afd14f830c293cac47a` | brutal | regression | 432 | 同上 |
| 0a历史回归 | `0a46d527995adc2411c04484de7336d63d4b0c5f` | brutal | regression | 432 | 同上 |

六条合计2592局，各自九国对其余八国、三图、物理出生和玩家槽交换；每条每国48局、每图144局、每对6局。候选全部brutal，10k资金、0额外兵、engineDifficulty4、27000tick；正常付费、前提和可见性不变。原始Bot保留normal策略，与双方相同的引擎难度/资源规则分开，不套用brutal对手断言。

qualification_a/b/c使用原已登记种子710101/710202/710303、720101/720202/720303、730101/730202/730303；regression用mp08t2:10111、tn01t2:20222、mp11t2:30333。A/B/C已经看过对C18的结果，本次用于**同一个未调参候选**对另一预先要求对手的同条件资格比较，不能冒称给新候选的新未见种子。下一修改版必须另外登记未见资格种子；历史regression本来就是回归，不包装成未见资格。

上一原型三条使用comparison_mode=direct，逐条W>L只是筛选，须三套完整核验后合并；历史三条使用historical，80/70/70不降低。report仅强度门槛失败与真正运行/资源错误分开，保留全部败局、超时平局与实际错误。错误、缺局不作平局填充。

六条共用workflow/engine `562ebc71daba86c4ea0ea28e49ff5c28a2825932`，`ts-redalert2`树与356及上一资格引擎11e相同。候选始终356，不把workflow或后续文档提交混写成AI候选。

| 用途 | 精确CI |
| --- | --- |
| 对635，qualification_a | [40241153672](https://github.com/chenxuan520/ra2web/actions/runs/40241153672) |
| 对635，qualification_b | [40241240910](https://github.com/chenxuan520/ra2web/actions/runs/40241240910) |
| 对635，qualification_c | [40241320276](https://github.com/chenxuan520/ra2web/actions/runs/40241320276) |
| 对原始14，normal，regression | [40241346363](https://github.com/chenxuan520/ra2web/actions/runs/40241346363) |
| 对04，brutal，regression | [40241433799](https://github.com/chenxuan520/ra2web/actions/runs/40241433799) |
| 对0a，brutal，regression | [40241436421](https://github.com/chenxuan520/ra2web/actions/runs/40241436421) |

这是派发记录，不代表已经完成或达标。沿用同一个“RA2 对战完成汇报”任务和已授权只读监控，不新建重复任务；正常运行静默。独立战术对手、消融、镜像、普通难度、共同对手非退步以及未来合并引擎验证等其余条件仍待完成，master不因本阶段绿灯自动推广。
