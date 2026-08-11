# RAI 协作规则 — 所有 AI agent(Codex / opencode / Claude / Hermes)与人类开发者必须遵守

## 分支与部署映射
| 分支  | 用途 | 服务器部署目录 | systemd 服务 |
|-------|------|----------------|--------------|
| main  | 生产 | /opt/rai/apps/formal | rai.service |
| beta  | 预演 | /opt/rai/apps/beta | rai-beta.service |
| feature/* | 任务分支 | — | — |

## 铁律(违反 = 破坏协作,禁止)
1. **禁止直接推送或修改 main / beta。** 所有改动必须在 feature 分支上完成,通过 PR 合并,由人类 review。
2. **禁止提交任何密钥、.env、*.db*、node_modules、uploads/、avatars/。**(已由 .gitignore 拦截,提交前用 `git status` 确认无遗漏)
3. **一台机器同一时刻只允许一个 agent 修改同一工作目录。** 需要并行时,不同机器/不同克隆各自开分支。
4. **Hermes agent 只允许在 /opt/rai/work/hermes 工作。** 严禁直接编辑 /opt/rai/apps/ 下的部署目录。
5. **部署只能通过服务器上的 /opt/rai/deploy.sh 执行。** 严禁手动向部署目录拷贝文件。

## 工作流程
1. 开始任务:`git fetch origin && git checkout -b feature/<简短描述> origin/main`(涉及预演的从 origin/beta 开)
2. 修改代码,提交:`git add <具体文件>` + `git commit -m "type(scope): 描述"`(type: feat|fix|refactor|docs|chore|security)
3. 推送并开 PR:`git push -u origin feature/<简短描述>`,PR 描述写清楚改了什么、为什么、影响范围。
4. 等人类 review 合并。agent 不自行 merge,不碰服务器部署。

## 提交前验证(必须)
- `npm run check` —— 全量语法检查,必须通过。
- 改动涉及的功能对应回归:`npm run test:xxx`(如 test:file-edit、test:conversation-integrity)。
- 不要为通过检查而删改无关代码;如果现有检查本来就失败,单独说明,不要顺手"修"无关内容。

## 冲突处理
- 拉取或合并遇到冲突时:**禁止 `--force` 推送**、禁止丢弃他人提交。
- 冲突必须人工确认后解决;解决后在 PR/提交说明里写明选择了哪一侧及原因。

## 大文件注意
- `server.js` 是单文件 monolith,多人同时改同一区域必然冲突。改动尽量局部化;需要动大段时先在 PR 讨论或群里打招呼。

## 上线(人类操作)
- 合并 main 后:`ssh root@服务器 /opt/rai/deploy.sh formal`
- 合并 beta 后:`/opt/rai/deploy.sh beta`
- 部署脚本自动:git 同步 → 按需 npm install → 重启服务 → 打印当前版本。
