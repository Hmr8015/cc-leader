#!/usr/bin/env bash
set -euo pipefail

CLAUDE_SKILLS_DIR="${HOME}/.claude/skills"
LOCAL_BIN_DIR="${HOME}/.local/bin"
WRAPPER_PATH="${LOCAL_BIN_DIR}/cc-leader"
DS_WRAPPER_PATH="${LOCAL_BIN_DIR}/ds-l"

log() {
  printf '%s\n' "$1"
}

main() {
  local removed_skills=0
  local candidate
  local wrapper_removed="否"
  local ds_wrapper_removed="否"

  if [[ -d "$CLAUDE_SKILLS_DIR" ]]; then
    shopt -s nullglob
    for candidate in "${CLAUDE_SKILLS_DIR}"/cc-leader--*; do
      rm -rf "$candidate"
      removed_skills=$((removed_skills + 1))
      log "已删除 skill: $(basename "$candidate")"
    done
    shopt -u nullglob
  fi

  if [[ -e "$WRAPPER_PATH" || -L "$WRAPPER_PATH" ]]; then
    rm -rf "$WRAPPER_PATH"
    wrapper_removed="是"
    log "已删除 wrapper: ${WRAPPER_PATH}"
  fi

  if [[ -e "$DS_WRAPPER_PATH" || -L "$DS_WRAPPER_PATH" ]]; then
    rm -rf "$DS_WRAPPER_PATH"
    ds_wrapper_removed="是"
    log "已删除 wrapper: ${DS_WRAPPER_PATH}"
  fi

  cat <<EOF
卸载完成
- 已删除 skill: ${removed_skills} 个
- 已删除 wrapper: ${wrapper_removed}
- wrapper 路径: ${WRAPPER_PATH}
- 已删除 ds-l wrapper: ${ds_wrapper_removed}
- ds-l wrapper 路径: ${DS_WRAPPER_PATH}
EOF
}

main "$@"
