# Konfiguracja Authentika dla PomagierKB — krok po kroku

Instrukcja wg `docs/design/infra.md` §2. Wykonuje się ją **raz**, po pierwszym starcie
stacka edge (patrz `docs/deployment.md` krok 3), przez WWW na
`https://auth.ilovelighting.sanok.pl`. Ścieżki menu wg Authentik 2025.x — w innych
wydaniach nazwy mogą się minimalnie różnić.

Na razie **bez SMTP** — Authentik nie wysyła maili (reset hasła, zaproszenia). Konta
zakłada ręcznie `akadmin` (patrz §3). SMTP można dopiąć później w `deploy/edge/.env`
(`AUTHENTIK_EMAIL__*`).

---

## 1. Initial setup — hasło akadmin

1. Wejdź na `https://auth.ilovelighting.sanok.pl/if/flow/initial-setup/`.
2. Ustaw e-mail i **silne hasło** dla wbudowanego konta `akadmin`; zapisz je w menedżerze
   haseł.

**UWAGA:** dopóki initial-setup nie jest wykonany, KAŻDY kto zna adres może przejąć
konto administratora — zrób ten krok natychmiast po starcie stacka.

`akadmin` to konto awaryjne (break-glass) — na co dzień pracuj na własnym koncie
z grupą `kag-admin` (§2-3). Odzyskiwanie `akadmin`: `docs/runbooks/break-glass-authentik.md`.

## 2. Grupy ról panelu

**Directory → Groups → Create**, utwórz trzy grupy (pole „is superuser" zostaw WYŁĄCZONE
— to role aplikacji, nie uprawnienia w Authentiku):

| Grupa | Rola w panelu |
|---|---|
| `kag-admin` | administrator: ustawienia, klucze LLM, bazy, użytkownicy, klucze MCP write |
| `kag-operator` | operator: ingest, Inbox (promote/reject), buildy, własne klucze MCP read |
| `kag-viewer` | podgląd + „Zapytaj bazę" — **domyślna grupa dla całej firmy** |

Panel mapuje grupy na role w kolejności admin → operator → viewer (pierwsza pasująca).
Konto **bez żadnej** grupy `kag-*` dostaje 403 już na poziomie Authentika (bindingi w §5).

Dodaj swoje konto (nie `akadmin`) do `kag-admin`.

## 3. Konta użytkowników (ręcznie, bez SMTP)

Dla każdego pracownika (`Directory → Users → Create`):

1. Username, Name, Email (email jest wymagany przez panel do identyfikacji).
2. Po utworzeniu: karta użytkownika → **Set password** (przekaż hasło bezpiecznym kanałem
   i każ zmienić przy pierwszym logowaniu) — albo **Create recovery link** i wyślij link
   samodzielnie (link = pełne przejęcie konta; traktuj jak hasło).
3. **Zawsze** dodaj konto do `kag-viewer` (konwencja: to grupa domyślna firmy).
   Operatorów/adminów dodatkowo do `kag-operator`/`kag-admin`.

## 4. Provider OIDC dla panelu

**Applications → Providers → Create → OAuth2/OpenID Provider:**

| Pole | Wartość |
|---|---|
| Name | `kag-panel-oidc` |
| Authorization flow | `default-provider-authorization-implicit-consent` (bez ekranu zgody; explicit też zadziała) |
| Client type | **Confidential** |
| Client ID | `kag-panel` |
| Client Secret | wygenerowany — **skopiuj do `deploy/kag/.env` jako `PANEL_OIDC_CLIENT_SECRET`** |
| Redirect URIs | tryb **Strict**: `https://kag.ilovelighting.sanok.pl/api/auth/callback` (dokładnie ten jeden) |
| Signing Key | `authentik Self-signed Certificate` |
| Subject mode | **Based on the User's UUID** (stabilny `sub` — panel wiąże po nim użytkowników i klucze MCP; nie zmieniaj później, bo wszyscy „staną się" nowymi kontami) |

**Scopes** (Advanced protocol settings → Scopes) — zaznacz standardowe mapowania:
`openid`, `email`, `profile` **oraz `offline_access`**. Mapping `profile` emituje claim
`groups` (lista nazw grup) — panel czyta go z ID tokena/userinfo, nic customowego nie
trzeba. `offline_access` daje refresh tokeny — panel utrzymuje sesję absolutną 12 h
z idle 60 min i odświeża tokeny w tle; bez tego scope'a użytkownicy będą wylogowywani
po wygaśnięciu access tokena.

## 5. Aplikacja i bindingi grup

1. **Applications → Applications → Create:** Name `KAG Panel`, slug `kag-panel`,
   Provider `kag-panel-oidc`, Launch URL `https://kag.ilovelighting.sanok.pl/`.
