# F3b 独立源码审查（当前未冻结工作树）

审查对象：GameApi、GameObjectData/UnitData、RulesApi、builtIn消费点及四份focused测试。只读审查，不改仓库；另由只读辅助审查外部武器调用链。此处没有启动资源对局或真实机制fixture，不能作战力、完整公平或发布结论。检查时源码SHA见 independent-focused-tests.json；focused执行前后相同。

## 实质发现与修复复审

### 已修：外部真实发射状态可绕过伪装动画

初读的GameApi.ts外部返回分支原第275行直接取unit.isFiring；Infantry.ts:305–307在伪装仍有效时把FireUp/FireProne序列改为Ready。AttackTask.ts:628–629真实攻击动作会设isFiring=true；DisguiseTrait.ts:65–81仅非perma单位进入开火/移动解伪装分支，因此不能认为原版SPY开火一定先失去伪装。观察API直接返回该状态可暴露屏幕未显示的动作。

已反馈根代理/API代理，现GameApi.ts:263–280对所有外部对象一致不读取/不返回stance与isFiring；own/shared分支299、322仍保留实际字段。GameApiDisguiseObservation.test.ts:55–65将两字段纳入throwing getter/private字段集合，第91行新增Ready外观等价负向测试，同时验证own/shared实际状态保留。复审和focused通过。

stance同样不应泛称全部可见：infantry/sequenceMap.ts的findSequence按外观art可用序列回退到默认行走/Ready，不能直接把真实stance当公开姿态。此次保守统一省略，不只给SPY删除字段，避免字段存在性识别。

### 已知受限：新敌方辐射污染记忆暂不建立

squads/desolatorTactics.ts:71–77现已显式区分stance===undefined分支，仅在已知stance===Deployed时记录污染站点。新外部合同未提供stance，所有外部DESO因此不再建立新的污染记忆；已知旧site仍按原expires保留，own/shared真实展开继续工作。已作为实质覆盖损失反馈根代理与consumer代理。根代理明确选择在本正确性分项保留此限制：不从隐藏stance读取，也不把未知当实测展开；合法可见辐射场或可靠外观展开投影后续单独补。isSafeMove现已明确仅检查已记site，true并不保证地面没有辐射。下一项必须补可验证的可见展开/辐射场投影，或独立保守风险模型，并真实验证。不能对本次宣称敌方辐射避让覆盖完整。现有合成测试中手给敌方stance不等于真实新API仍提供该字段。

这不是要求本次新增潜在污染区策略：引入这样的策略会改变警戒与记忆时长，需要单项验证。发布评审应保持此限制显式可见。

## 其余重点检查

- 名单、enemy/hostile/neutral关系、filter、generic/unit直读均经同一当前appearance与可见性门；外部真实SPY和同外观E1共享字段集合；MGTK树与真实树的单位直读都undefined。self/shared库存使用真实权限，假友方色不授予控制权。
- 外部HP/最大HP、购买价、武器实例/冷却、工厂/集结点、矿载、乘员、订单idle、精确速度等一致不读；公共类型规则只在消费者中用显式estimated函数估算，没有塞回实际字段。未见新代码从隐藏runtime补估计值。
- veteranLevel不是另一个伪装私有泄漏：PipOverlay.ts:731–741/824–827直接渲染真实等级图标，未按伪装或外部owner屏蔽；Infantry.ts:168–176直接做升级闪光。维修扳手也在PipOverlay.ts:817–822无外部owner过滤，API保留有源码依据。
- 所有以外部单位作为攻击方的生产getCombatWeapon调用都传game。唯一不传game的squads/common.ts:55，调用方在combatSquad普通难度分支使用己方unit作为attacker，有真实武器；不是外部估计漏参。
- tacticalTargeting.ts:12–19在外部stance未知时保留两种名义武器候选，不推断站立；仍排除定向攻击不可用的areaFire。
- 未见外部HP未知直接判死的残留关键路径。威胁/目标排序采用名义strength或公开healthLevel；未知驻军数的可驻军目标不会被当空楼安全占领。
- own/shared的真实HP、武器/冷却、运输容量、维修/矿载及控制状态保留，相关方法测试通过。尚不能替代真实运输/维修fixture。
- rulesCache先读取当前合法外观名称后查公共规则，不用隐藏真名长期绑定ID。当前API无外观缓存，支持同tick变装/共享检测变化。

## 独立验证

执行四文件focused：GameApiDisguiseObservation、GameApiObservationBoundary、ObservedUnitConsumers、SpecialtyCombatMicro。65通过、0失败、396断言；代码前后SHA稳定。日志 independent-focused-tests.log，SHA256 42ef06310412d32864e7803f6fc2bc31ad5b2be9577ce6d39ae0833bd7032299。

随后消费者补显式unknown分支及两个回归测试，独立增量复跑ObservedUnitConsumers共12通过、0失败、61断言。测试确认未知姿态不伪造已发生污染，既有己方展开记忆在失去情报/消失后保持原到期时间；日志与两文件源码SHA见independent-radiation-limit-tests.json。

这是方法/消费者测试，不是实际原版单位流程或历史profile兼容对局。真实fixture由对应代理独立执行，完整策略强度仍未认证。

## 保留范围

MapApi、事件发生时快照、PlayerData敏感元数据和超级武器通道是已登记的后续边界；本次未要求一起重写，也不因此宣称完整公平。NAPSIS原版实际共享探测/供电范围由fixture代理继续验证。本文仅审查已列源码合同，不对未见资源对局给通过结论。
