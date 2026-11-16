# RAILBREAKER

3D-Movement-Shooter im Browser. Three.js r170 (ES-Module vom CDN), keine Physik-Library, keine externen Assets:
Geometrie, Texturen, Musik und Soundeffekte entstehen komplett prozedural.

## Starten

| Variante | So geht's |
|---|---|
| `railbreaker-standalone.html` | Doppelklick. Eine einzige Datei, der gesamte Spielcode ist eingebettet (Three.js kommt vom CDN, also Internet nötig). |
| `index.html` + `js/` | Braucht einen lokalen Webserver, weil Browser ES-Module nicht über `file://` laden: `python3 -m http.server 8080` im Projektordner, dann `http://localhost:8080`. |

Die Standalone-Datei ist ein Bündel der Dateien in `js/` (erzeugt mit `esbuild --bundle --format=esm --external:three --external:three/addons/*`). Zum Entwickeln die Mehrdatei-Version nehmen.

## Steuerung

| Taste | Aktion |
|---|---|
| WASD | Bewegen (W halten = Sprint) |
| Maus | Umsehen |
| Linksklick | Pulse Carbine |
| Rechtsklick (halten) | Rail-Gun: Rail wächst in Blickrichtung, die Maus steuert die Kurve |
| Space | Springen / Doppelsprung / Wall-Jump / Rail-Absprung |
| Shift | Dash (2 Ladungen, unverwundbar) |
| Ctrl oder C | Slide (C empfohlen: Ctrl+W schliesst den Browser-Tab) |
| W / S beim Grinden | Speed-Pumping, im Takt der Musik gibt es den Bonus |
| A / D beim Grinden | Lehnen, seitlicher Absprung |
| Esc | Pause |
| R | Schneller Neustart (gleicher Seed) |
| T | Tutorial überspringen |

Alle Tastatur-Belegungen lassen sich unter CONTROLS ändern.

## Speed-Techniken

- **Slide-Jump-Kette:** Im Sprint Slide drücken (+4 m/s), sofort springen, Slide gedrückt halten und so landen. Am Boden greift dann nie die normale Reibung. Der Boost kommt einmal pro Sekunde, das Tempo pendelt sich bei gut 40 m/s ein.
- **Air-Strafe:** Über Sprint-Tempo in der Luft nur A oder D halten und die Maus weich mitziehen. Der Geschwindigkeitsvektor dreht ohne Verlust und legt leicht zu. S bremst in der Luft.
- **Rails:** Gefälle beschleunigt, W halten ebenfalls, W/S-Tipper auf dem Beat geben +3,2 m/s. Kurz vor dem Rail-Ende abspringen = Perfect Release (+20 Energie, Zeitlupe, +50 % Schaden).
- **Rail-Hop:** Beim Absprung in Richtung einer anderen Rail schauen, der Sprung wird ballistisch darauf gelenkt.
- **Rail-Gun in der Luft:** Rechtsklick halten, die Rail fängt dich sofort. Grinden lädt Energie schneller, als die Rail-Gun sie verbraucht.
- **Wallrun-Ketten:** In den Chevron-Korridoren von Wand zu Wand springen. Jeder Wallrun lädt Doppelsprung und Dash wieder auf.
- **Boost-Pads** (gelb) zeigen immer auf einen Rail-Anfang oder eine Brücke. **Launch-Pads** (magenta) auf tiefen Dächern schiessen dich zurück nach oben.
- **Tempo ist Schaden und Schutz:** 10 Schaden im Stand, 30 bei 40 m/s. Über 25 m/s nimmst du 40 % weniger Schaden.

## Die wichtigsten Tuning-Parameter (`js/config.js`)