2. Na aplikacji `KAG Panel` → zakładka **Policy / Group / User Bindings** → dodaj trzy
   bindingi **grup**: `kag-admin`, `kag-operator`, `kag-viewer`.
   Efekt: dostęp ma tylko członek którejś z grup; pozostałe konta dostają 403 od
   Authentika zanim dotkną panelu.

Issuer dla panelu (wpisany w `deploy/kag/.env` jako `PANEL_OIDC_ISSUER`):
`https://auth.ilovelighting.sanok.pl/application/o/kag-panel/`

Weryfikacja discovery (z dowolnej maszyny):

```bash
curl -fsS https://auth.ilovelighting.sanok.pl/application/o/kag-panel/.well-known/openid-configuration | head -c 300; echo
```

## 6. Embedded outpost + forward-auth (opcjonalne UI OpenSPG)

Ten krok przygotowuje ochronę ścieżki `/openspg/*` (produktowe UI OpenSPG, tylko
`kag-admin`). Sama ścieżka jest **domyślnie wyłączona** — blok w `deploy/edge/Caddyfile`
jest wykomentowany, a Caddy nie jest wpięty do sieci `kag-internal`. Konfigurację w
Authentiku warto jednak założyć od razu.

1. **Providers → Create → Proxy Provider:**
   - Name: `kag-openspg-fwd`; Authorization flow jak wyżej;
   - tryb: **Forward auth (single application)**;
   - External host: `https://kag.ilovelighting.sanok.pl`.
2. **Applications → Create:** Name `OpenSPG Admin`, slug `kag-openspg`,
   Provider `kag-openspg-fwd`. Bindingi: **TYLKO grupa `kag-admin`**.
3. **Applications → Outposts → `authentik Embedded Outpost` → Edit** → w polu
   Applications zaznacz dodatkowo `OpenSPG Admin` → Update.
   (Embedded outpost żyje w procesie authentik-server — stąd routing
   `/outpost.goauthentik.io/*` w Caddyfile na vhoście `kag.*`; niczego nie instalujesz.)

Włączenie ścieżki (świadoma decyzja admina, zwiększa powierzchnię ataku):
odkomentuj blok `/openspg/*` w Caddyfile, dopnij usługę caddy do sieci `kag-internal`
w compose edge, `docker compose up -d caddy`. Test: niezalogowany → redirect na
`auth.*`; zalogowany bez `kag-admin` → 403; członek `kag-admin` → UI OpenSPG.

## 7. MFA dla kag-admin

Minimum: każdy członek `kag-admin` rejestruje sobie TOTP/WebAuthn w
`https://auth.ilovelighting.sanok.pl/if/user/` → Settings → **MFA Devices**.

Wymuszenie (rekomendowane):

1. **Flows & Stages → Flows → `default-authentication-flow` → Stage Bindings** →
   znajdź binding stage'a `default-authentication-mfa-validation` → Edit stage:
   - Device classes: TOTP + WebAuthn (wg preferencji);
   - **Not configured action: Force configuration**, Configuration stage:
     `default-authenticator-totp-setup`.
2. Żeby wymuszać tylko dla `kag-admin` (reszta firmy bez MFA na razie): na tym
   **stage bindingu** dodaj Expression Policy (Create & bind), treść:

   ```python
   return ak_is_group_member(request.user, name="kag-admin")
   ```

   i ustaw na bindingu „Evaluate when stage is run" (re-evaluate policies).

Test: wyloguj się, zaloguj kontem z `kag-admin` — przy braku urządzenia MFA Authentik
wymusi konfigurację TOTP.

## 8. Higiena

- **System → Brands:** tytuł/logo po polsku (np. „ILoveLighting — logowanie").
- Raportowanie błędów, telemetria i update-check są już wyłączone przez env stacka edge
  (`AUTHENTIK_ERROR_REPORTING__ENABLED=false` itd.) — nie włączaj ich w UI.
- Nie montujemy docker.socka i nie tworzymy outpostów kontenerowych — używamy wyłącznie
  embedded outposta.

## 9. Checklist końcowy

- [ ] `akadmin` ma silne hasło w menedżerze; na co dzień nieużywane.
- [ ] Grupy `kag-admin/operator/viewer` istnieją; Twoje konto w `kag-admin`.
- [ ] Discovery `.../application/o/kag-panel/.well-known/openid-configuration` zwraca 200.
- [ ] `PANEL_OIDC_CLIENT_SECRET` przeniesiony do `deploy/kag/.env` (chmod 600).
- [ ] Logowanie do panelu działa; konto bez grup `kag-*` dostaje 403.
- [ ] Członek `kag-admin` przechodzi przez MFA.
- [ ] Embedded outpost obsługuje aplikację `OpenSPG Admin` (nawet jeśli ścieżka wyłączona).
