# 窄 DESO 素材/动画原型结果

本轮只在隔离 worktree `/workspace/scratch/visible-deso-prototype` 增加4个源码/测试文件；主工作树、GameApi、策略、物理、规则、RNG均未改，没有commit/push/CI。基于fc1b1c8，其源码仍为冻结0efe。该项不阻塞正在进行的L1付费侦察。

## 可review代码

- `ts-redalert2/e2e/lib/apparent-sprite-classifier.ts`：纯完整像素等价类分类器；输入只允许已取得的表观素材样本，完全不接受真实单位/stance/weapon/radiation。相同像素类若同时有非展开含义，则整个类unknown；所有可能帧都需唯一展开外观才正向。未知域/残缺图像/不完整catalog拒绝。
- `ts-redalert2/src/test/ai/ApparentSpriteClassifier.test.ts`：6通过、21断言。含真实身份/私有getter陷阱、同像素不同来源、过渡/未知混合、palette/remap域变化、结构不完整及调用次序/注册突变。
- `ts-redalert2/e2e/ai-visible-deso-prototype.ts`：真实素材哈希与实际Animation类的窄执行，33断言；不是完整renderer/游戏。独立tsconfig通过。

`node_modules`只是指向主工作区依赖的本地symlink，绝不可提交。此worktree所有改动目前untracked，避免误当已集成源码。

## 实际新证据

原版RA2.MIX→conquer.mix/deso.shp，189904B、SHA7f157a5089a3ec822ae73eb951993a410c8fabc0d1fa839ddb0eed255aabfcc4。644帧126×88，已与本地准备的CDN素材逐字节核对。全部原palette RGBA/索引/轮廓哈希，实际查看15帧contact，记录在 `/workspace/scratch/visible-deso-material/material.json`（412411B，SHA3f4433c617b5c841b5664dcc6fd85aa8611471eddaa574538fef49f18a1030aa）。素材/脚本/原始资源与SHA索引在该目录，不提交素材。

稳定298的原palette完整RGBA只与自身相等，窄素材正控制得到`deployed`；但298/过渡313/放射297的二值轮廓完全相同，因此粗轮廓模型对三者全部unknown。298与313仅差10个非透明像素，其中2个为remap色；这不能推广到任何调色/光照/遮挡仍唯一。298同时在Deployed与DeployedFire中使用，始终不能证明刚放射。Prone86与FireProne212不同index却同像素，原始SequenceType/index仍不能作为玩家读数。

用仓库真实Animation类、Infantry停播后切下一sequence的同一窄逻辑运行：底层动作固定展开、相同结束render time1100ms，10ms采样已到298；100ms采样仍是Deploy310；1000ms才首次显示则为Deploy300。3条trace全保留于 `prototype-report.json`（21017B，SHA2d77229104009ce49d75df7ccb13287d73f8efbedd5b6be217fd44cbcb5f7f5e）。这不是3局、没有游戏tick、没有GPU帧。它具体证明“模拟状态已Deployed且等待固定tick”不能直接推当前画面一定是稳定298。

## 交付边界与可执行后续

分类器是材料实验工具，**没有合法确定的当前可见样本生产端，故不接GameApi/敌污染记忆，也不宣称恢复展开观测**。没有必要继续做全颜色GPU研究来阻塞主策略。

若要快速取得一个可维护语义观察合同，下一独立单项可建立“公开步兵表现状态”作为renderer和AI共同消费的确定性表示：固定模拟tick推进clip相位，先按观察者的合法apparent art与伪装mask选择表现，过渡/稳定明确；renderer直接使用此表现而非另读同一unit的真实stance并以wall clock独立重选。AI只看这个实际被renderer使用的表现类，same appearance SPY与DESO同输出。此改动仅表现调度但会改变现有动画节奏，必须单独冻结/跨帧率回归；它不能偷偷加入本次L1，也不能由“展开表现”产生污染真值。若不选该范围，当前API继续unknown，风险保持明确。

无需用户批准。主线L1可立即独立继续；上述原型只提供具体可复查约束，不要求全部渲染系统重写。
