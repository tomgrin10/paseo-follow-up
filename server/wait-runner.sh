#!/bin/sh
# Wait (folded in from paseo-wait 0.0.1). Invoked by the agent's native Bash tool, never by the plugin worker.
# It records "started" once and writes an atomic exit receipt (result.json), the only proof of completion.
# The command's output (stdout and stderr) still streams to the agent's Bash as it arrives; a copy goes to
# output.log for the chat's Wait row, rotated in 512 KiB halves (output.prev.log) so it never holds more than ~1 MiB.
# stderr is merged into stdout on that path.
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
# The display copy, fed from a FIFO so nothing in the agent's own stream buffers: plain tee passes the bytes through
# as they arrive. awk writes the copy line by line and starts a new 512 KiB half when one fills.
capture() {
  awk -v out="$job_directory/output.log" -v old="$job_directory/output.prev.log" '
    { if (length($0) > 65536) $0 = substr($0, length($0) - 65535)
      print > out; fflush(out); n += length($0) + 1
      if (n >= 524288) { close(out); system("mv -f \"" out "\" \"" old "\""); n = 0 } }'
}
fifo="$job_directory/output.fifo"
rm -f "$fifo"
if mkfifo "$fifo" 2>/dev/null; then
  capture < "$fifo" > /dev/null 2>&1 &
  capture_pid=$!
  # The command's exit code travels on fd 4, so the pipe into tee never replaces it. tee ignores SIGPIPE only for
  # itself: if the copy dies, it keeps writing to the agent (POSIX: a failed file write doesn't stop the others).
  exec 3>&1
  job_status=$( { { bash -c "$job_command" 2>&1; echo $? >&4; } | { trap '' PIPE; exec tee "$fifo"; } >&3; } 4>&1 )
  wait "$capture_pid" 2>/dev/null
  rm -f "$fifo"
  exit "${job_status:-1}"
fi
bash -c "$job_command"
exit $?
