#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const mobileRoot = new URL("../apps/mobile/", import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, mobileRoot), "utf8"));

const mobilePackage = await readJson("package.json");
const expoPackage = await readJson("node_modules/expo/package.json");
const bundledNativeModules = await readJson(
  "node_modules/expo/bundledNativeModules.json"
);

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) {
    return undefined;
  }
  return match.slice(1).map(Number);
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
};

const satisfies = (version, range) => {
  if (range === "*") {
    return true;
  }

  const actual = parseVersion(version);
  const minimum = parseVersion(range.replace(/^[~^]/, ""));
  if (!actual || !minimum) {
    return false;
  }

  if (range.startsWith("~")) {
    return (
      actual[0] === minimum[0] &&
      actual[1] === minimum[1] &&
      compareVersions(actual, minimum) >= 0
    );
  }

  if (range.startsWith("^")) {
    if (minimum[0] > 0) {
      return actual[0] === minimum[0] && compareVersions(actual, minimum) >= 0;
    }
    return (
      actual[0] === minimum[0] &&
      actual[1] === minimum[1] &&
      compareVersions(actual, minimum) >= 0
    );
  }

  return compareVersions(actual, minimum) === 0;
};

const errors = [];
const expoSpecifier = mobilePackage.dependencies?.expo;
if (!expoSpecifier || !satisfies(expoPackage.version, expoSpecifier)) {
  errors.push(
    `installed expo ${expoPackage.version} does not satisfy ${expoSpecifier ?? "MISSING"}`
  );
}

let checkedModules = 0;
for (const name of Object.keys(mobilePackage.dependencies ?? {}).sort()) {
  const expectedRange = bundledNativeModules[name];
  if (!expectedRange) {
    continue;
  }

  const installedPackage = await readJson(`node_modules/${name}/package.json`);
  checkedModules += 1;
  if (!satisfies(installedPackage.version, expectedRange)) {
    errors.push(
      `${name} ${installedPackage.version} does not satisfy Expo's ${expectedRange}`
    );
  }
}

if (errors.length > 0) {
  throw new Error(`Mobile toolchain mismatch:\n- ${errors.join("\n- ")}`);
}

process.stdout.write(
  `Mobile toolchain aligned: Expo ${expoPackage.version}, ${checkedModules} native dependencies checked\n`
);
