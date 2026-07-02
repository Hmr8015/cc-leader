#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SKILLS_SOURCE_DIR="${REPO_ROOT}/skills"
CLAUDE_SKILLS_DIR="${HOME}/.claude/skills"
LOCAL_BIN_DIR="${HOME}/.local/bin"
WRAPPER_PATH="${LOCAL_BIN_DIR}/cc-leader"
DS_WRAPPER_PATH="${LOCAL_BIN_DIR}/ds-l"

log() {
  printf '%s\n' "$1"
}

warn() {
  printf '警告: %s\n' "$1" >&2
}

ensure_dir() {
  local dir_path="$1"
  if [[ ! -d "$dir_path" ]]; then
    mkdir -p "$dir_path"
    log "已创建目录: ${dir_path}"
  fi
}

install_skill_copy() {
  local skill_dir="$1"
  local skill_name
  local source_path
  local target_path

  skill_name="$(basename "$skill_dir")"
  source_path="$(cd -- "$skill_dir" && pwd -P)"
  target_path="${CLAUDE_SKILLS_DIR}/cc-leader--${skill_name}"

  if [[ -e "$target_path" || -L "$target_path" ]]; then
    rm -rf "$target_path"
    cp -R "$source_path" "$target_path"
    log "skill 已更新: cc-leader--${skill_name}"
  else
    cp -R "$source_path" "$target_path"
    log "skill 已安装: cc-leader--${skill_name}"
  fi
}

remove_stale_skill_targets() {
  local candidate
  local base_name
  local skill_name

  [[ -d "$CLAUDE_SKILLS_DIR" ]] || return

  shopt -s nullglob
  for candidate in "${CLAUDE_SKILLS_DIR}"/cc-leader--*; do
    base_name="$(basename "$candidate")"
    skill_name="${base_name#cc-leader--}"
    if [[ ! -d "${SKILLS_SOURCE_DIR}/${skill_name}" ]]; then
      rm -rf "$candidate"
      log "已删除过期 skill: ${base_name}"
    fi
  done
  shopt -u nullglob
}

ensure_wrapper() {
  local wrapper_path="$1"
  local target_script="$2"
  local expected

  expected=$(cat <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${REPO_ROOT}/scripts/${target_script}" "\$@"
EOF
)

  if [[ -f "$wrapper_path" ]] && [[ "$(cat "$wrapper_path")" == "$expected" ]]; then
    chmod +x "$wrapper_path"
    log "wrapper 已存在, 跳过: ${wrapper_path}"
    return
  fi

  if [[ -e "$wrapper_path" || -L "$wrapper_path" ]]; then
    rm -rf "$wrapper_path"
  fi

  printf '%s\n' "$expected" >"$wrapper_path"
  chmod +x "$wrapper_path"
  log "wrapper 已写入: ${wrapper_path}"
}

check_path_warning() {
  case ":${PATH}:" in
    *":${LOCAL_BIN_DIR}:"*)
      return
      ;;
    *)
      warn "${LOCAL_BIN_DIR} 不在 PATH 中。请手动加入后再直接使用 cc-leader / ds-l。"
      ;;
  esac
}

update_repo() {
  log "正在更新仓库: git pull"
  (
    cd "$REPO_ROOT"
    git pull
  )
  log "仓库已更新"
}

main() {
  local skill_count=0
  local skill_dir
  local do_update=0

  for arg in "$@"; do
    case "$arg" in
      --update) do_update=1 ;;
      *) printf '未知参数: %s\n' "$arg" >&2; exit 1 ;;
    esac
  done

  if [[ "$do_update" -eq 1 ]]; then
    update_repo
  fi

  if [[ ! -d "$SKILLS_SOURCE_DIR" ]]; then
    printf '错误: 未找到 skills 目录: %s\n' "$SKILLS_SOURCE_DIR" >&2
    exit 1
  fi

  ensure_dir "$CLAUDE_SKILLS_DIR"
  ensure_dir "$LOCAL_BIN_DIR"
  remove_stale_skill_targets

  shopt -s nullglob
  for skill_dir in "$SKILLS_SOURCE_DIR"/*; do
    [[ -d "$skill_dir" ]] || continue
    install_skill_copy "$skill_dir"
    skill_count=$((skill_count + 1))
  done
  shopt -u nullglob

  if [[ "$skill_count" -eq 0 ]]; then
    printf '错误: skills/ 下没有可注册的 skill 目录\n' >&2
    exit 1
  fi

  ensure_wrapper "$WRAPPER_PATH" "cc-leader-harness.mjs"
  ensure_wrapper "$DS_WRAPPER_PATH" "ds-leader.mjs"
  check_path_warning

  log "开始校验仓库完整性: npm run validate"
  (
    cd "$REPO_ROOT"
    npm run validate
  )

  cat <<EOF
安装完成
- 已同步 skill: ${skill_count} 个
- wrapper 路径: ${WRAPPER_PATH}
- ds-l wrapper 路径: ${DS_WRAPPER_PATH}
- 使用方式:
  cd <目标项目根目录>
  cc-leader init --slug <project-slug>
  cc-leader state:set --set spec_path=<spec-file-path>
EOF
}

main "$@"
