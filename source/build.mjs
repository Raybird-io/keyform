import { build } from 'esbuild';
import fs from 'fs';
const r = await build({ entryPoints: ['src/app.js'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', legalComments: 'eof' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('src/style.css', 'utf8');
let html = fs.readFileSync('src/index.html', 'utf8');
html = html.replace('/*CSS*/', () => css).replace('/*JS*/', () => js);
fs.writeFileSync('../keyform.html', html);
console.log('Built ../keyform.html (' + (html.length / 1024).toFixed(0) + ' KB)');
