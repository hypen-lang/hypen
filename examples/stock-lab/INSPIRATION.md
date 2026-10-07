# Orbit design reference

Visually inspected the full [Investment portfolio app by Jeremy Blaze / Never Before Seen](https://dribbble.com/shots/26607836-Investment-portfolio-app) on 7 September 2026.

Implemented its structural direction in the shared Hypen app: centered regular-weight balance, thin white chart with subtle glow, charcoal surfaces, two-column stock cards, divided holding rows, and persistent Dashboard / Markets / Portfolio / Watchlist navigation. Icons are original SVG paths; reference assets are not copied.

The tabs, stock selection, search, watchlist and period controls are functional. The dashboard uses real paper-holding totals. IBM is a stored Alpha Vantage snapshot; other symbols are clearly identified as synthetic in Markets.

Current captures: `orbit-dashboard-web.png`, `orbit-holdings-web.png`, `orbit-portfolio-canvas.png`, `orbit-portfolio-desktop.png`, `orbit-portfolio-ios.png`, `orbit-portfolio-android.png` under screenshots. Earlier captures document earlier designs.

Checked all five renderers visually; web interactions and five module tests pass. Native preview shells retain their own chrome (the iOS shell obscures the app header; Android overlays its connection badge). Canvas typography and native label metrics still differ, so these captures are not a claim of pixel parity.
