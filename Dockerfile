# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini gosu && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist
# Mounted disks can replace build-time ownership. Initialize only this data
# directory as root, then drop privileges before executing the application.
RUN <<'SCRIPT'
set -eu
mkdir -p /app/.data
chown node:node /app/.data
chmod 700 /app/.data
cat > /usr/local/bin/ephemeral-entrypoint <<'ENTRYPOINT'
#!/bin/sh
set -eu
umask 077
data_dir=${DATA_DIR:-/app/.data}
if [ "$data_dir" != /app/.data ]; then
  echo 'Container DATA_DIR must be /app/.data; mount the persistent disk there.' >&2
  exit 1
fi
if [ -L "$data_dir" ]; then
  echo 'Refusing a symlink as the persistent data directory.' >&2
  exit 1
fi
mkdir -p "$data_dir"
if [ "$(id -u)" = 0 ]; then
  if [ "$(stat -c %u "$data_dir")" != "$(id -u node)" ]; then
    chown -R node:node "$data_dir"
  fi
  chmod 700 "$data_dir"
  if ! gosu node sh -c 'test -w "$1"' sh "$data_dir"; then
    echo 'Persistent disk is not writable by node (UID 1000). Repair mount ownership before restarting.' >&2
    exit 1
  fi
  exec gosu node "$@"
fi
if [ ! -w "$data_dir" ]; then
  echo 'Persistent disk must be writable by node (UID 1000). Repair ownership before restarting.' >&2
  exit 1
fi
exec "$@"
ENTRYPOINT
chmod 755 /usr/local/bin/ephemeral-entrypoint
SCRIPT
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/app/.data
EXPOSE 4310
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ephemeral-entrypoint"]
CMD ["node", "--import", "tsx", "server/index.ts"]
