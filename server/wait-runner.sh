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
  printf '{"exitCode":%s}\n' "$job_status" > "$job_directory/result.tmp"
  mv "$job_directory/result.tmp" "$job_directory/result.json"
  exit "$job_status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$working_directory" || exit 126
bash -c "$job_command"
exit $?
