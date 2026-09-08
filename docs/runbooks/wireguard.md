# Runbook: tunel WireGuard do sieci biurowej

Tunel łączy VPS PomagierKB z siecią biurową za NAT-em. Ruch jest **asymetryczny** i to jest
cała jego istota:

| Kierunek | Dozwolone? | Czym egzekwowane |
|---|---|---|
| VPS → cała sieć biurowa | **TAK** | `AllowedIPs` peera + trasa przez `wg0` |
| sieć biurowa → host VPS (SSH, ICMP) | TAK | reguły ufw na interfejsie `wg0` |
| sieć biurowa → sieci docker | **NIE** | `wg_guard.sh` (DOCKER-USER) |
| kontenery docker → sieć biurowa | **NIE** | `wg_guard.sh` (DOCKER-USER) |

## Dlaczego bez `wg_guard.sh` tunel jest dziurawy

`DOCKER-USER` kończy się regułą `-i eth0 -j DROP`, która chroni kontenery przed ruchem
z internetu — ale dopasowuje **interfejs**. Ruch wchodzący przez `wg0` jej nie dotyka, spada
do `RETURN`, trafia do `DOCKER-FORWARD` i zostaje przepuszczony. ufw też nie pomoże mimo
`deny (routed)`, bo łańcuch Dockera stoi w `FORWARD` **przed** łańcuchami ufw.

Bez guarda sieć biurowa miałaby bezpośredni dostęp do `kag-datastores` (172.23.0.0/16), gdzie
**OpenSPG na :8887 nie ma żadnego uwierzytelnienia**, a obok stoją MySQL, Neo4j i MinIO.

Kierunek odwrotny jest równie istotny: host ma trasę do całego LAN-u biura, więc kontener,
który zdołałby wypchnąć pakiet przez `FORWARD`, dojechałby nią do biurowych drukarek i NAS-a.
`release-openspg-server` ma konfigurowalny `base_url` modelu i nieuwierzytelniony
`/public/v1/datasource/testConnect` — czyli gotowy pivot SSRF. `egress_guard.sh` tego nie
obejmuje, bo powstał, zanim tunel istniał.

## Pliki

| Co | Gdzie |
|---|---|
| Konfiguracja serwera (Z KLUCZAMI) | `/etc/wireguard/wg0.conf` — 0600 root, **nigdy w gicie** |
| Szablony bez kluczy | `deploy/wireguard/wg0.conf.example`, `peer-office.conf.example` |
| Izolacja od dockera | `deploy/scripts/wg_guard.sh` + `deploy/systemd/kag-wg-guard.service` |
| Kopia kluczy | `wireguard.tar.zst` w nocnym snapshocie (`backup.sh` §7b) |

## Uruchomienie od zera

```bash
sudo apt-get install -y wireguard-tools        # moduł jest w jądrze, DKMS niepotrzebny
umask 077 && mkdir -p /etc/wireguard
wg genkey | tee /etc/wireguard/server.key | wg pubkey > /etc/wireguard/server.pub
wg genkey | tee /tmp/office.key        | wg pubkey > /tmp/office.pub
# wypełnij /etc/wireguard/wg0.conf wg szablonu, potem:
sudo systemctl enable --now wg-quick@wg0
sudo install -m 0644 /kag/deploy/systemd/kag-wg-guard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now kag-wg-guard
sudo ufw allow 51820/udp
sudo ufw allow in on wg0 to any port 22 proto tcp
```

**Klucz prywatny strony biurowej skasuj z tego hosta po przekazaniu** (`shred -u /tmp/office.key`).
Czystszy wariant: klucz prywatny generuje strona biurowa i podaje wyłącznie publiczny — wtedy
sekret nigdy nie przechodzi przez VPS.

## Kontrola po uruchomieniu

Testy negatywne są ważniejsze od pozytywnych: to one dowodzą, że zakres jest faktem.

```bash
wg show                                          # handshake < 2 min, bajty rosną
ip route get <adres w LAN biura>                 # musi wskazać dev wg0
ping -c2 <maszyna w LAN biura>                   # NIE router — router odpowie mimo braku forwardingu
deploy/scripts/wg_guard.sh --check               # exit 0
iptables -S DOCKER-USER | grep -c kag-wg-guard   # > 0
```

