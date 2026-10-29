# CI40947340059 独立只读核验

结论：通过，744项断言；未启动新游戏、fixture、CI，也未更改仓库。

- ZIP14个唯一成员CRC、SHA256及解压字节全部核对；ZIP SHA256 `c7981e595f3fa77cb72d062d8053f2b22ca550db5a1e54f978fab04fb67a2562`。
- engine `8f295c9c40bd24a4782164a31e668b0754039bd7`，候选 `8f295c9c40bd24a4782164a31e668b0754039bd7`，baseline C18/brutal；候选与engine是同一冻结提交。所有F1/F3a提供的源码哈希已从该engine的Git对象原始字节重算，未使用旧183或本地开发raw。真实资源字节与CI资源哈希一致。
- F1：normal/brutal各两个隐藏实际出生点世界，各180tick、6观察点、1实际命令；逐观察SHA重算、完整意图/命令相等；0隐藏敏感字段读取。合法揭示改变方向，重遮后恢复公共候选；隐藏矿量4→3仍unknown=null，揭示后150credits，真实富矿11925credits通过4000credit预算门槛。
- F3a：真实SUB/DLPH各232tick、6交错API快照。事件17tick自然隐形、176tick实际sensor解隐、231tick再隐形；旧ID、列表/filter与自己单位正确。解隐前0开火；197tick各一次ASWLauncher真实发射保留，覆盖窗口0伤害。shroud reset/reveal是实际API机制预置，不是裂缝产生器实战。
- L0新增3个真实机制场景的完整raw与仓库冻结证据逐字节相同（SHA07a56c90...c68ed0）；初始27目标分配后，3840/3959不补，3960补95个不足0.8可见度区域（94未知中心+1已见中心）；全已探0→0、自身clone排除通过。revealedTargetCount始终null，不认领已走完路线；真实cache按检查点充分预热，不认证正常增量调度/完整策略。
- 烟测两份paired raw+两个receipt全部原字节SHA、manifest fingerprint正确；精确冻结pure `validateJobReport` 与 `summarizeTournament` 重验通过。美国/苏俄两有向配对，共4唯一局，物理出生和玩家槽均真实交换。10k/0兵/难度4，双方brutal，全部3000tick到时，errorCount0。它们是运行兼容烟测，**不计27000tick强度样本，不给新AI胜率结论**。
- CI原日志：339 Bun通过、13跳过、0失败；37 Python检查。其他三份旧机制fixture的passed/issues/errors检查通过，仅作为机制。

逐成员哈希、Git源码重算计数、回执、所有断言见 `independent-review.json` 与 `independent-smoke-validation.json`。所有jobs/artifact清单来自根代理已读connected GitHub的记录，本子代理没有再次抓取该列表。
