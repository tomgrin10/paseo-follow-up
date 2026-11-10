#!/bin/sh
# Wait (folded in from paseo-wait 0.0.1). Invoked by the agent's native Bash tool, never by the plugin worker.
# It records "started" once and writes an atomic exit receipt (result.json), the only proof of completion.
set -u
umask 077
job_directory=$1
working_directory=$2
job_command=$3
if ! mkdir "$job_directory/started" 2>/dev/null; then
  echo 'This prepared job has already started; prepare a new job to run it again.' >&2
  exit 125
fi
finish() {
  job_status=$?
  trap - EXIT
  if [ -e "$job_directory/timed-out" ]; then
    printf '{"exitCode":%s,"timedOut":true}\n' "$job_status" > "$job_directory/result.tmp"
  else
    printf '{"exitCode":%s}\n' "$job_status" > "$job_directory/result.tmp"
  fi
  mv "$job_directory/result.tmp" "$job_directory/result.json"
  exit "$job_status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$working_directory" || exit 126
# A time limit (seconds) written at prepare: the command is stopped after it (TERM, then KILL 30 s later), so a
# job that never finishes (an unbounded poll loop) can't keep the machine busy forever. Exit 124 means it hit the
# limit; the receipt records that. Without timeout(1) (macOS) the command runs unbounded, as before.
job_limit=$(cat "$job_directory/timeout" 2>/dev/null || true)
if [ -n "$job_limit" ] && command -v timeout >/dev/null 2>&1; then
  timeout -k 30 "$job_limit" bash -c "$job_command"
  job_status=$?
  if [ "$job_status" -eq 124 ]; then : > "$job_directory/timed-out"; fi
  exit "$job_status"
fi
bash -c "$job_command"
exit $?
