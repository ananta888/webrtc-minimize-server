# draw.io Web-App (eingebetteter Diagramm-Editor)

Herkunft: offizielles Release `jgraph/drawio` **v32.6.1**, Artefakt `draw.war`
(`https://github.com/jgraph/drawio/releases/download/v32.6.1/draw.war`)

- SHA-256 des Release-Artefakts: `44dd56958c8408963457dc98f04d2228408ac145c7aa1d8e6895d9c88d5e42aa`
- Lizenz: Apache-2.0 (siehe `LICENSE`, `NOTICE`)
- Umfang: auf den Embed-Betrieb beschnittener Teilbaum (`webapp/`, 30,7 MB)

## Was enthalten ist

- Einstiegsdateien (`index.html`, `clear.html`, `favicon.ico`, `shortcuts.svg`)
- Editor-Bundles: `js/app.min.js`, `js/stencils.min.js`, `js/shapes-14-6-5.min.js`, `js/extensions.min.js`
- Loader und Kleinteile: `js/bootstrap.js`, `js/main.js`, `js/deflate/`, `js/math/`
- Stile (`styles/`), Symbole (`img/`, `images/` ohne Vorschaubilder der Cloud-Panels), Formen (`shapes/`, `stencils/`)
- Sprachdateien: `resources/dia.txt` (Englisch), `dia_i18n.txt`, `dia_de.txt`

## Was entfernt wurde

Java-Webapp-Gerüst (`WEB-INF/`), nicht kompilierte Quellbäume (`js/diagramly/`, `js/grapheditor/` u. a.),
Viewer- und Cloud-Integrations-Bundles (`js/viewer*.min.js`, `js/integrate.min.js`),
optionale Import-/Layout-Plugins (`js/orgchart*`, `js/plantuml/`, `js/mermaid/`, `js/elk/`,
`js/gliffy/`, `js/vsd*/`, `js/libavoid-js/`), Template-Galerie (`templates/`), MathJax v4 (`math4/`),
Service-Worker/Workbox, OAuth-Rückkanäle (`connect/`) und alle Nachrichtenkataloge außer
Englisch und Deutsch.

Folge: Formeln in Diagrammen werden nicht gerendert; Importe aus Fremdformaten und
Mathe-/Mermaid-/PlantUML-Erweiterungen stehen nicht zur Verfügung. Kern-Bearbeitung,
Import/Export des drawio-XML-Formats und Diagramm-Exporte sind unverändert nutzbar.

## Nutzung in diesem Produkt

Die Webapp wird ausschliesslich same-origin unter `/drawio/` ausgeliefert und in einem
iframe mit `?embed=1&proto=json` betrieben. Cloud-Speicher sind ueber URL-Parameter
(`gapi=0 od=0 ms365=0 gh=0 gl=0 stealth=1`) und fehlende Integrations-Bundles doppelt
deaktiviert. Inhalte verlassen niemals den Browser-Peer-Pfad.

Der Produktname nennt draw.io nicht (UI-Bezeichnung: „Diagramm-Editor"); Markenrechte
an „draw.io"/„diagrams.net" verbleiben beim Rechteinhaber. Icon- und Stencil-Bibliotheken
werden nur als Teil dieser Webapp ausgeliefert und nicht als eigene Produkt-Assets
weiterverwendet; die zusaetzlichen Bedingungen aus dem upstream README (u. a. kein
Atlassian-Bezug, keine Nutzung als KI-Trainingsgrundlage) bleiben zu beachten.
