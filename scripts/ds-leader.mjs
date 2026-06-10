#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const root = process.cwd();
const dsRoot = path.join(root, ".cc-leader", "ds-leader");
const latestDir = path.join(dsRoot, "latest");
const logsDir = path.join(latestDir, "logs");
const codexDir = path.join(latestDir, "codex");
const latestPaths = {
  spec: path.join(latestDir, "spec.md"),
  plan: path.join(latestDir, "plan.md"),
  task: path.join(latestDir, "task.md"),
  acceptance: path.join(latestDir, "acceptance.md"),
  workerPrompt: path.join(latestDir, "worker.prompt.md"),
  review: path.join(latestDir, "review.md"),
  report: path.join(latestDir, "report.md"),
  state: path.join(latestDir, "state.json"),
  driveSummary: path.join(codexDir, "drive-summary.json"),
  driveStdout: path.join(codexDir, "stdout.jsonl"),
  driveStderr: path.join(codexDir, "stderr.log"),
};

const legacyLatestJson = path.join(dsRoot, "latest.json");
const legacyLatestPrompt = path.join(dsRoot, "latest.prompt.md");
const commandNames = new Set(["spec", "plan", "task", "run", "review", "report"]);

const help = rawArgs.includes("-h") || rawArgs.includes("--help");
const previewOnly =
  rawArgs.includes("-p") ||
  rawArgs.includes("--plan") ||
  rawArgs.includes("--print-only");
const useLast =
  rawArgs.includes("-u") ||
  rawArgs.includes("--use-last") ||
  rawArgs.includes("--run-last");
const showLast =
  rawArgs.includes("-s") ||
  rawArgs.includes("--show-last") ||
  rawArgs.includes("--last");

const cleanArgs = rawArgs.filter(
  (arg) =>
    ![
      "-h",
      "--help",
      "-p",
      "--plan",
      "--print-only",
      "-u",
      "--use-last",
      "--run-last",
      "-s",
      "--show-last",
      "--last",
    ].includes(arg),
);

const maybeCommand = cleanArgs[0] ?? null;
const command = commandNames.has(maybeCommand) ? maybeCommand : null;
const commandText = command ? cleanArgs.slice(1).join(" ").trim() : cleanArgs.join(" ").trim();

