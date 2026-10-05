#!/usr/bin/env node
// Copies the latest `dotnet publish` wwwroot output into node-host/public.
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const sourceDir = path.join(projectRoot, 'bin', 'Release', 'net10.0', 'publish', 'wwwroot');
const targetDir = path.join(__dirname, '..', 'public');

if (!fs.existsSync(sourceDir)) {
  console.error(`Publish output not found at ${sourceDir}.\nRun "dotnet publish -c Release" from the project root first.`);
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });
console.log(`Copied ${sourceDir} -> ${targetDir}`);
