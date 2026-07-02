#!/usr/bin/env node
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(packRoot, "cc-leader.manifest.json"), "utf8"));
const stateFileDefault = path.join(root, ".cc-leader", "session.json");
const driveStateFileDefault = path.join(root, ".cc-leader", "drive-state.json");
const heldLocks = new Set();
const detachedRunnerCommand = "__run-detached-job";
const detachedDriveCommand = "__run-detached-drive";
const runMetaFileName = "job.json";
const driveMetaFileName = "drive.json";
const logPollIntervalMs = 250;
const defaultDriveContinuePrompt =
  "继续工作。不要停下来询问我是否继续，除非遇到真实 blocker、缺失关键输入、需要用户业务决策，或需要越出当前工作目录/约束。";

function registerLock(lockPath) {
  heldLocks.add(lockPath);
}

function releaseLock(lockPath) {
  heldLocks.delete(lockPath);
}

function releaseAllLocks() {
  for (const lockPath of heldLocks) {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {}
  }
  heldLocks.clear();
}

process.on("SIGINT", () => {
  releaseAllLocks();
  process.exit(130);
});

process.on("SIGTERM", () => {
  releaseAllLocks();
  process.exit(143);
});

function printHelp() {
  console.log(`CC Leader Harness

命令:
  init [--workflow-id <id>] [--slug <slug>] [--state-file <path>] [--force]
  state:get [--state-file <path>]
  state:set [--state-file <path>] --set key=value [--set key=value ...]
  resolve-phase [--state-file <path>]
  job:status [--state-file <path>] [--job-id <id>]
  drive [--drive-state-file <path>] [--timeout-seconds <n>] [--max-auto-continue <n>] [--continue-prompt <text>] [--title <slug>] [--worker codex|claude] [--model <model>] [--effort low|medium|high|xhigh|max] [prompt]
  report [--state-file <path>] [--final-report-path <path>]
  run [--state-file <path>] [--write-scope <path>] [--timeout-seconds <n>] [--worker codex|claude] [--model <model>] [--effort low|medium|high|xhigh|max]
  work [--state-file <path>] [--write-scope <path>] [--timeout-seconds <n>] [--worker codex|claude] [--model <model>] [--effort low|medium|high|xhigh|max]
  prepare-job --job <name> [--state-file <path>] [--phase-id <id>] [--write-scope <path>] [--phase-review-path <path> ...] [--override key=value ...]
  dispatch --job <name> [--state-file <path>] [--phase-id <id>] [--write-scope <path>] [--phase-review-path <path> ...] [--override key=value ...] [--timeout-seconds <n>] [--worker codex|claude] [--model <model>] [--effort low|medium|high|xhigh|max] [--dry-run] [--allow-after-revise-cap]
    --worker: worker 类型 (默认 codex). codex: OpenAI Codex CLI; claude: Claude Code CLI
    --model: 模型名或别名 (codex: -m <model>; claude: --model <model>)
    --effort: effort 级别 (claude 专用: low|medium|high|xhigh|max; codex 忽略)
    --allow-after-revise-cap: 仅用于 specAdversarialReview. spec_review_revise_count >= 2 时旁路一次硬 gate; 必须由用户明确授权才能加.
`);
}

function fail(message, code = 1) {
  console.error(message);
  releaseAllLocks();
  process.exit(code);
}

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      i += 1;
      continue;
    }
    const key = token.slice(2);
    if (["force", "dry-run", "allow-after-revise-cap"].includes(key)) {
      args[key] = true;
      i += 1;
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      fail(`缺少参数值: --${key}`);
    }
    if (key === "set" || key === "override" || key === "phase-review-path") {
      args[key] ??= [];
      args[key].push(next);
    } else {
      args[key] = next;
    }
    i += 2;
  }
  return args;
}

function repoRel(p) {
  return path.relative(root, p).split(path.sep).join("/");
}

function abs(p) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function packAbs(p) {
  return path.isAbsolute(p) ? p : path.join(packRoot, p);
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function fileExists(p) {
  return existsSync(abs(p));
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(abs(filePath), "utf8"));
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(abs(filePath)));
  writeFileSync(abs(filePath), `${JSON.stringify(value, null, 2)}\n`);
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateState(state) {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    fail(`state 类型错误: 期望 object，实际 ${describeType(state)}`);
  }

  const checks = [
    ["workflow_id", (value) => value === null || typeof value === "string", "string|null"],
    ["current_phase", (value) => typeof value === "string", "string"],
    ["spec_approved", (value) => typeof value === "boolean", "boolean"],
    ["spec_review_passed", (value) => typeof value === "boolean", "boolean"],
    [
      "spec_review_revise_count",
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      "number >= 0",
    ],
    ["phase_plan_review_passed", (value) => typeof value === "boolean", "boolean"],
    ["ready_phase_ids", (value) => Array.isArray(value), "array"],
    ["completed_phase_ids", (value) => Array.isArray(value), "array"],
    ["reviewed_phase_ids", (value) => Array.isArray(value), "array"],
    [
      "job_attempts",
      (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      "object",
    ],
  ];

  for (const [field, check, expected] of checks) {
    if (!check(state[field])) {
      fail(`state 字段类型错误: ${field}, 期望 ${expected}，实际 ${describeType(state[field])}`);
    }
  }

  return state;
}

function readState(stateFile) {
  const target = abs(stateFile);
  if (!existsSync(target)) {
    return validateState(structuredClone(manifest.sessionState.initialState));
  }
  return validateState(JSON.parse(readFileSync(target, "utf8")));
}

function saveState(stateFile, state) {
  writeJsonFile(stateFile, state);
}

function defaultDriveState() {
  return {
    active_drive_id: null,
    last_drive_id: null,
    last_notified_milestone_seq: 0,
    updated_at: null,
  };
}

function readDriveState(stateFile = driveStateFileDefault) {
  const target = abs(stateFile);
  if (!existsSync(target)) {
    return defaultDriveState();
  }

  const state = JSON.parse(readFileSync(target, "utf8"));
  return {
    active_drive_id: typeof state.active_drive_id === "string" ? state.active_drive_id : null,
    last_drive_id: typeof state.last_drive_id === "string" ? state.last_drive_id : null,
    last_notified_milestone_seq:
      Number.isInteger(state.last_notified_milestone_seq) && state.last_notified_milestone_seq >= 0
        ? state.last_notified_milestone_seq
        : 0,
    updated_at: typeof state.updated_at === "string" ? state.updated_at : null,
  };
}

function saveDriveState(stateFile, state) {
  writeJsonFile(stateFile, state);
}

function parseScalar(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function applySets(target, sets = []) {
  for (const entry of sets) {
    const eq = entry.indexOf("=");
    if (eq === -1) fail(`无效 key=value: ${entry}`);
    const key = entry.slice(0, eq);
    const raw = entry.slice(eq + 1);
    target[key] = parseScalar(raw);
  }
  return target;
}

function slugify(input) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "workflow";
}

function timestampParts(date = new Date()) {
  const iso = date.toISOString();
  const ymd = iso.slice(0, 10).replace(/-/g, "");
  const hms = iso.slice(11, 19).replace(/:/g, "");
  return { iso, ymd, hms };
}

function generateWorkflowId(slug = "workflow") {
  const { ymd } = timestampParts();
  return `wf-${slugify(slug)}-${ymd}-${randomBytes(2).toString("hex")}`;
}

function deriveArtifactPath(artifactName, id) {
  const artifact = manifest.artifacts[artifactName];
  if (!artifact) fail(`未知 artifact: ${artifactName}`);
  return path.join(root, artifact.defaultDirectory, `${id}.md`);
}

function ensureWorkflowId(state, slug, explicitId = null) {
  if (explicitId) {
    state.workflow_id = explicitId;
    state.override_log_path ??= repoRel(deriveArtifactPath("overrideLog", state.workflow_id));
    return state.workflow_id;
  }
  if (state.workflow_id) return state.workflow_id;
  state.workflow_id = generateWorkflowId(slug);
  state.override_log_path ??= repoRel(deriveArtifactPath("overrideLog", state.workflow_id));
  return state.workflow_id;
}

function createJobId(jobName, phaseId = null) {
  const { ymd, hms } = timestampParts();
  const scope = phaseId ?? "global";
  return `job-${slugify(jobName)}-${slugify(scope)}-${ymd}t${hms}z`;
}

function createDriveId(title = "drive") {
  const { ymd, hms } = timestampParts();
  return `drive-${slugify(title)}-${ymd}t${hms}z-${randomBytes(2).toString("hex")}`;
}

function parsePhaseIdsFromPlan(planPath) {
  if (!planPath || !fileExists(planPath)) return [];
  const text = readFileSync(abs(planPath), "utf8");
  // 排除后接文件扩展名的匹配（如 phase-01-foo-result.md），避免 artifact 文件名被当成 phase id
  const matches = [...text.matchAll(/phase-[0-9]{1,2}-[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?![a-zA-Z0-9-]|\.[a-zA-Z0-9])/g)];
  const raw = [...new Set(matches.map((m) => m[0]))];
  const validPattern = new RegExp(manifest.naming.phaseIdPattern);
  const invalid = raw.filter((id) => !validPattern.test(id));
  if (invalid.length > 0) {
    fail(
      `phase_id 格式不合法: ${invalid.join(", ")}\n` +
      `要求: ${manifest.naming.phaseIdPattern}\n` +
      `示例: phase-01-core-todo`,
    );
  }
  return raw;
}

function extractSection(filePath, heading) {
  if (!filePath || !fileExists(filePath)) return null;
  const lines = readFileSync(abs(filePath), "utf8").split("\n");
  const targetHeading = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === targetHeading);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }

  return lines.slice(start + 1, end).join("\n").trim() || null;
}

const INLINE_SIZE_CAP_BYTES = 64 * 1024;

function inlineFenceMarkdown(absPath, body) {
  return `<!-- inline: ${absPath} -->\n\`\`\`markdown\n${body}\n\`\`\``;
}

function readArtifactInline(filePath, label) {
  if (!filePath) return `(${label} 路径未提供)`;
  const absPath = abs(filePath);
  if (!fileExists(absPath)) {
    return `(${label} 文件缺失: ${absPath} — 必要时用 shell 读取核实)`;
  }
  const text = readFileSync(absPath, "utf8");
  if (Buffer.byteLength(text, "utf8") > INLINE_SIZE_CAP_BYTES) {
    process.stderr.write(
      `warn: ${label} 内容超 ${INLINE_SIZE_CAP_BYTES} 字节, 回退到路径模式: ${absPath}\n`,
    );
    return `(${label} 内容超出内联上限 ${INLINE_SIZE_CAP_BYTES} 字节, 直接读路径: ${absPath})`;
  }
  return inlineFenceMarkdown(absPath, text.replace(/\n+$/, ""));
}

