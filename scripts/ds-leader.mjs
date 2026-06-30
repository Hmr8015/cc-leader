#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const root = process.cwd();
const dsRoot = path.join(root, ".cc-leader", "ds-leader");
const latestDir = path.join(dsRoot, "latest");
const logsDir = path.join(latestDir, "logs");
const codexDir = path.join(latestDir, "codex");
const debugDir = path.join(latestDir, "debug");
const latestPaths = {
  spec: path.join(latestDir, "spec.md"),
  plan: path.join(latestDir, "plan.md"),
  task: path.join(latestDir, "task.md"),
  acceptance: path.join(latestDir, "acceptance.md"),
  workerPrompt: path.join(latestDir, "worker.prompt.md"),
  review: path.join(latestDir, "review.md"),
  report: path.join(latestDir, "report.md"),
  fixPrompt: path.join(latestDir, "fix.prompt.md"),
  state: path.join(latestDir, "state.json"),
  driveSummary: path.join(codexDir, "drive-summary.json"),
  driveStdout: path.join(codexDir, "stdout.jsonl"),
  driveStderr: path.join(codexDir, "stderr.log"),
  reviewSchema: path.join(codexDir, "review.schema.json"),
};

const reviewModel = "gpt-5.5";
const reviewEffort = "xhigh";
const noChangeAdjudication = "DS_FIX_NO_CHANGES: all blocking findings rejected";

const legacyLatestJson = path.join(dsRoot, "latest.json");
const legacyLatestPrompt = path.join(dsRoot, "latest.prompt.md");
const commandNames = new Set(["spec", "plan", "task", "run", "review", "report", "fix", "close", "merge"]);
const forceReview = rawArgs.includes("--force-review");
const bugfix = rawArgs.includes("--bugfix");
const verified = rawArgs.includes("--verified");
const selfTest = rawArgs.includes("--self-test");

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
      "--force-review",
      "--bugfix",
      "--verified",
      "--self-test",
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

  ds-l run [--bugfix]
    记录 git base，调用 cc-leader drive 实现、验证并提交；结束时 worktree 必须干净。

  ds-l close [--force-review] [--bugfix]
    fetch/rebase origin/main 后执行提交范围审核；修复、验证、提交并复审，最多 5 轮。

  ds-l review
    强制使用 gpt-5.5/xhigh 独立审核当前 review_base..HEAD；显式调用时不适用小改动跳过规则。

  ds-l fix
    仅当 verdict 为 needs_fix 时，裁决 findings，修复成立的 blocker/high/medium，验证并提交。

  ds-l report
    读取 latest 产物、review、Codex Worker 输出、git status/diff/cached diff/untracked text files，调 DeepSeek 生成最终报告。

  ds-l merge [--verified]
    将已通过最终审核的任务分支 ff-only 合回 main 并 push；bugfix 必须传 --verified。

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
  ensureDir(debugDir);
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

function writeRawText(filePath, content) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, String(content ?? ""), "utf8");
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
    fix_prompt: repoRel(latestPaths.fixPrompt),
    state: repoRel(latestPaths.state),
  };
}

