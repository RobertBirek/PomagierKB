# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Tika PomagierKB = minimalny obraz producenta + Tesseract z językiem polskim + nasza konfiguracja.
# Celowo NIE wariant `-full` (2 GB: GDAL, ffmpeg, ImageMagick; bez polskiego) — ten kontener
# parsuje NIEZAUFANE uploady, więc dokładamy tylko to, czego używamy.
# Kontekst budowania = KORZEŃ repo (jak panel i mcp — tak buduje compose i job image-build w CI):
#   docker build -f services/tika/Dockerfile -t kag-tika:local .
# Obraz bazowy podaje compose z TIKA_IMAGE (.env, pin digestem); wartość domyślna = ten sam pin.
ARG TIKA_BASE_IMAGE=apache/tika@sha256:06bcdbd09aca073293e5a171ad161418cc93c91d58d9e4e205064eade84889d4
# ^ 4.1.0 (tag 4.1.0-1), pin 2026-10-05
FROM ${TIKA_BASE_IMAGE}
ARG TIKA_BASE_IMAGE
USER root
# Bezpiecznik: konfiguracja JSON i układ /opt/tika-server istnieją od Tiki 4. Baza z linii 3.x
# (np. stary TIKA_IMAGE w .env) ma dać BŁĄD BUDOWANIA, a nie obraz, który nie wstanie.
RUN test -d /opt/tika-server || { echo "TIKA_BASE_IMAGE nie jest Tiką 4.x (brak /opt/tika-server)"; exit 1; }
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-pol tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -m 0755 /etc/tika
# katalog tworzymy jawnie wyżej: COPY --chmod nadałby 0444 także katalogowi (brak x = plik nieczytelny)
COPY --chmod=0444 services/tika/tika-config.json /etc/tika/tika-config.json
# Tożsamość wydania (D12-14) — te same etykiety co kag-panel/kag-mcp; CI sprawdza revision i pin bazy.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ARG SOURCE_URL=https://github.com/RobertBirek/PomagierKB
LABEL org.opencontainers.image.title="kag-tika" \
      org.opencontainers.image.description="PomagierKB — Apache Tika 4 + Tesseract (pol, eng)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.base.name="${TIKA_BASE_IMAGE}"
USER 35002:35002
CMD ["-c", "/etc/tika/tika-config.json"]
