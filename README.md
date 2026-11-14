# Full Page Screenshot

Chrome extension (MV3) that captures a full-resolution screenshot of an entire webpage in one click.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this directory.

Requires Chrome 116+.

## Use

Click the toolbar icon or press `Alt+Shift+P`. The page is scrolled and captured, then a result tab opens where you can download PNG/JPEG or copy the image.

Click the icon again (or press `Esc`) mid-capture to stop early and keep what was captured so far.

## How it works

- `background.js` — service worker; scrolls the page a viewport at a time and grabs each with `captureVisibleTab`.
- `page.js` — injected into the page to measure and scroll it.
- `result.js` — stitches the frames and renders the result page.
- `db.js` — IndexedDB store for frames and finished images.

Permissions: `activeTab`, `scripting`. Nothing leaves your machine.
