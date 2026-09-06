#!/bin/sh
# Tworzy użytkownika aplikacyjnego OpenSPG (docs/design/infra.md §3).
# Wykonywany przez entrypoint obrazu MySQL/MariaDB RAZ — przy pierwszej
# inicjalizacji pustego wolumenu danych. Serwer OpenSPG łączy się tym
# użytkownikiem (SERVER_REPOSITORY_IMPL_JDBC_USERNAME), NIE rootem.
set -eu

# fail-fast: zmienne wstrzykuje compose (environment usługi mysql)
: "${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD is required}"
: "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"
: "${MYSQL_APP_USER:?MYSQL_APP_USER is required}"
: "${MYSQL_APP_PASSWORD:?MYSQL_APP_PASSWORD is required}"

echo "[mysql-init] tworzę użytkownika aplikacyjnego '${MYSQL_APP_USER}' dla bazy '${MYSQL_DATABASE}'"

# Połączenie lokalne (socket) — serwer w fazie initdb nie nasłuchuje jeszcze po TCP.
# Hasło przez MYSQL_PWD, NIGDY w argv (twarda zasada CLAUDE.md: sekrety nie trafiają do
# tablicy procesów ani do logów; klient wypisywał wtedy na stderr "Using a password on the
# command line interface can be insecure", co entrypoint kierował do json-file kontenera).
# Ten sam wzorzec: deploy/scripts/backup.sh, deploy/scripts/verify_backup.sh.
# Hasła w treści SQL idą przez stdin (heredoc), więc nie są widoczne w /proc/*/cmdline.
MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql --protocol=socket -uroot <<SQL
CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_APP_USER}'@'%';
FLUSH PRIVILEGES;
SQL

echo "[mysql-init] gotowe"