function printHelp() {
  console.log(`
ds-l：DS Leader + Codex Worker 调度器

Phase 1 workflow 命令：

  ds-l spec "需求"
    调 DeepSeek 生成 .cc-leader/ds-leader/latest/spec.md 和 acceptance.md，不启动 Codex。

  ds-l plan
    读取 latest/spec.md + acceptance.md，调 DeepSeek 生成 latest/plan.md。

  ds-l task
    读取 latest/spec.md + plan.md + acceptance.md，调 DeepSeek 生成 latest/task.md 和 worker.prompt.md。

  ds-l run
    读取 latest/worker.prompt.md，调用 cc-leader drive 执行，不重新生成计划。

  ds-l review
    读取 latest 产物、Codex Worker 输出、git status/diff，调 DeepSeek 判断执行是否通过。

  ds-l report
    读取 latest 产物、review、Codex Worker 输出、git status/diff，调 DeepSeek 生成最终报告。

兼容快捷方式：

  ds-l -p "需求"
    等价于 spec + plan + task，只预览，不 run。

  ds-l -u
    读取 latest/worker.prompt.md，调用 cc-leader drive 执行。

  ds-l -s
    查看 latest 状态和下一步建议。

旧式兼容：

  ds-l "新的明确需求"
    等价于 spec + plan + task + run。

快捷别名建议：

  ds-p "需求"    等价于 ds-l -p "需求"
`);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function ensureLatestDirs() {
  ensureDir(latestDir);
  ensureDir(logsDir);
  ensureDir(codexDir);
}

function repoRel(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function nowIso() {
  return new Date().toISOString();
}

function createWorkflowId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase();
  return `ds-${stamp}-${randomBytes(2).toString("hex")}`;
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function readRequiredText(filePath, label, nextCommand) {
  if (!existsSync(filePath)) {
    fail(`${label} 不存在: ${repoRel(filePath)}\n请先运行: ${nextCommand}`);
  }
  const text = readText(filePath).trim();
  if (!text || text.includes("_pending:")) {
    fail(`${label} 还未生成有效内容: ${repoRel(filePath)}\n请先运行: ${nextCommand}`);
  }
  return text;
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${String(content).replace(/\s+$/, "")}\n`, "utf8");
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readText(filePath));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function artifactPaths() {
  return {
    root: repoRel(latestDir),
    spec: repoRel(latestPaths.spec),
    plan: repoRel(latestPaths.plan),
    task: repoRel(latestPaths.task),
    acceptance: repoRel(latestPaths.acceptance),
    worker_prompt: repoRel(latestPaths.workerPrompt),
    review: repoRel(latestPaths.review),
    report: repoRel(latestPaths.report),
    state: repoRel(latestPaths.state),
  };
}

function baseState(originalRequest, title) {
  const createdAt = nowIso();
  return {
    schema_version: 1,
    workflow_id: createWorkflowId(),
    created_at: createdAt,
    updated_at: createdAt,
    phase: "spec",
    status: "active",
    original_request: originalRequest,
    title: title || "DS workflow",
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
    paths: artifactPaths(),
    drive: {
      drive_id: null,
      thread_id: null,
      status: null,
      stop_reason: null,
      summary_file: repoRel(latestPaths.driveSummary),
      last_message_file: null,
      stdout_log: null,
      stderr_log: null,
    },
    review: {
      verdict: null,
      summary: null,
      needs: [],
      fix_iteration: 0,
    },
    limits: {
      max_fix_iterations: 2,
    },
    latest_error: null,
    next_recommended_command: "ds-l plan",
  };
}

function readState() {
  return readJsonIfExists(latestPaths.state);
}

function saveState(state, patch = {}) {
  const next = {
    ...state,
    ...patch,
    paths: artifactPaths(),
    updated_at: nowIso(),
  };
  writeJson(latestPaths.state, next);
  return next;
}

function suggestNext(state) {
  if (!state) return 'ds-l spec "需求"';
  if (state.next_recommended_command) return state.next_recommended_command;
  if (state.phase === "spec") return "ds-l plan";
  if (state.phase === "plan") return "ds-l task";
  if (state.phase === "task") return "ds-l run";
  if (state.phase === "running") return "ds-l -s";
  if (state.phase === "run") return "ds-l review";
  if (state.phase === "review") {
    if (state.review?.verdict === "pass") return "ds-l report";
    if (state.review?.verdict === "needs_fix") return "Review found needs_fix; automatic fix is not implemented";
    if (state.review?.verdict === "needs_user_decision") return "Review needs user decision";
  }
  if (state.phase === "report") return state.next_recommended_command || "ds-l -s";
  return "ds-l -s";
}

function shell(cmd) {
  const result = spawnSync("bash", ["-lc", cmd], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function projectInfo() {
  return shell(`
pwd
echo "---- git status ----"
git status --short 2>/dev/null || true
echo "---- files ----"
git ls-files 2>/dev/null | sed -n '1,220p' || find . -maxdepth 3 -type f | sed -n '1,220p'
`).stdout;
}

function deepSeekConfig() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    fail("Missing DEEPSEEK_API_KEY. Run:\n  export DEEPSEEK_API_KEY='your_key'");
  }
  return {
    apiKey,
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
  };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek did not return JSON.");
    return JSON.parse(match[0]);
  }
}

async function callDeepSeekJson(stage, systemPrompt, userPrompt) {
  const { apiKey, model } = deepSeekConfig();
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: false,
  };

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek API failed: HTTP ${res.status}\n${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`No content in DeepSeek response:\n${JSON.stringify(data, null, 2)}`);
  }
  const parsed = parseJsonLoose(content);
  ensureLatestDirs();
  writeJson(path.join(logsDir, `deepseek-${stage}.json`), {
    stage,
    created_at: nowIso(),
    model,
    raw_content: content,
    parsed,
  });
  return parsed;
}

const baseSystemPrompt = `
你是 DS Leader，不是代码执行者。

职责边界：
- 你只负责生成 spec / plan / task / report 类文档。
- Codex Worker 只负责 execute。
- 不要让 Codex 自己 review 自己并自动循环修复。
- 不要输出 Markdown 包裹块；只输出一个 JSON object。
- 如果输入不足以安全推进，在对应 markdown 中明确写出需要用户决策的点。
`;

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`DeepSeek JSON 缺少字符串字段: ${field}`);
  }
  return value.trim();
}

function pendingMarkdown(title, nextCommand) {
  return `# ${title}

_pending: run \`${nextCommand}\`_
`;
}

async function commandSpec(request) {
  if (!request) fail('ds-l spec 需要需求文本，例如: ds-l spec "实现登录页"');
  ensureLatestDirs();

  const parsed = await callDeepSeekJson(
    "spec",
    `${baseSystemPrompt}

当前阶段：spec。
输出 JSON schema:
{
  "title": "简短任务标题",
  "spec_md": "完整 Markdown spec",
  "acceptance_md": "完整 Markdown acceptance criteria"
}
`,
    `当前项目状态：

${projectInfo()}

用户原始需求：

${request}

请生成 DS workflow v1 的 spec 和 acceptance。要求：
1. spec_md 包含目标、非目标、约束、修改范围、风险、开放问题。
2. acceptance_md 使用可观察的验收标准。
3. 不启动 Codex，不写实现细节到需要 worker 猜测的程度。
`,
  );

  const title = requireString(parsed.title, "title");
  const specMd = requireString(parsed.spec_md, "spec_md");
  const acceptanceMd = requireString(parsed.acceptance_md, "acceptance_md");
  const state = baseState(request, title);

  writeText(latestPaths.spec, specMd);
  writeText(latestPaths.acceptance, acceptanceMd);
  writeText(latestPaths.plan, pendingMarkdown("DS Plan", "ds-l plan"));
  writeText(latestPaths.task, pendingMarkdown("DS Task", "ds-l task"));
  writeText(latestPaths.workerPrompt, pendingMarkdown("Worker Prompt", "ds-l task"));
  saveState(state);

  console.log("\n=== DS Spec ===");
  console.log(`Title: ${title}`);
  console.log(`Spec: ${repoRel(latestPaths.spec)}`);
  console.log(`Acceptance: ${repoRel(latestPaths.acceptance)}`);
  console.log("Next: ds-l plan\n");
  return readState();
}

async function commandPlan() {
  const state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');
  const spec = readRequiredText(latestPaths.spec, "spec.md", 'ds-l spec "需求"');
  const acceptance = readRequiredText(latestPaths.acceptance, "acceptance.md", 'ds-l spec "需求"');

  const parsed = await callDeepSeekJson(
    "plan",
    `${baseSystemPrompt}

当前阶段：plan。
输出 JSON schema:
{
  "plan_md": "完整 Markdown plan"
}
`,
    `用户原始需求：

${state.original_request || "(unknown)"}

spec.md:

${spec}

acceptance.md:

${acceptance}

当前项目状态：

${projectInfo()}

请生成 DS workflow v1 的 plan。要求：
1. plan_md 包含执行策略、步骤、预计修改文件、验证方式、不做事项。
2. 计划必须约束 scope，避免过度实现。
3. 不生成 worker prompt，那是 task 阶段职责。
`,
  );

  const planMd = requireString(parsed.plan_md, "plan_md");
  writeText(latestPaths.plan, planMd);
  saveState(state, {
    phase: "plan",
    status: "active",
    latest_error: null,
    next_recommended_command: "ds-l task",
  });

  console.log("\n=== DS Plan ===");
  console.log(`Plan: ${repoRel(latestPaths.plan)}`);
  console.log("Next: ds-l task\n");
  return readState();
}

function buildWorkerPrompt({ state, spec, plan, acceptance, taskMd, dsWorkerPrompt }) {
  return `
你是 Codex Worker，只负责 execute，不负责最终 review。

【用户原始需求】
${state.original_request || "(unknown)"}

【DS Spec】
${spec}

【DS Plan】
${plan}

【DS Task】
${taskMd}

【Acceptance Criteria】
${acceptance}

【DS Leader 给你的执行提示】
${dsWorkerPrompt}

【强制执行规则】
1. 先阅读当前项目结构和必要文件。
2. 任务足够明确时直接执行，不要要求用户重复需求。
3. 只修改完成 DS Task 所必需的文件。
4. 不要扩大 scope，不要做无关重构。
5. 完成后运行必要验证命令；无法运行时说明原因。
6. 你可以做一次实现自检，但只检查是否符合 DS Task 和是否有真实 bug。
7. 禁止自己 review 自己并自动循环修复。
8. 禁止完成后继续提出并执行下一轮改动。
9. 遇到真实 blocker 时停止并说明 blocker。
10. 最终输出：
   - 修改了哪些文件
   - 如何运行
   - 验证结果
   - 是否还有必须由用户确认的问题
`;
}

async function commandTask() {
  const state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');
  const spec = readRequiredText(latestPaths.spec, "spec.md", 'ds-l spec "需求"');
  const plan = readRequiredText(latestPaths.plan, "plan.md", "ds-l plan");
  const acceptance = readRequiredText(latestPaths.acceptance, "acceptance.md", 'ds-l spec "需求"');

  const parsed = await callDeepSeekJson(
    "task",
    `${baseSystemPrompt}

当前阶段：task。
输出 JSON schema:
{
  "task_md": "完整 Markdown task",
  "worker_prompt_md": "给 Codex Worker 的执行提示，不含最终 review 或自动循环修复要求"
}
`,
    `用户原始需求：

${state.original_request || "(unknown)"}

spec.md:

${spec}

plan.md:

${plan}

acceptance.md:

${acceptance}

请生成 DS workflow v1 的 task 和 worker prompt。要求：
1. task_md 包含 Worker Objective、Ordered Tasks、Allowed Scope、Verification Commands、Completion Criteria。
2. worker_prompt_md 只要求 Codex execute。
3. 明确禁止 Codex 自己 review 自己并自动循环修复。
4. 完成后停止，输出总结。
`,
  );

  const taskMd = requireString(parsed.task_md, "task_md");
  const dsWorkerPrompt = requireString(parsed.worker_prompt_md, "worker_prompt_md");
  const workerPrompt = buildWorkerPrompt({
    state,
    spec,
    plan,
    acceptance,
    taskMd,
    dsWorkerPrompt,
  });

  writeText(latestPaths.task, taskMd);
  writeText(latestPaths.workerPrompt, workerPrompt);
  saveState(state, {
    phase: "task",
    status: "active",
    latest_error: null,
    next_recommended_command: "ds-l run",
  });

  console.log("\n=== DS Task ===");
  console.log(`Task: ${repoRel(latestPaths.task)}`);
  console.log(`Worker prompt: ${repoRel(latestPaths.workerPrompt)}`);
  console.log("Next: ds-l run\n");
  return readState();
}

function loadLegacyLatestPlan() {
  if (!existsSync(legacyLatestJson)) return null;
  const data = JSON.parse(readText(legacyLatestJson));
  const prompt = data.worker_prompt_final || data.worker_prompt;
  if (!prompt && existsSync(legacyLatestPrompt)) {
    data.worker_prompt_final = readText(legacyLatestPrompt);
  }
  return data;
}

function loadLatestWorkerPrompt() {
  if (existsSync(latestPaths.workerPrompt)) {
    const prompt = readText(latestPaths.workerPrompt).trim();
    if (prompt && !prompt.includes("_pending:")) return prompt;
  }

  const legacy = loadLegacyLatestPlan();
  const legacyPrompt = legacy?.worker_prompt_final || legacy?.worker_prompt;
  if (legacyPrompt) return legacyPrompt;

  fail('没有可执行的 latest worker prompt。请先运行: ds-l -p "需求" 或 ds-l task');
}

function parseDriveSummary(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    try {
      return parseJsonLoose(stdout);
    } catch {
      return null;
    }
  }
}

function resolveRepoPath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}

