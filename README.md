# OptiCode Studio

OptiCode Studio is an all-in-one, privacy-first QR, barcode and optical file-transfer workspace built with React, Vite, TypeScript and Framer Motion.

## What it includes

- QR Code Generator with live preview and PNG / SVG / JPEG export
- Photo → QR encoding with automatic single-QR sizing
- Lossless Multi-QR photo/file framing for larger payloads
- Smart QR + barcode scanner using camera, gallery and drag/drop images
- QR, EAN, UPC, Code 128/39, Data Matrix, PDF417 and other supported scan formats
- Barcode Lab for local UPC/EAN/ISBN normalization and check-digit validation
- Scan Library with search, tags, favorites, backup and restore
- Local Scan Analytics
- OptiTransfer 2.0 with four-lane QR streaming, fountain recovery and SHA-256 verification
- Worker-based QR encoding with a four-group prefetch pipeline and synchronous browser fallback
- Experimental OptiFrame v1 codec: four-level grayscale / 2-bit optical symbols with four finder patterns, perspective correction and CRC-32
- Completion-timed 1 MB physical optical benchmark with sustained and best-≥1-second peak goodput
- Browser-side protocol diagnostics, multi-lane tests and recovery stress tests (`#/diagnostics`)
- Phase 4 OptiFrame receiver hardening: multi-worker perspective decoding, tracked-region acquisition and 1×/2×/4× lane decoding
- Dark, light and system themes with contrast-aware light-mode styling
- Installable PWA with GitHub Pages deployment

## Stack

- React 18
- Vite
- TypeScript
- Framer Motion
- React Router
- Lucide React
- Sonner
- qrcode
- jsQR
- @zxing/browser

## Privacy model

Camera frames, generated QR payloads and scan history are processed locally by the browser. The app does not require an account or a server-side scan database. External actions such as opening a website, search, email, map or payment URI are controlled by the device/browser after you choose them.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

The repository is `Mahin98250/OptiCode-Studio` and the GitHub Pages deployment uses the `/OptiCode-Studio/` base path.

---

## Project links

- **GitHub profile:** https://github.com/Mahin98250
- **Portfolio repository:** https://github.com/Mahin98250/Porfolio
- **More projects:** https://github.com/Mahin98250?tab=repositories

> Live demo links will be added only after the deployment URL is verified.
