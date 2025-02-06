/**
 * Patch the generated JS file to insert @vite-ignore for "new URL" as
 * we bundle the wasm file into the JS file.
 */
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const pkgDir = path.join(__dirname, 'pkg');
const jsPath = path.join(pkgDir, 'wasm_memprof.js');
const jsContent = fs.readFileSync(jsPath, 'utf8');

const newUrlPattern = /new URL\('(.+)', import.meta.url\)/g;
const newUrlReplacement = "new URL(/* @vite-ignore */'$1', import.meta.url)";

fs.writeFileSync(jsPath, jsContent.replace(newUrlPattern, newUrlReplacement));

console.log('Patched', jsPath);
