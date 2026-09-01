---
schema: design-context/v1
surface: developer-ui
sources:
  - src/cli.ts
  - docs/prototype.html
  - docs/launch-video.html
  - docs/launch-video-16x9.html
  - docs/launch-video-9x16.html
  - branding/logo.png
---

# vibelive design

## Overview

vibelive has three designed surfaces.
The shipped CLI renders process output, presence, chat, and control state.
`docs/prototype.html` is an interactive visual prototype.
The launch HTML files are timed media compositions.

Keep the CLI compatible with the user's terminal.
Treat prototype interactions and launch scenes as demonstrations.
Do not imply that the browser prototype ships with the CLI.

## Colors

The shipped CLI defines no ANSI palette.
Raw process output goes to `stdout` unchanged.
Status, chat, presence, control, and errors use the terminal default on `stderr`.

The prototype and launch files define these core roles:

- Canvas: `--bg-0` `#07080b`.
- Prototype background layer: `--bg-1` `#0d0f14`.
- Terminal panel: `--panel` `#101319`.
- Launch status panel: `--panel-2` `#0c0e13`.
- Primary text: `--text-0` `#e8eaf0`.
- Secondary text: `--text-1` `#9aa3b8`.
- Muted text: `--text-2` `#5c6478`.
- Primary accent: `--amber` `#f5a524`.
- Text on amber: `--amber-ink` `#241a04`.
- Peer accents: `--red` `#e5484d` and `--blue` `#3b82f6`.
- Success and local state: `--green` `#3ddc84`.
- Panel edge: white at seven percent opacity.

Use amber for focus, driver state, and the `live` wordmark segment.
Use participant colors consistently within one scene.
Use amber ink for text placed on amber.

## Typography

The CLI inherits the user's monospace terminal font.
Do not add ANSI typography or replace wrapped process formatting.

Prototype terminal content uses this stack:
`ui-monospace`, `SF Mono`, `Menlo`, `Cascadia Code`, Consolas, monospace.
Prototype feed text is 13.4px with a `1.65` line height.

Launch media adds a system sans-serif stack for labels and wordmarks.
Terminal streams remain monospaced.
Preserve the sizes in each aspect-ratio file.

## Layout

CLI status lines go to `stderr`.
Indent join URLs and driver instructions with two spaces.
Send wrapped process output to `stdout` without added indentation.
Use bracketed labels for presence, control, errors, and lifecycle state.

The prototype terminal is at most 920px or 94vw wide.
Its body uses `18px 20px 14px` padding.
At 640px, reduce body padding and hide the path and chat hint.

Launch canvases have fixed output dimensions:

- `docs/launch-video.html`: 1280 by 720.
- `docs/launch-video-16x9.html`: 1920 by 1080.
- `docs/launch-video-9x16.html`: 1080 by 1920.

Scale each fixed canvas to the viewport without changing its aspect ratio.

## Elevation & Depth

Elevation does not apply to shipped CLI output.

Visual terminal frames use a one-pixel translucent border.
They use an inset highlight and two dark outer shadows.
Cursor labels use a smaller shadow for separation from terminal text.
Launch scenes may dim, blur, or recede the terminal before the end card.

## Shapes

The owned icon is the 400px square file at `branding/logo.png`.
It uses a rounded blue field and two overlapping pointer shapes.

Visual terminals use rounded frames.
Avatars and driver rings are circles.
The prototype uses pill shapes for local state.
Cursor labels use an asymmetric speech-tag radius.

Use `›` as the prototype chat prompt.
Use `▌` as its typing cursor.
Use a star only to identify the host avatar in visual media.

## Components

- The host banner names the wrapped command and prints join details.
- The join view streams agent output and prints presence to `stderr`.
- Chat lines use `[name] message`.
- The control line names the driver and optional queue.
- The prototype roster overlaps participant avatars.
- The driver ring shows exclusive write control.
- The cursor layer shows simulated participant movement.
- The chat bar separates conversation from agent input.
- The local badge describes the transport shown by the scene.
- The end card presents the wordmark, tagline, and install command.

Preserve clear keyboard commands in CLI help.
Keep visual controls readable when the prototype reaches its mobile breakpoint.

## Do's and Don'ts

- Do preserve wrapped process bytes on `stdout`.
- Don't mix status or chat text into the process stream.
- Do send operational context to `stderr`.
- Don't add colors that override a user's terminal theme.
- Do show exactly one driver in control state.
- Don't depict simultaneous writers to one agent process.
- Do label local/LAN transport accurately.
- Don't claim the planned encrypted relay ships today.
- Do keep participant colors stable within one visual sequence.
- Don't reuse one color for two participants in the same scene.
- Do preserve each launch file's target aspect ratio.
- Don't stretch one layout to produce another format.
