#!/usr/bin/env bash
# A three-node Galera cluster in docker for the contract tests. See docs/testing.md.
#   bash tests/rig/galera.sh up | down | status
# Settings from the environment:
#   MDC_RIG_DOCKER_RUN  the command that starts a container in the foreground, default docker run
#   MDC_RIG_IMAGE       default codership/mysql-galera:8.0.42, never pulled or built here
#   MDC_RIG_NAME        prefix of the containers and the network, default mdc-rig
#   MDC_RIG_STATE       state dir (logs, secrets), default ${TMPDIR:-/tmp}/<name>-state
#   MDC_RIG_ENV         the env file the tests read, default <state dir>/rig.env
#   MDC_RIG_TIMEOUT     seconds `up` waits per phase, default 240
set -u
NAME=${MDC_RIG_NAME:-mdc-rig}
IMAGE=${MDC_RIG_IMAGE:-codership/mysql-galera:8.0.42}
STATE=${MDC_RIG_STATE:-${TMPDIR:-/tmp}/$NAME-state}
ENVFILE=${MDC_RIG_ENV:-$STATE/rig.env}
TIMEOUT=${MDC_RIG_TIMEOUT:-240}
RUN=${MDC_RIG_DOCKER_RUN:-docker run}
NET=$NAME-net
NODES=(1 2 3)
DB_USER=mdc
DB_NAME=mdc

node_sql() { # node_sql <n> <sql>: the sql as root inside node n, the password not in argv
  docker exec -e MYSQL_PWD="$ROOT_PW" "$NAME-$1" mysql -uroot -N -B -e "$2" 2> /dev/null
}

wsrep() { # wsrep <n> <variable>
  node_sql "$1" "SHOW STATUS LIKE '$2'" | cut -f2
}

node_ready() { # node_ready <n>: size 3, Primary and Synced
  [ "$(wsrep "$1" wsrep_cluster_size)" = 3 ] &&
    [ "$(wsrep "$1" wsrep_cluster_status)" = Primary ] &&
    [ "$(wsrep "$1" wsrep_local_state_comment)" = Synced ]
}

start_node() { # start_node <n> [<join list>]: the foreground run, in the background of this script
  local n=$1 join=${2:-}
  ( [ -n "$join" ] && echo "WSREP_JOIN=$join"
    echo "MYSQL_ROOT_PASSWORD=$ROOT_PW"
    echo "MYSQL_USER=$DB_USER"
    echo "MYSQL_PASSWORD=$APP_PW"
    echo "MYSQL_DATABASE=$DB_NAME" ) > "$STATE/node$n.env"
  # shellcheck disable=SC2086 # $RUN is a command with words
  $RUN --rm --name "$NAME-$n" --hostname "$NAME-$n" --network "$NET" \
    --env-file "$STATE/node$n.env" -p "127.0.0.1::3306" "$IMAGE" mysqld \
    > "$STATE/node$n.log" 2>&1 &
  echo $! > "$STATE/node$n.pid"
}

fail_node() { # fail_node <n> <why>
  echo "rig: node $1 $2" >&2
  echo "rig: tail of its log:" >&2
  tail -n 40 "$STATE/node$1.log" >&2
  exit 1
}

wait_for() { # wait_for <n> <what> <command...>
  local n=$1 what=$2 deadline=$((SECONDS + TIMEOUT))
  shift 2
  until "$@"; do
    [ $SECONDS -lt $deadline ] || fail_node "$n" "is not $what after ${TIMEOUT}s"
    sleep 2
  done
}

node_up() { docker exec "$NAME-$1" true > /dev/null 2>&1 && node_sql "$1" 'SELECT 1' > /dev/null; }

cmd_up() {
  cmd_down > /dev/null 2>&1
  umask 077
  mkdir -p "$STATE" || exit 1
  ROOT_PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
  APP_PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
  docker network create "$NET" > /dev/null || { echo "rig: no network" >&2; exit 1; }
  # the first node starts a new cluster, the others join it, one after the other
  start_node 1
  wait_for 1 "up" node_up 1
  for n in 2 3; do
    start_node "$n" "$NAME-1"
    wait_for "$n" "up" node_up "$n"
  done
  for n in "${NODES[@]}"; do
    wait_for "$n" "Primary and Synced with 3 nodes" node_ready "$n"
  done
  {
    echo "MDC_GALERA_HOST=127.0.0.1"
    for n in "${NODES[@]}"; do
      echo "MDC_GALERA_PORT$n=$(docker port "$NAME-$n" 3306/tcp | head -n1 | sed 's/.*://')"
    done
    echo "MDC_GALERA_USER=$DB_USER"
    echo "MDC_GALERA_PASSWORD=$APP_PW"
    echo "MDC_GALERA_DATABASE=$DB_NAME"
  } > "$ENVFILE"
  echo "$ENVFILE"
}

cmd_down() {
  local n
  for n in "${NODES[@]}"; do docker rm -f "$NAME-$n" > /dev/null 2>&1; done
  for n in "${NODES[@]}"; do
    [ -f "$STATE/node$n.pid" ] && kill "$(cat "$STATE/node$n.pid")" 2> /dev/null
  done
  docker network rm "$NET" > /dev/null 2>&1
  rm -rf "$STATE"
  [ "$ENVFILE" = "$STATE/rig.env" ] || rm -f "$ENVFILE"
  return 0
}

cmd_status() {
  ROOT_PW=$(sed -n 's/^MYSQL_ROOT_PASSWORD=//p' "$STATE/node1.env" 2> /dev/null)
  local n
  for n in "${NODES[@]}"; do
    echo "node $n: size=$(wsrep "$n" wsrep_cluster_size)" \
      "status=$(wsrep "$n" wsrep_cluster_status)" \
      "state=$(wsrep "$n" wsrep_local_state_comment)"
  done
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: bash tests/rig/galera.sh up|down|status" >&2; exit 2 ;;
esac