function extractPhaseBlock(planPath, phaseId) {
  if (!planPath || !fileExists(planPath)) {
    return `(phase plan 缺失: ${planPath ?? "(未传)"} — 用 shell 读取核实)`;
  }
  if (!phaseId) return `(未指定 phase_id)`;
  const lines = readFileSync(abs(planPath), "utf8").split("\n");
  const escapedId = phaseId.replace(/[.*+?^${}()|[\\\]]/g, "\\$&");
  const headingRe = new RegExp(`^###\\s.*${escapedId}`);
  let start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) {
    // Fallback: find a ### section that contains "phase_id: <phaseId>" in its body
    const fieldRe = new RegExp(`phase_id:\\s+\`?${escapedId}\`?`);
    const fieldIdx = lines.findIndex((line) => fieldRe.test(line));
    if (fieldIdx !== -1) {
      for (let i = fieldIdx - 1; i >= 0; i -= 1) {
        if (lines[i].startsWith("### ")) { start = i; break; }
      }
    }
  }
  if (start === -1) {
    return `(phase plan 中未找到 ${phaseId} 的 \`### 阶段\` 块 — 用 shell 在 ${abs(planPath)} 里查)`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("### ") || line.startsWith("## ")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join("\n").trim();
  if (!body) return `(${phaseId} 块为空)`;
  return inlineFenceMarkdown(abs(planPath), body);
}

function extractSpecSummary(specPath) {
  if (!specPath || !fileExists(specPath)) {
    return `(spec 缺失: ${specPath ?? "(未传)"} — 用 shell 读取核实)`;
  }
  const wanted = ["目标", "约束", "成功标准"];
  const parts = [];
  for (const heading of wanted) {
    const body = extractSection(abs(specPath), heading);
    if (body) parts.push(`## ${heading}\n\n${body}`);
  }
  if (parts.length === 0) {
    return `(spec 未找到任何 ${wanted.join(" / ")} section — 直接读 ${abs(specPath)})`;
  }
  return inlineFenceMarkdown(abs(specPath), parts.join("\n\n"));
}

function concatPhaseReviews(reviewPaths) {
  if (!Array.isArray(reviewPaths) || reviewPaths.length === 0) {
    return `(无 phase review 输入)`;
  }
  const blocks = reviewPaths.map((reviewPath) =>
    readArtifactInline(reviewPath, `phase review ${reviewPath}`),
  );
  return blocks.join("\n\n---\n\n");
}

