import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repoRoot, "apps/mobile/assets");

// Lucide ShieldCheck v1.27.0, ISC licensed.
const shieldPaths = [
  "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  "m9 12 2 2 4-4",
];

function shieldSvg(color, size = 58) {
  const paths = shieldPaths
    .map(
      (path) =>
        `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join("");
  return `<svg width="${size}%" height="${size}%" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

function document(markup, options) {
  const background = options.background ?? "transparent";
  const tile = options.tile
    ? `<div class="tile">${markup}</div>`
    : `<div class="mark">${markup}</div>`;
  return `<!doctype html>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 1024px; height: 1024px; margin: 0; overflow: hidden; }
      body { display: grid; place-items: center; background: ${background}; }
      .tile, .mark { display: grid; place-items: center; }
      .tile {
        width: ${options.tileSize ?? 560}px;
        height: ${options.tileSize ?? 560}px;
        border-radius: ${options.tileRadius ?? 132}px;
        background: ${options.tile};
      }
      .mark { width: ${options.markSize ?? 610}px; height: ${options.markSize ?? 610}px; }
    </style>
    ${tile}`;
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });

const assets = [
  {
    name: "icon.png",
    html: document(shieldSvg("#126B5B"), {
      background: "#183B36",
      tile: "#DDEFEA",
      tileSize: 590,
      tileRadius: 136,
    }),
    transparent: false,
  },
  {
    name: "adaptive-icon.png",
    html: document(shieldSvg("#126B5B"), {
      tile: "#DDEFEA",
      tileSize: 520,
      tileRadius: 120,
    }),
    transparent: true,
  },
  {
    name: "monochrome-icon.png",
    html: document(shieldSvg("#FFFFFF", 72), { markSize: 560 }),
    transparent: true,
  },
  {
    name: "splash-icon.png",
    html: document(shieldSvg("#126B5B"), {
      tile: "#DDEFEA",
      tileSize: 520,
      tileRadius: 120,
    }),
    transparent: true,
  },
  {
    name: "splash-icon-dark.png",
    html: document(shieldSvg("#55C2A7"), {
      tile: "#203D36",
      tileSize: 520,
      tileRadius: 120,
    }),
    transparent: true,
  },
];

for (const asset of assets) {
  await page.setContent(asset.html);
  await page.screenshot({
    path: resolve(outputDirectory, asset.name),
    omitBackground: asset.transparent,
  });
}

await browser.close();
console.log(`Generated ${assets.length} mobile assets in ${outputDirectory}`);
