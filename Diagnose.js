#!/usr/bin/env node

// ─────────────────────────────────────────────
// ELT MUSIC BOT - FULL AUDIO DIAGNOSTICS
// Run with:  npm run diagnose
// ─────────────────────────────────────────────

const { spawnSync } = require('child_process');

let problems = 0;
const bad = (text) => {
  problems++;
  console.log(`❌ ${text}`);
};
const good = (text) => console.log(`✅ ${text}`);
const title = (text) => {
  console.log('');
  console.log(text);
  console.log('-'.repeat(text.length));
};

console.log('==============================================');
console.log('       ELT MUSIC BOT AUDIO DIAGNOSTICS');
console.log('==============================================');

title('1. NODE.JS');
const major = parseInt(process.version.slice(1), 10);
console.log(`Node.js Version: ${process.version}`);
if (major < 22) bad('Node 22.12 or newer is required by discord.js voice.');
else good('Node version is fine');

// ─────────────────────────────────────────────
title('2. PACKAGE CHECK');

const packages = [
  'discord.js',
  'discord-player',
  '@discord-player/extractor',
  'discord-player-youtubei',
  'ffmpeg-static',
  'mediaplex',
  'libsodium-wrappers',
  '@snazzah/davey', // REQUIRED: Discord's DAVE voice encryption
];

for (const name of packages) {
  try {
    require(name);
    let version = '';
    try {
      version = require(`${name}/package.json`).version;
    } catch {}
    good(`${name}${version ? ` v${version}` : ''}`);
  } catch (error) {
    bad(`${name} - MISSING (${error.message.split('\n')[0]})`);
    if (name === '@snazzah/davey') {
      console.log('   ^ THIS ONE makes the bot crash when it joins voice. Add it to package.json and redeploy.');
    }
  }
}

// ─────────────────────────────────────────────
title('3. DAVE (VOICE ENCRYPTION)');

try {
  const { DAVESession } = require('@snazzah/davey');
  if (typeof DAVESession === 'function') good('DAVESession is available');
  else bad('DAVESession was not found in @snazzah/davey');
} catch (error) {
  bad(`DAVE unavailable: ${error.message.split('\n')[0]}`);
}

// ─────────────────────────────────────────────
title('4. FFMPEG CHECK');

try {
  const ffmpegPath = require('ffmpeg-static');
  console.log(`Path: ${ffmpegPath}`);

  const version = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15_000 });
  if (version.status === 0) good('FFmpeg executable works');
  else bad(`FFmpeg executable failed: ${String(version.stderr || '').slice(0, 300)}`);

  const protocols = spawnSync(ffmpegPath, ['-hide_banner', '-protocols'], { encoding: 'utf8', timeout: 15_000 });
  const out = String(protocols.stdout || '');
  console.log(`HTTPS support: ${/\bhttps\b/.test(out) ? 'YES' : 'NO'}`);
  console.log(`HLS support: ${/\bhls\b/.test(out) ? 'YES' : 'NO'}`);

  const decode = spawnSync(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { timeout: 15_000 }
  );
  if (decode.status === 0) good(`FFmpeg decode test passed (${decode.stdout?.length || 0} bytes)`);
  else bad(`FFmpeg decode test failed: ${String(decode.stderr || '').slice(0, 300)}`);
} catch (error) {
  bad(`FFmpeg error: ${error.message}`);
}

// ─────────────────────────────────────────────
title('5. OPUS CHECK');

try {
  const mediaplex = require('mediaplex');
  good('Mediaplex loaded');

  const encoder = new mediaplex.OpusEncoder(48000, 2);
  good('Opus encoder initialized');

  const encoded = encoder.encode(Buffer.alloc(960 * 2 * 2), 960);
  if (encoded && encoded.length) good(`Opus encoding works (${encoded.length} bytes)`);
  else bad('Opus encoder returned empty data');
} catch (error) {
  bad(`Mediaplex/Opus error: ${error.message}`);
}

// ─────────────────────────────────────────────
title('6. ENCRYPTION CHECK');

try {
  require('libsodium-wrappers');
  good('libsodium-wrappers loaded');
} catch (error) {
  bad(`libsodium error: ${error.message}`);
}

// ─────────────────────────────────────────────
title('7. DISCORD PLAYER CHECK');

try {
  const { Player } = require('discord-player');
  const { Client, GatewayIntentBits } = require('discord.js');
  const ffmpegPath = require('ffmpeg-static');

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const player = new Player(client, { skipFFmpeg: false, ffmpegPath, lagMonitor: 0 });
  good('Discord Player instance created');

  console.log('\nDependency report:');
  console.log(player.scanDeps());

  try {
    player.destroy?.();
  } catch {}
  try {
    client.destroy();
  } catch {}
} catch (error) {
  bad(`Discord Player error: ${error.message}`);
}

// ─────────────────────────────────────────────
title('8. EXTRACTOR CHECK');

try {
  const { DefaultExtractors } = require('@discord-player/extractor');
  good(`DefaultExtractors loaded (${Array.isArray(DefaultExtractors) ? DefaultExtractors.length : 'ok'})`);
} catch (error) {
  bad(`Extractor error: ${error.message}`);
}

console.log('');
console.log('==============================================');
console.log(problems === 0 ? '   ALL CHECKS PASSED — deploy the bot.' : `   ${problems} PROBLEM(S) FOUND — fix the ❌ lines above.`);
console.log('==============================================');
console.log('');

process.exit(problems === 0 ? 0 : 1);