function readStatusFromMarkdown(filePath) {
  if (!filePath || !fileExists(filePath)) return null;
  const raw = readMarkdownField(filePath, "status");
  if (!raw) return null;
  const value = raw.replace(/^[`"']|[`"']$/g, "").trim().toLowerCase();
  if (!value || value.includes("|")) return null;
  return value;
}

function resolvePhase(state) {
  if (!state.spec_approved || !state.spec_review_passed) return "drafting-specs";
  if (!state.phase_plan_list_path || !state.phase_plan_review_passed) return "writing-phase-plans";

  const allPhaseIds = parsePhaseIdsFromPlan(state.phase_plan_list_path);
  const pendingReview = (state.completed_phase_ids ?? []).filter(
    (phaseId) => !(state.reviewed_phase_ids ?? []).includes(phaseId),
  );
  if (pendingReview.length > 0) return "reviewing-phase-results";

  const allReviewed =
    allPhaseIds.length > 0 && allPhaseIds.every((phaseId) => (state.reviewed_phase_ids ?? []).includes(phaseId));

  if (allReviewed) {
    const finalVerdict = readStatusFromMarkdown(state.final_spec_review_path);
    if (finalVerdict !== "pass") return "reviewing-phase-results";
    if (!state.final_report_path) return "reporting-results";
    return "reporting-results";
  }

  const remainingReady = (state.ready_phase_ids ?? []).filter(
    (phaseId) => !(state.completed_phase_ids ?? []).includes(phaseId),
  );
  if (remainingReady.length > 0) return "executing-phase-tasks";

  return "writing-phase-tasks";
}

function uniq(items) {
  return [...new Set(items)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStateLock(stateFile, fn) {
  const lockDir = `${abs(stateFile)}.lock`;
  const timeoutAt = Date.now() + 30000;
  let clearedStaleLock = false;

  while (true) {
    try {
      mkdirSync(lockDir);
      registerLock(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 30 * 1000 && !clearedStaleLock) {
          console.warn("warn: State lock 已超 30 秒, 疑似残留, 自动清理");
          rmSync(lockDir, { recursive: true, force: true });
          clearedStaleLock = true;
          continue;
        }
      } catch {
        // ignore stat/rm race and fall back to normal wait loop
      }
      if (Date.now() > timeoutAt) {
        fail(`获取 state lock 超时: ${stateFile}`);
      }
      await sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } finally {
      releaseLock(lockDir);
    }
  }
}

function readMarkdownField(filePath, field) {
  if (!existsSync(abs(filePath))) return null;
  const text = readFileSync(abs(filePath), "utf8");
  const pattern = new RegExp(`^- ${field}: (.+)$`, "m");
  return text.match(pattern)?.[1]?.trim() ?? null;
}

function captureFileSnapshot(filePath) {
  const target = abs(filePath);
  if (!existsSync(target)) {
    return { exists: false, size: -1, mtimeMs: -1 };
  }
  const stat = statSync(target);
  return {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function didFileChangeSince(snapshot, filePath) {
  const next = captureFileSnapshot(filePath);
  if (!snapshot.exists && next.exists) return true;
  if (snapshot.exists !== next.exists) return true;
  return snapshot.size !== next.size || snapshot.mtimeMs !== next.mtimeMs;
}

function toRepoRelativeIfInsideRoot(target) {
  const absolute = abs(target);
  if (!absolute.startsWith(root)) return absolute;
  return repoRel(absolute);
}

function resolvePhaseArtifactPath(dirPath, phaseId, suffix) {
  const candidates = [];

  if (dirPath) {
    const baseDir = abs(dirPath);
    candidates.push(path.join(baseDir, `${phaseId}.md`));
    candidates.push(path.join(baseDir, `${phaseId}-${suffix}.md`));
  }

  const artifactName = suffix === "result" ? "phaseResult" : "phaseReview";
  candidates.push(abs(deriveArtifactPath(artifactName, phaseId)));

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? null;
}

function selectNextJob(phase, state) {
  const allPhaseIds = parsePhaseIdsFromPlan(state.phase_plan_list_path);
  const readyPhaseIds = new Set(state.ready_phase_ids ?? []);
  const completedPhaseIds = new Set(state.completed_phase_ids ?? []);
  const reviewedPhaseIds = new Set(state.reviewed_phase_ids ?? []);

  if (phase === "drafting-specs" && state.spec_approved && !state.spec_review_passed) {
    return { jobName: "specAdversarialReview" };
  }

  if (phase === "writing-phase-plans") {
    return { jobName: "phasePlanSynthesis" };
  }

  if (phase === "writing-phase-tasks") {
    const phaseId = allPhaseIds.find((id) => !readyPhaseIds.has(id));
    return phaseId ? { jobName: "phaseTaskSynthesis", phaseId } : null;
  }

  if (phase === "executing-phase-tasks") {
    const phaseId = allPhaseIds.find((id) => readyPhaseIds.has(id) && !completedPhaseIds.has(id));
    return phaseId ? { jobName: "phaseExecution", phaseId } : null;
  }

  if (phase === "reviewing-phase-results") {
    const phaseId = allPhaseIds.find((id) => completedPhaseIds.has(id) && !reviewedPhaseIds.has(id));
    if (phaseId) {
      return { jobName: "phaseReview", phaseId };
    }

    const allReviewed =
      allPhaseIds.length > 0 && allPhaseIds.every((id) => reviewedPhaseIds.has(id));
    if (!allReviewed || readStatusFromMarkdown(state.final_spec_review_path) === "pass") {
      return null;
    }

    return {
      jobName: "finalSpecReview",
      phaseReviewPaths: allPhaseIds
        .filter((id) => reviewedPhaseIds.has(id))
        .map((id) => resolvePhaseArtifactPath(state.phase_review_dir, id, "review")),
    };
  }

  return null;
}

function resolveTransportConfig(args) {
  return {
    worker_kind: args["worker"] ?? "codex",
    model: args["model"] ?? null,
    effort: args["effort"] ?? null,
  };
}

function buildWorkerSpawn(transport, mode, { outputFile, threadId, prompt }) {
  if (transport.worker_kind === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--dangerously-skip-permissions"];
    if (transport.model) args.push("--model", transport.model);
    if (transport.effort) args.push("--effort", transport.effort);
    if (mode === "drive_resume" && threadId) args.push("--resume", threadId);
    args.push(prompt);
    return { binary: "claude", args };
  }
  // codex
  const { binary, subcommand: sub, approvalBypassFlag: bypass } = manifest.transport.command;
  if (mode === "worker_job") {
    const cmdArgs = [sub, "--json", bypass];
    if (transport.model) cmdArgs.push("-m", transport.model);
    cmdArgs.push(prompt);
    return { binary, args: cmdArgs };
  }
  if (mode === "drive_start") {
    const cmdArgs = [sub, "--json", "-o", outputFile, bypass];
    if (transport.model) cmdArgs.push("-m", transport.model);
    cmdArgs.push(prompt);
    return { binary, args: cmdArgs };
  }
  // drive_resume
  const cmdArgs = [sub, "resume", "--json", "-o", outputFile, bypass];
  if (transport.model) cmdArgs.push("-m", transport.model);
  cmdArgs.push(threadId, prompt);
  return { binary, args: cmdArgs };
}

function buildRunDispatchArgs(runArgs, selection) {
  const dispatchArgs = {};

  if (runArgs["timeout-seconds"] != null) {
    dispatchArgs["timeout-seconds"] = runArgs["timeout-seconds"];
  }

  if (selection.phaseId) {
    dispatchArgs["phase-id"] = selection.phaseId;
  }

  if (selection.jobName === "phaseExecution" && runArgs["write-scope"]) {
    dispatchArgs["write-scope"] = runArgs["write-scope"];
  }

  if (selection.jobName === "finalSpecReview") {
    dispatchArgs["phase-review-path"] = selection.phaseReviewPaths;
  }

  if (runArgs["worker"] != null) dispatchArgs["worker"] = runArgs["worker"];
  if (runArgs["model"] != null) dispatchArgs["model"] = runArgs["model"];
  if (runArgs["effort"] != null) dispatchArgs["effort"] = runArgs["effort"];

  return dispatchArgs;
}

function buildJobContext(jobName, state, args) {
  const workflowId = ensureWorkflowId(state, args.slug ?? path.basename(root), args["workflow-id"] ?? null);
  const phaseId = args["phase-id"] ?? null;
  const job = manifest.workerJobs[jobName];
  if (!job) fail(`未知 job: ${jobName}`);

  const jobId = createJobId(jobName, phaseId);
  const runDir = path.join(root, manifest.runtime.runRootDirectory, workflowId, jobId);
  const promptFile = path.join(runDir, "prompt.md");
  const stdoutLog = path.join(runDir, "stdout.jsonl");
  const stderrLog = path.join(runDir, "stderr.log");
  const resultFile = path.join(runDir, "result.json");

  const derived = {
    repo_root: root,
    workflow_id: workflowId,
    job_id: jobId,
    result_file_path: resultFile,
  };

  const specPath = args["spec-path"] ?? state.spec_path ?? deriveArtifactPath("spec", workflowId);
  const specReviewPath =
    args["spec-review-path"] ?? state.spec_review_path ?? deriveArtifactPath("specReview", workflowId);
  const phasePlanListPath =
    args["phase-plan-list-path"] ?? state.phase_plan_list_path ?? deriveArtifactPath("phasePlanList", workflowId);
  const finalSpecReviewPath =
    args["final-spec-review-path"] ??
    state.final_spec_review_path ??
    deriveArtifactPath("finalSpecReview", workflowId);

  if (jobName === "specAdversarialReview") {
    const hasPrev = existsSync(abs(specReviewPath));
    Object.assign(derived, {
      spec_path: abs(specPath),
      spec_review_path: abs(specReviewPath),
      previous_review_path: hasPrev ? abs(specReviewPath) : "(无上轮 review)",
      spec_content: readArtifactInline(abs(specPath), "spec"),
      previous_review_content: hasPrev
        ? readArtifactInline(abs(specReviewPath), "previous review")
        : "(无上轮 review)",
    });
  }

  if (jobName === "phasePlanSynthesis") {
    Object.assign(derived, {
      spec_path: abs(specPath),
      phase_plan_list_path: abs(phasePlanListPath),
      spec_content: readArtifactInline(abs(specPath), "spec"),
    });
  }

  if (jobName === "phaseTaskSynthesis") {
    if (!phaseId) fail("phaseTaskSynthesis 需要 --phase-id");
    Object.assign(derived, {
      phase_id: phaseId,
      spec_path: abs(specPath),
      phase_plan_list_path: abs(phasePlanListPath),
      phase_task_list_path: abs(
        args["phase-task-list-path"] ?? deriveArtifactPath("phaseTaskList", phaseId),
      ),
      spec_summary_content: extractSpecSummary(abs(specPath)),
      phase_plan_block_content: extractPhaseBlock(abs(phasePlanListPath), phaseId),
    });
  }

  if (jobName === "phaseExecution") {
    if (!phaseId) fail("phaseExecution 需要 --phase-id");
    if (!args["write-scope"]) fail("phaseExecution 需要 --write-scope");
    const phaseTaskListPath = abs(
      args["phase-task-list-path"] ?? deriveArtifactPath("phaseTaskList", phaseId),
    );
    Object.assign(derived, {
      phase_id: phaseId,
      phase_task_list_path: phaseTaskListPath,
      phase_result_path: abs(args["phase-result-path"] ?? deriveArtifactPath("phaseResult", phaseId)),
      write_scope: args["write-scope"],
      phase_task_list_content: readArtifactInline(phaseTaskListPath, "phase task list"),
    });
  }

  if (jobName === "phaseReview") {
    if (!phaseId) fail("phaseReview 需要 --phase-id");
    const phaseTaskListPath = abs(
      args["phase-task-list-path"] ?? deriveArtifactPath("phaseTaskList", phaseId),
    );
    const phaseResultPath = abs(args["phase-result-path"] ?? deriveArtifactPath("phaseResult", phaseId));
    Object.assign(derived, {
      phase_id: phaseId,
      phase_plan_list_path: abs(phasePlanListPath),
      phase_task_list_path: phaseTaskListPath,
      phase_result_path: phaseResultPath,
      phase_review_path: abs(args["phase-review-path-output"] ?? deriveArtifactPath("phaseReview", phaseId)),
      phase_plan_block_content: extractPhaseBlock(abs(phasePlanListPath), phaseId),
      phase_task_list_content: readArtifactInline(phaseTaskListPath, "phase task list"),
      phase_result_content: readArtifactInline(phaseResultPath, "phase result"),
    });
  }

  if (jobName === "finalSpecReview") {
    const reviewPathList =
      args["phase-review-path"]?.map((p) => abs(p)) ??
      uniq((state.reviewed_phase_ids ?? []).map((phase) => abs(deriveArtifactPath("phaseReview", phase))));
    const reviewPaths = reviewPathList.length
      ? reviewPathList.map((p) => `  - \`${p}\``).join("\n")
      : "  - <none>";
    Object.assign(derived, {
      spec_path: abs(specPath),
      phase_plan_list_path: abs(phasePlanListPath),
      phase_review_paths: reviewPaths,
      final_spec_review_path: abs(finalSpecReviewPath),
      spec_content: readArtifactInline(abs(specPath), "spec"),
      phase_plan_list_content: readArtifactInline(abs(phasePlanListPath), "phase plan list"),
      phase_reviews_concat_content: concatPhaseReviews(reviewPathList),
    });
  }

  applySets(derived, args.override);

  const required = job.dispatch.requiredVariables;
  for (const key of required) {
    if (derived[key] == null || derived[key] === "") {
      fail(`${jobName}: 缺少必需变量 ${key}`);
    }
  }

  return {
    jobName,
    jobId,
    phaseId,
    workflowId,
    runDir,
    promptFile,
    stdoutLog,
    stderrLog,
    resultFile,
    variables: derived,
  };
}

function renderPrompt(promptPath, variables) {
  let text = readFileSync(packAbs(promptPath), "utf8");
  for (const [key, value] of Object.entries(variables)) {
    const literal = String(value);
    text = text.split(`{{${key}}}`).join(literal);
  }
  const unresolved = text.match(/{{[^}]+}}/g);
  if (unresolved) {
    fail(`prompt 仍有未替换变量: ${unresolved.join(", ")}`);
  }
  return text;
}

function ensureOutputDirectories(jobContext) {
  ensureDir(jobContext.runDir);
  for (const key of [
    "result_file_path",
    "spec_review_path",
    "phase_plan_list_path",
    "phase_task_list_path",
    "phase_result_path",
    "phase_review_path",
    "final_spec_review_path",
  ]) {
    if (jobContext.variables[key]) {
      ensureDir(path.dirname(abs(jobContext.variables[key])));
    }
  }
}

function driveRunsRoot() {
  return path.join(root, ".cc-leader", "drives");
}

function buildDriveContext(args) {
  const prompt = args.prompt ?? args._.slice(1).join(" ").trim();
  if (!prompt) {
    fail("drive 缺少 prompt；如要接管现有 drive，请不要传 prompt，并确保已有 active drive");
  }

  const title = args.title ?? prompt.slice(0, 48);
  const driveId = createDriveId(title);
  const runDir = path.join(driveRunsRoot(), driveId);
  return {
    driveId,
    prompt,
    title,
    runDir,
    promptFile: path.join(runDir, "prompt.md"),
    stdoutLog: path.join(runDir, "stdout.jsonl"),
    stderrLog: path.join(runDir, "stderr.log"),
    metaFile: path.join(runDir, driveMetaFileName),
    lastMessageFile: path.join(runDir, "last-message.txt"),
    currentAttemptOutputFile: path.join(runDir, "attempt-last-message.txt"),
  };
}

function driveMetaPath(input) {
  const runDir = typeof input === "string" ? input : input.runDir;
  return path.join(runDir, driveMetaFileName);
}

function runMetaPath(input) {
  const runDir = typeof input === "string" ? input : input.runDir;
  return path.join(runDir, runMetaFileName);
}

function buildDriveRecord(driveContext, args) {
  const { iso } = timestampParts();
  const timeoutSeconds =
    args["timeout-seconds"] != null ? Number(args["timeout-seconds"]) : manifest.transport.timeoutSeconds.default;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    fail("drive: timeout-seconds 必须是正数");
  }

  const maxAutoContinue =
    args["max-auto-continue"] != null ? Number(args["max-auto-continue"]) : 20;
  if (!Number.isInteger(maxAutoContinue) || maxAutoContinue < 0) {
    fail("drive: max-auto-continue 必须是非负整数");
  }

  return {
    schema_version: 1,
    mode: "drive",
    status: "launching",
    stop_reason: null,
    drive_id: driveContext.driveId,
    title: driveContext.title,
    user_prompt: driveContext.prompt,
    launched_at: iso,
    finished_at: null,
    prompt_file: driveContext.promptFile,
    stdout_log: driveContext.stdoutLog,
    stderr_log: driveContext.stderrLog,
    meta_file: driveContext.metaFile,
    drive_state_file: args["drive-state-file"] ?? driveStateFileDefault,
    last_message_file: driveContext.lastMessageFile,
    current_attempt_output_file: driveContext.currentAttemptOutputFile,
    timeout_seconds: timeoutSeconds,
    continue_prompt: args["continue-prompt"] ?? defaultDriveContinuePrompt,
    max_auto_continue: maxAutoContinue,
    auto_continue_count: 0,
    current_attempt: 0,
    milestone_seq: 0,
    latest_milestone: null,
    thread_id: null,
    transport: resolveTransportConfig(args),
    runner_pid: null,
    runner_started_at: null,
    codex_pid: null,
    codex_started_at: null,
    last_exit_code: null,
    last_error: null,
    timed_out: false,
    latest_message: null,
  };
}

function readDriveRecord(metaFile) {
  if (!metaFile || !existsSync(abs(metaFile))) return null;
  return readJsonFile(metaFile);
}

function writeDriveRecord(metaFile, record) {
  writeJsonFile(metaFile, record);
}

function findActiveDriveMetaFile(state) {
  if (!state.active_drive_id) return null;
  return path.join(driveRunsRoot(), state.active_drive_id, driveMetaFileName);
}

function findDriveMetaFileById(driveId) {
  if (!driveId) return null;
  return path.join(driveRunsRoot(), driveId, driveMetaFileName);
}

function buildJobRecord(jobContext, timeoutSeconds, attempt, beforeSnapshot, transport) {
  const { iso } = timestampParts();
  return {
    schema_version: 1,
    status: "launching",
    launched_at: iso,
    attempt,
    timeout_seconds: timeoutSeconds,
    workflow_id: jobContext.workflowId,
    job_name: jobContext.jobName,
    job_id: jobContext.jobId,
    phase_id: jobContext.phaseId,
    run_dir: jobContext.runDir,
    prompt_file: jobContext.promptFile,
    stdout_log: jobContext.stdoutLog,
    stderr_log: jobContext.stderrLog,
    result_file: jobContext.resultFile,
    meta_file: runMetaPath(jobContext),
    variables: jobContext.variables,
    recovery_snapshot: beforeSnapshot,
    transport: transport ?? { worker_kind: "codex", model: null, effort: null },
    runner_pid: null,
    runner_started_at: null,
    worker_pid: null,
    worker_started_at: null,
    finished_at: null,
    worker_exit_code: null,
    worker_error: null,
    timed_out: false,
  };
}

function readJobRecord(metaFile) {
  if (!metaFile || !existsSync(abs(metaFile))) return null;
  return readJsonFile(metaFile);
}

function writeJobRecord(metaFile, record) {
  writeJsonFile(metaFile, record);
}

function jobContextFromRecord(record) {
  return {
    jobName: record.job_name,
    jobId: record.job_id,
    phaseId: record.phase_id ?? null,
    workflowId: record.workflow_id,
    runDir: record.run_dir,
    promptFile: record.prompt_file,
    stdoutLog: record.stdout_log,
    stderrLog: record.stderr_log,
    resultFile: record.result_file,
    variables: record.variables ?? {},
  };
}

function findActiveJobMetaFile(state) {
  if (!state.workflow_id || !state.active_job_id) return null;
  return path.join(root, manifest.runtime.runRootDirectory, state.workflow_id, state.active_job_id, runMetaFileName);
}

function inferJobIdFromResultPath(resultFilePath) {
  if (!resultFilePath) return null;
  const normalized = resultFilePath.split(path.sep).join("/");
  const match = normalized.match(/\.cc-leader\/runs\/[^/]+\/([^/]+)\/result\.json$/);
  return match?.[1] ?? null;
}

function runDirForJob(workflowId, jobId) {
  return path.join(root, manifest.runtime.runRootDirectory, workflowId, jobId);
}

function formatPathForOutput(target) {
  if (!target) return null;
  const absolute = abs(target);
  return absolute.startsWith(root) ? repoRel(absolute) : absolute;
}

function describeFileStatus(filePath) {
  const absolute = abs(filePath);
  const exists = existsSync(absolute);
  if (!exists) {
    return {
      path: formatPathForOutput(absolute),
      exists: false,
      size: null,
      updated_at: null,
    };
  }

  const stat = statSync(absolute);
  return {
    path: formatPathForOutput(absolute),
    exists: true,
    size: stat.size,
    updated_at: new Date(stat.mtimeMs).toISOString(),
  };
}

function readOptionalText(filePath) {
  const absolute = abs(filePath);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, "utf8");
}

function trimMessage(text) {
  return text?.replace(/\s+/g, " ").trim() ?? null;
}

function shouldAutoContinueDrive(message) {
  const text = trimMessage(message);
  if (!text) return false;

  const blockerPattern =
    /(需要你|请提供|请选择|which option|choose one|need your decision|business decision|write-scope|spec approval|批准|缺少.*输入|blocker|阻塞)/i;
  if (blockerPattern.test(text)) return false;

  const continuePattern =
    /(是否继续|继续吗|要我继续|如需我继续|如果你愿意.*继续|继续工作|继续推进|shall i continue|should i continue|would you like me to continue|want me to continue|if you'd like[,]? i can continue|i can keep going|keep going|keep working)/i;
  return continuePattern.test(text);
}

function detectDriveMilestone(message, stopReason = null, error = null) {
  const text = trimMessage(message);

  if (stopReason === "completed") {
    return {
      type: "drive_finished",
      summary: text ?? "drive 已结束",
    };
  }

  if (stopReason === "waiting_for_user" || stopReason === "transport_failed") {
    return {
      type: "needs_user",
      summary: text ?? error ?? "需要用户介入",
    };
  }

  if (!text) return null;

  if (/(pull request|pr)\s+(已)?合并|merged (the )?(pull request|pr)|pr merged|pull request merged/i.test(text)) {
    return {
      type: "pr_merged",
      summary: text,
    };
  }

  if (/\bci\b.*(fail|failed|failure)|checks? failed|pipeline failed|github actions?.*failed|build failed/i.test(text)) {
    return {
      type: "ci_failed",
      summary: text,
    };
  }

  return null;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readFileDelta(filePath, offset) {
  if (!existsSync(filePath)) return { offset, chunk: null };
  const size = statSync(filePath).size;
  if (size <= offset) return { offset: size, chunk: null };

  const fd = openSync(filePath, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return { offset: size, chunk: buffer };
  } finally {
    closeSync(fd);
  }
}

function buildRunOutcome(record) {
  return {
    exitCode: record?.worker_exit_code ?? 1,
    error:
      record?.worker_error ??
      (record?.timed_out ? `worker timed out after ${record.timeout_seconds} seconds` : null),
  };
}

function buildTransportFailure(jobContext, record, attempt, attemptsAllowed) {
  return {
    status: "transport_failed",
    job: jobContext.jobName,
    job_id: jobContext.jobId,
    exit_code: record?.worker_exit_code ?? 1,
    stderr_log: repoRel(jobContext.stderrLog),
    stdout_log: repoRel(jobContext.stdoutLog),
    result_file: repoRel(jobContext.resultFile),
    status_file: repoRel(runMetaPath(jobContext)),
    error:
      record?.worker_error ??
      (record?.timed_out ? `worker timed out after ${record.timeout_seconds} seconds` : null),
    timed_out: Boolean(record?.timed_out),
    attempt,
    attempts_allowed: attemptsAllowed,
  };
}

function flushJobLogs(jobContext, cursors) {
  const next = { ...cursors };
  const stdoutDelta = readFileDelta(jobContext.stdoutLog, next.stdout);
  if (stdoutDelta.chunk) {
    process.stderr.write(stdoutDelta.chunk);
  }
  next.stdout = stdoutDelta.offset;

  const stderrDelta = readFileDelta(jobContext.stderrLog, next.stderr);
  if (stderrDelta.chunk) {
    process.stderr.write(stderrDelta.chunk);
  }
  next.stderr = stderrDelta.offset;
  return next;
}

async function waitForDetachedJob(record, forwardLogs = true) {
  const jobContext = jobContextFromRecord(record);
  const metaFile = record.meta_file ?? runMetaPath(jobContext);
  let latest = record;
  let cursors = { stdout: 0, stderr: 0 };

  while (true) {
    if (forwardLogs) {
      cursors = flushJobLogs(jobContext, cursors);
    }

    latest = readJobRecord(metaFile) ?? latest;
    const workerAlive = isProcessAlive(latest?.worker_pid);
    const runnerAlive = isProcessAlive(latest?.runner_pid);
    const finished = latest?.status === "finished";
    const launchAgeMs = latest?.launched_at ? Date.now() - Date.parse(latest.launched_at) : Number.POSITIVE_INFINITY;
    const launchSettled = latest?.status !== "launching" || launchAgeMs > 2000;

    if (finished || (!workerAlive && !runnerAlive && launchSettled)) {
      if (forwardLogs) {
        cursors = flushJobLogs(jobContext, cursors);
      }
      return latest;
    }

    await sleep(logPollIntervalMs);
  }
}

function appendText(filePath, text) {
  writeFileSync(filePath, text, { flag: "a" });
}

async function waitForDetachedDrive(record, options = {}) {
  const {
    forwardLogs = false,
    sinceMilestoneSeq = null,
  } = options;
  const metaFile = record.meta_file;
  let latest = record;
  let cursors = { stdout: 0, stderr: 0 };

  while (true) {
    if (forwardLogs) {
      const stdoutDelta = readFileDelta(latest.stdout_log, cursors.stdout);
      if (stdoutDelta.chunk) process.stderr.write(stdoutDelta.chunk);
      cursors.stdout = stdoutDelta.offset;

      const stderrDelta = readFileDelta(latest.stderr_log, cursors.stderr);
      if (stderrDelta.chunk) process.stderr.write(stderrDelta.chunk);
      cursors.stderr = stderrDelta.offset;
    }

    latest = readDriveRecord(metaFile) ?? latest;
    const codexAlive = isProcessAlive(latest?.codex_pid);
    const runnerAlive = isProcessAlive(latest?.runner_pid);
    const finished = latest?.status === "finished";
    const hasNewMilestone =
      sinceMilestoneSeq != null && (latest?.milestone_seq ?? 0) > sinceMilestoneSeq;
    const launchAgeMs = latest?.launched_at ? Date.now() - Date.parse(latest.launched_at) : Number.POSITIVE_INFINITY;
    const launchSettled = latest?.status !== "launching" || launchAgeMs > 2000;

    if (hasNewMilestone || finished || (!codexAlive && !runnerAlive && launchSettled)) {
      if (forwardLogs) {
        const stdoutDelta = readFileDelta(latest.stdout_log, cursors.stdout);
        if (stdoutDelta.chunk) process.stderr.write(stdoutDelta.chunk);
        const stderrDelta = readFileDelta(latest.stderr_log, cursors.stderr);
        if (stderrDelta.chunk) process.stderr.write(stderrDelta.chunk);
      }
      return latest;
    }

    await sleep(logPollIntervalMs);
  }
}

async function clearActiveDriveState(stateFile, driveId = null) {
  return withStateLock(stateFile, async () => {
    const next = readDriveState(stateFile);
    if (!driveId || next.active_drive_id === driveId) {
      next.active_drive_id = null;
    }
    next.updated_at = timestampParts().iso;
    saveDriveState(stateFile, next);
    return next;
  });
}

async function setActiveDriveState(stateFile, driveId) {
  return withStateLock(stateFile, async () => {
    const next = readDriveState(stateFile);
    next.active_drive_id = driveId;
    next.last_drive_id = driveId;
    next.last_notified_milestone_seq = 0;
    next.updated_at = timestampParts().iso;
    saveDriveState(stateFile, next);
    return next;
  });
}

async function setLastNotifiedDriveMilestone(stateFile, seq) {
  return withStateLock(stateFile, async () => {
    const next = readDriveState(stateFile);
    next.last_notified_milestone_seq = seq;
    next.updated_at = timestampParts().iso;
    saveDriveState(stateFile, next);
    return next;
  });
}

async function executeDetachedDriveRunner(metaFile) {
  const initial = readDriveRecord(metaFile);
  if (!initial) {
    fail(`detached drive 找不到 meta: ${metaFile}`);
  }

  ensureDir(path.dirname(initial.stdout_log));
  const stdoutStream = createWriteStream(initial.stdout_log, { flags: "a" });
  const stderrStream = createWriteStream(initial.stderr_log, { flags: "a" });

  try {
    let current = {
      ...initial,
      status: "running",
      runner_pid: process.pid,
      runner_started_at: timestampParts().iso,
    };
    writeDriveRecord(metaFile, current);

    while (true) {
      const attempt = current.current_attempt + 1;
      const mode = current.thread_id ? "resume" : "start";
      const prompt = current.thread_id ? current.continue_prompt : current.user_prompt;

      appendText(current.stderr_log, `\n=== drive attempt ${attempt} (${mode}) ===\n`);
      writeDriveRecord(metaFile, {
        ...current,
        status: "running",
        current_attempt: attempt,
        last_error: null,
        timed_out: false,
      });

      const driveTransport = current.transport ?? { worker_kind: "codex", model: null, effort: null };
      const run = await new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let threadId = current.thread_id;
        let stdoutBuffer = "";
        const { binary, args } = buildWorkerSpawn(
          driveTransport,
          mode === "start" ? "drive_start" : "drive_resume",
          { outputFile: current.current_attempt_output_file, threadId: current.thread_id, prompt },
        );

        const child = spawn(binary, args, {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        });

        writeDriveRecord(metaFile, {
          ...(readDriveRecord(metaFile) ?? current),
          codex_pid: child.pid ?? null,
          codex_started_at: timestampParts().iso,
        });

        const timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!settled) child.kill("SIGKILL");
          }, 5000);
        }, current.timeout_seconds * 1000);

        child.stdout.on("data", (chunk) => {
          stdoutStream.write(chunk);
          stdoutBuffer += chunk.toString("utf8");
          let newline = stdoutBuffer.indexOf("\n");
          while (newline !== -1) {
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (line) {
              try {
                const event = JSON.parse(line);
                if (driveTransport.worker_kind === "claude") {
                  if (event.type === "system" && event.subtype === "init" && event.session_id) {
                    threadId = event.session_id;
                  }
                  if (event.type === "result" && event.result) {
                    writeFileSync(abs(current.current_attempt_output_file), event.result);
                  }
                } else {
                  if (event.type === "thread.started" && event.thread_id) {
                    threadId = event.thread_id;
                  }
                }
              } catch {}
            }
            newline = stdoutBuffer.indexOf("\n");
          }
        });

        child.stderr.on("data", (chunk) => {
          stderrStream.write(chunk);
        });

        child.on("error", (error) => {
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode: 127, error: error.message, timedOut, threadId });
        });

        child.on("close", (code) => {
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, error: null, timedOut, threadId });
        });
      });

      const latestMessage = trimMessage(readOptionalText(current.current_attempt_output_file));
      current = {
        ...(readDriveRecord(metaFile) ?? current),
        thread_id: run.threadId ?? current.thread_id,
        latest_message: latestMessage,
        last_message_file: current.last_message_file,
        last_exit_code: run.exitCode,
        last_error: run.error,
        timed_out: run.timedOut,
        codex_pid: null,
      };
      if (latestMessage) {
        writeFileSync(current.last_message_file, `${latestMessage}\n`);
      }

      const progressMilestone = detectDriveMilestone(latestMessage);
      if (progressMilestone) {
        current = {
          ...current,
          milestone_seq: current.milestone_seq + 1,
          latest_milestone: {
            seq: current.milestone_seq + 1,
            type: progressMilestone.type,
            summary: progressMilestone.summary,
            happened_at: timestampParts().iso,
          },
        };
        writeDriveRecord(metaFile, current);
      }

      if (run.error || run.timedOut) {
        const milestone = detectDriveMilestone(latestMessage, "transport_failed", run.error);
        current = {
          ...current,
          status: "finished",
          stop_reason: "transport_failed",
          finished_at: timestampParts().iso,
          milestone_seq: milestone ? current.milestone_seq + 1 : current.milestone_seq,
          latest_milestone: milestone
            ? {
              seq: current.milestone_seq + 1,
              type: milestone.type,
              summary: milestone.summary,
              happened_at: timestampParts().iso,
            }
            : current.latest_milestone,
        };
        writeDriveRecord(metaFile, current);
        await clearActiveDriveState(current.drive_state_file, current.drive_id);
        return current;
      }

      if (shouldAutoContinueDrive(latestMessage) && current.auto_continue_count < current.max_auto_continue) {
        current = {
          ...current,
          auto_continue_count: current.auto_continue_count + 1,
          status: "running",
          stop_reason: null,
        };
        writeDriveRecord(metaFile, current);
        continue;
      }

      const stopReason = shouldAutoContinueDrive(latestMessage) ? "waiting_for_user" : "completed";
      const milestone = detectDriveMilestone(latestMessage, stopReason);
      current = {
        ...current,
        status: "finished",
        stop_reason: stopReason,
        finished_at: timestampParts().iso,
        milestone_seq: milestone ? current.milestone_seq + 1 : current.milestone_seq,
        latest_milestone: milestone
          ? {
            seq: current.milestone_seq + 1,
            type: milestone.type,
            summary: milestone.summary,
            happened_at: timestampParts().iso,
          }
          : current.latest_milestone,
      };
      writeDriveRecord(metaFile, current);
      await clearActiveDriveState(current.drive_state_file, current.drive_id);
      return current;
    }
  } finally {
    stdoutStream.end();
    stderrStream.end();
  }
}

