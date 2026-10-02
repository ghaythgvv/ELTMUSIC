// ─────────────────────────────────────────────
// ELT MUSIC BOT - OPUS TEST
// ─────────────────────────────────────────────

console.log('======================================');
console.log('       ELT MUSIC BOT - OPUS TEST');
console.log('======================================\n');

console.log(`Node.js: ${process.version}\n`);

try {
  const mediaplex = require('mediaplex');

  console.log('✅ mediaplex module loaded');

  if (
    typeof mediaplex.OpusEncoder !==
    'function'
  ) {
    throw new Error(
      'mediaplex.OpusEncoder is not available'
    );
  }

  console.log(
    '✅ OpusEncoder class found'
  );

  const encoder =
    new mediaplex.OpusEncoder(
      48000,
      2
    );

  console.log(
    '✅ Opus encoder created'
  );

  // 20ms stereo PCM at 48kHz.
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
    !encoded ||
    !encoded.length
  ) {
    throw new Error(
      'Encoder returned empty audio data'
    );
  }

  console.log(
    `✅ PCM → Opus encoding works`
  );

  console.log(
    `   Encoded size: ${encoded.length} bytes`
  );

  try {
    const decoded =
      encoder.decode(encoded);

    console.log(
      `✅ Opus → PCM decoding works`
    );

    console.log(
      `   Decoded size: ${decoded.length} bytes`
    );
  } catch (decodeError) {
    console.warn(
      `⚠️ Decode test failed: ${decodeError.message}`
    );
  }

  try {
    if (
      typeof mediaplex.getOpusVersion ===
      'function'
    ) {
      console.log(
        `✅ libopus version: ${mediaplex.getOpusVersion()}`
      );
    }
  } catch {}

  console.log(
    '\n🎵 OPUS AUDIO TEST PASSED'
  );
  console.log(
    'The Opus encoder is available for Discord Player.'
  );

  process.exit(0);
} catch (error) {
  console.error(
    '\n❌ OPUS AUDIO TEST FAILED'
  );

  console.error(
    `Reason: ${error.message}`
  );

  console.error(
    '\nMake sure package.json contains:'
  );

  console.error(
    '  "mediaplex": "^1.0.0"'
  );

  console.error(
    '\nThen run: npm install'
  );

  process.exit(1);
}
