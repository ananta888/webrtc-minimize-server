# Trusted-Video-Compositor

## Grenze

Der Browser-Compositor läuft ausschließlich im bewusst gestarteten
Broadcast-Zweig. Er erhält nur die bereits geklonten und in der aktuellen
Program-Epoch consentierten Kamera-/Bildschirmtracks. Die interaktive
Raumdarstellung, Originaltracks und SFrame-Pfade werden nicht verändert.

Der Ausgang ist genau ein fester Canvas-Videotrack (`program-video`) mit
stabiler Geometrie und Bildrate. WHIP behandelt diesen Track als detailreichen,
hoch priorisierten Programmausgang. Stop, Abort, Quellenende und Destroy lösen
Videoelemente, Timer, Canvas und Ausgangstrack; Originaltracks werden nicht
gestoppt.

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

## Noch offener Real-Gate

Die deterministischen Tests prüfen Geometrien, Thumbnail-Floor, Slate,
geschlossene Profile, opt-in Overlays, Erzeugung und Cleanup. Noch offen und
nicht als bestanden behauptet sind OffscreenCanvas-/Worker-Auslagerung,
automatische VAD-Kopplung, ein visueller Golden-Test mit echten Kamera- und
Bildschirmquellen sowie der geforderte 60-Minuten-A/V-, Freeze-, CPU- und
Memory-Lauf auf realen Geräten. Deshalb bleibt TBP-015 `partial`.
