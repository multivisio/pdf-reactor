# pdf-reactor

Lokaler PDFreactor für Projekte auf Basis der Simple Reporting Library (srl). Das Tool startet den PDFreactor-Webservice in Docker und rendert aus einem srl-Projekt heraus das PDF, ohne Umweg über den Server.

- `pdf-reactor start | stop | status | …` verwaltet den Docker-Container `pdfreactor` (Port 9423).
- `pdf-reactor pdf | watch | components | file` baut das aktuelle srl-Projekt (`build-pdf`), stellt es über einen kleinen lokalen Webserver bereit und lässt PDFreactor daraus ein PDF erzeugen.

## Voraussetzungen

| | macOS | Linux / Windows (WSL 2) |
|---|---|---|
| **Docker** mit Compose v2 (`docker compose`) | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Docker Desktop mit aktivierter WSL-Integration oder Docker Engine mit Compose-Plugin |
| **Node.js** ≥ 20 | ✓ | ✓ (der `watch`-Modus braucht unter Linux mindestens Node 20) |
| **bash**, **curl**, **git** | vorinstalliert (bash 3.2 reicht) | vorinstalliert |
| **srl-Projekt** mit npm-Script `build-pdf` | ✓ | ✓ |
| **PDFreactor-Lizenzschlüssel** (`licensekey.txt`) | optional | optional |

Ohne Lizenzschlüssel läuft PDFreactor im Evaluationsmodus und setzt Wasserzeichen ins PDF.

Das Docker-Image `realobjects/pdfreactor` gibt es für `amd64` und `arm64`, es läuft also auch nativ auf Macs mit Apple Silicon.

Prüfen:

```bash
docker compose version && node --version
```

## Installation

### 1. Repository klonen

```bash
git clone https://github.com/multivisio/pdf-reactor.git ~/pdf-reactor
```

Der Ort ist frei wählbar, das Script findet seinen Ordner selbst.

### 2. Lizenzschlüssel ablegen (optional)

Die Datei `licensekey.txt` nach `~/pdf-reactor/config/licensekey.txt` kopieren. Sie ist in `.gitignore` eingetragen und wird nie committet.

### 3. Befehl in den PATH legen

```bash
mkdir -p ~/.local/bin
```

```bash
ln -sf ~/pdf-reactor/bin/pdf-reactor ~/.local/bin/pdf-reactor
```

`~/.local/bin` ist nicht überall im PATH. Prüfen mit:

```bash
command -v pdf-reactor
```

Kommt keine Ausgabe, den Ordner in die Konfiguration der eigenen Shell eintragen und ein neues Terminal öffnen.

**macOS** (Standard-Shell ist zsh):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

**Linux / WSL** (bash):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

Das Script selbst läuft immer mit bash (`#!/usr/bin/env bash`), auch wenn die Login-Shell zsh ist. Auf dem Mac genügt das vorinstallierte bash 3.2, Homebrew-bash ist nicht nötig.

### 4. Service starten

Auf dem Mac (und unter WSL mit Docker Desktop) muss Docker Desktop laufen.

```bash
pdf-reactor start
```

Der Befehl wartet, bis der Service antwortet, und gibt dann die Version aus. Beim ersten Start wird das Image geladen, das dauert etwas.

## Nutzung

### PDF aus einem srl-Projekt erzeugen

Im Projektordner (oder einem Unterordner davon) ausführen:

```bash
pdf-reactor pdf
```

Der Befehl startet den PDFreactor-Container bei Bedarf selbst, führt `npm run build-pdf -- --no-clean` aus und schreibt das Ergebnis nach `.output/pdf-reactor/report.pdf`. Statt npm wird pnpm oder yarn verwendet, wenn das Projekt eine entsprechende Lockdatei hat.

