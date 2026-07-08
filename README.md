# bim-ifc-loi-editor

Experimental browser-only demo for checking and editing IFC LOI (Level of Information) data.

This repository is for experimentation and validation of a front-end IFC LOI workflow. It is not intended to be a production BIM authoring tool.

The app loads an IFC STEP file in the browser, runs rule-based LOI checks, shows warnings in an editable table, highlights selected targets in a schematic 3D view, and downloads the edited IFC file.

Live demo:

```text
https://bim-ifc-loi-editor.0xkaz.com
```

## Features

- Open an IFC file from disk, drag and drop it, or load the bundled sample.
- Load the bundled LOI rules or open a custom JSON rule file.
- Inspect IFC entity counts, property sets, units, and target check results.
- Edit missing or failing LOI fields directly from the check results table.
- Highlight the selected target in the viewer while editing.
- Download the modified IFC file from the browser.
- Runs offline after dependencies are installed. No CDN or external API is required at runtime.

## Technology

- Vite
- TypeScript
- Vitest
- Three.js

This project does not currently use Rust, WebAssembly, `web-ifc`, or `@thatopen/components`. The viewer is a lightweight schematic Three.js view, not a full IFC geometry renderer. The LOI parser and checker are independent browser-safe TypeScript modules.

## Getting Started

Requirements:

- Node.js 22 or newer is recommended.
- pnpm

Install dependencies:

```bash
pnpm install
```

Start the development server:

```bash
pnpm dev
```

Open the Vite URL shown in the terminal, then use **Open sample** or drop an IFC file into the viewer.

## Build and Test

```bash
pnpm test
pnpm build
```

The production build is emitted to `dist/`.

## Editing and Downloading IFC

1. Load an IFC file.
2. Review the `Target results` table.
3. Enter values in the `Edit` column for missing or failing rows.
4. Click `Apply` on the relevant row.
5. Click `Download IFC`.

The download uses the current in-memory STEP document, including edits applied in the table.

## Rule Files

The default rule file is:

```text
rules/space-basic.json
```

Custom rule files can be opened with **Load rules**. Rule evaluation is separate from the viewer, so checks still work even if 3D rendering is unavailable.

## Sample Files

The bundled sample IFC is:

```text
fixtures/golden-house.ifc
```

It is included for local demo and test purposes.

## Known Limits

- This is an experimental demo repository.
- The 3D view is schematic and is intended to make target selection visible. It does not render full IFC geometry.
- The IFC support is focused on STEP text parsing and LOI-oriented entity/property editing.
- Edits are applied to supported attributes and `IfcPropertySingleValue`-style rule targets.
- Do not treat edited IFC output as production-ready without independent validation in dedicated BIM/IFC tooling.

## Cloudflare Pages

Use these settings for Cloudflare Pages:

- Build command: `pnpm build`
- Build output directory: `dist`
- Root directory: repository root

No runtime environment variables are required.

## Repository Hygiene

Do not publish generated or local dependency directories such as `node_modules/`, `.pnpm-store/`, or `dist/`.

## License

Apache-2.0. See `LICENSE`.