function readRequiredStateFile(filePath, label) {
  const resolved = resolveRepoPath(filePath);
  if (!resolved || !existsSync(resolved)) {
    fail(`${label} 不存在: ${filePath || "(missing)"}\n请先运行: ds-l run`);
  }
  return readText(resolved);
}

function commandOutput(cmd, label) {
  const result = shell(cmd);
  if (result.code !== 0) {
    return `${label} failed with exit ${result.code}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`;
  }
  return result.stdout || "(empty)";
}

function commandRun() {
  const workerPrompt = loadLatestWorkerPrompt();
  ensureLatestDirs();
  const state = readState();
  if (state) {
    saveState(state, {
      phase: "running",
      status: "active",
      latest_error: null,
      next_recommended_command: "ds-l -s",
    });
  }

  console.log("\nStarting cc-leader drive with latest Codex worker prompt...\n");
  const result = spawnSync("cc-leader", ["drive", workerPrompt], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
    env: process.env,
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  writeText(latestPaths.driveStdout, stdout);
  writeText(latestPaths.driveStderr, stderr);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const summary = parseDriveSummary(stdout);
  if (summary) {
    writeJson(latestPaths.driveSummary, summary);
  } else {
    writeJson(latestPaths.driveSummary, {
      raw_stdout: stdout,
      raw_stderr: stderr,
      exit_code: result.status ?? 1,
      error: result.error?.message ?? null,
    });
  }

  const latestState = readState();
  if (latestState) {
    const failed = Boolean(result.error) || (result.status ?? 1) !== 0;
    saveState(latestState, {
      phase: failed ? "blocked" : summary?.active ? "running" : "run",
      status: failed ? "blocked" : "active",
      latest_error: failed ? result.error?.message || `cc-leader drive exited ${result.status}` : null,
      drive: {
        ...latestState.drive,
        drive_id: summary?.drive_id ?? latestState.drive?.drive_id ?? null,
        thread_id: summary?.thread_id ?? latestState.drive?.thread_id ?? null,
        status: summary?.status ?? null,
        stop_reason: summary?.stop_reason ?? null,
        summary_file: repoRel(latestPaths.driveSummary),
        last_message_file: summary?.last_message_file ?? null,
        stdout_log: summary?.stdout_log ?? repoRel(latestPaths.driveStdout),
        stderr_log: summary?.stderr_log ?? repoRel(latestPaths.driveStderr),
      },
      next_recommended_command: failed
        ? "ds-l -s"
        : "ds-l review",
    });
  }

  if (result.error) {
    fail(result.error.message);
  }
  process.exit(result.status ?? 0);
}

function requireVerdict(value) {
  const verdict = requireString(value, "verdict");
  const allowed = new Set(["pass", "needs_fix", "needs_user_decision"]);
  if (!allowed.has(verdict)) {
    throw new Error(`DeepSeek JSON verdict 非法: ${verdict}`);
  }
  return verdict;
}

function normalizeNeeds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("DeepSeek JSON 字段 needs 必须是数组。");
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function fallbackReviewMarkdown({ verdict, summary, needs }) {
  const needsMd = needs.length ? needs.map((item) => `- ${item}`).join("\n") : "- None";
  return `# DS Review

## Verdict

${verdict}

## Summary

${summary}

## Needs

${needsMd}
`;
}

async function commandReview() {
  const state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');

  const spec = readRequiredText(latestPaths.spec, "spec.md", 'ds-l spec "需求"');
  const plan = readRequiredText(latestPaths.plan, "plan.md", "ds-l plan");
  const task = readRequiredText(latestPaths.task, "task.md", "ds-l task");
  const acceptance = readRequiredText(latestPaths.acceptance, "acceptance.md", 'ds-l spec "需求"');
  const workerPrompt = readRequiredText(latestPaths.workerPrompt, "worker.prompt.md", "ds-l task");
  const workerLastMessage = readRequiredStateFile(
    state.drive?.last_message_file,
    "state.drive.last_message_file",
  );
  const workerStderr = readRequiredStateFile(state.drive?.stderr_log, "state.drive.stderr_log");
  const gitStatus = commandOutput("git status --short", "git status --short");
  const gitDiff = commandOutput("git diff", "git diff");

  const parsed = await callDeepSeekJson(
    "review",
    `${baseSystemPrompt}

当前阶段：review。
你必须审查 Codex Worker 的执行是否符合 spec / plan / acceptance。
禁止要求自动 fix 循环，禁止生成 report。
verdict 只能是 pass、needs_fix、needs_user_decision 三者之一。

输出 JSON schema:
{
  "verdict": "pass | needs_fix | needs_user_decision",
  "summary": "简短审查总结",
  "needs": ["needs_fix 时列出需要修复的问题；needs_user_decision 时列出需要用户确认的问题；pass 时可为空数组"],
  "review_md": "完整 Markdown review，必须包含 Verdict、Summary、Evidence、Needs"
}
`,
    `用户原始需求：

${state.original_request || "(unknown)"}

state.json:

${JSON.stringify(state, null, 2)}

spec.md:

${spec}

plan.md:

${plan}

task.md:

${task}

acceptance.md:

${acceptance}

worker.prompt.md:

${workerPrompt}

state.drive.last_message_file:

${workerLastMessage}

state.drive.stderr_log:

${workerStderr || "(empty)"}

git status --short:

${gitStatus}

git diff:

${gitDiff}

请基于以上材料判断 Worker 是否满足 spec、plan、acceptance。
要求：
1. 如果实现满足验收标准且没有明显阻塞，verdict=pass。
2. 如果需要代码修复，verdict=needs_fix，并在 needs 中列出具体修复项。
3. 如果不能安全判断或需要产品/用户取舍，verdict=needs_user_decision，并在 needs 中说明用户必须确认什么。
4. 不要启动或建议自动修复循环。
5. 不要生成 report。
`,
  );

  const verdict = requireVerdict(parsed.verdict);
  const summary = requireString(parsed.summary, "summary");
  const parsedNeeds = normalizeNeeds(parsed.needs);
  const needs = verdict === "pass" || parsedNeeds.length ? parsedNeeds : [summary];
  const reviewMd =
    typeof parsed.review_md === "string" && parsed.review_md.trim()
      ? parsed.review_md.trim()
      : fallbackReviewMarkdown({ verdict, summary, needs });
  const nextRecommendedCommand =
    verdict === "pass"
      ? "ds-l report"
      : verdict === "needs_fix"
        ? "Review found needs_fix; automatic fix is not implemented"
        : "Review needs user decision";

  writeText(latestPaths.review, reviewMd);
  saveState(state, {
    phase: "review",
    status: verdict === "pass" ? "active" : "blocked",
    latest_error: null,
    review: {
      ...state.review,
      verdict,
      summary,
      needs,
    },
    next_recommended_command: nextRecommendedCommand,
  });

  console.log("\n=== DS Review ===");
  console.log(`Verdict: ${verdict}`);
  console.log(`Summary: ${summary}`);
  if (needs.length) {
    console.log("Needs:");
    for (const need of needs) console.log(`- ${need}`);
  }
  console.log(`Review: ${repoRel(latestPaths.review)}`);
  console.log(`Next: ${nextRecommendedCommand}\n`);
  return readState();
}

function requireReviewReady(state) {
  if (!existsSync(latestPaths.review)) {
    fail(`review.md 不存在: ${repoRel(latestPaths.review)}\n请先运行: ds-l review`);
  }
  if (!state.review?.verdict) {
    fail("state.json 中 review.verdict 为空。\n请先运行: ds-l review");
  }
  return requireVerdict(state.review.verdict);
}

function reportNextCommand(verdict) {
  if (verdict === "pass") return "Phase 3A report completed";
  if (verdict === "needs_fix") return "manual fix not implemented; inspect review.md";
  return "user decision required; inspect review.md";
}

async function commandReport() {
  const state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');
  const verdict = requireReviewReady(state);

  const spec = readRequiredText(latestPaths.spec, "spec.md", 'ds-l spec "需求"');
  const plan = readRequiredText(latestPaths.plan, "plan.md", "ds-l plan");
  const task = readRequiredText(latestPaths.task, "task.md", "ds-l task");
  const acceptance = readRequiredText(latestPaths.acceptance, "acceptance.md", 'ds-l spec "需求"');
  const workerPrompt = readRequiredText(latestPaths.workerPrompt, "worker.prompt.md", "ds-l task");
  const review = readRequiredText(latestPaths.review, "review.md", "ds-l review");
  const workerLastMessage = readRequiredStateFile(
    state.drive?.last_message_file,
    "state.drive.last_message_file",
  );
  const workerStderr = readRequiredStateFile(state.drive?.stderr_log, "state.drive.stderr_log");
  const gitStatus = commandOutput("git status --short", "git status --short");
  const gitDiff = commandOutput("git diff", "git diff");

  const parsed = await callDeepSeekJson(
    "report",
    `${baseSystemPrompt}

当前阶段：report。
你必须生成最终报告，不要生成 fix 方案，不要自动调用 Codex，不要设计自动循环。
输出 JSON schema:
{
  "report_md": "完整 Markdown report"
}
`,
    `用户原始需求：

${state.original_request || "(unknown)"}

state.json:

${JSON.stringify(state, null, 2)}

spec.md:

${spec}

plan.md:

${plan}

task.md:

${task}

acceptance.md:

${acceptance}

worker.prompt.md:

${workerPrompt}

review.md:

${review}

state.drive.last_message_file:

${workerLastMessage}

state.drive.stderr_log:

${workerStderr || "(empty)"}

git status --short:

${gitStatus}

git diff:

${gitDiff}

请生成 DS workflow v1 的最终报告 report.md。
report.md 至少必须包含：
1. 任务标题
2. 原始需求
3. workflow_id
4. spec 摘要
5. plan 摘要
6. task 摘要
7. Codex run 结果
8. DS review verdict
9. DS review summary
10. git status 摘要
11. 最终结论

要求：
1. 基于 review verdict 给出最终结论。
2. verdict=pass 时说明工作流已完成。
3. verdict=needs_fix 时说明 manual fix 尚未实现，并引导查看 review.md。
4. verdict=needs_user_decision 时说明需要用户决策，并引导查看 review.md。
5. 禁止实现或要求自动 fix。
6. 禁止自动调用 Codex 修复。
7. 禁止自动循环。
`,
  );

  const reportMd = requireString(parsed.report_md, "report_md");
  const nextRecommendedCommand = reportNextCommand(verdict);

  writeText(latestPaths.report, reportMd);
  saveState(state, {
    phase: "report",
    status: verdict === "pass" ? "completed" : "active",
    latest_error: null,
    next_recommended_command: nextRecommendedCommand,
  });

  console.log("\n=== DS Report ===");
  console.log(`Verdict: ${verdict}`);
  console.log(`Report: ${repoRel(latestPaths.report)}`);
  console.log(`Next: ${nextRecommendedCommand}\n`);
  return readState();
}

async function commandPreview(request) {
  if (!request) fail('ds-l -p 需要需求文本，例如: ds-l -p "实现登录页"');
  await commandSpec(request);
  await commandPlan();
  await commandTask();
  console.log("Preview complete. Next: ds-l run\n");
}

async function commandLegacyAuto(request) {
  if (!request) fail("缺少需求文本。");
  await commandPreview(request);
  commandRun();
}

function artifactLine(label, filePath) {
  const exists = existsSync(filePath);
  return `- ${label}: ${repoRel(filePath)} ${exists ? "" : "(missing)"}`.trimEnd();
}

function showLatestStatus() {
  const state = readState();
  if (!state) {
    const legacy = loadLegacyLatestPlan();
    if (!legacy) {
      fail('没有 latest 状态。请先运行: ds-l -p "需求" 或 ds-l spec "需求"');
    }
    console.log("\n=== Latest DS Leader Plan (legacy) ===");
    console.log(`Title: ${legacy.title || "(untitled)"}`);
    console.log(`Original task: ${legacy.original_task || "(unknown)"}`);
    console.log(`Created at: ${legacy.created_at || "(unknown)"}`);
    console.log(`Saved: ${repoRel(legacyLatestJson)}`);
    console.log("\nNext: ds-l -u\n");
    return;
  }

  console.log("\n=== DS Leader Latest ===");
  console.log(`workflow_id: ${state.workflow_id}`);
  console.log(`title: ${state.title || "(untitled)"}`);
  console.log(`phase: ${state.phase}`);
  console.log(`status: ${state.status}`);
  console.log(`updated_at: ${state.updated_at}`);
  if (state.latest_error) console.log(`latest_error: ${state.latest_error}`);

  console.log("\nArtifacts:");
  console.log(artifactLine("spec", latestPaths.spec));
  console.log(artifactLine("plan", latestPaths.plan));
  console.log(artifactLine("task", latestPaths.task));
  console.log(artifactLine("acceptance", latestPaths.acceptance));
  console.log(artifactLine("worker_prompt", latestPaths.workerPrompt));
  console.log(artifactLine("review", latestPaths.review));
  console.log(artifactLine("report", latestPaths.report));
  console.log(artifactLine("state", latestPaths.state));

  if (state.drive?.drive_id || existsSync(latestPaths.driveSummary)) {
    console.log("\nDrive:");
    console.log(`- drive_id: ${state.drive?.drive_id ?? "(unknown)"}`);
    console.log(`- status: ${state.drive?.status ?? "(unknown)"}`);
    console.log(`- stop_reason: ${state.drive?.stop_reason ?? "(unknown)"}`);
    console.log(`- summary_file: ${state.drive?.summary_file ?? repoRel(latestPaths.driveSummary)}`);
  }

  if (state.review?.verdict || existsSync(latestPaths.review)) {
    console.log("\nReview:");
    console.log(`- verdict: ${state.review?.verdict ?? "(unknown)"}`);
    console.log(`- summary: ${state.review?.summary ?? "(unknown)"}`);
    if (state.review?.needs?.length) {
      console.log(`- needs: ${state.review.needs.join("; ")}`);
    }
  }

  if (existsSync(latestPaths.report)) {
    console.log("\nReport:");
    console.log(`- report: ${repoRel(latestPaths.report)}`);
  }

  console.log(`\nNext: ${suggestNext(state)}\n`);
}

async function main() {
  if (help) {
    printHelp();
    return;
  }

  if (showLast) {
    showLatestStatus();
    return;
  }

  if (useLast) {
    commandRun();
    return;
  }

  if (previewOnly) {
    await commandPreview(commandText);
    return;
  }

  if (command === "spec") {
    await commandSpec(commandText);
    return;
  }

  if (command === "plan") {
    await commandPlan();
    return;
  }

  if (command === "task") {
    await commandTask();
    return;
  }

  if (command === "run") {
    commandRun();
    return;
  }

  if (command === "review") {
    await commandReview();
    return;
  }

  if (command === "report") {
    await commandReport();
    return;
  }

  if (commandText) {
    await commandLegacyAuto(commandText);
    return;
  }

  printHelp();
  process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
