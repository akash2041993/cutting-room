// Copies the two generated files the app needs into www/:
//   www/vendor/supabase.js  <- the Supabase library, from node_modules (run "npm install" first)
//   www/config.js           <- your settings, from docs/config.js (the one file you edit)
// Stops with a plain message if config.js still has the PASTE_YOUR... placeholders, so you never build an app that cannot log anyone in.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error('\nSTOP: ' + msg + '\n'); process.exit(1); };

const cfgSrc = join(root, 'docs', 'config.js');
if (!existsSync(cfgSrc)) fail('docs/config.js is missing.');
const cfg = readFileSync(cfgSrc, 'utf8');
const stillPlaceholder = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'POLICY_URL']
  .filter((k) => new RegExp(k + '\\s*:\\s*["\'][^"\']*PASTE_YOUR').test(cfg));
if (stillPlaceholder.length && !process.argv.includes('--allow-placeholders')) {
  fail('docs/config.js still has placeholders for: ' + stillPlaceholder.join(', ') +
    '.\nOpen docs/config.js on GitHub (pencil icon), paste your real values, and save. Then run the build again.');
}

const lib = join(root, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
if (!existsSync(lib)) fail('Supabase library not found. Run "npm install" first.');

mkdirSync(join(root, 'www', 'vendor'), { recursive: true });
copyFileSync(lib, join(root, 'www', 'vendor', 'supabase.js'));
copyFileSync(cfgSrc, join(root, 'www', 'config.js'));
console.log('www/ is ready (supabase.js + config.js copied).');
