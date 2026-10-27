#!/usr/bin/env bash
# Runs the coding agent (OpenCode on Meta's Muse Spark) in this folder.
# The Meta API key is read from the META_API_KEY environment variable and never stored here.
# Personal skills and Claude Code settings on the machine are switched off so the agent
# only sees this project.
set -euo pipefail
: "${META_API_KEY:?Set META_API_KEY in your environment first}"
export OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1
exec opencode "$@"
