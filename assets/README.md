# Porygon assets

Logo files for the Porygon README / site.

| File | Use |
|------|-----|
| `porygon.svg` | Scalable mark — best for the README header & favicon |
| `porygon-512.png` … `porygon-16.png` | Raster mark, transparent background, square |
| `porygon-lockup-light.png` | Mark + wordmark for light backgrounds |
| `porygon-lockup-dark.png`  | Mark + wordmark for dark backgrounds |

## Drop into your README

Centered header that swaps with GitHub's light/dark theme:

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"  srcset="assets/porygon-lockup-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/porygon-lockup-light.png">
    <img alt="Porygon" src="assets/porygon-lockup-light.png" width="320">
  </picture>
</p>

<p align="center">Tooling for AI-augmented pokeemerald decomp ROM hacking.</p>
```

Just the mark:

```md
<img src="assets/porygon.svg" width="96" align="left">
```
