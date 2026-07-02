# CC Leader

给 Claude Code 用的多 agent workflow skill pack。

它做三件事：

1. 用 `cc` + `codex` 跑一套有 gate 的开发 workflow：spec -> plan -> task -> execute -> review -> report
2. 提供一个独立的 detached codex `drive` 模式：用户给任务，codex 静默持续做，只在少数里程碑事件上通知
3. 提供独立的 `ds-l` 闭环：DeepSeek 做 leader，Codex 做 worker，实现 -> 审核 -> 修复 -> 复审 -> 合回 main（见下文 "DS Leader (`ds-l`) 模式"）

## 这是什么

核心角色：

- `cc`：面向用户，做状态推进、用户沟通、gate 决策、最终报告
- `worker`：当前只支持 `codex-cli`，负责生成、执行、审查

核心约束：

- 关键阶段都要落盘为 artifact
- workflow 前进要过 review gate
- transport 真源是结果文件，不是 stdout/stderr
- workflow 状态由 `cc-leader` CLI 管理，不手改 `.cc-leader/session.json`

## 什么时候用什么

| 入口               | 用途                               | 适合场景                               |
| ------------------ | ---------------------------------- | -------------------------------------- |
| `/cc-leader-spec`  | 起草或续接 spec                    | 还没批准 spec，或要重写 spec           |
| `/cc-leader-run`   | 按 workflow gate 自动推进          | 需要完整 spec / review / report 链     |
| `/cc-leader-drive` | 启动 detached codex 做用户指定任务 | 不想走 workflow，只想让 codex 持续做事 |
| `ds-l`             | DeepSeek leader + Codex worker 闭环 | 单任务的实现、审核、修复、复审、合回交付 |

CLI 对应入口：

| 命令                      | 用途                                     |
| ------------------------- | ---------------------------------------- |
| `cc-leader init`          | 初始化 workflow state                    |
| `cc-leader state:get`     | 读取 workflow state                      |
| `cc-leader state:set`     | 写 workflow state                        |
| `cc-leader resolve-phase` | 推断当前 workflow phase                  |
| `cc-leader dispatch`      | 高级手动派发单个 worker job              |
| `cc-leader job:status`    | 查看 workflow active job 或指定 job 状态 |
| `cc-leader run`           | 自动推进 workflow                        |
| `cc-leader drive`         | 启动或接管 detached codex drive          |
| `cc-leader report`        | 手动生成最终报告                         |
| `cc-leader prepare-job`   | 只生成 prompt 和 run 目录，不实际执行    |

兼容性说明：

- `cc-leader work` 目前仍是 `drive` 的兼容别名
- 新文档和新使用方式都以 `drive` 为准

## 安装

```bash
git clone https://github.com/dualface/cc-leader.git
cd cc-leader
./scripts/install.sh
```

安装脚本会：

- 把 `skills/*` 复制到 `~/.claude/skills/cc-leader--<name>`
- 已有 skill 目录会覆盖同步
- 旧 symlink 会先清掉，再替换成真实目录
- 删除仓库里已不存在的过期 skill 目录
- 在 `~/.local/bin/cc-leader` 写 wrapper
- 在 `~/.local/bin/ds-l` 写 wrapper
- 运行 `npm run validate`

要求：

- `~/.local/bin` 在 `PATH` 里
- 本机能运行 `node`
- 本机已安装 `codex`
- 使用 `ds-l` 时还需导出 `DEEPSEEK_API_KEY`

卸载：

```bash
./scripts/uninstall.sh
```

升级：

```bash
./scripts/install.sh --update
```

`--update` 会：

- 先执行 `git pull`
- 重新同步全部 skill
- 替换旧 symlink
- 删除过期 skill
- 在 wrapper 内容变化时重写 wrapper

## 快速上手

### 1. 走完整 workflow

进入目标项目根目录, 并先建一个 worktree (避免 state 被覆盖, 见下文 "Worktree 与多 spec"):

```bash
cd <target-project>
git worktree add worktrees/<task-cluster> -b cc-leader/<task-cluster>
cd worktrees/<task-cluster>
```

在 Claude Code 里:

```text
/cc-leader-spec
```

spec 通过并批准后:

```text
/cc-leader-run
```

