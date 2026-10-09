# Listing artwork

Original code-native vector artwork, created October 9, 2026 for Paid Access.
Copyright 2026 Mason James. GPL-2.0-or-later, matching the plugin.

| File | Purpose |
| --- | --- |
| `icon.svg` | Editable 256 × 256 icon source |
| `../../icon.png` | 256 × 256 registry/conventional bundle icon |
| `banner.svg` | Editable 1600 × 900 listing card source |
| `banner.png` | 1600 × 900 registry banner |

Design brief: a small, legible publishing mark combining a page with an open
door; warm paper, dark ink, and a lime accent. The door represents controlled
access. The banner states the two supported payment uses and the free GPL model.
It is product artwork, not a screenshot or a claim of third-party endorsement.
No EmDash, Stripe, or x402 logo artwork was copied. Arial/Helvetica are system
font references in the SVG; no font binaries are distributed.

Execution: authored directly as SVG and rasterized with Sharp 0.35.5. This was
chosen for editable geometry and a crisp small icon; no image-generation model,
stock assets, private source images, or external prompt were used. Both SVGs
carry accessibility titles/descriptions. The PNGs have been visually inspected.

Re-export from the repository root using a local Sharp installation (an optional
artwork tool, not a runtime plugin dependency):

```js
// Run with Node in an environment where sharp@0.35.5 is available.
import sharp from "sharp";
await sharp("assets/listing/icon.svg").png({ compressionLevel: 9 }).toFile("icon.png");
await sharp("assets/listing/banner.svg").png({ compressionLevel: 9 }).toFile("assets/listing/banner.png");
```

PNG export uses the environment's available Arial-compatible fonts. Review text
layout after regenerating on a different OS. Only the icon is conventionally
included in the size-limited sandbox bundle; the manifest's `release.artifacts`
declares both PNG files for separate listing-media upload. No gallery screenshots
are declared until a verified installation can supply real captures.
