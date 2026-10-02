#!/usr/bin/env node

// ─────────────────────────────────────────────
// ELT MUSIC BOT - FULL AUDIO DIAGNOSTICS
// ─────────────────────────────────────────────

console.log('');
console.log('==============================================');
console.log('       ELT MUSIC BOT AUDIO DIAGNOSTICS');
console.log('==============================================');
console.log('');

console.log(
  `1. Node.js Version: ${process.version}`
);

console.log('');

// ─────────────────────────────────────────────
// PACKAGE CHECK
// ─────────────────────────────────────────────

console.log('2. PACKAGE CHECK');
console.log('----------------');

const packages = [
  'discord.js',
  'discord-player',
  '@discord-player/extractor',
  'discord-player-youtubei',
  'ffmpeg-static',
  'mediaplex',
  'libsodium-wrappers'
];

for (const packageName of packages) {
  try {
    const loaded =
      require(packageName);

    let version = '';

    try {
      version =
        require(`${packageName}/package.json`)
          .version;
    } catch {}

    console.log(
      `✅ ${packageName}${
        version
          ? ` v${version}`
          : ''
      }`
    );
  } catch (error) {
    console.log(
      `❌ ${packageName} - MISSING`
    );

    console.log(
      `   ${error.message}`
    );
  }
}

console.log('');

// ─────────────────────────────────────────────
// FFMPEG
// ─────────────────────────────────────────────

console.log('3. FFMPEG CHECK');
console.log('---------------');

try {
  const ffmpegPath =
    require('ffmpeg-static');

  console.log(
    `Path: ${ffmpegPath}`
  );

  const {
    spawnSync,
  } = require('child_process');

  const result =
    spawnSync(
      ffmpegPath,
      ['-hide_banner', '-version'],
      {
        encoding: 'utf8',
        timeout: 15_000,
      }
    );

  if (result.status === 0) {
    console.log(
      '✅ FFmpeg executable works'
    );
  } else {
    console.log(
      '❌ FFmpeg executable failed'
    );

    console.log(
      String(
        result.stderr || ''
      ).slice(0, 500)
    );
  }

  const protocols =
    spawnSync(
      ffmpegPath,
      [
        '-hide_banner',
        '-protocols',
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
      }
    );

  const output =
    String(
      protocols.stdout || ''
    );

  console.log(
    `HTTPS support: ${
      /\bhttps\b/.test(output)
        ? 'YES'
        : 'NO'
    }`
  );

  console.log(
    `HLS support: ${
      /\bhls\b/.test(output)
        ? 'YES'
        : 'NO'
    }`
  );

  const decode =
    spawnSync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=d=1',
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        'pipe:1',
      ],
      {
        timeout: 15_000,
      }
    );

  if (decode.status === 0) {
    console.log(
      `✅ FFmpeg decode test passed (${decode.stdout?.length || 0} bytes)`
    );
  } else {
    console.log(
      '❌ FFmpeg decode test failed'
    );

    console.log(
      String(
        decode.stderr || ''
      ).slice(0, 500)
    );
  }
} catch (error) {
  console.log(
    `❌ FFmpeg error: ${error.message}`
  );
}

console.log('');

// ─────────────────────────────────────────────
// OPUS
// ─────────────────────────────────────────────

console.log('4. OPUS CHECK');
console.log('-------------');

try {
  const mediaplex =
    require('mediaplex');

  console.log(
    '✅ Mediaplex loaded'
  );

  const encoder =
    new mediaplex.OpusEncoder(
      48000,
      2
    );

  console.log(
    '✅ Opus encoder initialized'
  );

  const pcm =
    Buffer.alloc(
      960 * 2 * 2
    );

  const encoded =
    encoder.encode(
      pcm,
      960
    );

  if (
    encoded &&
    encoded.length
  ) {
    console.log(
      `✅ Opus encoding works (${encoded.length} bytes)`
    );
  } else {
    console.log(
      '❌ Opus encoder returned empty data'
    );
  }

  try {
    const decoded =
      encoder.decode(encoded);

    console.log(
      `✅ Opus decoding works (${decoded.length} bytes)`
    );
  } catch (error) {
    console.log(
      `⚠️ Opus decoding test failed: ${error.message}`
    );
  }

  if (
    typeof mediaplex.getOpusVersion ===
    'function'
  ) {
    try {
      console.log(
        `libopus: ${mediaplex.getOpusVersion()}`
      );
    } catch {}
  }
} catch (error) {
  console.log(
    `❌ Mediaplex/Opus error: ${error.message}`
  );
}

console.log('');

// ─────────────────────────────────────────────
// SODIUM
// ─────────────────────────────────────────────

console.log('5. ENCRYPTION CHECK');
console.log('-------------------');

try {
  const sodium =
    require('libsodium-wrappers');

  console.log(
    '✅ libsodium-wrappers loaded'
  );

  if (
    sodium &&
    typeof sodium.ready?.then ===
      'function'
  ) {
    sodium.ready
      .then(() => {
        console.log(
          '✅ libsodium initialized'
        );
      })
      .catch(() => {});
  }
} catch (error) {
  console.log(
    `❌ libsodium error: ${error.message}`
  );
}

console.log('');

// ─────────────────────────────────────────────
// DISCORD PLAYER
// ─────────────────────────────────────────────

console.log('6. DISCORD PLAYER CHECK');
console.log('-----------------------');

try {
  const {
    Player,
  } = require('discord-player');

  console.log(
    '✅ discord-player loaded'
  );

  const {
    Client,
    GatewayIntentBits,
  } = require('discord.js');

  const client =
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

  const ffmpegPath =
    require('ffmpeg-static');

  const player =
    new Player(
      client,
      {
        skipFFmpeg: false,
        ffmpegPath,
        connectionTimeout: 30_000,
        lagMonitor: 10_000,
      }
    );

  console.log(
    '✅ Discord Player instance created'
  );

  console.log(
    '   skipFFmpeg: false'
  );

  console.log(
    `   ffmpegPath: ${ffmpegPath}`
  );

  try {
    console.log(
      '\nDependency report:'
    );

    console.log(
      player.scanDeps()
    );
  } catch (error) {
    console.log(
      `⚠️ Could not scan dependencies: ${error.message}`
    );
  }

  try {
    client.destroy();
  } catch {}
} catch (error) {
  console.log(
    `❌ Discord Player error: ${error.message}`
  );
}

console.log('');

// ─────────────────────────────────────────────
// EXTRACTOR CHECK
// ─────────────────────────────────────────────

console.log('7. EXTRACTOR CHECK');
console.log('------------------');

try {
  const {
    DefaultExtractors,
  } = require(
    '@discord-player/extractor'
  );

  console.log(
    '✅ DefaultExtractors loaded'
  );

  console.log(
    `   Extractor count: ${
      Array.isArray(
        DefaultExtractors
      )
        ? DefaultExtractors.length
        : 'available'
    }`
  );
} catch (error) {
  console.log(
    `❌ Extractor error: ${error.message}`
  );
}

console.log('');

// ─────────────────────────────────────────────
// FINAL
// ─────────────────────────────────────────────

console.log('==============================================');
console.log('             DIAGNOSTICS COMPLETE');
console.log('==============================================');
console.log('');
console.log(
  'If all important checks show ✅, deploy the bot again.'
);
console.log('');
