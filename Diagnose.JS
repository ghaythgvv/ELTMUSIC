#!/usr/bin/env node
 
// Audio Diagnostics Script
console.log('=== DISCORD BOT AUDIO DIAGNOSTICS ===\n');
 
// 1. Check Node version
console.log('1. Node.js Version:');
console.log(`   ${process.version}\n`);
 
// 2. Check for required packages
console.log('2. Checking Audio Dependencies:');
const deps = [
  'discord.js',
  'discord-player',
  'ffmpeg-static',
  'opusscript',
  'libsodium-wrappers',
  'prism-media'
];
 
deps.forEach(dep => {
  try {
    const pkg = require(dep);
    console.log(`   ✅ ${dep} - INSTALLED`);
  } catch (e) {
    console.log(`   ❌ ${dep} - MISSING`);
  }
});
 
// 3. Check FFmpeg
console.log('\n3. FFmpeg Check:');
try {
  const ffmpegPath = require('ffmpeg-static');
  console.log(`   ✅ FFmpeg path: ${ffmpegPath}`);
 
  const { spawnSync } = require('child_process');
  const result = spawnSync(ffmpegPath, ['-version']);
  if (result.status === 0) {
    console.log(`   ✅ FFmpeg executable works`);
  } else {
    console.log(`   ❌ FFmpeg failed to run`);
  }
} catch (e) {
  console.log(`   ❌ FFmpeg error: ${e.message}`);
}
 
// 4. Check Opus encoder
console.log('\n4. Opus Encoder Check:');
try {
  const opus = require('opusscript');
  console.log(`   ✅ OpusScript loaded`);
 
  // Test encoding
  const encoder = new opus.OpusEncoder(48000, 2);
  console.log(`   ✅ Opus encoder initialized (48kHz, stereo)`);
} catch (e) {
  console.log(`   ❌ Opus error: ${e.message}`);
}
 
// 5. Check libsodium
console.log('\n5. Encryption Check:');
try {
  const sodium = require('libsodium-wrappers');
  console.log(`   ✅ libsodium-wrappers loaded`);
} catch (e) {
  console.log(`   ❌ libsodium error: ${e.message}`);
}
 
// 6. Check discord-player
console.log('\n6. Discord Player Check:');
try {
  const { Player } = require('discord-player');
  console.log(`   ✅ discord-player loaded`);
 
  const player = new Player({ skipFFmpeg: false });
  console.log(`   ✅ Player instance created with skipFFmpeg: false`);
} catch (e) {
  console.log(`   ❌ discord-player error: ${e.message}`);
}
 
console.log('\n=== DIAGNOSTICS COMPLETE ===');
console.log('\nIf you see any ❌ above, run: npm install\n');
 
