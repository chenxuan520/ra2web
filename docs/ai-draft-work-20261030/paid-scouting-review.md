# L1 付费侦察：只读验收清单

2026-10-30。本文件只读审查现有生产、动作、揭雾、伤害/生产事件接口与本轮计划；没有修改仓库源码、Git、CI 或监控任务。新 runner 还在实现，以下不代表已经通过实验。

## 独立实验身份

- 两图 mp08t2/tn01t2 × open/intercepted × 两个物理出生/玩家槽方向 × S1/S2/R2 × 确定性重复2：预计48次运行、24个独立条件，不是48局胜率。
- 相同条件 S2/R2 必须 engine/runner/资源规则/seed/fixtures/公共候选/初始视野/真实生产政策相同，只改 sharedTarget 与 distinctLease；不可同时加退出、反狗、补兵、绕行或经济反应。
- S1 数量/成本参考，不是 S2 或 R2 的纯路线消融。共同简化控制器不叫完整当前Bot或C18。
- 预置相同正常设施、隐藏目标与防守要逐项明记；狗必须由正常队列付费出厂，无免费狗、现金补充或地形编辑。机制不回答MCV开局的工厂/矿车/坦克延迟。

## 成本与生产账目（当前源码实际机制）

`ProductionTrait.tickQueue` 在每次生产tick使 `currentItem.creditsSpent += spendAmount`、`player.credits -= spendAmount`，生产是分期扣款。`FactoryTrait.produceGroundUnitAt` 的 `FactoryProduceUnit` 事件早于 `item.creditsSpent = 0` 和 `queue.shift`，适合只读捕获本只的 `creditsEach/creditsSpent`。`UpdateQueueAction.Cancel` 从后移除数量，只有本类全部取消时才返 `existingItems[0].creditsSpent`；不要用数量×标价替代实际退款。设施失去前提的 `ProductionTrait.ensurePrerequisites` 也会退款，需来源区分。

必须保留：

1. 请求(action提交)、真实队列接受数量、每tick实际付款、工厂出厂ID/完成时付款、剩余在产付款和数量、取消/退款。
2. 若使用原 `Player.credits` descriptor 的透明委托包装，仅采样原 getter/setter，不能新增赋值、跳过原负余额验证或改变原事件顺序；读者必须能看到包装代码。
3. 每笔余额变化可结合实际生产queue及动作上下文标记来源；未知收入/花费保留unknown，不能把负数全叫狗花费。无采矿、销售、维修等固定场景可明确审计排除其他渠道。
4. 对每个正常场景：`initialCredits + allCredits - allDebits == finalCredits`。另核 `dogDebits - dogRefunds == completedDogCost + endingDogPaidInProgress`，禁止混用净现金差和出厂成本。
5. 截止在产场景应为已支付>0、出厂0、剩余在产>0；取消边界应有明确请求、被接受取消和真实退款。不能将未出厂的钱记成错误或免费生产。
6. 上游 Add quantity2 可以作为共同固定生产政策，但登记为“一次请求2、队列顺序出厂”；不得称两次请求或第二只出厂前策略自然选择。每臂实际受理量不能靠请求量推断。

## 合法输入与场景控制

- 控制器只接 Bot自己的 GameApi/MapApi合法视图、固定公共候选、己方单位和ProductionApi；裁判的真对象、hidden布局、损伤来源、可达性与矿车/工厂真坐标不得反馈。
- setup-only 先生成并登记精确坐标/公共方向/建筑/防守/初始shroud、资源SHA与上限；完成setup后从实际兵营出口验证路线可达，而非放建筑前从玩家start看能走。
- hidden目标置换反事实：同初始合法观察/公开候选，敌目标位置交换后直到首次合法信息差之前，生产/下令完全相同。只比较 tick0 一个命令不足。
- 至少一个公共空点；揭露空点是信息，不是发现敌基地。受阻场景中的防守起初应不可见，不能借其位置挑路线。
- “两方向通畅”要区分地图几何可达与实际狗走到；“防守生效”必须有真实武器发射/命中/损失，不仅预置了地堡就判拦截成功。
- 换边需保存玩家槽、country、物理start、兵营出口、公共候选与fixture角色对应，不只交换label。两图非镜面对称，不要求反射坐标完全相同，但同身份S2/R2必须完全相同。

## 路线、揭雾、损失遥测

- 每次分配/换目标/命令有tick、unitID、目标来源/坐标、当时合法可见单位；无目标/目标已探不凭两狗预算编目标。
- R2同tick有效租约互斥；死亡释放租约可以仍按同一候选序列回到pending，但不加入另一臂没有的放弃或补兵规则。
- 实际狗轨迹、出厂/离厂分开；Assignment不是到达，不要把工厂出口中途的命令当已正常离厂。
- 揭雾只读真实shroud变化，计相对初始已探集合的新增union。`MapShroud`的shroud坐标含高程映射，不把矩形buffer padding/不存在的地砖当有效地图面积。可选全有效地图tile坐标集合逐tick差，或只统计真实tile映射支持的shroud格，定义必须固定。
- `MapShroud.update` 汇总同tick多单位invalidations。缺少可靠来源时 perDogReveal=null，只报teamUnion；不要按调用先后任意将共享新格归一只狗。轨迹重叠不叫视野重复。
- 首见只通过Bot观察名单，第一次见建筑与第一次见出厂单位分开；不得直接用工厂真生产事件给策略/“玩家首次看到生产”评分。
- `InflictDamageEvent` 有 target、attacker、damageHP；`ObjectDestroyEvent` 有 attackerInfo/incidental，真实死亡与unspawn/易主/被运输分开。不能“不在己方列表”自动当死。
- 保留首次覆盖阈值的未发生/null；均值/中位数如只含成功者必须标明分母，失败臂不能被丢掉。
- 对手合法视图首次发现己方两个入口/生产出口有独立记录；预置无侦察对手导致未发生是覆盖边界，不是安全守家收益。

## 边界与验收建议

- 单未知目标：R2不能伪造第二方向，第二狗可等待或明确共同fallback，与登记一致。
- 全目标已探：无请求、无狗扣款（不能靠预置免费狗证明）。
- 无可生产前提：真实请求拒绝/不提交的设计写明，绝不免费补狗。
- 生产中截止、真实取消退款分别单独场景；不增加主路线样本n。
- 同配置重复所有非身份元数据应逐字节相同；身份应记录replicate但不得与指令、经济、轨迹数据相互影响。
- 不要求R2总优于S2：可能抱团过狗有利，完整保留未探/死亡/未能产完/运行错误。机制passed与覆盖改善、正常整局强度分别结论。
- 正式证据用冻结源码后重跑，精确commit/tree、runner与所有依赖/资源SHA、完整raw与紧凑报告/原始SHA索引分开。开发dirty结果不能伪装冻结。

## 待源码审查

后续检查 `e2e/ai-paid-scouting.ts` 的实际实现，特别是透明余额包装、队列事件完成时机、controller闭包可见信息、完整场景后路径验证和swap身份。此时没有读取不存在的新runner，也没有跑任何新实验。
