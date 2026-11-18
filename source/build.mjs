import { build } from 'esbuild';
import fs from 'fs';
const r = await build({ entryPoints: ['src/app.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', legalComments: 'eof' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('src/style.css', 'utf8');
let html = fs.readFileSync('src/index.html', 'utf8');
// the logo comes from icon/keyform.svg, so the app, its tab icon and the launcher always match
const icon = 'data:image/svg+xml,' + encodeURIComponent(fs.readFileSync('../icon/keyform.svg', 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim());
html = html.replace('/*CSS*/', () => css).replace('/*JS*/', () => js).replaceAll('/*ICON*/', () => icon);
fs.writeFileSync('../keyform.html', html);
console.log('Built ../keyform.html (' + (html.length / 1024).toFixed(0) + ' KB)');