(`/cc-leader-spec` 内部会强制 worktree gate; 用户也可让 cc 用 EnterWorktree 自动切。手动 cd 是 CLI 直用的等价方式。)

如果只用 CLI, 最小流程是:

```bash
cd <target-project>
git worktree add worktrees/<task-cluster> -b cc-leader/<task-cluster>
cd worktrees/<task-cluster>
cc-leader init --slug <project-slug>
cc-leader state:set --set spec_path=docs/specs/<workflow-id>.md
cc-leader dispatch --job specAdversarialReview
cc-leader run --write-scope <allowed-write-path>
```

### 2. 直接驱动 detached codex

当你不想走 workflow，只想让 codex 持续干活：

```bash
cd <target-project>
cc-leader drive "实现 xxx；除非遇到真实 blocker，否则一直做下去"
```

如果 `cc` 自己断线、报错、额度耗尽，重新接管当前 drive：

```bash
cc-leader drive
```

## Workflow 模式

### Phase 顺序

| #   | Phase                     | 做什么                                    | Gate                   |
| --- | ------------------------- | ----------------------------------------- | ---------------------- |
| 1   | `drafting-specs`          | 和用户一起写 spec，worker 做对抗式 review | spec 批准              |
| 2   | `writing-phase-plans`     | 基于已批准 spec 写 phase plan list        | self review            |
| 3   | `writing-phase-tasks`     | 为每个 phase 写 task list                 | self review            |
| 4   | `executing-phase-tasks`   | 串行执行可运行 phase                      | 每 phase 完成后 review |
| 5   | `reviewing-phase-results` | phase review + final spec review          | 全部 pass 后报告       |
| 6   | `reporting-results`       | `cc` 汇总最终报告                         | 完成                   |

### Workflow 状态文件

默认状态文件:

- `.cc-leader/session.json` (相对于 `cc-leader` 命令的 CWD)

状态里重点字段:

- `workflow_id`
- `current_phase`
- `spec_path`
- `spec_review_passed`
- `spec_approved`
- `phase_plan_list_path`
- `phase_task_dir`
- `phase_result_dir`
- `phase_review_dir`
- `ready_phase_ids`
- `completed_phase_ids`
- `reviewed_phase_ids`
- `active_job_id`
- `last_result_file_path`

不要手改这个文件。只通过 `cc-leader` CLI 读写。

### Worktree 与多 spec

`cc-leader` 把 `.cc-leader/session.json` 写在**当前 CWD** 下 (`process.cwd()` 解析)。同一 CWD 同一时间只能跑一个 workflow; `cc-leader init` 第二次会要求 `--force`, 一旦 force 就**直接覆盖**前一个 workflow 的 state, 历史只剩 `.cc-leader/runs/<workflow-id>/` 里的 artifact。

所以多 spec 推进有两种模式:

1. **串行 (默认)**: 同一 worktree 内, 上一个 workflow `done` 后再 `cc-leader init --slug <new> --force` 起下一个
2. **并行**: 每个 spec 独占一个 git worktree, 路径约定 `worktrees/<task-cluster>/`, 每个 worktree 独立一份 `.cc-leader/session.json`, 互不污染
   - 启动: `git worktree add worktrees/<name> -b cc-leader/<name>`
   - 单个 cc session 的 CWD 单一, 并行需多开 cc session, 每个 session `cd` 进各自的 worktree (或用 `EnterWorktree path=worktrees/<name>`)
   - **必须** 给每个并行 workflow 划独立 `--write-scope` 路径, 否则 phaseExecution 会互相覆盖
   - 远端 PR 建议串行 merge, 避免冲突堆积

`/cc-leader-spec` 入口已强制 worktree gate: 不在 `worktrees/<name>` 下不会让你 `init`, 防误覆盖。直用 CLI 时请自行 `cd` 到目标 worktree。

把 `worktrees/` 加到 `.gitignore`, 避免 worktree 子目录意外被主仓提交。

### Workflow 运行目录

每个 worker job 的 transport 文件都在：

- `.cc-leader/runs/<workflow-id>/<job-id>/`

固定文件：

- `prompt.md`
- `stdout.jsonl`
- `stderr.log`
- `result.json`
- `job.json`