| Pfad | Bedeutung |
|---|---|
| `player.sprintSpeed`, `groundAccel`, `airAccel` | Grundtempo und Beschleunigung |
| `player.friction`, `overspeedFriction`, `landGrace` | Wie viel Momentum am Boden erhalten bleibt |
| `player.airStrafeGain` | Tempogewinn durch Air-Strafing |
| `player.softCap`, `softCapDrag` | Weiche Geschwindigkeitsgrenze |
| `player.stepHeight`, `ledgeHeight` | Treppen- und Edge-Grab-Assist |
| `slide.boost`, `slide.cooldown`, `slide.friction` | Slide und Slide-Jump |
| `wallrun.*`, `dash.*` | Wallrun-Dauer, Wall-Jump-Impulse, Dash-Tempo und -Ladungen |
| `rail.snapDist`, `rail.minSpeed`, `rail.pumpOnBeat`, `rail.hopRange` | Einrasten, Grind-Tempo, Pumping, Rail-Hop |
| `rail.slowmoScale`, `rail.slowmoTime` | Absprung-Zeitlupe |
| `railgun.growSpeed`, `maxLength`, `energyCost`, `turnRate` | Rail-Gun |
| `weapon.*` | Feuerrate, Schaden, Hitze |
| `enemies.*`, `waves.*` | Gegnerwerte, Spawn-Distanzen, Boss |
| `world.jumpSafety`, `world.fogDensity`, `world.viewRadius` | Critical-Path-Sicherheit, Nebel, Sichtweite in Chunks |
| `flow.*`, `score.*` | Flow-Meter, Overdrive, Punkte |
| `QUALITY` | Render-Auflösung, Partikel, Blur-Samples, FXAA pro Stufe |

## Architektur

| Datei | System |
|---|---|
| `game.js` | Hauptschleife (120-Hz-Physik mit Interpolation), State-Machine, Events |
| `input.js` | Tastatur/Maus, Edge-Queue, Rebinding, Pointer Lock |
| `player.js` | PlayerController: GROUNDED, AIRBORNE, SLIDING, WALLRUNNING, GRINDING, DASHING |
| `camera.js` | CameraRig: FOV, Tilt, Trauma-Shake, Headbob, Lande-Dip, Recoil |
| `rails.js` | Centripetal-Catmull-Rom-Splines mit Bogenlängen-Tabelle, Snapping, Rail-Gun |
| `weapons.js` | Pulse Carbine, Rail-Gun-Energie, Viewmodel |
| `enemies.js` | Pooling, Boids, Sniper, Cutter, Bulwark, Warden, Wellen auf Beats |
| `world.js` | Chunk-Generierung mit Critical Path, Hash-Grid, Capsule-Kollision, Raycasts |
| `vfx.js` | Partikel, Instanz-Batches, Himmel/Wolkenmeer, Post-Processing |
| `audio.js` | Lookahead-Scheduler, Synthwave-Track, Beat-Clock, SFX |
| `score.js` | Flow, Combos, Highscore, Ghost-Aufzeichnung und -Wiedergabe |
| `ui.js` | HUD, Popups, Menüs, Settings |

## Bekannte Abweichungen von der Spezifikation

- **Schatten:** Die Welt ist unbeleuchtet (emissiver Neon-Look), es gibt keine Shadow-Maps. Die Qualitätsstufe regelt stattdessen den Lande-Marker, der in der Luft zeigt, wo du aufkommst.
- **Sprint:** Shift ist laut Tabelle der Dash, darum sprintet man automatisch mit W.
- **Luftkontrolle:** Statt eines reinen Quake-Wish-Caps dreht Input oberhalb des Sprint-Tempos den Geschwindigkeitsvektor und bremst in Gegenrichtung. Das ist für Einsteiger besser steuerbar und lässt Air-Strafing trotzdem zu.
- **Critical Path:** Hub und Gate verbindet immer eine lange Plattform mit zwei Lücken von 62 % der Sprint-Sprungweite oder eine Rampe. So landet ein Sprung im Volltempo mitten auf dem Ziel statt dahinter.
- **Dynamische Auflösung:** Fällt die Framerate unter 50, senkt das Spiel die Render-Auflösung schrittweise (bis 55 %) und hebt sie wieder an, wenn Luft ist.