Z maszyny w biurze **muszą** wypaść timeouty (nie „connection refused"):

```bash
curl -m 5 http://172.23.0.2:8887/     # OpenSPG — bez auth, więc to jest ten ważny
nc -z -w5 172.23.0.3 3306             # MySQL
curl -m 5 http://<publiczny adres VPS>/   # ruch DNAT-owany do Caddy też ma nie przechodzić
```

Z kontenera **musi** wypaść timeout:

```bash
docker exec release-openspg-server curl -m 5 http://<adres w LAN biura>/
```

## Diagnostyka

| Objaw | Przyczyna | Naprawa |
|---|---|---|
| Brak handshake'u | port 51820/udp zablokowany albo zły `Endpoint` | `ufw status`, `tcpdump -ni eth0 udp port 51820` |
| Tunel działa „od biura", z VPS-a cisza | brak `PersistentKeepalive` po stronie biura | dopisz `PersistentKeepalive = 25` u peera |
| VPS widzi router biura, nie widzi maszyn w LAN | forwarding albo zapora po stronie biura | sprawdź router biurowy — to nie jest problem VPS-a |
| Duże pliki wiszą, małe przechodzą | MTU/fragmentacja | `wg-quick` ustawia 1420; przy tunelu w tunelu zejdź niżej |
| Po restarcie Dockera biuro nagle widzi kontenery | `DOCKER-USER` wyczyszczone, guard nie wstał | `systemctl status kag-wg-guard`; `PartOf=docker.service` ma to robić sam |
| `drift_check.sh` zgłasza nieoczekiwany nasłuch | ktoś otworzył port poza kontraktem | sprawdź `ss -lntup`; allowlista jest w `drift_check.sh` |

## Pułapka kolejności guardów (odkryta przy wdrożeniu 2026-09-08)

`egress_guard.sh` wylicza adresy hosta z `ip -4 -o addr show scope global` **przy każdym
starcie** i zakłada reguły raz. Gdy tunel wstawał później niż guard, adres `wg0` nie trafiał
do wyliczenia i pivot `kag-egress → host:80/443/8080` był tą drogą otwarty — OpenSPG dostawał
od Caddy'ego HTTP 308 pod adresem `10.90.0.1`, choć pod pozostałymi adresami hosta był
zablokowany.

Naprawione przez `After=wg-quick@wg0.service` w `kag-egress-guard.service`. **Po każdej
zmianie adresacji tunelu uruchom `systemctl restart kag-egress-guard`** — sam `wg_guard.sh`
tego nie załatwia, bo działa w `FORWARD`, a ruch kontener → adres hosta idzie do `INPUT`.

Kontrola:

```bash
iptables -S DOCKER-USER | grep kag-egress-guard | grep -c 10.90.0.1   # musi być ≥ 1
docker exec release-openspg-server curl -s -m 4 -o /dev/null -w '%{http_code}' http://10.90.0.1/
# oczekiwane: 000 i exit 28 (timeout). 308 oznacza, że guard nie zna adresu tunelu.
```

## Rotacja kluczy

```bash
wg genkey | tee /etc/wireguard/server.key.new | wg pubkey    # nowy klucz publiczny → do peerów
```

Rotacja **zrywa tunel** do czasu zaktualizowania obu stron — rób ją, mając SSH z allowlisty
publicznej jako drogę zapasową. Po rotacji: `systemctl restart wg-quick@wg0 kag-wg-guard`
oraz świeży backup (`systemctl start kag-backup.service`), bo stary snapshot ma stary klucz.

## Wyłączenie tunelu

```bash
sudo systemctl disable --now kag-wg-guard wg-quick@wg0
sudo ufw delete allow 51820/udp
sudo ufw delete allow in on wg0 to any port 22 proto tcp
```

Usuń też `51820/udp` z `HOST_LISTEN_ALLOW` w `deploy/scripts/drift_check.sh` — inaczej
allowlista opisuje port, którego już nie ma, i przestaje być kontraktem.
