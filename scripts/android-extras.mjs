// Runs in the cloud build after "npx cap add android": puts our icon in, swaps Capacitor's default splash picture for a plain dark one,
// and sets the version number.
//   - copies resources/android/** over android/app/src/main/res/**
//   - replaces drawable*/splash.png with a solid #0e1115 background and colours the Android 12+ splash the same
//   - sets versionCode (from BUILD_NUMBER, so every build is newer than the last) and versionName
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const gradle = join(root, 'android', 'app', 'build.gradle');
if (!existsSync(res) || !existsSync(gradle)) {
  console.error('android/ project not found. Run "npx cap add android" first.');
  process.exit(1);
}

// 1) icons
const icons = join(root, 'resources', 'android');
if (existsSync(icons)) { cpSync(icons, res, { recursive: true, force: true }); console.log('icons copied'); }
else console.warn('WARNING: resources/android not found, the default icon will be used.');

// 2) splash: remove the default Capacitor logo pictures, use a plain dark rectangle instead
let removed = 0;
for (const dir of readdirSync(res)) {
  if (!dir.startsWith('drawable')) continue;
  const f = join(res, dir, 'splash.png');
  if (existsSync(f)) { rmSync(f); removed++; }
}
mkdirSync(join(res, 'drawable'), { recursive: true });
writeFileSync(join(res, 'drawable', 'splash.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n    <solid android:color="#0E1115" />\n</shape>\n');
const styles = join(res, 'values', 'styles.xml');
if (existsSync(styles)) {
  let st = readFileSync(styles, 'utf8');
  const next = st.replace(/(<style\s+name="AppTheme\.NoActionBarLaunch"[^>]*>)/, '$1\n        <item name="windowSplashScreenBackground">#0E1115</item>');
  if (next === st) console.warn('WARNING: launch theme not found in styles.xml; Android 12+ splash colour left as is.');
  else { writeFileSync(styles, next); console.log('splash colour set'); }
}
console.log('splash: removed ' + removed + ' default picture(s)');

// 3) version
const build = Math.max(1, parseInt(process.env.BUILD_NUMBER || '1', 10) || 1);
const name = process.env.VERSION_NAME || '1.' + build;
let g = readFileSync(gradle, 'utf8');
const before = g;
g = g.replace(/versionCode\s+\d+/, 'versionCode ' + build).replace(/versionName\s+"[^"]*"/, 'versionName "' + name + '"');
if (g === before) console.warn('WARNING: could not find versionCode/versionName in build.gradle; the version was left as is.');
else { writeFileSync(gradle, g); console.log('version set: code ' + build + ', name ' + name); }
