// Quick Opus Test
console.log('Testing Opus encoding...\n');

try {
  const OpusScript = require('opusscript');
  console.log('✅ opusscript module loaded');

  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  console.log('✅ Opus encoder created (48kHz, stereo)');

  // Create dummy audio data (silent audio)
  const pcm = Buffer.alloc(1920 * 2 * 2); // 20ms of stereo audio at 48kHz

  const encoded = encoder.encode(pcm, 960);
  console.log(`✅ Audio encoded successfully (${encoded.length} bytes)`);

  console.log('\n🎵 Opus encoding is working! Audio should work.\n');
} catch (error) {
  console.log(`\n❌ Opus encoding FAILED: ${error.message}`);
  console.log('\nFix: Run "npm install opusscript --save"\n');
  process.exit(1);
}
