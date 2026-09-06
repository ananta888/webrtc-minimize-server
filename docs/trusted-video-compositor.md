# Trusted-Video-Compositor

## Grenze

Der Browser-Compositor läuft ausschließlich im bewusst gestarteten
Broadcast-Zweig. Er erhält nur die bereits geklonten und in der aktuellen
Program-Epoch consentierten Kamera-/Bildschirmtracks. Die interaktive
Raumdarstellung, Originaltracks und SFrame-Pfade werden nicht verändert.

Der Ausgang ist genau ein fester Canvas-Videotrack (`program-video`) mit
stabiler Geometrie und Bildrate. WHIP behandelt diesen Track als detailreichen,
hoch priorisierten Programmausgang. Stop, Abort und Destroy lösen Videoelemente,
Timer, Canvas und Ausgangstrack; Originaltracks werden nicht gestoppt.
Quellenende entfernt nur den jeweiligen Eingang und degradiert bei Bedarf zum Slate.

## Profile und Layouts

| Profil | Geometrie | FPS | Zweck |
|---|---:|---:|---|
| Bandbreite | 960 × 540 | 12 | langsame Uplinks |
| Ausgewogen | 1280 × 720 | 24 | Standard |
| Bildschirmtext | 1920 × 1080 | 15 | lesbare Folien/IDE |
| Qualität | 1920 × 1080 | 30 | bewegte Kamera |

Implementiert sind Einzelquelle, Bildschirm plus Presenter, Side-by-Side,
Active Speaker, Grid, Waiting Slate und End Slate. Bildschirmquellen verwenden
`contain`, damit keine Texte abgeschnitten werden. Kameras verwenden `cover`;
im Presenter-/Active-Speaker-Layout erzwingt das Profil eine Mindestbreite für
das Kamera-Thumbnail.

Ein langsamer Renderpfad senkt die effektive FPS schrittweise bis auf fünf und
erholt sich langsam. Versteckte Tabs werden ebenfalls auf fünf FPS begrenzt.
Endet eine Quelle, wird sie aus dem Layout entfernt; ohne verbleibende Quelle
erscheint ein neutrales Wartebild. Die Canvas-Capture-Uhr bleibt beim Browser
und wird weder aus eingehenden Frame-Timestamps noch aus Raumdaten konstruiert.

## Metadaten und Datenschutz

Quellnamen, Programmtitel und Untertitel sind im Overlay standardmäßig aus.
Der Renderer akzeptiert nur eine geschlossene, längenbegrenzte Policy ohne
Steuerzeichen. Dadurch gelangen private Raumtitel oder Anzeigenamen nicht
implizit in ein öffentliches Programmbild. Die spätere Cockpit-Integration muss
jede dieser Optionen sichtbar und explizit aktivieren.

## Lifecycle und Grenzen

Jeder lokale Video-Start ist auf fünf Sekunden begrenzt und sofort abbrechbar.
Setup-Fehler, Abort und Close lösen Listener, Timer, Videoelemente und jeden
bereits erzeugten Ausgangstrack. Eingangsquellen gehören weiterhin dem Capture-
bzw. Consent-Lifecycle und werden vom Compositor nicht selbst gestoppt.
Auch ein lokaler Track-Stopp ohne `ended`-Ereignis entfernt die Quelle beim
nächsten Renderdurchlauf; ohne Quellen erscheint die neutrale Starttafel.

Ein nicht behandelbarer Renderfehler beendet den Ausgang statt einen verwaisten
Render-Timer fortzuführen. Der Snapshot meldet `render-error` und effektive FPS 0.
Ein neuer Capture- oder Broadcast-Start wird dadurch niemals automatisch ausgelöst.
Nach Close werden weitere Layout-/Overlay-Änderungen abgelehnt.

Der implementierte Pfad ist **Main-Thread-Canvas**, kein Worker-Versprechen.
Render-Backpressure reduziert begrenzt die Ziel-FPS; versteckte Tabs verwenden
höchstens fünf FPS. Browser-/OS-Drosselung kann stärker ausfallen. Eine
OffscreenCanvas-/Worker-Auslagerung und reale Hintergrund-/Mobile-Gates bleiben
offen. Die lokale Canvas-Clock beweist keine A/V-Lippensynchronität beim Zuschauer.

## Reproduzierbare Verifikation

```sh
node --test test/trusted-video-compositor.browser.test.js
RUN_COMPOSITOR_SOAK=1 COMPOSITOR_SOAK_SECONDS=3600 \
  node --test test/trusted-video-compositor.browser.test.js
```

Der Standardgate startet echte headless Chromium-/Firefox-Kontexte und nach einem
synthetischen lokalen Button-Klick eigene Canvas-Quellen. Physische Capture-APIs
sind gesperrt. Unabhängige Pixel-Erwartungen prüfen alle sieben Layouts,
Bildschirm-Letterboxing, Kamera-Cropping, Titel-Consent und Quellenende. Der
Ausgang wird über ein echtes Videoelement gelesen, nicht durch Zählen von
`drawImage`-Mocks. Frame-Callbacks prüfen Fortschritt und monotone Media-Zeit.

Der opt-in Langzeitlauf dauert standardmäßig **eine Stunde pro Browser** und
wechselt laufend Layouts. Er prüft sowohl tatsächlich dargestellte Frames als
auch Änderungen bekannter bewegter Quellpixel, damit weiterlaufende Framezähler
kein eingefrorenes Bild kaschieren. Die Evidenz nennt Browserversion und SHA-256
des tatsächlich gebündelten Test-/Produktionscodes. Ein kürzerer Probelauf ist
kein Stunden-Nachweis. Heapwerte sind nur Browser-Schätzungen, falls verfügbar;
fehlende Werte werden nicht erfunden. Ein Zuwachs über 64 MiB beendet den Gate.

CPU, gesamter Prozess-RSS, physische Kamera-/Bildschirmtextqualität, Audio-Clock,
Lippensynchronität, Bluetooth, Worker-Rendering und reale Hintergrunddrosselung
werden dadurch ausdrücklich **nicht** als verifiziert ausgegeben. Diese separaten
Akzeptanzgates halten TBP-015 offen.

Automatische quellengebundene VAD-/Sprecherzuordnung ist weiterhin offen. Der
Active-Speaker-Renderer akzeptiert bisher eine ausdrücklich gewählte Quell-ID.
TBP-015 bleibt während dieser Arbeiten `in_progress`, nicht abgeschlossen.