function launchDetachedRunner(record) {
  const child = spawn(
    process.execPath,
    [packAbs("scripts/cc-leader-harness.mjs"), detachedRunnerCommand, "--meta-file", record.meta_file],
    {
      cwd: root,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return child.pid ?? null;
}

function launchDetachedDriveRunner(record) {
  const child = spawn(
    process.execPath,
    [packAbs("scripts/cc-leader-harness.mjs"), detachedDriveCommand, "--meta-file", record.meta_file],
    {
      cwd: root,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return child.pid ?? null;
}

async function clearActiveJobState(stateFile) {
  return withStateLock(stateFile, async () => {
    const next = readState(stateFile);
    next.active_job_id = null;
    saveState(stateFile, next);
    return next;
  });
}

async function resumeActiveJobIfPresent(stateFile) {
  const state = readState(stateFile);
  if (!state.active_job_id) return null;

  const phase = resolvePhase(state);
  const metaFile = findActiveJobMetaFile(state);
  const record = readJobRecord(metaFile);
  if (!record) {
    await clearActiveJobState(stateFile);
    return null;
  }

  const latest = await waitForDetachedJob(record);
  const jobContext = jobContextFromRecord(latest);
  const run = buildRunOutcome(latest);

  let result = null;
  if (existsSync(jobContext.resultFile)) {
    result = readJsonFile(jobContext.resultFile);
  } else {
    result = synthesizeResultFromArtifact(
      jobContext.jobName,
      jobContext,
      run,
      latest?.recovery_snapshot ?? null,
    );
  }

  if (!result) {
    const nextState = await clearActiveJobState(stateFile);
    return {
      ok: false,
      phase,
      jobName: jobContext.jobName,
      phaseId: jobContext.phaseId,
      transportFailure: buildTransportFailure(
        jobContext,
        latest,
        latest?.attempt ?? 1,
        (manifest.retryPolicy?.maxTransportRetriesPerJob ?? 0) + 1,
      ),
      state: nextState,
    };
  }

  const nextState = await withStateLock(stateFile, async () => {
    const next = updateStateFromResult(readState(stateFile), jobContext, result);
    saveState(stateFile, next);
    return next;
  });

  return {
    ok: true,
    resumed: true,
    phase,
    exit_code: run.exitCode,
    result,
    state: nextState,
    run_dir: repoRel(jobContext.runDir),
    stdout_log: repoRel(jobContext.stdoutLog),
    stderr_log: repoRel(jobContext.stderrLog),
    jobName: jobContext.jobName,
    phaseId: jobContext.phaseId,
  };
}

function inspectRecoveryCandidate(record, resultExists) {
  if (!record || resultExists) return null;
  const jobContext = jobContextFromRecord(record);
  const config = getRecoveryConfig(record.job_name, jobContext);
  if (!config?.path) return null;

  const artifactExists = existsSync(config.path);
  const changedSinceLaunch = record.recovery_snapshot
    ? didFileChangeSince(record.recovery_snapshot, config.path)
    : artifactExists;
  const rawVerdict = artifactExists ? readMarkdownField(config.path, config.verdictField) : null;
  const parsedVerdict = rawVerdict
    ? (config.normalizeVerdict ? config.normalizeVerdict(rawVerdict) : rawVerdict)
    : null;
  const recoverable = Boolean(
    artifactExists &&
    changedSinceLaunch &&
    parsedVerdict &&
    !String(parsedVerdict).includes("|"),
  );

  return {
    artifact: config.artifact,
    path: formatPathForOutput(config.path),
    exists: artifactExists,
    changed_since_launch: changedSinceLaunch,
    parsed_verdict: parsedVerdict ?? null,
    recoverable,
  };
}

function buildJobStatus(state, args) {
  const source = args["job-id"]
    ? "job_id_arg"
    : state.active_job_id
      ? "active_job_id"
      : state.last_result_file_path
        ? "last_result_file_path"
        : "none";
  const workflowId = state.workflow_id ?? null;
  const resolvedJobId = args["job-id"] ?? state.active_job_id ?? inferJobIdFromResultPath(state.last_result_file_path);

  if (!workflowId) {
    return {
      found: false,
      lifecycle_state: "no_workflow",
      workflow_id: null,
      source,
      state: {
        current_phase: resolvePhase(state),
        active_job_id: state.active_job_id,
        last_result_file_path: state.last_result_file_path,
      },
      reason: "当前没有 workflow_id",
    };
  }

  if (!resolvedJobId) {
    return {
      found: false,
      lifecycle_state: "idle",
      workflow_id: workflowId,
      source,
      state: {
        current_phase: resolvePhase(state),
        active_job_id: state.active_job_id,
        last_result_file_path: state.last_result_file_path,
      },
      reason: "当前没有 active job，也推不出最近 job_id",
    };
  }

  const runDir = runDirForJob(workflowId, resolvedJobId);
  const promptFile = path.join(runDir, "prompt.md");
  const stdoutLog = path.join(runDir, "stdout.jsonl");
  const stderrLog = path.join(runDir, "stderr.log");
  const resultFile = path.join(runDir, "result.json");
  const metaFile = runMetaPath(runDir);

  const runDirExists = existsSync(runDir);
  const record = readJobRecord(metaFile);
  const result = existsSync(resultFile) ? readJsonFile(resultFile) : null;
  const runnerAlive = isProcessAlive(record?.runner_pid);
  const workerAlive = isProcessAlive(record?.worker_pid);
  const recoveryCandidate = inspectRecoveryCandidate(record, Boolean(result));

  let lifecycleState = "missing";
  if (workerAlive || runnerAlive) {
    lifecycleState = "running";
  } else if (record?.status === "launching") {
    lifecycleState = "launching";
  } else if (result) {
    lifecycleState = "result_ready";
  } else if (record?.status === "finished") {
    lifecycleState = "finished_without_result";
  } else if (runDirExists || record) {
    lifecycleState = "unknown";
  }

  return {
    found: Boolean(runDirExists || record || result),
    workflow_id: workflowId,
    current_phase: resolvePhase(state),
    requested_job_id: args["job-id"] ?? null,
    resolved_job_id: resolvedJobId,
    source,
    lifecycle_state: lifecycleState,
    can_resume: resolvedJobId === state.active_job_id && (workerAlive || runnerAlive),
    state: {
      active_job_id: state.active_job_id,
      active_phase_id: state.active_phase_id,
      current_execution_root: state.current_execution_root,
      last_result_file_path: state.last_result_file_path,
    },
    job: {
      job_id: resolvedJobId,
      job_name: record?.job_name ?? result?.job ?? null,
      phase_id: record?.phase_id ?? result?.phase_id ?? null,
      attempt: record?.attempt ?? state.job_attempts?.[resolvedJobId] ?? null,
      status: record?.status ?? (result ? "finished" : runDirExists ? "unknown" : "missing"),
      timeout_seconds: record?.timeout_seconds ?? null,
      launched_at: record?.launched_at ?? null,
      finished_at: record?.finished_at ?? result?.finished_at ?? null,
    },
    runner: {
      pid: record?.runner_pid ?? null,
      alive: runnerAlive,
      started_at: record?.runner_started_at ?? null,
    },
    worker: {
      pid: record?.worker_pid ?? null,
      alive: workerAlive,
      started_at: record?.worker_started_at ?? null,
      exit_code: record?.worker_exit_code ?? result?.exit_code ?? null,
      error: record?.worker_error ?? null,
      timed_out: Boolean(record?.timed_out),
    },
    files: {
      run_dir: {
        path: formatPathForOutput(runDir),
        exists: runDirExists,
      },
      meta: describeFileStatus(metaFile),
      prompt: describeFileStatus(promptFile),
      stdout_log: describeFileStatus(stdoutLog),
      stderr_log: describeFileStatus(stderrLog),
      result: describeFileStatus(resultFile),
    },
    result: result
      ? {
        status: result.status ?? null,
        verdict: result.verdict ?? null,
        next_action: result.next_action ?? null,
        summary: result.summary ?? null,
        blockers: Array.isArray(result.blockers) ? result.blockers : [],
        recovered_from_artifact: Boolean(result.recovered_from_artifact),
        artifact_write_ok: result.artifact_write_ok ?? null,
        outputs: Array.isArray(result.outputs) ? result.outputs : [],
      }
      : null,
    recovery_candidate: recoveryCandidate,
  };
}

function updateStateFromResult(state, jobContext, result) {
  state.last_result_file_path = repoRel(jobContext.resultFile);
  state.active_job_id = null;

  if (result.job === "specAdversarialReview") {
    state.spec_review_path = toRepoRelativeIfInsideRoot(jobContext.variables.spec_review_path);
    state.spec_review_passed = result.verdict === "pass";
    if (result.verdict === "pass") {
      state.spec_review_revise_count = 0;
    } else if (result.verdict === "revise") {
      state.spec_review_revise_count = (state.spec_review_revise_count ?? 0) + 1;
    }
  }

  if (result.job === "phasePlanSynthesis") {
    state.phase_plan_list_path = toRepoRelativeIfInsideRoot(jobContext.variables.phase_plan_list_path);
    state.phase_plan_review_passed = result.verdict === "pass";
  }

  if (result.job === "phaseTaskSynthesis" && result.verdict === "pass") {
    state.phase_task_dir = repoRel(path.dirname(abs(jobContext.variables.phase_task_list_path)));
    state.ready_phase_ids = uniq([...(state.ready_phase_ids ?? []), jobContext.phaseId]);
  }

  if (result.job === "phaseExecution") {
    state.phase_result_dir = repoRel(path.dirname(abs(jobContext.variables.phase_result_path)));
    state.active_phase_id = null;
    state.current_execution_root = null;
    if (result.verdict === "complete") {
      state.completed_phase_ids = uniq([...(state.completed_phase_ids ?? []), jobContext.phaseId]);
    }
  }

  if (result.job === "phaseReview") {
    state.phase_review_dir = repoRel(path.dirname(abs(jobContext.variables.phase_review_path)));
    if (result.verdict === "pass") {
      state.reviewed_phase_ids = uniq([...(state.reviewed_phase_ids ?? []), jobContext.phaseId]);
    } else {
      state.reviewed_phase_ids = (state.reviewed_phase_ids ?? []).filter((phaseId) => phaseId !== jobContext.phaseId);
      state.completed_phase_ids = (state.completed_phase_ids ?? []).filter((phaseId) => phaseId !== jobContext.phaseId);
      state.ready_phase_ids = uniq([...(state.ready_phase_ids ?? []), jobContext.phaseId]);
      if (result.next_action === "reopen_execution") {
        state.active_phase_id = jobContext.phaseId;
        state.current_phase = "executing-phase-tasks";
        return state;
      }
      if (result.next_action === "rewrite_task_list") {
        state.active_phase_id = null;
        state.current_phase = "writing-phase-tasks";
        return state;
      }
    }
  }

  if (result.job === "finalSpecReview") {
    if (result.verdict === "pass") {
      state.final_spec_review_path = toRepoRelativeIfInsideRoot(jobContext.variables.final_spec_review_path);
    } else if (result.next_action === "reopen_smallest_failing_phase") {
      state.current_phase = "reviewing-phase-results";
      return state;
    }
  }

  state.current_phase = resolvePhase(state);
  return state;
}

function getRecoveryConfig(jobName, jobContext) {
  return {
    specAdversarialReview: {
      artifact: "specReview",
      path: jobContext.variables.spec_review_path,
      verdictField: "status",
      nextAction: (verdict) => (verdict === "pass" ? "wait_for_user_spec_approval" : "revise_spec_with_user"),
    },
    phasePlanSynthesis: {
      artifact: "phasePlanList",
      path: jobContext.variables.phase_plan_list_path,
      verdictField: "self_review_verdict",
      nextAction: (verdict) => (verdict === "pass" ? "dispatch_phase_task_synthesis" : "revise_spec_with_user"),
    },
    phaseTaskSynthesis: {
      artifact: "phaseTaskList",
      path: jobContext.variables.phase_task_list_path,
      verdictField: "self_review_verdict",
      nextAction: (verdict) => (verdict === "pass" ? "mark_phase_ready" : "revise_phase_plan"),
    },
    phaseExecution: {
      artifact: "phaseResult",
      path: jobContext.variables.phase_result_path,
      verdictField: "execution_status",
      nextAction: (verdict) => (verdict === "complete" ? "dispatch_phase_review" : "wait_for_cc_intervention"),
      normalizeVerdict: (value) => (value === "complete" ? "complete" : null),
    },
    phaseReview: {
      artifact: "phaseReview",
      path: jobContext.variables.phase_review_path,
      verdictField: "status",
      nextAction: (verdict) => (verdict === "pass" ? "proceed_to_next_phase" : "reopen_execution"),
    },
    finalSpecReview: {
      artifact: "finalSpecReview",
      path: jobContext.variables.final_spec_review_path,
      verdictField: "status",
      nextAction: (verdict) => (verdict === "pass" ? "proceed_to_final_report" : "reopen_smallest_failing_phase"),
    },
  }[jobName];
}

function parseChangedArtifactsFromPhaseResult(filePath) {
  const target = abs(filePath);
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, "utf8").split("\n");
  const out = [];
  let collecting = false;

  for (const line of lines) {
    if (line.startsWith("- changed_files_or_artifacts:")) {
      collecting = true;
      continue;
    }
    if (collecting && line.startsWith("- ")) {
      collecting = false;
    }
    if (collecting) {
      const match = line.match(/^\s+-\s+(.+)$/);
      if (match) out.push(abs(match[1].trim()));
    }
  }

  return uniq(out);
}

function synthesizeResultFromArtifact(jobName, jobContext, run, beforeSnapshot) {
  const config = getRecoveryConfig(jobName, jobContext);
  if (!config?.path || !existsSync(config.path)) return null;
  if (beforeSnapshot && !didFileChangeSince(beforeSnapshot, config.path)) return null;

  const rawVerdict = readMarkdownField(config.path, config.verdictField);
  const verdict = config.normalizeVerdict ? config.normalizeVerdict(rawVerdict) : rawVerdict;
  if (!verdict || verdict.includes("|")) return null;

  const outputs = [
    {
      artifact: config.artifact,
      path: abs(config.path),
    },
  ];

  if (jobName === "phaseExecution") {
    for (const changedPath of parseChangedArtifactsFromPhaseResult(config.path)) {
      outputs.push({
        artifact: "changedArtifact",
        path: changedPath,
      });
    }
  }

  const { iso } = timestampParts();
  const result = {
    status: "done",
    job: jobName,
    workflow_id: jobContext.workflowId,
    phase_id: jobContext.phaseId ?? null,
    started_at: iso,
    finished_at: iso,
    exit_code: run?.exitCode ?? 0,
    artifact_write_ok: true,
    recovered_from_artifact: true,
    retryable: false,
    verdict,
    outputs,
    next_action: config.nextAction(verdict),
    summary: `Recovered result from ${config.artifact} artifact after worker exited without result.json.`,
    blockers: [],
  };

  writeJsonFile(jobContext.resultFile, result);
  return result;
}

async function executeDetachedJobRunner(metaFile) {
  const record = readJobRecord(metaFile);
  if (!record) {
    fail(`detached runner 找不到 job meta: ${metaFile}`);
  }

  const next = {
    ...record,
    status: "running",
    runner_pid: process.pid,
    runner_started_at: timestampParts().iso,
  };
  writeJobRecord(metaFile, next);

  const promptContent = readFileSync(next.prompt_file, "utf8").replace(/\n$/, "");
  ensureDir(path.dirname(next.stdout_log));
  ensureDir(path.dirname(next.stderr_log));
  const stdoutFd = openSync(next.stdout_log, "a");
  const stderrFd = openSync(next.stderr_log, "a");

  try {
    const run = await new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      const jobTransport = next.transport ?? { worker_kind: "codex", model: null, effort: null };
      const { binary, args: workerArgs } = buildWorkerSpawn(jobTransport, "worker_job", { prompt: promptContent });
      const child = spawn(binary, workerArgs, {
        cwd: root,
        stdio: ["ignore", stdoutFd, stderrFd],
      });

      const started = {
        ...next,
        worker_pid: child.pid ?? null,
        worker_started_at: timestampParts().iso,
      };
      writeJobRecord(metaFile, started);

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, next.timeout_seconds * 1000);

      child.on("error", (error) => {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: 127, error: error.message, timedOut });
      });

      child.on("close", (code) => {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, error: null, timedOut });
      });
    });

    writeJobRecord(metaFile, {
      ...(readJobRecord(metaFile) ?? next),
      status: "finished",
      finished_at: timestampParts().iso,
      worker_exit_code: run.exitCode,
      worker_error: run.error,
      timed_out: run.timedOut,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

function createRollbackAnchor(jobContext) {
  const tagName = `pre-${jobContext.jobId}`;
  const result = spawnSync("git", ["tag", tagName], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status === 0) return;

  const detail =
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `git tag 退出码 ${result.status ?? "unknown"}`;
  console.warn(`warn: 创建 rollback tag 失败 (${tagName}): ${detail}`);
}

async function executeReportCommand(stateFile, args) {
  const state = await withStateLock(stateFile, async () => {
    const next = readState(stateFile);
    if (!next.workflow_id) fail("report 需要 workflow_id");
    if (!next.spec_path || !next.phase_plan_list_path || !next.final_spec_review_path) {
      fail("report 需要 spec_path、phase_plan_list_path、final_spec_review_path");
    }
    if (readStatusFromMarkdown(next.final_spec_review_path) !== "pass") {
      fail("report 需要 final spec review 为 pass");
    }
    const allPhaseIds = parsePhaseIdsFromPlan(next.phase_plan_list_path);
    const missingReviewed = allPhaseIds.filter(
      (phaseId) => !(next.reviewed_phase_ids ?? []).includes(phaseId),
    );
    if (missingReviewed.length > 0) {
      fail(`report 前仍有未通过 review 的 phase: ${missingReviewed.join(", ")}`);
    }
    if (resolvePhase(next) !== "reporting-results") {
      fail(`report 只允许在 reporting-results 阶段执行，当前是 ${resolvePhase(next)}`);
    }

    const finalReportPath =
      args["final-report-path"] ?? next.final_report_path ?? deriveArtifactPath("finalReport", next.workflow_id);
    const originalGoal = extractSection(next.spec_path, "目标") ?? `见 ${next.spec_path}`;
    const phaseLines = allPhaseIds.length
      ? allPhaseIds.map((phaseId) => {
        const phaseResultPath = resolvePhaseArtifactPath(next.phase_result_dir, phaseId, "result");
        const phaseSummary = extractSection(phaseResultPath, "阶段摘要");
        if (!phaseSummary) {
          return `### ${phaseId}\n\n- 阶段摘要缺失`;
        }
        return `### ${phaseId}\n\n${phaseSummary}`;
      }).join("\n\n")
      : "- none";
    const finalReviewConclusion =
      extractSection(next.final_spec_review_path, "结论") ?? "- final spec review pass";
    const report = `# 最终报告: ${next.workflow_id}

## 工作流摘要

- spec_path: ${next.spec_path}
- phase_plan_list_path: ${next.phase_plan_list_path}
- final_spec_review_path: ${next.final_spec_review_path}
- completion_status: complete

## 原始目标

${originalGoal}

## 分 Phase 摘要

${phaseLines}

## 验证证据

- 见 phase result 与 phase review artifact

## 审查结果

${finalReviewConclusion}

## 剩余风险

- none

## 最终结论

- spec_satisfied: yes
- next_recommended_action: none

## Override 摘要

- none
`;
    ensureDir(path.dirname(abs(finalReportPath)));
    writeFileSync(abs(finalReportPath), report);
    next.final_report_path = toRepoRelativeIfInsideRoot(finalReportPath);
    next.current_phase = resolvePhase(next);
    saveState(stateFile, next);
    return next;
  });

  return {
    final_report_path: state.final_report_path,
    current_phase: state.current_phase,
    state,
  };
}

async function executeDispatchJob(stateFile, jobName, args) {
  const state = readState(stateFile);
  let jobContext = buildJobContext(jobName, state, args);
  const promptPath = manifest.workerJobs[jobName].dispatch.promptContractPath;
  const timeoutSeconds =
    args["timeout-seconds"] != null
      ? Number(args["timeout-seconds"])
      : manifest.workerJobs[jobName].timeoutSeconds;

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    fail("timeout-seconds 必须是正数");
  }

  let run = null;
  let result = null;
  let transportFailure = null;
  const maxTransportRetries = manifest.retryPolicy?.maxTransportRetriesPerJob ?? 0;

  for (let attempt = 1; attempt <= maxTransportRetries + 1; attempt += 1) {
    if (attempt > 1) {
      await sleep(1100);
      jobContext = buildJobContext(jobName, readState(stateFile), args);
    }

    await withStateLock(stateFile, async () => {
      const attemptState = readState(stateFile);
      attemptState.active_job_id = jobContext.jobId;
      attemptState.last_result_file_path = repoRel(jobContext.resultFile);
      if (jobContext.phaseId && jobName === "phaseExecution") {
        attemptState.active_phase_id = jobContext.phaseId;
        attemptState.current_execution_root = ".";
      }
      attemptState.job_attempts ??= {};
      attemptState.job_attempts[jobContext.jobId] = attempt;
      saveState(stateFile, attemptState);
    });

    const currentPrompt = renderPrompt(promptPath, jobContext.variables);
    ensureOutputDirectories(jobContext);
    writeFileSync(jobContext.promptFile, `${currentPrompt}\n`);
    const recoveryConfig = getRecoveryConfig(jobName, jobContext);
    const beforeSnapshot = recoveryConfig?.path ? captureFileSnapshot(recoveryConfig.path) : null;
    const transport = resolveTransportConfig(args);
    const record = buildJobRecord(jobContext, timeoutSeconds, attempt, beforeSnapshot, transport);
    writeJobRecord(record.meta_file, record);
    if (manifest.workerJobs[jobName].writesCode) {
      createRollbackAnchor(jobContext);
    }
    launchDetachedRunner(record);
    const latest = await waitForDetachedJob(record);
    run = buildRunOutcome(latest);

    if (existsSync(jobContext.resultFile)) {
      result = readJsonFile(jobContext.resultFile);
      transportFailure = null;
      break;
    }

    result = synthesizeResultFromArtifact(
      jobName,
      jobContext,
      run,
      latest?.recovery_snapshot ?? beforeSnapshot,
    );
    if (result) {
      transportFailure = null;
      break;
    }

    transportFailure = buildTransportFailure(jobContext, latest, attempt, maxTransportRetries + 1);
  }

  if (!result) {
    const nextState = await clearActiveJobState(stateFile);
    return {
      ok: false,
      transportFailure,
      state: nextState,
    };
  }

  const expectedOutputs = Array.isArray(result.outputs) ? result.outputs : [];
  for (const output of expectedOutputs) {
    if (!existsSync(output.path)) {
      fail(`结果文件声明输出不存在: ${output.path}`);
    }
  }

  const nextState = await withStateLock(stateFile, async () => {
    const next = updateStateFromResult(readState(stateFile), jobContext, result);
    saveState(stateFile, next);
    return next;
  });

  return {
    ok: true,
    exit_code: run?.exitCode ?? 1,
    result,
    state: nextState,
    run_dir: repoRel(jobContext.runDir),
    stdout_log: repoRel(jobContext.stdoutLog),
    stderr_log: repoRel(jobContext.stderrLog),
  };
}

function summarizeDriveRecord(record, mode) {
  return {
    mode,
    drive_id: record.drive_id,
    title: record.title,
    status: record.status,
    active: record.status !== "finished",
    stop_reason: record.stop_reason,
    auto_continue_count: record.auto_continue_count,
    max_auto_continue: record.max_auto_continue,
    milestone_seq: record.milestone_seq,
    milestone: record.latest_milestone,
    thread_id: record.thread_id,
    latest_message: record.latest_message,
    last_exit_code: record.last_exit_code,
    timed_out: record.timed_out,
    prompt_file: repoRel(record.prompt_file),
    stdout_log: repoRel(record.stdout_log),
    stderr_log: repoRel(record.stderr_log),
    meta_file: repoRel(record.meta_file),
    last_message_file: repoRel(record.last_message_file),
  };
}

async function executeDriveCommand(args) {
  const driveStateFile = args["drive-state-file"] ?? driveStateFileDefault;
  const prompt = args.prompt ?? args._.slice(1).join(" ").trim();
  const driveState = readDriveState(driveStateFile);

  if (!prompt) {
    const metaFile =
      findActiveDriveMetaFile(driveState) ??
      findDriveMetaFileById(driveState.last_drive_id);
    if (!metaFile) {
      fail("drive 缺少 prompt，且当前没有 active drive 或最近 drive 可接管");
    }
    const record = readDriveRecord(metaFile);
    if (!record) {
      if (driveState.active_drive_id) {
        await clearActiveDriveState(driveStateFile, driveState.active_drive_id);
      }
      fail(`active drive 缺少 meta 文件: ${metaFile}`);
    }
    if ((record.milestone_seq ?? 0) > (driveState.last_notified_milestone_seq ?? 0)) {
      await setLastNotifiedDriveMilestone(driveStateFile, record.milestone_seq ?? 0);
      return summarizeDriveRecord(record, "attach");
    }
    const latest = await waitForDetachedDrive(record, {
      sinceMilestoneSeq: driveState.last_notified_milestone_seq ?? 0,
    });
    if ((latest.milestone_seq ?? 0) > (driveState.last_notified_milestone_seq ?? 0)) {
      await setLastNotifiedDriveMilestone(driveStateFile, latest.milestone_seq ?? 0);
    }
    return summarizeDriveRecord(latest, "attach");
  }

  if (driveState.active_drive_id) {
    const activeMetaFile = findActiveDriveMetaFile(driveState);
    const activeRecord = readDriveRecord(activeMetaFile);
    if (activeRecord) {
      const activeAlive = isProcessAlive(activeRecord.runner_pid) || isProcessAlive(activeRecord.codex_pid);
      if (activeAlive || activeRecord.status !== "finished") {
        fail(`已有 active drive: ${driveState.active_drive_id}。如要接管，执行不带 prompt 的 cc-leader drive`);
      }
    }
    await clearActiveDriveState(driveStateFile, driveState.active_drive_id);
  }

  const driveContext = buildDriveContext({ ...args, prompt });
  ensureDir(driveContext.runDir);
  writeFileSync(driveContext.promptFile, `${prompt}\n`);
  const record = buildDriveRecord(driveContext, { ...args, prompt, "drive-state-file": driveStateFile });
  writeDriveRecord(record.meta_file, record);
  await setActiveDriveState(driveStateFile, record.drive_id);
  launchDetachedDriveRunner(record);
  const latest = await waitForDetachedDrive(record, { sinceMilestoneSeq: 0 });
  if ((latest.milestone_seq ?? 0) > 0) {
    await setLastNotifiedDriveMilestone(driveStateFile, latest.milestone_seq ?? 0);
  }
  return summarizeDriveRecord(latest, "start");
}

async function executeRunCommand(stateFile, args) {
  const reviseCounts = {};
  let step = 0;

  while (true) {
    const resumed = await resumeActiveJobIfPresent(stateFile);
    if (resumed) {
      if (!resumed.ok) {
        return {
          stopped: true,
          reason: "dispatch transport failed",
          phase: resumed.phase,
          job: resumed.jobName,
          phase_id: resumed.phaseId ?? null,
          transport_failure: resumed.transportFailure,
          state: resumed.state,
        };
      }

      step += 1;
      console.log(JSON.stringify({
        step,
        job: resumed.jobName,
        verdict: resumed.result.verdict ?? null,
        phase: resumed.phase,
      }));

      const result = resumed.result;
      const nextState = resumed.state;
      const selection = { jobName: resumed.jobName, phaseId: resumed.phaseId };

      if (result.verdict === "revise") {
        reviseCounts[selection.jobName] = (reviseCounts[selection.jobName] ?? 0) + 1;
      } else {
        reviseCounts[selection.jobName] = 0;
      }

      if (result.status === "blocked") {
        return {
          stopped: true,
          reason: "worker blocked",
          phase: resumed.phase,
          result,
          state: nextState,
        };
      }

      const needUserDecision =
        (selection.jobName === "specAdversarialReview" && result.verdict === "revise") ||
        (selection.jobName === "phaseReview" && result.verdict === "fail") ||
        (selection.jobName === "finalSpecReview" && result.verdict === "fail") ||
        (result.verdict === "revise" && (reviseCounts[selection.jobName] ?? 0) >= 2);

      if (needUserDecision) {
        return {
          stopped: true,
          reason: "需要用户决策",
          phase: resumed.phase,
          result,
          state: nextState,
        };
      }

      const autoRetryRevise =
        (selection.jobName === "phasePlanSynthesis" || selection.jobName === "phaseTaskSynthesis") &&
        result.verdict === "revise" &&
        (reviseCounts[selection.jobName] ?? 0) < 2;

      if (autoRetryRevise) {
        continue;
      }
    }

    const state = readState(stateFile);
    const phase = resolvePhase(state);

    if (phase === "drafting-specs" && !state.spec_approved) {
      return {
        stopped: true,
        reason: "spec 未批准, 需要用户操作",
        phase,
        state,
      };
    }

    if (phase === "reporting-results") {
      const report = await executeReportCommand(stateFile, args);
      return {
        stopped: false,
        reason: "已完成",
        phase: "reporting-results",
        state: report.state,
      };
    }

    const selection = selectNextJob(phase, state);
    if (!selection) {
      return {
        stopped: true,
        reason: "无法确定下一个 job",
        phase,
        state,
      };
    }

    if (manifest.workerJobs[selection.jobName].writesCode && !args["write-scope"]) {
      return {
        stopped: true,
        reason: "phaseExecution 需要 --write-scope, 需要用户操作",
        phase,
        job: selection.jobName,
        phase_id: selection.phaseId ?? null,
        state,
      };
    }

    const dispatchResult = await executeDispatchJob(stateFile, selection.jobName, buildRunDispatchArgs(args, selection));
    if (!dispatchResult.ok) {
      return {
        stopped: true,
        reason: "dispatch transport failed",
        phase,
        job: selection.jobName,
        phase_id: selection.phaseId ?? null,
        transport_failure: dispatchResult.transportFailure,
        state: dispatchResult.state ?? readState(stateFile),
      };
    }

    step += 1;
    console.log(JSON.stringify({
      step,
      job: selection.jobName,
      verdict: dispatchResult.result.verdict ?? null,
      phase,
    }));

    const result = dispatchResult.result;
    const nextState = dispatchResult.state;

    if (result.verdict === "revise") {
      reviseCounts[selection.jobName] = (reviseCounts[selection.jobName] ?? 0) + 1;
    } else {
      reviseCounts[selection.jobName] = 0;
    }

    if (result.status === "blocked") {
      return {
        stopped: true,
        reason: "worker blocked",
        phase,
        result,
        state: nextState,
      };
    }

    const needUserDecision =
      (selection.jobName === "specAdversarialReview" && result.verdict === "revise") ||
      (selection.jobName === "phaseReview" && result.verdict === "fail") ||
      (selection.jobName === "finalSpecReview" && result.verdict === "fail") ||
      (result.verdict === "revise" && (reviseCounts[selection.jobName] ?? 0) >= 2);

    if (needUserDecision) {
      return {
        stopped: true,
        reason: "需要用户决策",
        phase,
        result,
        state: nextState,
      };
    }

    const autoRetryRevise =
      (selection.jobName === "phasePlanSynthesis" || selection.jobName === "phaseTaskSynthesis") &&
      result.verdict === "revise" &&
      (reviseCounts[selection.jobName] ?? 0) < 2;

    if (autoRetryRevise) {
      continue;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const stateFile = args["state-file"] ?? stateFileDefault;

  if (command === detachedRunnerCommand) {
    if (!args["meta-file"]) fail(`${detachedRunnerCommand} 需要 --meta-file`);
    await executeDetachedJobRunner(args["meta-file"]);
    return;
  }

  if (command === detachedDriveCommand) {
    if (!args["meta-file"]) fail(`${detachedDriveCommand} 需要 --meta-file`);
    await executeDetachedDriveRunner(args["meta-file"]);
    return;
  }

  if (command === "drive" || command === "work") {
    const summary = await executeDriveCommand(args);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "init") {
    if (!args.force && existsSync(abs(stateFile))) {
      fail(`state 已存在: ${stateFile}。如要覆盖，加 --force`);
    }
    const state = await withStateLock(stateFile, async () => {
      const next = structuredClone(manifest.sessionState.initialState);
      ensureWorkflowId(next, args.slug ?? path.basename(root), args["workflow-id"] ?? null);
      next.current_phase = resolvePhase(next);
      saveState(stateFile, next);
      return next;
    });
    console.log(JSON.stringify({ stateFile: repoRel(abs(stateFile)), state }, null, 2));
    return;
  }

  if (command === "state:get") {
    console.log(JSON.stringify(readState(stateFile), null, 2));
    return;
  }

  if (command === "state:set") {
    const state = await withStateLock(stateFile, async () => {
      const next = readState(stateFile);
      applySets(next, args.set ?? []);
      next.current_phase = resolvePhase(next);
      saveState(stateFile, next);
      return next;
    });
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (command === "resolve-phase") {
    const state = readState(stateFile);
    console.log(resolvePhase(state));
    return;
  }

  if (command === "job:status") {
    const state = readState(stateFile);
    console.log(JSON.stringify(buildJobStatus(state, args), null, 2));
    return;
  }

  if (command === "report") {
    const report = await executeReportCommand(stateFile, args);
    console.log(JSON.stringify({
      final_report_path: report.final_report_path,
      current_phase: report.current_phase,
    }, null, 2));
    return;
  }

  if (command === "run") {
    const summary = await executeRunCommand(stateFile, args);
    console.log(JSON.stringify(summary));
    return;
  }

  if (command !== "prepare-job" && command !== "dispatch") {
    fail(`未知命令: ${command}`);
  }

  const jobName = args.job;
  if (!jobName) fail("缺少 --job");

  const state = readState(stateFile);

  if (jobName === "specAdversarialReview") {
    const reviseCount = state.spec_review_revise_count ?? 0;
    if (reviseCount >= 2 && !args["allow-after-revise-cap"]) {
      fail(
        `specAdversarialReview gate: 已累计 ${reviseCount} 轮 revise (上限 2). ` +
        `自动循环已停止. 让用户三选一: ` +
        `(a) 接受当前 spec, 走 override 流程 (记 override + state:set spec_approved=true 等); ` +
        `(b) 放弃本次 workflow; ` +
        `(c) 用户明确要求再审一轮, 此时加 --allow-after-revise-cap 旁路一次. ` +
        `旁路后若仍 revise, 计数器继续增长, gate 再次触发, 必须再次明确授权, 不允许自动重试.`,
      );
    }
  }

  let jobContext = buildJobContext(jobName, state, args);
  const promptPath = manifest.workerJobs[jobName].dispatch.promptContractPath;
  const promptContent = renderPrompt(promptPath, jobContext.variables);

  if (command === "prepare-job" || args["dry-run"]) {
    ensureOutputDirectories(jobContext);
    writeFileSync(jobContext.promptFile, `${promptContent}\n`);
    console.log(JSON.stringify({
      mode: command === "prepare-job" ? "prepare-job" : "dry-run",
      job: jobName,
      workflow_id: jobContext.workflowId,
      job_id: jobContext.jobId,
      run_dir: repoRel(jobContext.runDir),
      prompt_file: repoRel(jobContext.promptFile),
      result_file: repoRel(jobContext.resultFile),
      variables: Object.fromEntries(
        Object.entries(jobContext.variables).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
      ),
    }, null, 2));
    return;
  }

  const dispatchResult = await executeDispatchJob(stateFile, jobName, args);
  if (!dispatchResult.ok) {
    fail(JSON.stringify(dispatchResult.transportFailure, null, 2));
  }
  console.log(JSON.stringify({
    exit_code: dispatchResult.exit_code,
    result: dispatchResult.result,
    state: dispatchResult.state,
    run_dir: dispatchResult.run_dir,
    stdout_log: dispatchResult.stdout_log,
    stderr_log: dispatchResult.stderr_log,
  }, null, 2));
}

main().catch((error) => {
  fail(error.stack || error.message);
});
