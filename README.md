# taximetr
Taxik

## Přihlášení a oznámení

- Přihlášení vyžaduje jméno a heslo. Šest neúspěšných pokusů na jméno v 15minutovém okně dočasně zablokuje další pokusy. Úspěšné přihlášení počítadlo vynuluje.
- Má-li majitel již vlastní heslo, použije ho. Pro první založení účtu `owner` lze serveru nastavit `TAXI_OWNER_PASSWORD` s novým heslem o 12 až 128 znacích. Po prvním úspěšném přihlášení je heslo v databázi uložené jako hash a proměnnou lze odstranit. Staré účty může majitel převést přes Nastavení → Nastavit přihlášení. Tím zůstanou spojené se stávajícími jízdami a směnami.
- Dlouhodobá relace obnovuje poslední profil z bezpečné cookie. Funguje ve stejném prohlížeči s uloženými daty a obnovuje se při používání. Odhlášení relaci zruší.
- Pro Web Push nastavte dlouhodobý soukromý klíč P-256 ve formátu JWK do `TAXI_PUSH_VAPID_JWK` a kontaktní adresu ve tvaru `mailto:…` do `TAXI_PUSH_CONTACT`. Klíč lze vytvořit příkazem níže. Uložte ho jako tajnou hodnotu serveru. Výměna klíče vyžaduje novou registraci oznámení na zařízení.

  ```sh
  node -e "console.log(JSON.stringify(require('node:crypto').generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'})))"
  ```

- Řidič povolí oznámení v aplikaci a v systému telefonu. Na iOS musí aplikaci otevřít z ikony přidané na plochu. Zvuk systémových oznámení řídí telefon.
- Webová verze obnoví GPS při spuštění s otevřenou směnou a po návratu do aplikace. Pro odesílání během skutečného uspání webu je třeba nativní služba polohy s oprávněním pro běh na pozadí. Na Androidu ji lze provozovat jako službu na popředí se stálým oznámením, na iOS přes Core Location s režimem polohy na pozadí. Zakázky a uzávěrky mají používat stejný serverový stav.

Návrh oddělení poloh a zakázek je v [PERFORMANCE.md](PERFORMANCE.md).

## Jedna produkční verze pro všechny taxislužby

Každá zákaznická služba sleduje repozitář `taxiliberec/Startaxi` a jedinou produkční větev `feature/customer-booking`. Vylepšení slučujte jednou do této větve. Render po každém commitu automaticky sestaví každou připojenou službu. Během sestavování mohou být instalace krátce na různých verzích. Výsledek ověříte podle SHA nasazeného commitu a odpovědi `/healthz`.

Novou taxislužbu připojte jednou:

1. Založte jí vlastní projekt Supabase. Ze sekce Connect vezměte PostgreSQL připojení pro server (např. Session pooler) s TLS. Databázová role musí při prvním startu umět vytvořit tabulku v public. Připojení uložte jen do tajné proměnné Renderu `DATABASE_URL`.
2. V samostatném Render workspace zákazníka připojte tento GitHub a vytvořte Blueprint z produkční větve se souborem `render.yaml`. Ve sdíleném workspace vytvořte samostatnou Web Service s unikátním názvem a stejnou větví, automatickým nasazením po commitu, příkazem sestavení `npm ci && npm test`, startem `npm start`, kontrolou `/healthz` a `TAXI_PROXY_HTTPS=1`.
3. Nastavte vlastní počáteční `TAXI_OWNER_PASSWORD` (12–128 znaků). Pro mobilní oznámení nastavte vlastní dvojici hodnot VAPID podle části výše. Po prvním přihlášení lze počáteční heslo z prostředí odebrat.
4. Ověřte odpověď `OK` na `/healthz`, přihlášení majitele a zákaznický vstup `/customer/` na doméně zákazníka. První spuštění v prázdné databázi vytvoří provozní tabulku. Další nasazení zachovají její obsah.

Rozhraní, adresní katalog a pravidla aplikace pocházejí ze stejného commitu. Jízdy, GPS, účty, zákaznické nastavení a relace patří do databáze příslušné taxislužby. Více domén téže taxislužby může vést na stejnou Render službu.