`job.json` 用于恢复/续跑。
真正状态真源仍然是 `result.json` + 业务 artifact。

### `run` 的行为

`cc-leader run --write-scope <path>` 会：

- 自动判断当前 phase
- 选下一个 worker job
- 在 detached runner 里执行 `codex exec`
- worker 退出后读 `result.json`
- 更新 workflow state
- 循环直到完成或必须用户介入

`run` 会停下来的典型情况：

- spec 还没批准
- `phaseExecution` 缺 `--write-scope`
- worker blocked
- 需要用户决策
- transport 失败且无法自动恢复

### `job:status` 的用途

`job:status` 只看 workflow job，不看 `drive`。

```bash
cc-leader job:status
cc-leader job:status --job-id <job-id>
```

它会报告：

- active job / 指定 job 是谁
- detached runner / worker 是否还活着
- `result.json` 是否已就绪
- `stdout` / `stderr` / `job.json` 路径和文件状态
- 必要时的 artifact recovery 候选信息

### Workflow 恢复

如果 `cc` 中途挂了，不要手动清状态。

恢复路径：

1. 再执行 `cc-leader run --write-scope <path>`
2. harness 会先检查 `active_job_id`
3. 如果后台 worker 还活着，就接管等待
4. 如果 worker 已退出，就读取 `result.json`
5. 如果 `result.json` 丢了但 artifact 足够，会尝试 artifact recovery

## Drive 模式

### `drive` 的语义

`drive` 独立于 workflow。

它不管：

- phase
- review gate
- spec approval
- 最终报告

它只做：

- 用用户给的 prompt 启动 detached codex
- 在 codex 只是停下来问“是否继续”时自动 `resume`
- 静默等待下一个里程碑事件

### `drive` 只看 4 类里程碑

| 事件         | `milestone.type` | 意义                                         |
| ------------ | ---------------- | -------------------------------------------- |
| PR merge     | `pr_merged`      | codex 报告 PR 已合并                         |
| CI 失败      | `ci_failed`      | codex 报告 CI / checks / pipeline 失败       |
| 需要用户介入 | `needs_user`     | 真的需要用户提供输入、做决策、或处理 blocker |
| drive 结束   | `drive_finished` | drive 已经结束                               |

非里程碑进展：

- 不通知用户
- 不把 stdout/stderr 转发给 `cc`
- 尽量减少 `cc` token 消耗

### `drive` 返回什么

```bash
cc-leader drive "你的任务"
```

这个命令会静默跑到下一个里程碑再返回 JSON。

重点字段：

- `drive_id`
- `active`
- `stop_reason`
- `milestone.seq`
- `milestone.type`
- `milestone.summary`
- `auto_continue_count`
- `thread_id`
- `stdout_log`
- `stderr_log`

语义：

- `active == true`：drive 还在继续跑，只是出现了一个里程碑
- `active == false`：drive 已结束

### `drive` 状态文件和目录

默认 drive 状态文件：

- `.cc-leader/drive-state.json`

默认 drive 运行目录：

- `.cc-leader/drives/<drive-id>/`

固定文件：

- `prompt.md`
- `stdout.jsonl`
- `stderr.log`
- `drive.json`
- `last-message.txt`
- `attempt-last-message.txt`

`drive.json` 里会记录：

- `drive_id`
- `thread_id`
- 当前 attempt
- 自动 continue 次数
- 最近里程碑
- 进程 pid
- 停止原因

### `drive` 的恢复与接管

不带 prompt 执行：

```bash
cc-leader drive
```

语义：

- 如果当前有 active drive：继续静默等下一个里程碑
- 如果 active 已结束但最近一次 drive 还有未通知里程碑：把那个里程碑取回来
- 如果既没有 active drive，也没有最近 drive：报错

### `drive` 的自动 continue 规则

如果 codex 最后消息只是“是否继续”类提示：

- driver 自动执行 `codex exec resume`
- 不通知用户

如果最后消息看起来像真实 blocker / 真实缺输入 / 真实业务决策：

- 归类为 `needs_user`
- 把控制权交还用户

可调参数：

```bash
cc-leader drive \
  --timeout-seconds 1800 \
  --max-auto-continue 50 \
  --continue-prompt "继续工作。除非真实 blocker，否则不要停下来问我是否继续。" \
  "你的任务"
```