function baseState(originalRequest, title) {
  const createdAt = nowIso();
  return {
    schema_version: 2,
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
      round: 0,
      findings: [],
      audited_head_sha: null,
      skipped: false,
      explicitly_requested: false,
    },
    limits: {
      max_fix_iterations: 5,
      max_review_rounds: 5,
    },
    git: {
      start_sha: null,
      review_base_sha: null,
      head_sha: null,
      audited_upstream_sha: null,
    },
    delivery: {
      bugfix: false,
      status: "not_started",
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

function safeDebugName(command) {
  return String(command || "deepseek")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "deepseek";
}

function rawResponsePath(command) {
  return path.join(debugDir, `${safeDebugName(command)}.raw.txt`);
}

function latestErrorObject(command, message, rawResponseFile) {
  return {
    command,
    message,
    raw_response_file: repoRel(rawResponseFile),
    created_at: nowIso(),
  };
}

function recordLatestError({ command, message, rawResponseFile, stateFactory }) {
  const latestError = latestErrorObject(command, message, rawResponseFile);
  const existingState = readState();
  const state = existingState || (typeof stateFactory === "function" ? stateFactory() : null);
  if (!state) return latestError;
  saveState(state, {
    status: "blocked",
    latest_error: latestError,
    next_recommended_command: command ? `ds-l ${command}` : state.next_recommended_command,
  });
  return latestError;
}

function formatLatestError(latestError) {
  if (!latestError) return null;
  if (typeof latestError === "string") return latestError;
  if (typeof latestError !== "object") return String(latestError);

  const command = latestError.command ? `${latestError.command}: ` : "";
  const message = latestError.message || JSON.stringify(latestError);
  const rawFile = latestError.raw_response_file ? ` (${latestError.raw_response_file})` : "";
  return `${command}${message}${rawFile}`;
}

function suggestNext(state) {
  if (!state) return 'ds-l spec "需求"';
  if (state.next_recommended_command) return state.next_recommended_command;
  if (state.phase === "spec") return "ds-l plan";
  if (state.phase === "plan") return "ds-l task";
  if (state.phase === "task") return "ds-l run";
  if (state.phase === "running") return "ds-l -s";
  if (state.phase === "run") return "ds-l close";
  if (state.phase === "review") {
    if (state.review?.verdict === "pass") return "ds-l report";
    if (state.review?.verdict === "needs_fix") return "ds-l fix";
    if (state.review?.verdict === "needs_user_decision") return "Review needs user decision";
  }
  if (state.phase === "fix") return "ds-l close";
  if (state.phase === "closed") {
    return state.delivery?.bugfix ? "ds-l merge --verified" : "ds-l merge";
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

function runGit(args, cwd = root) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
}

function gitText(args, label = `git ${args.join(" ")}`, cwd = root) {
  const result = runGit(args, cwd);
  if (result.error || (result.status ?? 1) !== 0) {
    fail(
      `${label} failed\n${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  return (result.stdout || "").trim();
}

function currentHead() {
  return gitText(["rev-parse", "HEAD"], "读取当前 HEAD");
}

function currentBranch(cwd = root) {
  return gitText(["branch", "--show-current"], "读取当前分支", cwd);
}

function worktreeStatus(cwd = root) {
  return gitText(["status", "--porcelain"], "读取 worktree 状态", cwd);
}

function requireCleanWorktree(stage, cwd = root) {
  const status = worktreeStatus(cwd);
  if (status) fail(`${stage} 要求干净 worktree，请先提交或处理以下改动：\n${status}`);
}

function requireCommitRange(base, head) {
  if (!base) fail("缺少 review_base_sha；请重新运行 ds-l run。 ");
  const result = runGit(["merge-base", "--is-ancestor", base, head]);
  if ((result.status ?? 1) !== 0) {
    fail(`审核基线 ${base} 不是 HEAD ${head} 的祖先；请运行 ds-l close 重新 rebase。`);
  }
  if (base === head) fail("git base 到 HEAD 之间没有提交，无法审核。");
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

function collectFencedBlocks(text) {
  const blocks = [];
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let match;

  while ((match = fencePattern.exec(text)) !== null) {
    const meta = match[1].trim();
    let body = match[2];
    let priority = 2;

    if (/^json\b/i.test(meta)) {
      priority = 0;
      if (!body.trim()) body = meta.replace(/^json\b/i, "").trim();
    } else if (!meta) {
      priority = 1;
    } else if (!body.trim() && meta.startsWith("{")) {
      body = meta;
    }

    if (body.trim()) {
      blocks.push({
        body,
        index: match.index,
        priority,
      });
    }
  }

  return blocks.sort((a, b) => a.priority - b.priority || a.index - b.index).map((block) => block.body);
}

function collectCompleteJsonObjects(text) {
  const candidates = [];
  const source = String(text ?? "");

  for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

function jsonCandidates(text) {
  const candidates = [];
  const seen = new Set();
  const add = (value) => {
    const candidate = String(value ?? "").trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  add(text);
  const fencedBlocks = collectFencedBlocks(String(text ?? ""));
  for (const block of fencedBlocks) add(block);

  const sources = [String(text ?? ""), ...fencedBlocks];
  for (const source of sources) {
    for (const objectText of collectCompleteJsonObjects(source)) {
      add(objectText);
    }
  }

  return candidates;
}

function deepSeekNonJsonMessage(command, rawResponseFile, rawContent, cause) {
  const raw = String(rawContent ?? "");
  const preview = raw ? raw.slice(0, 1000) : "(empty)";
  const truncated = raw.length > 1000 ? "\n...(truncated; full raw response saved to file)" : "";
  const parseError = cause?.message ? `\nParse error: ${cause.message}` : "";

  return [
    "DeepSeek returned non-JSON.",
    `raw response saved to ${repoRel(rawResponseFile)}`,
    "建议查看该文件以诊断模型输出。",
    parseError.trimStart(),
    "",
    "Raw response preview (first 1000 chars):",
    `${preview}${truncated}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function createDeepSeekNonJsonError({ command, rawContent, cause, rawResponseFile, stateFactory }) {
  const filePath = rawResponseFile || rawResponsePath(command);
  writeRawText(filePath, rawContent);
  const latestError = recordLatestError({
    command,
    message: "DeepSeek returned non-JSON",
    rawResponseFile: filePath,
    stateFactory,
  });
  const error = new Error(deepSeekNonJsonMessage(command, filePath, rawContent, cause));
  error.userFacing = true;
  error.latestError = latestError;
  error.cause = cause;
  return error;
}

function parseJsonLoose(text, options = {}) {
  let lastError = null;

  for (const candidate of jsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const cause = lastError || new Error("No complete JSON object found in response.");
  if (options.command) {
    throw createDeepSeekNonJsonError({
      command: options.command,
      rawContent: text,
      cause,
      rawResponseFile: options.rawResponseFile,
      stateFactory: options.stateFactory,
    });
  }

  throw new Error(`Could not parse JSON from response: ${cause.message}`);
}

async function callDeepSeekJson(stage, systemPrompt, userPrompt, options = {}) {
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

  const responseText = await res.text();
  if (!res.ok) {
    throw new Error(`DeepSeek API failed: HTTP ${res.status}\n${responseText}`);
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (error) {
    throw createDeepSeekNonJsonError({
      command: stage,
      rawContent: responseText,
      cause: error,
      rawResponseFile: rawResponsePath(stage),
      stateFactory: options.stateFactory,
    });
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`No content in DeepSeek response:\n${JSON.stringify(data, null, 2)}`);
  }
  const parsed = parseJsonLoose(content, {
    command: stage,
    rawResponseFile: rawResponsePath(stage),
    stateFactory: options.stateFactory,
  });
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
    {
      stateFactory: () => baseState(request, "DS workflow"),
    },
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
9. 完成最小验证后，按关注点创建 git commit；不要把无关改动混入提交。
10. 结束前确认 git status --porcelain 为空；存在无法提交的改动时停止并说明。
11. 遇到真实 blocker 时停止并说明 blocker。
12. 最终输出：
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

function driveIncomplete(summary) {
  return !summary || summary.active || summary.stop_reason !== "completed" || summary.last_exit_code !== 0;
}

function runDriveToCompletion(prompt) {
  let args = ["drive", prompt];
  let stdout = "";
  let stderr = "";
  let result;
  let summary;
  do {
    result = spawnSync("cc-leader", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
      env: process.env,
    });
    stdout += result.stdout || "";
    stderr += result.stderr || "";
    summary = parseDriveSummary(result.stdout || "");
    args = ["drive"];
  } while (!result.error && (result.status ?? 1) === 0 && summary?.active);
  return { result, stdout, stderr, summary };
}

function rejectedAllFindings(summary) {
  return String(summary?.latest_message || "").includes(noChangeAdjudication);
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

const maxUntrackedFileChars = 20000;
const maxUntrackedTotalChars = 60000;
const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".sqlite",
  ".db",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
]);

const languageByExtension = new Map([
  [".css", "css"],
  [".html", "html"],
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".json", "json"],
  [".md", "markdown"],
  [".mjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
]);

function skippedUntrackedReason(filePath) {
  const parts = filePath.split("/");
  if (
    parts.includes(".git") ||
    parts.includes(".cc-leader") ||
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes("build") ||
    parts.includes("coverage") ||
    parts.includes(".next") ||
    parts.includes(".venv") ||
    parts.some((part) => part.includes("pycache"))
  ) {
    return "skipped path";
  }
  const ext = path.extname(filePath).toLowerCase();
  if (binaryExtensions.has(ext)) return "skipped binary extension";
  return null;
}

function hasNulByte(buffer) {
  for (const byte of buffer) {
    if (byte === 0) return true;
  }
  return false;
}

function readFilePrefix(filePath, maxBytes) {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function readUntrackedTextPrefix(absPath, originalSize, charLimit) {
  const maxBytes = Math.min(originalSize, Math.max(0, charLimit) * 4 + 1024);
  const buffer = readFilePrefix(absPath, maxBytes);
  const text = buffer.toString("utf8");
  const content = text.slice(0, charLimit);
  return {
    content,
    truncated: originalSize > Buffer.byteLength(content, "utf8") || text.length > content.length,
    readChars: content.length,
  };
}

function markdownFenceFor(content) {
  const matches = content.match(/`{3,}/g) || [];
  const longest = matches.reduce((max, item) => Math.max(max, item.length), 2);
  return "`".repeat(longest + 1);
}

function untrackedLanguage(filePath) {
  return languageByExtension.get(path.extname(filePath).toLowerCase()) || "";
}

function listUntrackedFiles() {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 10,
  });
  if ((result.status ?? 1) !== 0) {
    return {
      files: [],
      error: `git ls-files --others --exclude-standard -z failed with exit ${result.status ?? 1}\n\nSTDERR:\n${result.stderr.toString("utf8")}`,
    };
  }
  return {
    files: result.stdout
      .toString("utf8")
      .split("\0")
      .filter((item) => item.length > 0),
    error: null,
  };
}

function collectUntrackedTextFiles() {
  const listed = listUntrackedFiles();
  const files = [];
  const skipped = [];
  let remainingChars = maxUntrackedTotalChars;

  for (const filePath of listed.files) {
    const pathReason = skippedUntrackedReason(filePath);
    if (pathReason) {
      skipped.push({ path: filePath, reason: pathReason });
      continue;
    }

    const absPath = path.join(root, filePath);
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch (error) {
      skipped.push({ path: filePath, reason: `stat failed: ${error.message}` });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: filePath, reason: "not a regular file" });
      continue;
    }

    try {
      const probe = readFilePrefix(absPath, Math.min(stat.size, 4096));
      if (hasNulByte(probe)) {
        skipped.push({ path: filePath, reason: "binary content detected" });
        continue;
      }
    } catch (error) {
      skipped.push({ path: filePath, reason: `read failed: ${error.message}` });
      continue;
    }

    if (remainingChars <= 0) {
      skipped.push({ path: filePath, reason: "total untracked content limit reached" });
      continue;
    }

    try {
      const charLimit = Math.min(maxUntrackedFileChars, remainingChars);
      const read = readUntrackedTextPrefix(absPath, stat.size, charLimit);
      files.push({
        path: filePath,
        originalSize: stat.size,
        ...read,
      });
      remainingChars -= read.readChars;
    } catch (error) {
      skipped.push({ path: filePath, reason: `read failed: ${error.message}` });
    }
  }

  return {
    error: listed.error,
    files,
    skipped,
    totalReadChars: maxUntrackedTotalChars - remainingChars,
  };
}

function formatUntrackedTextFiles(untracked) {
  const lines = ["## Untracked file contents", ""];
  if (untracked.error) {
    lines.push(untracked.error, "");
  }
  if (!untracked.files.length) {
    lines.push("(none)", "");
  }

  for (const file of untracked.files) {
    const fence = markdownFenceFor(file.content);
    const language = untrackedLanguage(file.path);
    lines.push(`### ${file.path}`, "");
    if (file.truncated) {
      lines.push(
        `Truncated: yes. Original size: ${file.originalSize} bytes. Read: ${file.readChars} chars.`,
        "",
      );
    } else {
      lines.push(`Truncated: no. Original size: ${file.originalSize} bytes. Read: ${file.readChars} chars.`, "");
    }
    lines.push(`${fence}${language}`, file.content, fence, "");
  }

  lines.push("## Skipped untracked files", "");
  if (!untracked.skipped.length) {
    lines.push("(none)", "");
  } else {
    for (const item of untracked.skipped) {
      lines.push(`- ${item.path}: ${item.reason}`);
    }
    lines.push("");
  }
  lines.push(`Total untracked text chars read: ${untracked.totalReadChars}/${maxUntrackedTotalChars}`);
  return lines.join("\n");
}

function workspaceReviewInputs() {
  const gitStatus = commandOutput("git status --short", "git status --short");
  const gitDiff = commandOutput("git diff", "git diff");
  const gitDiffCached = commandOutput("git diff --cached", "git diff --cached");
  const untrackedFiles = formatUntrackedTextFiles(collectUntrackedTextFiles());
  return {
    gitStatus,
    gitDiff,
    gitDiffCached,
    untrackedFiles,
  };
}

function formatCurrentWorkspaceEvidence(workspaceInputs) {
  return `## Current workspace evidence 当前工作区事实（authoritative）

Highest-priority evidence rules:
- Current workspace evidence is authoritative.
- Current file contents override Worker last-message and drive logs.
- Worker last-message is historical and may be stale.

### git status --short

${workspaceInputs.gitStatus}

### git diff

${workspaceInputs.gitDiff}

### git diff --cached

${workspaceInputs.gitDiffCached}

### untracked text files contents and skipped untracked files list

${workspaceInputs.untrackedFiles}`;
}

function formatHistoricalWorkerLogs({ workerLastMessage, workerStderr }) {
  return `## Historical worker logs Worker 历史日志（may be stale）

These logs are historical background only. They must not override Current workspace evidence.

### state.drive.last_message_file

${workerLastMessage}

### state.drive.stderr_log

${workerStderr || "(empty)"}`;
}

function commandRun() {
  const state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');
  requireCleanWorktree("ds-l run");
  const branch = currentBranch();
  if (!branch || branch === "main") fail("ds-l run 必须在任务 worktree 分支运行，不能直接在 main 上运行。");
  const currentSha = currentHead();
  const startSha = state.git?.start_sha || currentSha;
  const reviewBaseSha = state.git?.review_base_sha || startSha;
  const isBugfix = bugfix || state.delivery?.bugfix || false;
  const workerPrompt = `${loadLatestWorkerPrompt()}

【Git 交付要求】
完成最小验证后按关注点提交全部任务改动。结束前必须确认 git status --porcelain 为空。`;
  ensureLatestDirs();
  saveState(state, {
    phase: "running",
    status: "active",
    latest_error: null,
    git: {
      ...state.git,
      start_sha: startSha,
      review_base_sha: reviewBaseSha,
      head_sha: currentSha,
      audited_upstream_sha: null,
    },
    review: {
      ...state.review,
      verdict: null,
      summary: null,
      needs: [],
      fix_iteration: 0,
      round: 0,
      findings: [],
      audited_head_sha: null,
      skipped: false,
      explicitly_requested: false,
    },
    delivery: {
      ...state.delivery,
      bugfix: isBugfix,
      status: "implementing",
    },
    next_recommended_command: "ds-l -s",
  });

  console.log("\nStarting cc-leader drive with latest Codex worker prompt...\n");
  const { result, stdout, stderr, summary } = runDriveToCompletion(workerPrompt);
  writeText(latestPaths.driveStdout, stdout);
  writeText(latestPaths.driveStderr, stderr);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const incomplete = driveIncomplete(summary);
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
  let gateError = null;
  let headSha = currentSha;
  if (!result.error && (result.status ?? 1) === 0) {
    headSha = currentHead();
    const status = worktreeStatus();
    if (status) gateError = `Worker 结束后 worktree 不干净：\n${status}`;
    else if (headSha === currentSha) gateError = "Worker 没有创建任务提交。";
  }
  if (latestState) {
    const failed = Boolean(result.error) || (result.status ?? 1) !== 0 || Boolean(gateError) || incomplete;
    saveState(latestState, {
      phase: failed ? "blocked" : summary?.active ? "running" : "run",
      status: failed ? "blocked" : "active",
      latest_error: failed
        ? gateError || result.error?.message || (incomplete ? `worker stop_reason=${summary?.stop_reason || "missing"}` : `cc-leader drive exited ${result.status}`)
        : null,
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
      git: {
        ...latestState.git,
        head_sha: headSha,
      },
      delivery: {
        ...latestState.delivery,
        status: failed ? "blocked" : summary?.active ? "implementing" : "implemented",
      },
      next_recommended_command: failed
        ? "ds-l -s"
        : "ds-l close",
    });
  }

  if (result.error) {
    fail(result.error.message);
  }
  if (gateError) fail(gateError);
  if (incomplete) fail(`worker stop_reason=${summary?.stop_reason || "missing"}`);
  process.exit(result.status ?? 0);
}

function summarizeChangeStats(namesText, numstatText) {
  const files = namesText.split("\0").filter(Boolean);
  let added = 0;
  let deleted = 0;
  let binary = false;
  for (const line of numstatText.split("\n").filter(Boolean)) {
    const [add, del] = line.split("\t", 2);
    if (add === "-" || del === "-") binary = true;
    else {
      added += Number(add) || 0;
      deleted += Number(del) || 0;
    }
  }
  return {
    files,
    added,
    deleted,
    binary,
    can_skip_review: files.length === 1 && !binary && added + deleted <= 10,
  };
}

function commitRangeInputs(base, head) {
  requireCommitRange(base, head);
  const range = `${base}..${head}`;
  const names = gitText(["diff", "--name-only", "-z", range], "读取变更文件");
  const numstat = gitText(["diff", "--numstat", range], "读取变更行数");
  return {
    base,
    head,
    range,
    commits: gitText(["log", "--format=%H %s", range], "读取提交记录"),
    diff: gitText(["diff", "--no-ext-diff", "--find-renames", range], "读取提交范围 diff"),
    stats: summarizeChangeStats(names, numstat),
  };
}

function formatCommitRangeEvidence(evidence) {
  return `## Authoritative git evidence

Review range: ${evidence.range}

### Commits

${evidence.commits}

### Changed files

${evidence.stats.files.join("\n")}

### Diff

${evidence.diff}`;
}

function normalizeFindings(value) {
  if (!Array.isArray(value)) throw new Error("Reviewer findings 必须是数组。");
  const severities = new Set(["blocker", "high", "medium", "low"]);
  return value.map((finding, index) => {
    const severity = String(finding?.severity || "").toLowerCase();
    if (!severities.has(severity)) throw new Error(`Reviewer finding ${index + 1} severity 非法。`);
    return {
      id: `R${index + 1}`,
      severity,
      title: requireString(finding.title, `findings[${index}].title`),
      file: requireString(finding.file, `findings[${index}].file`),
      line: Number.isInteger(finding.line) ? finding.line : null,
      evidence: requireString(finding.evidence, `findings[${index}].evidence`),
      task_impact: requireString(finding.task_impact, `findings[${index}].task_impact`),
    };
  });
}

function reviewerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { type: "string", enum: ["blocker", "high", "medium", "low"] },
            title: { type: "string" },
            file: { type: "string" },
            line: { type: ["integer", "null"] },
            evidence: { type: "string" },
            task_impact: { type: "string" },
          },
          required: ["severity", "title", "file", "line", "evidence", "task_impact"],
        },
      },
    },
    required: ["summary", "findings"],
  };
}

