# Oddělení živé polohy od zakázek

## Měření před migrací

Na testovací databázi simulovat 10, 30 a 60 současně přihlášených řidičů. Každý posílá GPS po 5 až 8 sekundách. Dispečeři během zátěže zakázky vytvářejí, přidělují a vracejí k přeřazení. Sledovat velikost odpovědí, p95 doby zápisu GPS a zakázky, konflikty revizí a stáří poslední polohy. Měřit zvlášť po dobu klidu, náběhu směny a nahromaděných změn.

Tato verze už omezuje odesílání GPS při častých změnách na nejvýše jednou za 5 sekund v běžícím webovém klientu a zpomaluje dotazy skryté stránky s aktivními push oznámeními.

## Návrh dat a migrace

1. Přidat tabulku posledních poloh s jedním řádkem na řidiče. Ukládat souřadnice, přesnost, čas měření, ID relace, čas pro výpočet aktivity a vlastní revizi. Primární klíč je ID řidiče. Potřebné indexy ověřit podle skutečných dotazů. V této fázi přidat také oddělenou evidenci denní aktivity řidiče s klíčem řidič a datum.
2. V databázové transakci ověřit relaci a otevřenou směnu, zamknout řádek konkrétního řidiče a přijmout pouze stejně nové nebo novější měření. Aktualizaci aktivity a polohy uložit společně. Ukončení směny, odhlášení a odebrání oprávnění musí zároveň zneplatnit polohu. Zachovat pravidlo 45 sekund pro přidělení zakázky.
3. Zavést samostatné čtení poloh s vlastní revizí pro mapu. Endpoint omezit stejnými oprávněními jako současné zobrazení. Klient dál načítá zakázky s původní revizí. Pohyb vozu přestane způsobovat opakované stahování historie zakázek.
4. Pod příznakem nové cesty zkopírovat stávající platné polohy a aktivitu, dočasně zapisovat a porovnávat obě reprezentace, poté přepnout čtení i zápis. Při problému se vrátit na čtení původního stavu, dokud probíhá dvojí zápis. Stará data odstranit až po ověření konzistence a možnosti obnovy.
5. Po porovnání výsledků samostatně oddělit zakázky a směny. Změna stavu zakázky, přidělení řidiče a uzávěrka musí dál atomicky ověřovat oprávnění, dostupnost a součty. Historii načítat dle data a řidiče se stránkováním.

První nasazení rozdělené databáze patří do testovacího prostředí. Ověřit paralelní GPS z více zařízení, konkurující přiřazení, uzávěrku přes půlnoc v Praze, odhlášení a návrat na původní čtení. V této sadě úprav se databáze nemigruje.