| Befehl | Ergebnis |
|---|---|
| `pdf-reactor pdf` | ganzer Bericht → `.output/pdf-reactor/report.pdf` |
| `pdf-reactor watch` | wie `pdf`, rendert bei Änderungen in `src/` und `livingdocs/` neu, dazu im Modus `export` `public/html/` und `public/json/`, im Modus `content` der Quellordner. Solange es läuft, sind das Dokument und das aktuelle PDF (<http://localhost:4175/latest.pdf>) im Browser erreichbar, auch unter Windows aus WSL heraus. Mit `--mode components` für die Komponenten-Übersicht |
| `pdf-reactor components` | alle Livingdocs-Komponenten, je eine pro Seite → `.output/pdf-reactor/components.pdf` |
| `pdf-reactor file <pfad>` | eine einzelne HTML-Datei → `.output/pdf-reactor/generated.pdf` |

### Kunden-Overlays (`--customer`)

Projekte mit einer gemeinsamen Base und Kunden-Overlays unter `pdf/customers/nspXXX-<name>/` (z. B. `nsfd_report-standard-customer`) rendern ein Kunden-PDF so, wie ns.wow es zusammensetzt:

```bash
pdf-reactor pdf --customer nsp281-greiner
```

- Eingabe ist der ns.wow-Export des Kunden als `pdf/customers/<ordner>/pdf.html` (im Projekt per `.gitignore` ausgeschlossen, das sind Kundendaten). Ohne `--mode` läuft dafür der Modus `file`; fehlt die Datei, bricht das Tool mit einem Hinweis ab. Mit `--file` geht auch ein anderer Export.
- Der Build läuft als `npm run build-pdf -- --no-clean --customer <ordner>`. Das Projekt braucht dafür `"build-pdf": "srl build -t pdf"`.
- Nach `pdf.css`/`pdf.js` kommen die Kunden-Dateien in den `<head>`, in der Reihenfolge der `.output/ldd/pdf/<nspXXX>/pdf-configuration.xml` aus dem Build (`custom.css`, `custom.js`, Dateien aus `public/`). Sie werden aus `.output/ldd/pdf/` ausgeliefert, relative URLs für Schriften und Assets funktionieren also wie in ns.wow.
- Das PDF heißt wie der Kundenordner: `.output/pdf-reactor/<ordner>.pdf`, in den anderen Modi `<ordner>-components.pdf` bzw. `<ordner>-report.pdf`.
- `watch` beobachtet zusätzlich den Kundenordner.
- Statt des vollen Ordnernamens reicht das Präfix: `--customer nsp281`.
- `--mode components` rendert alle Komponenten mit den Kunden-Styles, auch ohne Export.

### Aufbau des Dokuments (`export` und `content`)

Liegt im Projekt ein ns.wow-Export (`public/json/routing_<lang>.json`), baut `pdf` das Dokument so nach, wie ns.wow es an PDFreactor schickt (Modus `export`):

- `body.pdf` mit dem Publikationstitel aus `settings.json` (`publicationName`)
- Reihenfolge und Kapitel kommen aus den Dateinamen, nicht aus dem App-Menü: die Seiten aus `public/html/<lang>` numerisch sortiert (`01_02 …` vor `01_10 …`), je führender Nummer ein `div.srl-chapter` (`00`, `01`, …, `99`), darin je Seite ein `div.srl-article srl-<seitenname>`
- es fehlen Seiten mit `excludeFromPdf`, Kategorie-Übersichtsseiten (z. B. `notes_group`) und leere Dateien. Seiten einer Kategorie bekommen die Klasse `srl-category-<kategorieseite>` (Zuordnung aus dem Routing)
- ein Kapitel mit Kapitel-Cover heißt wie dessen Titel (z. B. `srl-business-report`) und bekommt am Anfang die Kapitelnavigation (Running Header), wie bei ns.wow
- liegt `public/json/pdf_structure.json` vor, gelten Reihenfolge, Kapitelnamen und Livingdocs-IDs daraus (sonst: uuid aus dem Routing, Kapitel ohne Cover heißen `chapter-<nn>`)
- `pdf.css` und `pdf.js` stehen inline im `<head>`, Bilder kommen aus `public/images`
- auf das Seiten-HTML werden die PDF-Regeln angewendet wie in ns.wow: `data-remove-from-pdf="complete"` entfernt das Element, `"transient"` behält nur den Inhalt, `data-replace-tag` benennt es um, Links auf andere Seiten zeigen auf den Anker im Dokument. Die Attribute der anderen Ausgaben (`data-remove-from-web`, `-word`, `-xhtml`) bleiben stehen
- das fertige Dokument wird nach `.output/pdf-reactor/document-<lang>.html` geschrieben, PDFreactor lädt genau diese Datei. Im Terminal steht, wie viele Elemente entfernt, entpackt und umbenannt wurden

Als Quelle eignen sich die Rohdaten aus ns.wow, in denen noch alle `data-remove-from-*` stehen (`--source-dir <ordner>` mit Unterordnern je Sprache). Der Web-Export in `public/html` enthält keine Elemente, die nur im PDF vorkommen (`data-remove-from-web` ist dort schon angewendet): Cover, Inhaltsverzeichnis, Kapitel-Cover, Impressum, Rückseite und reine PDF-Komponenten wie `srl-pdf-pagebreak` fehlen deshalb. Findet sich in der Quelle kein `data-remove-from-web`, warnt das Tool. Ohne Routing-Datei, oder mit `--mode content`, wird jede Datei aus `public/html/<lang>` nur in ein eigenes `<article>` gepackt.

### Optionen

Alle Pfade sind relativ zum Projektordner.

| Option | Bedeutung | Standard |
|---|---|---|
| `--skip-build` | `build-pdf` überspringen, vorhandenen Build verwenden | |
| `--customer <ordner>` | Kunden-Overlay aus `pdf/customers/`, siehe oben | |
| `--mode <export\|content>` | Aufbau des Dokuments, siehe oben | `export`, wenn `public/json/routing_<lang>.json` existiert |
| `--lang <code>` | Sprachordner unterhalb des HTML-Quellordners | `de` |
| `--source-dir <dir>` | HTML-Quellordner, z. B. die Rohdaten aus ns.wow | `public/html`, sonst `public/pdf/web/html` |
| `--config <xml>` | PDFreactor-Konfiguration | `pdf/pdf-configuration-debug.xml` |
| `--public-base <dir>` | Basisordner für Assets (Bilder usw.), nicht im Modus `export` (dort immer `public`) | `public/exclude/web` |
| `--output <datei>` | anderer Ausgabepfad | |
| `--no-js` | ohne JavaScript rendern (wie die PDF-Vorschau im Editor) | |
| `--keep-file-assets` | nur `file`: eigene Styles und Scripts der Datei behalten | |
| `--port <port>` | Port des lokalen Dokumentservers | `4175` |
| `--document-host <host>` | Host, über den PDFreactor den lokalen Server erreicht | `host.docker.internal` |
| `--pdfreactor-url <url>` | anderen PDFreactor-Service verwenden (kein Autostart) | |

Beispiele:

```bash
pdf-reactor pdf --skip-build --lang en
```

So wie in Produktion, ohne angehängtes Log:

```bash
pdf-reactor pdf --lang en --config pdf/pdf-configuration.xml
```

```bash
pdf-reactor file public/exclude/generated.html --no-js
```

Aus einem npm-Script heraus funktioniert es ebenfalls, der Projektordner wird dann über `INIT_CWD` erkannt:

```json
"scripts": {
  "pdf:local": "pdf-reactor pdf"
}
```

### Service verwalten

| Befehl | Wirkung |
|---|---|
| `pdf-reactor start` | Container starten und warten, bis der Service bereit ist |
| `pdf-reactor stop` | Container stoppen |
| `pdf-reactor restart` | Container neu starten |
| `pdf-reactor reload` | Container neu erstellen, damit Konfiguration, Lizenzschlüssel und Änderungen an der Compose-Datei greifen |
| `pdf-reactor status` | Zustand von Container und Service |
| `pdf-reactor logs [-f]` | Logs anzeigen (weitere Argumente gehen an `docker compose logs`) |
| `pdf-reactor shell` | Shell im Container |
| `pdf-reactor update` | Image neu laden und Container neu erstellen |
| `pdf-reactor edit` | `config/pdfreactorwebservice.config` im `$EDITOR` öffnen, danach optional `reload` |
| `pdf-reactor down` | Container stoppen und entfernen |
| `pdf-reactor path` | Installationsordner ausgeben |

PDFreactor liest Konfiguration und Lizenzschlüssel nur beim Start. Nach Änderungen daran `pdf-reactor reload` ausführen, `restart` reicht nicht.

### Umgebungsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `PDFREACTOR_PORT` | Port des PDFreactor-Service | `9423` |
| `PDFREACTOR_WAIT` | maximale Wartezeit beim Start in Sekunden | `60` |
| `PDFREACTOR_LOG_LINES` | Anzahl Zeilen bei `logs` | `100` |
| `PDFREACTOR_PROJECT_ROOT` | srl-Projekt für die PDF-Befehle, statt es über den aktuellen Ordner zu suchen | |

Ein anderer Port muss bei jedem Befehl gesetzt sein, zum Beispiel dauerhaft in `~/.zshrc` bzw. `~/.bashrc`.

## Schriften

Schriften kommen ausschließlich aus dem jeweiligen Projekt. `build-pdf` legt sie in `.output/fonts/` ab und das Tool bindet sie ein. Fehlt `.output/fonts/style.css`, erscheint eine Warnung und das PDF wird mit Ersatzschriften gerendert.

## Fehlersuche

- **`docker not found` oder der Container startet nicht:** Läuft Docker Desktop? Mit `docker compose version` prüfen, ob Compose v2 verfügbar ist.
- **PDFreactor ist nur lokal erreichbar:** Der Port 9423 ist an `127.0.0.1` gebunden, andere Rechner im Netzwerk können den Service nicht nutzen.
- **Port 9423 ist belegt:** einen anderen Port über `PDFREACTOR_PORT` setzen.
- **Port 4175 ist belegt** (z. B. durch ein zweites `watch`): `--port` verwenden.
- **macOS fragt, ob `node` eingehende Verbindungen annehmen darf:** erlauben. PDFreactor im Container holt das Dokument über diesen Port vom lokalen Server.
- **PDFreactor erreicht den lokalen Server nicht:** Unter WSL ist ein neu geöffneter Port kurz nicht erreichbar, das Tool versucht es deshalb bis zu fünfmal. Hilft das nicht, Firewall und `--document-host` prüfen.
- **Bilder oder Styles fehlen, im Terminal steht „Blocked request for …“:** Der lokale Server liefert nur Dateien aus `.output`, `public`, `src`, `livingdocs` und dem Ordner von `--public-base` aus, damit der Rest des Projekts (z. B. `.env`, `.git`) im Netzwerk nicht abrufbar ist. Assets dort ablegen oder `--public-base` anpassen.
- **Die Adresse mit `host.docker.internal` lässt sich im Browser nicht öffnen:** Unter diesem Namen erreicht nur PDFreactor im Container den lokalen Server. Im Browser `localhost` verwenden, und zwar mit `watch`, denn bei `pdf`, `components` und `file` läuft der Server nur während des Renderns.
- **PDF sieht falsch aus:** `.output/pdf-reactor/document-<lang>.html` (Modus `export`) bzw. `last-wrapper.html` enthält das HTML, das an PDFreactor ging. Ist die Antwort kein PDF, liegt sie in `.output/pdf-reactor/last-pdfreactor-response.bin`. Zusätzlich `pdf-reactor logs` ansehen.
- **Warnung „removing container 'pdfreactor' from other setup“:** Ein Container gleichen Namens aus einer anderen Installation wurde entfernt. Das ist gewollt.
