#!/usr/bin/env bash
# Veille au stack dev Nelth (next:3000 + socket:3001). Idempotent, singleton.
exec 9>/tmp/nelth-dev.lock
flock -n 9 || exit 0
if ss -tln 2>/dev/null | grep -q ':3000 '; then
  exit 0
fi
cd /home/z/my-project || exit 1
setsid /usr/local/bin/bun run dev < /dev/null > /dev/null 2>&1 &