## `run` 和 `drive` 的区别

| 维度               | `run`                     | `drive`                       |
| ------------------ | ------------------------- | ----------------------------- |
| 目标               | 推 workflow               | 跑用户指定任务                |
| 是否依赖 spec/gate | 是                        | 否                            |
| 状态文件           | `.cc-leader/session.json` | `.cc-leader/drive-state.json` |
| 恢复入口           | `cc-leader run`           | `cc-leader drive`             |
| 监控对象           | worker job                | detached codex session        |
| 用户通知           | 每次 `run` 停点           | 只有 4 类里程碑               |
| 推荐用途           | 正式开发流程              | 独立长任务、少打断执行        |

## DS Leader (`ds-l`) 模式

`ds-l` 是独立于上述 workflow 的第三个入口：DeepSeek 做 leader（生成 spec / plan / task / report 文档），Codex 做 worker（实现与修复），`gpt-5.5` 做独立审核。适合单任务的"实现 -> 审核 -> 修复 -> 复审 -> 合回"闭环交付。

### 前置要求

- 已导出 `DEEPSEEK_API_KEY`（模型默认 `deepseek-v4-pro`，可用 `DEEPSEEK_MODEL` 覆盖）
- `cc-leader` wrapper 已安装（`ds-l run` / `ds-l fix` 内部调用 `cc-leader drive`）
- 本机已安装 `codex`（审核子代理固定使用 `gpt-5.5` / `xhigh`）
- `run` / `fix` / `close` / `merge` 必须在独立任务 worktree 分支运行，禁止直接在 main 上运行

### 命令面

