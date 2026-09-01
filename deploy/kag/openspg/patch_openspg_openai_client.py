#!/usr/bin/env python3
"""Patch obrazu release-openspg-server (OpenSPG/KAG 0.8): klient OpenAI + wycieki do logów.

Uruchamiany w entrypoincie kontenera PRZED startem Javy (deploy/kag/compose.yaml);
plik montowany :ro do /opt/openspg/. Naprawia cztery problemy upstreamu:

1. openai_client.py — `extra_body={"chat_template_kwargs": {"enable_thinking": ...}}`
   wysyłane ZAWSZE; oficjalne API OpenAI odrzuca nieznane pola. Po patchu
   enable_thinking idzie tylko do backendów innych niż api.openai.com.
2. openai_client.py — nowsze modele OpenAI wymagają `max_completion_tokens`
   i odrzucają `max_tokens`. Po patchu wybór pola zależy od base_url.
3. openai_client.py — nowsze modele OpenAI dopuszczają wyłącznie domyślną
   temperaturę. Po patchu dla api.openai.com wysyłamy NOT_GIVEN.
4. Wycieki sekretów: main_solver.py logował cały pipeline_config (zawiera klucze
   API), spg_server_bridge.py printował argumenty run_solver. Po patchu logi
   zawierają tylko bezpieczne identyfikatory.

Idempotencja: przed każdą łatką sprawdzamy, czy nowa treść już jest w pliku —
ponowne uruchomienie niczego nie zmienia. Nieoczekiwana treść źródła (inna
wersja obrazu) = twardy błąd → `&&` w entrypoincie nie wystartuje serwera
(fail-fast, żeby nie ruszyć z niespatchowanym, cieknącym kodem).
"""

import sys
from pathlib import Path

# Korzeń site-packages w obrazie serwera; opcjonalny argument pozwala testować lokalnie.
DEFAULT_SITE_PACKAGES = "/home/admin/miniconda3/lib/python3.10/site-packages"

# Warunek "to jest oficjalne API OpenAI" — porównanie pełnego, znormalizowanego base_url.
IS_OFFICIAL_OPENAI = 'self.base_url.rstrip("/") == "https://api.openai.com/v1"'

# Łatki: (ścieżka względem site-packages, opis, stara treść, nowa treść).
# Stare treści są DOKŁADNYMI liniami z obrazu @sha256:fe6708de... (build 2025-07-03).
# Uwaga: komentarze wstrzykiwane do plików obrazu celowo bez polskich znaków
# (nieznane locale kontenera przy ewentualnych późniejszych odczytach).
PATCHES = [
    (
        "kag/common/llm/openai_client.py",
        "enable_thinking tylko poza api.openai.com",
        '        self.extra_body = {"chat_template_kwargs": '
        '{"enable_thinking": self.think}}\n',
        "        # PATCH(PomagierKB): api.openai.com odrzuca nieznane pole chat_template_kwargs\n"
        "        self.extra_body = (\n"
        f"            {{}} if {IS_OFFICIAL_OPENAI}\n"
        '            else {"chat_template_kwargs": {"enable_thinking": self.think}}\n'
        "        )\n",
    ),
    (
        "kag/common/llm/openai_client.py",
        "max_completion_tokens zamiast max_tokens dla OpenAI",
        "            max_tokens=self.max_tokens if self.max_tokens > 0 else NOT_GIVEN,\n",
        "            # PATCH(PomagierKB): nowsze modele OpenAI wymagaja max_completion_tokens\n"
        "            **(\n"
        '                {"max_completion_tokens": self.max_tokens if self.max_tokens > 0 else NOT_GIVEN}\n'
        f"                if {IS_OFFICIAL_OPENAI}\n"
        '                else {"max_tokens": self.max_tokens if self.max_tokens > 0 else NOT_GIVEN}\n'
        "            ),\n",
    ),
    (
        "kag/common/llm/openai_client.py",
        "temperature pomijana dla OpenAI",
        "            temperature=self.temperature,\n",
        "            # PATCH(PomagierKB): nowsze modele OpenAI dopuszczaja tylko domyslna temperature\n"
        "            temperature=(\n"
        f"                NOT_GIVEN if {IS_OFFICIAL_OPENAI}\n"
        "                else self.temperature\n"
        "            ),\n",
    ),
    (
        "kag/solver/main_solver.py",
        "bez logowania pipeline_config (zawiera klucze API)",
        '        logger.error(f"pipeline conf: \\n{pipeline_config}")\n',
        "        # PATCH(PomagierKB): pipeline_config zawiera klucze API - nie logujemy tresci\n"
        '        logger.error("pipeline execution failed; konfiguracja pominieta w logu")\n',
    ),
    (
        "kag/bridge/spg_server_bridge.py",
        "bez printowania argumentów run_solver (zawierają configi z kluczami)",
        '            print(f"run_solver {func_name} args: {params} {args}")\n',
        "            # PATCH(PomagierKB): args zawieraja configi z kluczami API - tylko identyfikatory\n"
        '            print(f"run_solver {func_name} project={project_id} '
        'session={session_id} task={task_id}")\n',
    ),
]


def apply_patches(site_packages: Path) -> None:
    """Aplikuje wszystkie łatki; każdy plik czytany i zapisywany jeden raz."""
    by_file = {}
    for rel_path, description, old, new in PATCHES:
        by_file.setdefault(rel_path, []).append((description, old, new))

    for rel_path, file_patches in by_file.items():
        path = site_packages / rel_path
        source = path.read_text(encoding="utf-8")
        changed = False

        for description, old, new in file_patches:
            if new in source:
                # już zaaplikowane (poprzedni start kontenera) — nic nie robimy
                print(f"[patch] {rel_path}: {description} — już zaaplikowane")
                continue
            if old not in source:
                raise SystemExit(
                    f"[patch] BŁĄD: {rel_path}: nie znaleziono oczekiwanej treści dla "
                    f"'{description}' — inna wersja obrazu? Odmawiam startu (fail-fast)."
                )
            # replace wszystkich wystąpień (np. temperature= występuje w kilku metodach)
            source = source.replace(old, new)
            changed = True
            print(f"[patch] {rel_path}: {description} — zaaplikowano")

        # weryfikacja końcowa: każda nowa treść musi być obecna
        for description, _old, new in file_patches:
            if new not in source:
                raise SystemExit(
                    f"[patch] BŁĄD: {rel_path}: weryfikacja '{description}' nie przeszła."
                )

        if changed:
            path.write_text(source, encoding="utf-8")
            print(f"[patch] {rel_path}: zapisano")


def main() -> None:
    site_packages = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(DEFAULT_SITE_PACKAGES)
    apply_patches(site_packages)
    print("[patch] OK — wszystkie łatki na miejscu")


if __name__ == "__main__":
    main()
