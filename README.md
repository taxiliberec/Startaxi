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