| 命令                                  | 用途                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ds-l spec "需求"`                    | DeepSeek 生成 `spec.md` + `acceptance.md`                                                   |
| `ds-l plan`                           | 基于 spec 生成 `plan.md`                                                                    |
| `ds-l task`                           | 生成 `task.md` + `worker.prompt.md`                                                         |
| `ds-l run [--bugfix]`                 | 记录 git base，`cc-leader drive` 驱动 Codex 实现、最小验证并提交；结束时 worktree 必须干净  |
| `ds-l close [--force-review] [--bugfix]` | fetch 后 `rebase --onto origin/main <base>` 仅重放任务提交，然后自动审核/修复/复审直到通过 |
| `ds-l review`                         | 显式独立审核 `review_base..HEAD`；显式调用不适用小改动跳过规则                              |
| `ds-l fix`                            | 仅 verdict 为 `needs_fix` 时，裁决 findings，修复成立的 blocker/high/medium，验证并提交     |
| `ds-l report`                         | 汇总 latest 产物、review、worker 输出与当前工作区事实，DeepSeek 生成最终报告                |
| `ds-l merge --verified`               | 用户确认验证后，把已通过最终审核的 HEAD ff-only 合回 main 并 push                           |

兼容快捷方式：`ds-l -p "需求"`（spec + plan + task 预览，不 run）、`ds-l -u`（用 latest worker prompt 执行）、`ds-l -s`（查看状态与下一步建议）。

### 闭环规则

- 实现、最小验证、提交完成后才能进入审核；`run` 结束时必须有任务提交且 worktree 干净
- 审核范围固定为记录的 git base..HEAD；base 必须是 HEAD 的祖先
- 审核固定 `gpt-5.5` / `xhigh`，read-only 独立子代理，只基于 git range 事实输出 JSON findings
- 小改动跳过规则（单文件、非二进制、改动 ≤ 10 行）只在非显式审核且第 0 轮时生效；显式审核（`ds-l review`、`--force-review`、需求文本本身要求审核）不可跳过
- 成立的 blocker / high / medium 必须修复、验证、提交并复审；low 不阻塞；全部误报时 worker 必须输出固定裁决行才允许零改动通过
- 修复与复审最多 5 轮，超过后停下来交人工处理
- `close` 每轮都先 fetch，用 `rebase --onto` 仅重放任务提交；origin/main 变化会使旧审核失效并强制复审
- 最终审核通过后进入 `awaiting_user_validation`，由用户验证后运行 `ds-l merge --verified`
- main 只允许 ff-only 合回并 push；merge 前若 origin/main 又发生变化，回到 `ds-l close` 复审

### 状态与产物

全部在 `.cc-leader/ds-leader/latest/` 下：

- `spec.md`、`plan.md`、`task.md`、`acceptance.md`、`worker.prompt.md`
- `review.md`、`report.md`、`fix.prompt.md`
- `state.json`（由 `ds-l` 自管，不要手改）
- `codex/`（drive summary 与各轮 review 输出）、`logs/`（DeepSeek 各阶段响应）、`debug/`（原始响应排查）

## 外部依赖风险策略

第三方 API / 外部服务 / 网络依赖问题单独归入 `external_dependency_risks`：

- 不触发 spec revise
- 不触发 phase fail
- 不触发 blocked
- 会在 spec -> review -> result -> final report 全链路记录

这条规则只针对 workflow 模式。
`drive` 模式不做这类 workflow 级别归档。

## 目录约定

默认 artifact 目录：

| Artifact          | 默认路径                   |
| ----------------- | -------------------------- |
| spec              | `docs/specs/`              |
| spec review       | `docs/reviews/specs/`      |
| override log      | `docs/reviews/overrides/`  |
| phase plan list   | `docs/plans/`              |
| phase task list   | `docs/tasks/`              |
| phase result      | `docs/results/`            |
| phase review      | `docs/reviews/phases/`     |
| final spec review | `docs/reviews/spec-final/` |
| final report      | `docs/reports/`            |

这些目录不要求预先存在，harness 会在写入时创建。

## 重要文件

| 类别               | 文件                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| manifest           | [cc-leader.manifest.json](cc-leader.manifest.json)                                                                                         |
| bootstrap skill    | [skills/using-cc-leader/SKILL.md](skills/using-cc-leader/SKILL.md)                                                                         |
| 用户入口 skill     | [skills/spec/SKILL.md](skills/spec/SKILL.md) · [skills/run/SKILL.md](skills/run/SKILL.md) · [skills/drive/SKILL.md](skills/drive/SKILL.md) |
| harness            | [scripts/cc-leader-harness.mjs](scripts/cc-leader-harness.mjs)                                                                             |
| ds-l 调度器        | [scripts/ds-leader.mjs](scripts/ds-leader.mjs)                                                                                             |
| 安装脚本           | [scripts/install.sh](scripts/install.sh)                                                                                                   |
| 卸载脚本           | [scripts/uninstall.sh](scripts/uninstall.sh)                                                                                               |
| 校验脚本           | [scripts/validate-skill-pack.mjs](scripts/validate-skill-pack.mjs)                                                                         |
| smoke 样例         | [scripts/smoke-run.mjs](scripts/smoke-run.mjs)                                                                                             |
| 状态机             | [docs/state-machine.md](docs/state-machine.md)                                                                                             |
| transport 合同     | [docs/transport-contract.md](docs/transport-contract.md)                                                                                   |
| runtime 合同       | [docs/runtime-contract.md](docs/runtime-contract.md)                                                                                       |
| worker prompt 合同 | [docs/worker-prompt-contracts.md](docs/worker-prompt-contracts.md)                                                                         |
| harness 样例       | [docs/harness-example.md](docs/harness-example.md)                                                                                         |
| artifact 样例      | [docs/examples/minimal-todo/](docs/examples/minimal-todo/)                                                                                 |

## 开发与校验

本仓库常用命令：

```bash
npm run validate
npm run harness -- help
npm run smoke
```

校验脚本会检查：

- manifest / package.json 一致性
- 所有 skill 和 prompt 文件存在
- worker result 模板字段齐全
- examples 链完整
- `.gitignore` 覆盖 `.cc-leader/`

## 当前范围

已实现：

- 完整 workflow skill pack 骨架
- `codex-cli` worker runtime
- detached runner + workflow job 恢复
- `job:status`
- detached codex `drive`
- drive 里程碑监控与自动 continue
- `ds-l`：DeepSeek leader 的实现、审核、修复、复审、合回闭环
- 安装、卸载、校验、自带最小 smoke

未实现：

- 生产级调度服务
- 多 worker 并行调度服务端
- 除 `codex-cli` 之外的 worker runtime
- 自动 merge / worktree 管理系统