function runReviewAgent(prompt, round) {
  ensureLatestDirs();
  writeJson(latestPaths.reviewSchema, reviewerSchema());
  const lastMessage = path.join(codexDir, `review-round-${round}.json`);
  const stdoutFile = path.join(codexDir, `review-round-${round}.stdout.jsonl`);
  const stderrFile = path.join(codexDir, `review-round-${round}.stderr.log`);
  const result = spawnSync(
    "codex",
    [
      "-m",
      reviewModel,
      "-c",
      `model_reasoning_effort=\"${reviewEffort}\"`,
      "-s",
      "read-only",
      "-a",
      "never",
      "exec",
      "--json",
      "--ephemeral",
      "--strict-config",
      "--output-schema",
      latestPaths.reviewSchema,
      "-o",
      lastMessage,
      "-",
    ],
    {
      cwd: root,
      input: prompt,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
      env: process.env,
    },
  );
  writeRawText(stdoutFile, result.stdout || "");
  writeRawText(stderrFile, result.stderr || "");
  if (result.error || (result.status ?? 1) !== 0) {
    fail(
      `gpt-5.5/xhigh reviewer failed\n${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  return parseJsonLoose(readRequiredStateFile(lastMessage, `review round ${round} output`));
}

function reviewMarkdown({ verdict, summary, findings, base, head, skipped = false }) {
  const lines = [
    "# DS Review",
    "",
    "## Verdict",
    "",
    verdict,
    "",
    "## Scope",
    "",
    `- Base: ${base}`,
    `- Head: ${head}`,
    `- Reviewer: ${skipped ? "skipped by size rule" : `${reviewModel}/${reviewEffort}`}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Findings",
    "",
  ];
  if (!findings.length) lines.push("- None");
  for (const finding of findings) {
    lines.push(
      `- **${finding.id} ${finding.severity.toUpperCase()}** ${finding.file}${finding.line ? `:${finding.line}` : ""} — ${finding.title}`,
      `  - Evidence: ${finding.evidence}`,
      `  - Task impact: ${finding.task_impact}`,
    );
  }
  return lines.join("\n");
}

function requireVerdict(value) {
  const verdict = requireString(value, "verdict");
  const allowed = new Set(["pass", "needs_fix", "needs_user_decision"]);
  if (!allowed.has(verdict)) {
    throw new Error(`DeepSeek JSON verdict 非法: ${verdict}`);
  }
  return verdict;
}

async function commandReview({ explicit = true } = {}) {
  let state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');
  requireCleanWorktree("ds-l review");
  if (explicit && !state.review?.explicitly_requested) {
    state = saveState(state, {
      review: { ...state.review, explicitly_requested: true },
    });
  }
  const task = readRequiredText(latestPaths.task, "task.md", "ds-l task");
  const acceptance = readRequiredText(latestPaths.acceptance, "acceptance.md", 'ds-l spec "需求"');
  const head = currentHead();
  const base = state.git?.review_base_sha || state.git?.start_sha;
  const evidence = commitRangeInputs(base, head);
  const round = (Number.isInteger(state.review?.round) ? state.review.round : 0) + 1;

  const parsed = runReviewAgent(
    `You are an independent code-review sub-agent. Review only code facts in the supplied git range.
Do not rely on prior agent memory, worker claims, or uncommitted workspace state.
Find only blocker, high, medium, and low issues. A finding must cite concrete file evidence and explain impact on the task goal.
Do not report stylistic preferences. Return JSON matching the supplied schema.

Original task:
${state.original_request || "(unknown)"}

Task definition:
${task}

Acceptance criteria:
${acceptance}

${formatCommitRangeEvidence(evidence)}`,
    round,
  );

  const summary = requireString(parsed.summary, "summary");
  const findings = normalizeFindings(parsed.findings);
  const blocking = findings.filter((finding) => finding.severity !== "low");
  const verdict = blocking.length ? "needs_fix" : "pass";
  const needs = blocking.map(
    (finding) => `${finding.id} ${finding.severity}: ${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.title}`,
  );
  const reviewMd = reviewMarkdown({ verdict, summary, findings, base, head });
  const nextRecommendedCommand = verdict === "pass" ? "ds-l report" : "ds-l fix";

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
      findings,
      round,
      audited_head_sha: verdict === "pass" ? head : null,
      model: reviewModel,
      effort: reviewEffort,
      skipped: false,
      explicitly_requested: explicit || state.review?.explicitly_requested || false,
    },
    git: {
      ...state.git,
      head_sha: head,
      audited_upstream_sha: verdict === "pass" ? base : null,
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

function buildFixPrompt({
  stateJson,
  state,
  spec,
  plan,
  task,
  acceptance,
  workerPrompt,
  review,
  report,
  workerLastMessage,
  workerStderr,
  rangeEvidence,
}) {
  return `
你是 Codex Worker。当前是 DS workflow 的手动 fix 阶段。

【硬性边界】
1. 先逐项判断 review finding 是否成立；明确记录误报，成立的 blocker/high/medium 必须修复，low 不阻塞。
2. 不要做无关重构。
3. 不要扩大需求或新增未要求的功能。
4. 不要删除无关文件。
5. 不要自动调用 ds-l review。
6. 不要自动调用 ds-l report。
7. 不要实现 fix -> review -> fix 自动循环。
8. 修复后运行必要的最小验证并提交修复；无法运行时说明原因。
9. 结束前确认 git status --porcelain 为空。
10. 最终输出修复摘要，包括成立/误报判断、修改文件、验证结果、提交和剩余风险。
11. Git range evidence 和当前文件内容是权威事实。
12. Worker 历史日志仅供背景，不得覆盖代码事实。
13. 如果全部 blocker/high/medium 都是误报且无需改动，最终输出必须单独包含精确行：${noChangeAdjudication}

【用户原始需求】
${state.original_request || "(unknown)"}

【state.json】
${stateJson}

【spec.md】
${spec}

【plan.md】
${plan}

【task.md】
${task}

【acceptance.md】
${acceptance}

【review.md】
${review}

${formatCommitRangeEvidence(rangeEvidence)}

【worker.prompt.md】
${workerPrompt}

【report.md】
${report || "(not present)"}

${formatHistoricalWorkerLogs({ workerLastMessage, workerStderr })}

请裁决 review.md 中的 findings，完成成立问题的最小修复、验证和提交后停止。
`;
}

function commandFix() {
  const state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');
  const verdict = requireReviewReady(state);

  if (verdict === "pass") {
    fail("review.verdict = pass，无需修复。下一步建议: ds-l report");
  }
  if (verdict === "needs_user_decision") {
    fail("review.verdict = needs_user_decision，需要先由用户决策；ds-l fix 不会自动修复这类问题。");
  }
  if (verdict !== "needs_fix") {
    fail(`review.verdict = ${verdict}，ds-l fix 只允许在 needs_fix 时运行。`);
  }
  requireCleanWorktree("ds-l fix");
  const branch = currentBranch();
  if (!branch || branch === "main") fail("ds-l fix 必须在任务 worktree 分支运行，不能直接在 main 上运行。");
  const beforeHead = currentHead();

  const currentFixIteration = Number.isInteger(state.review?.fix_iteration)
    ? state.review.fix_iteration
    : 0;
  const maxFixIterations = Number.isInteger(state.limits?.max_fix_iterations)
    ? state.limits.max_fix_iterations
    : 5;
  if (currentFixIteration >= maxFixIterations) {
    fail(
      `fix_iteration 已达到 limits.max_fix_iterations (${currentFixIteration}/${maxFixIterations})，请人工检查 review.md 后再决定下一步。`,
    );
  }

  const stateJson = readRequiredText(latestPaths.state, "state.json", 'ds-l spec "需求"');
  const spec = readRequiredText(latestPaths.spec, "spec.md", 'ds-l spec "需求"');
  const plan = readRequiredText(latestPaths.plan, "plan.md", "ds-l plan");
  const task = readRequiredText(latestPaths.task, "task.md", "ds-l task");
  const acceptance = readRequiredText(latestPaths.acceptance, "acceptance.md", 'ds-l spec "需求"');
  const workerPrompt = readRequiredText(latestPaths.workerPrompt, "worker.prompt.md", "ds-l task");
  const review = readRequiredText(latestPaths.review, "review.md", "ds-l review");
  const report = existsSync(latestPaths.report) ? readText(latestPaths.report).trim() : "";
  const workerLastMessage = readRequiredStateFile(
    state.drive?.last_message_file,
    "state.drive.last_message_file",
  );
  const workerStderr = readRequiredStateFile(state.drive?.stderr_log, "state.drive.stderr_log");
  const rangeEvidence = commitRangeInputs(
    state.git?.review_base_sha || state.git?.start_sha,
    beforeHead,
  );
  const fixPrompt = buildFixPrompt({
    stateJson,
    state,
    spec,
    plan,
    task,
    acceptance,
    workerPrompt,
    review,
    report,
    workerLastMessage,
    workerStderr,
    rangeEvidence,
  });

  ensureLatestDirs();
  writeText(latestPaths.fixPrompt, fixPrompt);

  console.log("\nStarting manual-only ds-l fix with generated fix prompt...\n");
  const { result, stdout, stderr, summary } = runDriveToCompletion(fixPrompt);
  writeText(latestPaths.driveStdout, stdout);
  writeText(latestPaths.driveStderr, stderr);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const incomplete = driveIncomplete(summary);
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
  let gateError = null;
  let afterHead = beforeHead;
  let noChangeRejected = false;
  if (!result.error && (result.status ?? 1) === 0) {
    afterHead = currentHead();
    const status = worktreeStatus();
    if (status) gateError = `Fix 结束后 worktree 不干净：\n${status}`;
    else if (afterHead === beforeHead) {
      noChangeRejected = rejectedAllFindings(summary);
      if (!noChangeRejected) gateError = `Fix 没有创建修复提交，也未输出：${noChangeAdjudication}`;
    }
  }
  if (latestState) {
    const failed = Boolean(result.error) || (result.status ?? 1) !== 0 || Boolean(gateError) || incomplete;
    saveState(latestState, {
      phase: "fix",
      status: failed ? "blocked" : "active",
      latest_error: failed
        ? gateError || result.error?.message || (incomplete ? `fix worker stop_reason=${summary?.stop_reason || "missing"}` : `cc-leader drive exited ${result.status}`)
        : null,
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
      review: {
        ...latestState.review,
        fix_iteration: failed ? currentFixIteration : currentFixIteration + 1,
        audited_head_sha: null,
        adjudication: noChangeRejected ? "all_blocking_findings_rejected" : null,
      },
      git: {
        ...latestState.git,
        head_sha: afterHead,
        audited_upstream_sha: null,
      },
      next_recommended_command: failed ? "ds-l -s" : "ds-l review",
    });
  }

  console.log(`\nFix prompt: ${repoRel(latestPaths.fixPrompt)}`);
  console.log("Next: ds-l review\n");

  if (result.error) {
    fail(result.error.message);
  }
  if (gateError) fail(gateError);
  if ((result.status ?? 1) !== 0) fail(`cc-leader drive exited ${result.status}`);
  if (incomplete) fail(`fix worker stop_reason=${summary?.stop_reason || "missing"}`);
  return readState();
}

function runGitStep(args, label, cwd = root) {
  const result = runGit(args, cwd);
  if (result.error || (result.status ?? 1) !== 0) {
    fail(`${label} failed\n${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result;
}

function reviewInvalidation(state, upstream, head, finalReview = false) {
  const upstreamChanged = state.git?.review_base_sha !== upstream;
  const forceFreshReview = finalReview && state.review?.verdict === "pass";
  return {
    stale: upstreamChanged || state.git?.head_sha !== head || forceFreshReview,
    resetRounds: state.review?.verdict === "pass" && (upstreamChanged || forceFreshReview),
  };
}

function prepareReviewBase(state) {
  requireCleanWorktree("ds-l close");
  const branch = currentBranch();
  if (!branch) fail("ds-l close 不支持 detached HEAD。");
  if (branch === "main") fail("ds-l close 必须在任务 worktree 分支运行，不能直接在 main 上运行。");

  runGitStep(["fetch", "origin"], "git fetch origin");
  const upstream = gitText(["rev-parse", "origin/main"], "读取 origin/main");
  const rebase = runGit(["rebase", "origin/main"]);
  if (rebase.error || (rebase.status ?? 1) !== 0) {
    saveState(state, {
      phase: "blocked",
      status: "blocked",
      latest_error: "git rebase origin/main 失败；解决冲突并提交后重新运行 ds-l close。",
      delivery: { ...state.delivery, status: "rebase_conflict" },
      next_recommended_command: "ds-l close",
    });
    fail(`git rebase origin/main failed\n${rebase.error?.message || rebase.stderr || rebase.stdout}`);
  }

  requireCleanWorktree("rebase 后审核");
  const head = currentHead();
  const { stale, resetRounds } = reviewInvalidation(state, upstream, head, true);
  return saveState(state, {
    git: {
      ...state.git,
      review_base_sha: upstream,
      head_sha: head,
      audited_upstream_sha: stale ? null : state.git?.audited_upstream_sha,
    },
    review: stale
      ? {
          ...state.review,
          verdict: null,
          summary: null,
          needs: [],
          findings: [],
          audited_head_sha: null,
          skipped: false,
          round: resetRounds ? 0 : state.review?.round || 0,
          fix_iteration: resetRounds ? 0 : state.review?.fix_iteration || 0,
        }
      : state.review,
    delivery: {
      ...state.delivery,
      bugfix: bugfix || state.delivery?.bugfix || false,
      status: "reviewing",
    },
    next_recommended_command: "ds-l close",
  });
}

function markReviewSkipped(state, evidence) {
  const summary = `单文件且代码改动 ${evidence.stats.added + evidence.stats.deleted} 行，按规则跳过审核。`;
  writeText(
    latestPaths.review,
    reviewMarkdown({
      verdict: "pass",
      summary,
      findings: [],
      base: evidence.base,
      head: evidence.head,
      skipped: true,
    }),
  );
  return saveState(state, {
    phase: "review",
    status: "active",
    review: {
      ...state.review,
      verdict: "pass",
      summary,
      needs: [],
      findings: [],
      audited_head_sha: evidence.head,
      skipped: true,
    },
    git: {
      ...state.git,
      head_sha: evidence.head,
      audited_upstream_sha: evidence.base,
    },
  });
}

function finalizeClose(state) {
  const isBugfix = bugfix || state.delivery?.bugfix || false;
  const status = isBugfix ? "awaiting_user_validation" : "ready_to_merge";
  const next = isBugfix ? "ds-l merge --verified" : "ds-l merge";
  const nextState = saveState(state, {
    phase: "closed",
    status: "active",
    delivery: { ...state.delivery, bugfix: isBugfix, status },
    next_recommended_command: next,
  });
  console.log(`完成：${state.title || state.original_request || "DS task"}`);
  console.log(`Next: ${next}\n`);
  return nextState;
}

async function commandClose() {
  let state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l spec "需求"');
  if (bugfix || forceReview) {
    state = saveState(state, {
      delivery: { ...state.delivery, bugfix: bugfix || state.delivery?.bugfix || false },
      review: {
        ...state.review,
        explicitly_requested: forceReview || state.review?.explicitly_requested || false,
      },
    });
  }
  const resumableRebase = state.delivery?.status === "rebase_conflict";
  if (
    state.phase === "running" ||
    (state.phase === "blocked" && !resumableRebase) ||
    (state.phase === "fix" && state.status === "blocked") ||
    ["implementing", "blocked", "not_started"].includes(state.delivery?.status)
  ) {
    fail("实现尚未成功完成，不能进入 ds-l close。");
  }
  state = prepareReviewBase(state);
  let head = currentHead();
  const evidence = commitRangeInputs(state.git?.review_base_sha, head);
  const explicitlyRequested =
    forceReview || state.review?.explicitly_requested || /审核|review/i.test(state.original_request || "");

  if (
    state.review?.verdict !== "pass" &&
    (state.review?.round || 0) === 0 &&
    evidence.stats.can_skip_review &&
    !explicitlyRequested
  ) {
    state = markReviewSkipped(state, evidence);
  }

  while (
    state.review?.verdict !== "pass" ||
    state.review?.audited_head_sha !== head ||
    state.git?.audited_upstream_sha !== state.git?.review_base_sha
  ) {
    if (state.phase === "review" && state.review?.verdict === "needs_fix") {
      const maxFixes = state.limits?.max_fix_iterations || 5;
      if ((state.review?.fix_iteration || 0) >= maxFixes) {
        fail(`修复复审已达到最多 ${maxFixes} 轮，仍有 blocker/high/medium，请人工处理。`);
      }
      state = commandFix();
    } else {
      state = await commandReview({ explicit: false });
    }
    head = currentHead();
  }

  return finalizeClose(state);
}

function mainWorktreePath() {
  const output = gitText(["worktree", "list", "--porcelain"], "读取 git worktree");
  for (const record of output.split("\n\n")) {
    const lines = record.split("\n");
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7);
    if (worktree && branch === "refs/heads/main") return worktree;
  }
  fail("找不到检出 main 分支的 worktree，无法执行 ff-only 合回。");
}

function commandMerge() {
  const state = readState();
  if (!state) fail('没有 latest state。请先运行: ds-l close');
  requireCleanWorktree("ds-l merge");
  const branch = currentBranch();
  if (!branch || branch === "main") fail("ds-l merge 必须从任务 worktree 分支运行。");
  if (
    state.phase !== "closed" ||
    !["ready_to_merge", "awaiting_user_validation"].includes(state.delivery?.status)
  ) {
    fail("当前任务尚未完成 ds-l close，不能合回 main。");
  }
  const head = currentHead();
  if (state.review?.verdict !== "pass" || state.review?.audited_head_sha !== head) {
    fail("当前 HEAD 未通过最终审核，请先运行 ds-l close。");
  }
  if (state.delivery?.bugfix && !verified) {
    fail("bugfix 必须由用户确认验证通过后运行: ds-l merge --verified");
  }

  runGitStep(["fetch", "origin"], "git fetch origin");
  const upstream = gitText(["rev-parse", "origin/main"], "读取 origin/main");
  const alreadyPushed = upstream === head;
  if (!alreadyPushed && upstream !== state.git?.audited_upstream_sha) {
    saveState(state, {
      delivery: { ...state.delivery, status: "upstream_changed" },
      next_recommended_command: state.delivery?.bugfix ? "ds-l close --bugfix" : "ds-l close",
    });
    fail("origin/main 在最终审核后发生变化；请重新运行 ds-l close，复审后再合回。");
  }

  const mainPath = mainWorktreePath();
  requireCleanWorktree("main worktree 合回", mainPath);
  const mainHead = gitText(["rev-parse", "HEAD"], "读取 main HEAD", mainPath);
  if ((runGit(["merge-base", "--is-ancestor", mainHead, head], mainPath).status ?? 1) !== 0) {
    fail("本地 main 无法 ff-only 到审核 HEAD，请先处理 main 分支状态。");
  }
  if (!alreadyPushed) {
    runGitStep(["push", "origin", `${head}:refs/heads/main`], "push audited HEAD to origin/main", mainPath);
  }
  runGitStep(["merge", "--ff-only", head], `main ff-only merge audited HEAD ${head}`, mainPath);
  saveState(state, {
    phase: "merged",
    status: "completed",
    delivery: { ...state.delivery, status: "pushed", user_verified: Boolean(verified) },
    next_recommended_command: "ds-l report",
  });
  console.log(`完成：${state.title || state.original_request || branch} 已 ff-only 合回 main 并 push。`);
}

function reportNextCommand(verdict) {
  if (verdict === "pass") return "Phase 3A report completed";
  if (verdict === "needs_fix") return "ds-l fix";
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
  const workspaceInputs = workspaceReviewInputs();

  const parsed = await callDeepSeekJson(
    "report",
    `${baseSystemPrompt}

当前阶段：report。
你必须生成最终报告，不要生成 fix 方案，不要自动调用 Codex，不要设计自动循环。
报告证据规则：
- Current workspace evidence is authoritative.
- Current file contents override Worker last-message and drive logs.
- Worker last-message is historical and may be stale.
- If current file contents conflict with acceptance, report the final conclusion as needs_fix/blocked even if Worker logs claim success.
- Do not write a completed/pass final conclusion based only on Worker summary if current workspace evidence contradicts it.
- If current workspace evidence includes untracked file contents, review those contents before historical Worker logs.
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

${formatCurrentWorkspaceEvidence(workspaceInputs)}

review.md:

${review}

worker.prompt.md:

${workerPrompt}

${formatHistoricalWorkerLogs({ workerLastMessage, workerStderr })}

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
3. verdict=needs_fix 时说明可手动运行 ds-l fix，并引导查看 review.md。
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
  const latestError = formatLatestError(state.latest_error);
  if (latestError) console.log(`latest_error: ${latestError}`);

  console.log("\nArtifacts:");
  console.log(artifactLine("spec", latestPaths.spec));
  console.log(artifactLine("plan", latestPaths.plan));
  console.log(artifactLine("task", latestPaths.task));
  console.log(artifactLine("acceptance", latestPaths.acceptance));
  console.log(artifactLine("worker_prompt", latestPaths.workerPrompt));
  console.log(artifactLine("review", latestPaths.review));
  console.log(artifactLine("report", latestPaths.report));
  console.log(artifactLine("fix_prompt", latestPaths.fixPrompt));
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

function runSelfTest() {
  assert.equal(driveIncomplete({ active: false, stop_reason: "completed", last_exit_code: 0 }), false);
  assert.equal(driveIncomplete({ active: false, stop_reason: "waiting_for_user", last_exit_code: 0 }), true);
  assert.equal(driveIncomplete({ active: false, stop_reason: "completed", last_exit_code: 1 }), true);
  assert.equal(driveIncomplete(null), true);
  assert.equal(rejectedAllFindings({ latest_message: noChangeAdjudication }), true);
  assert.equal(rejectedAllFindings({ latest_message: "fixed" }), false);
  assert.deepEqual(summarizeChangeStats("a.js\0", "5\t5\ta.js"), {
    files: ["a.js"],
    added: 5,
    deleted: 5,
    binary: false,
    can_skip_review: true,
  });
  assert.equal(summarizeChangeStats("a.js\0b.js\0", "1\t0\ta.js\n1\t0\tb.js").can_skip_review, false);
  assert.equal(summarizeChangeStats("a.js\0", "11\t0\ta.js").can_skip_review, false);
  assert.equal(summarizeChangeStats("image.png\0", "-\t-\timage.png").can_skip_review, false);
  assert.equal(
    normalizeFindings([
      {
        severity: "high",
        title: "broken",
        file: "a.js",
        line: 1,
        evidence: "fact",
        task_impact: "fails",
      },
    ])[0].severity,
    "high",
  );
  const reviewed = {
    git: { review_base_sha: "base", head_sha: "head" },
    review: { verdict: "pass", round: 5 },
  };
  assert.deepEqual(reviewInvalidation(reviewed, "base", "head", true), {
    stale: true,
    resetRounds: true,
  });
  assert.deepEqual(reviewInvalidation(reviewed, "new-base", "new-head"), {
    stale: true,
    resetRounds: true,
  });
  assert.deepEqual(
    reviewInvalidation({ ...reviewed, review: { verdict: "needs_fix", round: 5 } }, "base", "head", true),
    { stale: false, resetRounds: false },
  );
  console.log("ds-l self-test: pass");
}

async function main() {
  if (selfTest) {
    runSelfTest();
    return;
  }
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

  if (command === "close") {
    await commandClose();
    return;
  }

  if (command === "merge") {
    commandMerge();
    return;
  }

  if (command === "report") {
    await commandReport();
    return;
  }

  if (command === "fix") {
    commandFix();
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
  console.error(error?.userFacing ? error.message : error?.stack || error?.message || error);
  process.exit(1);
});
