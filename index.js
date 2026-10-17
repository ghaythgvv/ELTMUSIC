require('dotenv').config();

const {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { spawnSync, spawn, execFile } = require('child_process');
const { Player, QueueRepeatMode, QueryType, Track } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');

// ─────────────────────────────────────────────
// OPTIONAL MODULES
// ─────────────────────────────────────────────

let YoutubeiExtractor = null;
try {
  ({ YoutubeiExtractor } = require('discord-player-youtubei'));
} catch (e) {
  console.error('⚠️ discord-player-youtubei could not be loaded. YouTube disabled:', e.message);
}

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  console.error('⚠️ ffmpeg-static could not be loaded:', e.message);
}

// Discord now REQUIRES the DAVE (end-to-end encryption) protocol for voice.
// Without @snazzah/davey the bot crashed the moment it tried to join a voice channel.
let daveOk = false;
try {
  require('@snazzah/davey');
  daveOk = true;
} catch {
  console.error('');
  console.error('❌❌❌ @snazzah/davey is NOT installed. Voice will NOT work. ❌❌❌');
  console.error('Fix: add  "@snazzah/davey": "^0.1.6"  to package.json dependencies and redeploy.');
  console.error('');
}

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || '!';
const DEFAULT_VOLUME = Math.min(100, Math.max(1, parseInt(process.env.DEFAULT_VOLUME, 10) || 50));
const GUILD_ID = process.env.GUILD_ID || '';
const COLOR = 0x9b59b6;

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN is missing. Add it in Railway → Variables.');
  process.exit(1);
}

// ─────────────────────────────────────────────
// FFMPEG
// ─────────────────────────────────────────────

const staticFfmpegPath = ffmpegPath;
let systemFfmpegPath = null;
try {
  const sys = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10_000 });
  if (sys.status === 0) systemFfmpegPath = 'ffmpeg';
} catch {}

if (systemFfmpegPath && process.env.FFMPEG_PREFER !== 'static') {
  ffmpegPath = systemFfmpegPath;
  console.log('🎬 Using SYSTEM ffmpeg (more reliable than the bundled static build).');
} else if (!systemFfmpegPath) {
  console.log('🎬 No system ffmpeg found, using the bundled static build.');
}

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
  console.log(`🎬 FFmpeg path: ${ffmpegPath}`);
} else {
  console.warn('⚠️ ffmpeg-static is unavailable. Discord Player will try to find system FFmpeg.');
}

function testFFmpeg() {
  if (!ffmpegPath) return;
  try {
    const version = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15_000 });
    console.log(`[FFMPEG] executable=${version.status === 0 ? 'OK' : 'FAILED'}`);
  } catch (e) {
    console.error('[FFMPEG] self-test failed:', e.message);
  }
}
testFFmpeg();

// ─────────────────────────────────────────────
// DISCORD CLIENT + PLAYER
// ─────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const player = new Player(client, {
  skipFFmpeg: false,
  connectionTimeout: 30_000,
  lagMonitor: 0, // the lag monitor only filled the logs; turn it off
  ...(ffmpegPath ? { ffmpegPath } : {}),
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const box = (text) => ({ embeds: [new EmbedBuilder().setColor(COLOR).setDescription(text)] });
const err = (text) => box(`❌ ${text}`);
const ok = (text) => box(`✅ ${text}`);

const getQueue = (guild) => (guild?.id ? player.nodes.get(guild.id) : null);

const withTimeout = (promise, ms, label = 'Operation') =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

// ─────────────────────────────────────────────
// SPOTIFY EMBED FALLBACK
// ─────────────────────────────────────────────

async function spotifyEmbedTracks(url) {
  const match = String(url).match(
    /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track)\/([A-Za-z0-9]+)/i
  );
  if (!match) return [];

  try {
    const response = await fetch(`https://open.spotify.com/embed/${match[1].toLowerCase()}/${match[2]}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const dataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!dataMatch) throw new Error(`No Spotify data found (HTTP ${response.status})`);

    const entity = JSON.parse(dataMatch[1])?.props?.pageProps?.state?.data?.entity;
    const raw = entity?.trackList?.length
      ? entity.trackList
      : entity?.type === 'track'
        ? [{ title: entity.title || entity.name, subtitle: (entity.artists || []).map((a) => a.name).join(', ') }]
        : [];

    return raw
      .map((t) => ({ title: t.title, author: t.subtitle, durationMS: Number(t.duration) || 0 }))
      .filter((t) => t.title);
  } catch (e) {
    console.error('[SPOTIFY] spotifyEmbedTracks error:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// SOUNDCLOUD MATCHING
// ─────────────────────────────────────────────

// Words that mean "this is NOT the original studio song".
const BAD_WORDS =
  /\b(remix|slowed|sped ?up|speed ?up|nightcore|cover|live|mashup|bootleg|edit|reverb|8d|bass ?boost(?:ed)?|instrumental|karaoke|acoustic|flip|vip|lofi|rework|remaster|refix|reprise|demo|tiktok|version|but its|but it's)\b/i;

// Words that carry no information about WHICH song it is.
const JUNK_WORDS = new Set([
  'official', 'video', 'videoclip', 'lyrics', 'lyric', 'audio', 'music', 'hd', 'hq', '4k',
  'visualizer', 'visualiser', 'feat', 'ft', 'featuring', 'prod', 'free', 'download', 'full',
  'song', 'the', 'a', 'by', 'and', 'x', 'topic', 'vevo', 'explicit', 'clip', 'new',
]);

// Old helper, still used to clean Spotify titles (drops "(feat. X)" and "[Remastered]").
function norm(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Like norm() but keeps what is inside brackets (so "senorita (remix)" keeps "remix").
function fold(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return fold(value)
    .split(' ')
    .filter((t) => t && !JUNK_WORDS.has(t));
}

// Edit distance, gives up early once it is above `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// How well does ONE word of the query match the track? 0 (no) … 1 (exact)
function tokenHit(word, trackTokens, glued) {
  if (trackTokens.includes(word)) return 1;
  // names typed glued together: "camilacabello" inside "camila cabello"
  if (word.length >= 4 && glued.includes(word)) return 0.9;
  // unfinished word: "senorit" -> "senorita"
  if (word.length >= 4 && trackTokens.some((t) => t.startsWith(word))) return 0.85;
  // typo: "ddel" -> "del", "chihro" -> "chihiro"
  const allowed = word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
  if (allowed) {
    for (const t of trackTokens) {
      if (editDistance(word, t, allowed) <= allowed) return 0.8;
    }
  }
  return 0;
}

function scoreQuery(track, query, wantedDurationMS = 0) {
  const queryWords = tokens(query);
  if (!queryWords.length || !track) return { score: -Infinity, coverage: 0, bad: false };

  const titleWords = tokens(track.title);
  const haystack = [...titleWords, ...tokens(track.author)];
  const glued = haystack.join('');

  const hits = queryWords.map((w) => tokenHit(w, haystack, glued));
  const coverage = hits.reduce((a, b) => a + b, 0) / queryWords.length;

  // title words nobody asked for ("... slowed to perfection", "... mix") make a worse match
  // (artist names repeated inside the title do not count against it)
  const authorWords = tokens(track.author);
  const unmatched = titleWords.filter(
    (t) => !authorWords.includes(t) && !queryWords.some((w) => w === t || t.startsWith(w) || editDistance(w, t, 1) <= 1)
  ).length;

  let score = coverage * 100 - Math.min(unmatched, 8) * 2;

  const bad = !BAD_WORDS.test(fold(query)) && BAD_WORDS.test(fold(track.title));
  if (bad) score -= 60;

  const ms = track.durationMS || 0;
  if (ms && ms < 90_000) score -= 50; // 30-second previews and snippets
  if (ms > 720_000 && !/\b(mix|hour|hours|full|album|live)\b/i.test(query)) score -= 40;
  if (isSnip(track)) score -= 80; // SoundCloud only streams 30 seconds of these

  if (wantedDurationMS > 0 && ms > 0) {
    const diff = Math.abs(ms - wantedDurationMS);
    if (diff <= 4_000) score += 40;
    else if (diff <= 10_000) score += 25;
    else if (diff <= 20_000) score += 10;
    else if (diff > 45_000) score -= 40;
  }

  return { score, coverage, bad };
}

// SoundCloud marks label tracks it only streams 30 seconds of.
let loggedRaw = false;
function isSnip(track) {
  const raw = track?.raw;
  if (!raw || typeof raw !== 'object') return false;
  if (!loggedRaw) {
    loggedRaw = true;
    console.log(`[SOUNDCLOUD] track fields: ${Object.keys(raw).slice(0, 40).join(', ')}`);
  }
  const policy = String(raw.policy || '').toUpperCase();
  return policy === 'SNIP' || policy === 'BLOCK';
}

// Ask iTunes (free, no key) what the real song is called and how long it is.
async function lookupOfficial(query) {
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(6_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const best = (data.results || [])
      .map((r) => ({
        title: r.trackName,
        author: r.artistName,
        durationMS: r.trackTimeMillis || 0,
        c: scoreQuery({ title: r.trackName, author: r.artistName }, query).coverage,
      }))
      .filter((x) => x.title && x.durationMS > 60_000 && x.c >= 0.8)
      .sort((a, b) => b.c - a.c)[0];
    if (best) console.log(`[OFFICIAL] "${query}" -> ${best.author} - ${best.title} (${Math.round(best.durationMS / 1000)}s)`);
    else console.log(`[OFFICIAL] no confident match for "${query}"`);
    return best || null;
  } catch (e) {
    console.error('[OFFICIAL] lookup failed:', e.message);
    return null;
  }
}

async function searchSoundCloud(query, requestedBy) {
  try {
    const result = await withTimeout(
      player.search(query, { requestedBy, searchEngine: QueryType.SOUNDCLOUD_SEARCH }),
      15_000,
      'SoundCloud search'
    );
    return result?.tracks || [];
  } catch (e) {
    console.error('[SOUNDCLOUD] Search error:', e.message);
    return [];
  }
}

// Other versions of a song, in case the first one will not stream.
const altsByUrl = new Map();

// Info about how good the chosen match is (used for the "not the original" note).
const matchInfo = new Map();

// Returns SoundCloud tracks, best first. Empty array = nothing close enough.
async function findCandidates(wanted, requestedBy, { strict = false } = {}) {
  let typed = null;
  let w = wanted;
  if (typeof wanted === 'string') {
    typed = wanted.trim();
    const off = await lookupOfficial(typed);
    if (off) w = { title: off.title, author: off.author, durationMS: off.durationMS };
  }

  const isObject = w && typeof w === 'object';
  const title = isObject ? w.title : String(w || '');
  const author = isObject ? w.author || '' : '';
  const durationMS = isObject ? w.durationMS || 0 : 0;

  const cleanTitle = isObject ? norm(title) || fold(title) : title;
  const firstArtist = String(author).split(/,|&| feat\.? | x /i)[0].trim();
  const matchText = isObject ? `${firstArtist} ${cleanTitle}`.trim() : title.trim();

  const queries = [
    ...new Set(
      (isObject
        ? [`${firstArtist} ${cleanTitle}`, `${cleanTitle} ${author}`, ...(typed ? [typed] : []), cleanTitle]
        : [title.trim(), tokens(title).join(' ')]
      )
        .map((q) => q.trim())
        .filter(Boolean)
    ),
  ];

  const minCoverage = strict ? 0.75 : 0.55;
  const seen = new Map();
  const rate = (track) => ({
    track,
    ...scoreQuery(track, matchText, durationMS),
    typedCoverage: typed ? scoreQuery(track, typed).coverage : 1,
  });

  for (const query of queries) {
    const tracks = await searchSoundCloud(query, requestedBy);
    for (const t of tracks) if (t?.url && !seen.has(t.url)) seen.set(t.url, t);

    const scored = [...seen.values()].map(rate).sort((a, b) => b.score - a.score);

    console.log(`[SOUNDCLOUD] Query: "${query}" (${tracks.length} results)`);
    scored.slice(0, 3).forEach((x, i) =>
      console.log(
        `  ${i + 1}. [${Math.round(x.score)}pts, ${Math.round(x.coverage * 100)}% words] ${x.track.title} by ${x.track.author} (${Math.round((x.track.durationMS || 0) / 1000)}s)${x.bad ? ' [remix/alt version]' : ''}${isSnip(x.track) ? ' [30s PREVIEW ONLY]' : ''}`
      )
    );

    // A clean, near-perfect match on the first query is good enough. Stop searching.
    if (scored[0] && !scored[0].bad && scored[0].coverage >= 0.95 && scored[0].score >= (durationMS ? 120 : 70)) break;
  }

  const good = [...seen.values()]
    .map(rate)
    .filter((x) => x.coverage >= minCoverage && x.typedCoverage >= 0.5 && x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Original versions first; remixes and slowed versions only as a last resort.
  const ordered = [...good.filter((x) => !x.bad), ...good.filter((x) => x.bad)];
  const ranked = ordered.map((x) => x.track);

  if (!ranked.length) {
    console.log(`[SOUNDCLOUD] ✗ No close match for: ${matchText}`);
    return [];
  }

  const first = ordered[0];
  const exact =
    durationMS > 0
      ? !first.bad && !isSnip(first.track) && Math.abs((first.track.durationMS || 0) - durationMS) <= 20_000
      : null;
  matchInfo.set(first.track.url, { exact });
  if (matchInfo.size > 200) matchInfo.delete(matchInfo.keys().next().value);

  console.log(`[SOUNDCLOUD] ✓ Selected: ${first.track.title} by ${first.track.author}${exact === false ? ' (NOT the exact original)' : ''}`);
  altsByUrl.set(first.track.url, ranked.slice(1, 5));
  if (altsByUrl.size > 200) altsByUrl.delete(altsByUrl.keys().next().value);
  return ranked;
}

async function findOnSoundCloud(wanted, requestedBy, options = {}) {
  const ranked = await findCandidates(wanted, requestedBy, options);
  return ranked[0] || null;
}

// ─────────────────────────────────────────────
// YOUTUBE LINKS (the YouTube extractor is broken, so find the song on SoundCloud)
// ─────────────────────────────────────────────

function youtubeId(url) {
  const m = String(url).match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/i
  );
  return m ? m[1] : null;
}

async function youtubeTitleQuery(url) {
  const id = youtubeId(url);
  if (!id) return null;
  try {
    const clean = `https://www.youtube.com/watch?v=${id}`; // drops &list= radio junk
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(clean)}&format=json`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const title = String(data.title || '').trim();
    if (!title) return null;
    const channel = String(data.author_name || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').trim();
    const query = fold(title).includes(fold(channel)) || !channel ? title : `${channel} ${title}`;
    console.log(`[YOUTUBE] ${id} -> "${query}"`);
    return query;
  } catch (e) {
    console.error('[YOUTUBE] Could not read the video title:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// YOUTUBE (through yt-dlp, because the built-in YouTube extractor is broken)
// ─────────────────────────────────────────────

const ytdlp = { ready: false, path: null, base: [], lastError: '', blockedUntil: 0, client: null };
const ytBlocked = () => Date.now() < ytdlp.blockedUntil;
const BOT_CHECK = /sign in|not a bot|cookies/i;
const isYouTubeUrl = (url) => /youtube\.com\/watch|youtu\.be\//i.test(String(url || ''));

function runYtdlp(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(
      ytdlp.path,
      args,
      { timeout: timeoutMs, maxBuffer: 30 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

async function setupYtdlp() {
  const fs = require('fs');
  const works = (p) => {
    try {
      const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 20_000 });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };

  let found = null;
  let version = null;
  for (const p of [process.env.YTDLP_PATH, 'yt-dlp', '/tmp/yt-dlp'].filter(Boolean)) {
    version = works(p);
    if (version) { found = p; break; }
  }

  if (!found) {
    try {
      console.log('[YTDLP] downloading yt-dlp…');
      const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', {
        signal: AbortSignal.timeout(90_000),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync('/tmp/yt-dlp', Buffer.from(await res.arrayBuffer()));
      fs.chmodSync('/tmp/yt-dlp', 0o755);
      version = works('/tmp/yt-dlp');
      if (version) found = '/tmp/yt-dlp';
    } catch (e) {
      console.error('[YTDLP] download failed:', e.message);
    }
  }

  if (!found) {
    console.log('[YTDLP] not available. YouTube is off, using SoundCloud only.');
    return;
  }

  ytdlp.path = found;
  ytdlp.base = ['--no-warnings', '--no-update'];

  try {
    const help = spawnSync(found, ['--help'], { encoding: 'utf8', timeout: 20_000 });
    if (/js-runtimes/.test(String(help.stdout))) ytdlp.base.push('--js-runtimes', 'node');
  } catch {}

  // Cookies: YT_COOKIES_B64 (recommended, base64 of the cookies.txt file) or YT_COOKIES (raw text).
  let cookieText = '';
  if (process.env.YT_COOKIES_B64) {
    try {
      cookieText = Buffer.from(process.env.YT_COOKIES_B64.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch (e) {
      console.error('[YTDLP] YT_COOKIES_B64 could not be decoded:', e.message);
    }
  } else if (process.env.YT_COOKIES) {
    cookieText = process.env.YT_COOKIES.replace(/\\n/g, '\n');
  }
  if (cookieText.trim()) {
    try {
      const lines = cookieText.split(/\r?\n/);
      const cookieLines = lines.filter((l) => l.trim() && !l.startsWith('#') || l.startsWith('#HttpOnly_'));
      const hasYoutube = cookieLines.some((l) => /youtube\.com|google\.com/.test(l));
      // yt-dlp needs the header line and real tabs between the columns.
      if (!/^# (Netscape )?HTTP Cookie File/i.test(cookieText.trim())) cookieText = `# Netscape HTTP Cookie File\n${cookieText}`;
      fs.writeFileSync('/tmp/yt-cookies.txt', cookieText.endsWith('\n') ? cookieText : `${cookieText}\n`);
      ytdlp.base.push('--cookies', '/tmp/yt-cookies.txt');
      console.log(`[YTDLP] using cookies: ${cookieLines.length} cookie lines${hasYoutube ? '' : ' (WARNING: none for youtube.com/google.com, wrong file?)'}`);
      if (cookieLines.length && !cookieLines.some((l) => l.includes('\t'))) {
        console.error('[YTDLP] WARNING: the cookie lines have no tab characters, so the file was probably damaged. Use YT_COOKIES_B64 instead.');
      }
    } catch (e) {
      console.error('[YTDLP] could not write cookies:', e.message);
    }
  }
  if (process.env.YTDLP_ARGS) ytdlp.base.push(...process.env.YTDLP_ARGS.split(/\s+/).filter(Boolean));

  ytdlp.ready = true;
  console.log(`[YTDLP] ready: ${found} version ${version}`);

  // Quick self-test so problems show up in the logs at startup.
  const t = await runYtdlp([...ytdlp.base, '--flat-playlist', '--dump-json', 'ytsearch1:test'], 30_000);
  if (t.stdout.trim()) console.log('[YTDLP] self-test: YouTube search works.');
  else {
    ytdlp.lastError = t.stderr.trim().split('\n').pop() || 'no output';
    console.error(`[YTDLP] self-test FAILED: ${ytdlp.lastError}`);
  }

  await findWorkingYtClient();
}

// YouTube blocks many servers ("Sign in to confirm you're not a bot").
// Some of its app clients are not blocked, so test them and keep the first that really streams.
async function findWorkingYtClient() {
  const testUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const clients = [null, 'android_vr', 'tv', 'tv_simply', 'ios', 'mweb', 'web_safari'];
  let lastLine = '';

  for (const client of clients) {
    const extra = client ? ['--extractor-args', `youtube:player_client=${client}`] : [];
    const r = await runYtdlp([...ytdlp.base, ...extra, '-f', 'bestaudio', '-g', '--no-playlist', testUrl], 45_000);
    const url = r.stdout.split('\n').find((l) => /^https?:\/\//.test(l.trim()));
    if (!url) {
      lastLine = r.stderr.trim().split('\n').filter(Boolean).pop() || 'no output';
      console.log(`[YTDLP] client ${client || 'default'}: blocked (${lastLine.slice(0, 120)})`);
      continue;
    }
    try {
      const res = await fetch(url.trim(), { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 200 || res.status === 206) {
        console.log(`[YTDLP] ✅ client ${client || 'default'} can stream from YouTube. Using it.`);
        if (client) ytdlp.base.push('--extractor-args', `youtube:player_client=${client}`);
        ytdlp.client = client || 'default';
        ytdlp.blockedUntil = 0;
        return true;
      }
      console.log(`[YTDLP] client ${client || 'default'}: got a link but the download was refused (HTTP ${res.status})`);
    } catch (e) {
      console.log(`[YTDLP] client ${client || 'default'}: download test failed (${e.message})`);
    }
  }

  ytdlp.lastError = lastLine;
  ytdlp.blockedUntil = Date.now() + 30 * 60_000;
  console.error('[YTDLP] ❌ YouTube is blocking this server for every client. Songs will come from SoundCloud.');
  console.error('[YTDLP] Fix: add YouTube cookies in Railway → Variables → YT_COOKIES (see the instructions).');
  return false;
}

// yt-dlp -> stdout -> ffmpeg. Used for every YouTube track.
function ytdlpStream(track) {
  const args = [...ytdlp.base, '-f', 'bestaudio[ext=webm]/bestaudio/best', '--no-playlist', '-o', '-', track.url];
  const proc = spawn(ytdlp.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  proc.stderr.on('data', (d) => (errText += d.toString()));
  proc.on('close', (code) => {
    if (code) {
      ytdlp.lastError = errText.trim().split('\n').filter(Boolean).pop() || `exit ${code}`;
      if (BOT_CHECK.test(ytdlp.lastError)) ytdlp.blockedUntil = Date.now() + 10 * 60_000;
      console.error(`[YTDLP] stream for "${track.title}" ended with code ${code}: ${ytdlp.lastError}`);
    }
  });
  proc.stdout.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
  return proc.stdout;
}

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function makeYouTubeTrack(e, requestedBy) {
  return new Track(player, {
    title: e.title,
    author: String(e.channel || e.uploader || 'YouTube').replace(/\s*-\s*topic$/i, ''),
    description: '',
    url: `https://www.youtube.com/watch?v=${e.id}`,
    thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    duration: clock(e.duration || 0),
    views: Number(e.view_count) || 0,
    requestedBy,
    source: 'arbitrary',
    raw: { ytdlp: true, id: e.id },
  });
}

// Search YouTube and return Track objects, best first.
async function findOnYouTube(wanted, requestedBy, { strict = false } = {}) {
  if (!ytdlp.ready) return [];

  let typed = null;
  let w = wanted;
  if (typeof wanted === 'string') {
    typed = wanted.trim();
    const off = await lookupOfficial(typed);
    if (off) w = { title: off.title, author: off.author, durationMS: off.durationMS };
  }

  const isObject = w && typeof w === 'object';
  const title = isObject ? w.title : String(w || '');
  const author = isObject ? w.author || '' : '';
  const durationMS = isObject ? w.durationMS || 0 : 0;
  const firstArtist = String(author).split(/,|&| feat\.? | x /i)[0].trim();
  const matchText = isObject ? `${firstArtist} ${norm(title) || fold(title)}`.trim() : title.trim();

  const r = await runYtdlp([...ytdlp.base, '--flat-playlist', '--dump-json', `ytsearch8:${matchText}`], 35_000);
  const entries = r.stdout
    .split('\n')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e && e.id && e.title);

  if (!entries.length) {
    ytdlp.lastError = r.stderr.trim().split('\n').filter(Boolean).pop() || 'no results';
    console.error(`[YOUTUBE] search failed for "${matchText}": ${ytdlp.lastError}`);
    return [];
  }

  const minCoverage = strict ? 0.75 : 0.6;
  const rated = entries
    .map((e) => {
      const ch = String(e.channel || e.uploader || '');
      const t = { title: e.title, author: ch.replace(/\s*-\s*topic$/i, ''), durationMS: Math.round((e.duration || 0) * 1000) };
      const sc = scoreQuery(t, matchText, durationMS);
      let score = sc.score;
      if (/-\s*topic$/i.test(ch)) score += 15; // auto-generated "official audio" channels
      else if (/vevo$/i.test(ch)) score += 8;
      if (/\b(reaction|tutorial|lesson|chords?|piano|guitar|drums?)\b/i.test(e.title)) score -= 30;
      // not the song itself
      if (/\b(making of|behind the scenes|footnotes|interview|trailer|teaser|documentary|performance|sessions?|tour|shorts?)\b/i.test(e.title)) score -= 60;
      // uploaded by the artist's own channel
      const artistWords = tokens(firstArtist);
      if (artistWords.length && artistWords.every((a) => tokens(ch).includes(a))) score += 20;
      return { e, t, score, coverage: sc.coverage, bad: sc.bad, typedCoverage: typed ? scoreQuery(t, typed).coverage : 1 };
    })
    .filter((x) => x.t.durationMS > 0 && x.coverage >= minCoverage && x.typedCoverage >= 0.5 && x.score > 0)
    .filter((x) => !(durationMS > 0 && Math.abs(x.t.durationMS - durationMS) > 45_000)) // loops, mixes, wrong songs
    .sort((a, b) => b.score - a.score);

  console.log(`[YOUTUBE] "${matchText}" (${entries.length} results)`);
  rated.slice(0, 3).forEach((x, i) =>
    console.log(`  ${i + 1}. [${Math.round(x.score)}pts] ${x.e.title} by ${x.e.channel || x.e.uploader} (${Math.round(x.t.durationMS / 1000)}s)${x.bad ? ' [alt version]' : ''}`)
  );

  const ordered = [...rated.filter((x) => !x.bad), ...rated.filter((x) => x.bad)];
  if (!ordered.length) return [];

  const first = ordered[0];
  const exact = durationMS > 0 ? !first.bad && Math.abs(first.t.durationMS - durationMS) <= 20_000 : null;
  const tracks = ordered.map((x) => makeYouTubeTrack(x.e, requestedBy));
  matchInfo.set(tracks[0].url, { exact });
  return tracks;
}

async function ytdlpTrackFromUrl(url, requestedBy) {
  if (!ytdlp.ready) return null;
  const id = youtubeId(url);
  if (!id) return null;
  const r = await runYtdlp([...ytdlp.base, '--no-playlist', '--dump-json', `https://www.youtube.com/watch?v=${id}`], 35_000);
  try {
    const e = JSON.parse(r.stdout.split('\n').find((l) => l.trim().startsWith('{')));
    return makeYouTubeTrack({ ...e, id }, requestedBy);
  } catch {
    ytdlp.lastError = r.stderr.trim().split('\n').filter(Boolean).pop() || 'could not read the video';
    console.error(`[YOUTUBE] could not read ${url}: ${ytdlp.lastError}`);
    return null;
  }
}

// YouTube first, SoundCloud as the backup.
async function findPlayable(wanted, requestedBy, { strict = false, backup = false } = {}) {
  if (ytdlp.ready && !ytBlocked()) {
    try {
      const yt = await findOnYouTube(wanted, requestedBy, { strict });
      if (yt.length) {
        altsByUrl.set(yt[0].url, yt.slice(1, 3));
        if (backup) {
          // find SoundCloud versions in the background, in case YouTube refuses to stream
          findCandidates(wanted, requestedBy, { strict })
            .then((sc) => altsByUrl.set(yt[0].url, [...(altsByUrl.get(yt[0].url) || []), ...sc.slice(0, 3)]))
            .catch(() => {});
        }
        return yt[0];
      }
    } catch (e) {
      console.error('[YOUTUBE] error:', e.message);
    }
  }
  return findOnSoundCloud(wanted, requestedBy, { strict });
}

// ─────────────────────────────────────────────
// QUEUE CHECK
// ─────────────────────────────────────────────

async function requireQueue(ctx, { needPlaying = true } = {}) {
  const voiceChannel = ctx.member?.voice?.channel;
  if (!voiceChannel) {
    await ctx.reply(err('Join a voice channel first.'));
    return null;
  }

  const queue = getQueue(ctx.guild);
  if (!queue || (needPlaying && !queue.currentTrack)) {
    await ctx.reply(err('Nothing is playing right now.'));
    return null;
  }

  const botVoiceChannel = ctx.guild.members.me?.voice?.channel;
  if (botVoiceChannel && botVoiceChannel.id !== voiceChannel.id) {
    await ctx.reply(err(`You need to be in ${botVoiceChannel} to use this.`));
    return null;
  }

  return queue;
}

// ─────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────

const commands = [
  // ───────────── PLAY ─────────────
  {
    name: 'play',
    aliases: ['p'],
    description: 'Play a song or playlist (name or link)',
    arg: { name: 'query', type: 'string', required: true, description: 'Song name or link' },

    async run(ctx, args) {
      const query = String(args.query || '').trim();
      if (!query) {
        return ctx.reply(err(`Give me a song name or link. Example: \`${PREFIX}play lofi hip hop\``));
      }

      if (!daveOk) {
        return ctx.reply(
          err('Voice is not set up: the `@snazzah/davey` package is missing on the server. Ask the owner to add it and redeploy.')
        );
      }

      const voiceChannel = ctx.member?.voice?.channel;
      if (!voiceChannel) return ctx.reply(err('Join a voice channel first.'));

      const botVoiceChannel = ctx.guild.members.me?.voice?.channel;
      if (botVoiceChannel && botVoiceChannel.id !== voiceChannel.id) {
        return ctx.reply(err(`I'm already playing in ${botVoiceChannel}.`));
      }

      await ctx.defer();

      const options = {
        requestedBy: ctx.user,
        nodeOptions: {
          metadata: { channel: ctx.channel },
          volume: DEFAULT_VOLUME,
          selfDeaf: true,
          leaveOnEmpty: true,
          leaveOnEmptyCooldown: 60_000,
          leaveOnEnd: true,
          leaveOnEndCooldown: 60_000,
          leaveOnStop: true,
          skipFFmpeg: false,
          // YouTube tracks are streamed through yt-dlp
          onBeforeCreateStream: async (track) => (ytdlp.ready && isYouTubeUrl(track.url) ? ytdlpStream(track) : null),
        },
      };

      // ───── SPOTIFY ─────
      if (/open\.spotify\.com|^spotify:/i.test(query)) {
        let found = null;
        try {
          found = await withTimeout(player.search(query, { requestedBy: ctx.user }), 25_000, 'Spotify search');
        } catch (e) {
          console.error('[SPOTIFY] Player search error:', e.message);
        }

        let list = (found?.tracks?.length ? found.tracks : found?.playlist?.tracks || []).map((t) => ({
          title: t.title,
          author: t.author,
          durationMS: t.durationMS || 0,
        }));
        console.log(`[SPOTIFY] Extractor returned ${list.length} tracks`);

        if (!list.length) {
          list = await spotifyEmbedTracks(query);
          console.log(`[SPOTIFY] Embed fallback returned ${list.length} tracks`);
        }

        list = list.slice(0, 100);
        if (!list.length) {
          return ctx.reply(err('I could not read that Spotify link. Make sure the playlist is public.'));
        }

        const missing = [];
        let started = false;
        let index = 0;

        // Find the first song that works and start playing it.
        for (; index < list.length && index < 5 && !started; index++) {
          try {
            const sc = await findPlayable(list[index], ctx.user, { strict: true });
            if (!sc) {
              missing.push(`${list[index].title} - ${list[index].author || ''}`.trim());
              continue;
            }
            await withTimeout(player.play(voiceChannel, sc, options), 30_000, 'Play');
            started = true;
          } catch (e) {
            console.error('[SPOTIFY → SOUNDCLOUD]', e);
          }
        }

        if (!started) {
          const queue = getQueue(ctx.guild);
          if (queue && !queue.currentTrack) {
            try { queue.delete(); } catch {}
          }
          return ctx.reply(err('I could not find a playable song on SoundCloud.'));
        }

        const playlistTitle = found?.playlist?.title;
        await ctx.reply(
          ok(
            playlistTitle
              ? `Loading Spotify playlist **${playlistTitle}** (${list.length} tracks)…`
              : `Queued **${list[0].title}**`
          )
        );

        // Add the remaining tracks in the background.
        (async () => {
          let added = 0;
          for (; index < list.length; index++) {
            const queue = getQueue(ctx.guild);
            if (!queue) return; // someone stopped the bot

            try {
              const sc = await findPlayable(list[index], ctx.user, { strict: true });
              if (sc) {
                queue.addTrack(sc);
                added++;
              } else {
                missing.push(`${list[index].title} - ${list[index].author || ''}`.trim());
              }
            } catch (e) {
              console.error('[SPOTIFY → SOUNDCLOUD]', e.message);
            }
          }

          const skipped = missing.length
            ? `\n\n⚠️ Not found on SoundCloud (${missing.length}): ${missing.slice(0, 10).join(' • ')}${missing.length > 10 ? ' …' : ''}`
            : '';

          ctx.channel?.send(ok(`Spotify playlist loaded: **${added + 1}** songs queued.${skipped}`)).catch(() => {});
        })();

        return;
      }

      // ───── NORMAL SEARCH / LINK ─────
      const isUrl = /^https?:\/\//i.test(query);
      const attempts = [];

      if (isUrl) {
        // YouTube extractor is broken: read the video title and find the song on SoundCloud instead.
        if (youtubeId(query)) {
          if (ytdlp.ready) {
            const ytTrack = await ytdlpTrackFromUrl(query, ctx.user);
            if (ytTrack) {
              attempts.push({ label: 'YouTube link', target: ytTrack });
              findCandidates(ytTrack.title, ctx.user)
                .then((sc) => altsByUrl.set(ytTrack.url, sc.slice(0, 3)))
                .catch(() => {});
            }
          }
        }
        if (youtubeId(query) && !attempts.length) {
          const guess = await youtubeTitleQuery(query);
          if (guess) {
            try {
              const sc = await withTimeout(findOnSoundCloud(guess, ctx.user), 40_000, 'SoundCloud match');
              if (sc) attempts.push({ label: 'SoundCloud (from YouTube link)', target: sc });
            } catch (e) {
              console.error('[YOUTUBE → SOUNDCLOUD]', e.message);
            }
          }
        }
        attempts.push({ label: 'link', target: query });
      } else {
        let best = null;
        try {
          best = await withTimeout(findPlayable(query, ctx.user, { backup: true }), 60_000, 'Song search');
        } catch (e) {
          console.error('[SEARCH]', e.message);
        }
        if (!best) {
          const queue = getQueue(ctx.guild);
          if (queue && !queue.currentTrack) {
            try { queue.delete(); } catch {}
          }
          return ctx.reply(
            err(`I couldn't find a full-length version of **${query.slice(0, 100)}**. Try the song name plus the artist.`)
          );
        }
        attempts.push({ label: isYouTubeUrl(best.url) ? 'YouTube' : 'SoundCloud', target: best });
      }

      let result = null;
      for (const attempt of attempts) {
        try {
          console.log(`[PLAY] Trying ${attempt.label}: ${query}`);
          result = await withTimeout(player.play(voiceChannel, attempt.target, options), 30_000, 'Play');
          if (result) {
            console.log(`[PLAY] Success using ${attempt.label}`);
            break;
          }
        } catch (e) {
          console.error(`[PLAY] Failed using ${attempt.label}:`, e);
        }
      }

      if (!result) {
        const queue = getQueue(ctx.guild);
        if (queue && !queue.currentTrack) {
          try { queue.delete(); } catch {}
        }
        return ctx.reply(err('I could not find or play that. Try another name or link.'));
      }

      const playlist = result.searchResult?.playlist;
      if (playlist) {
        return ctx.reply(ok(`Queued playlist **${playlist.title}** (${playlist.tracks.length} tracks)`));
      }
      const info = matchInfo.get(result.track.url);
      const note =
        info && info.exact === false
          ? '\n⚠️ I could not find the exact original, so this is the closest version I found.'
          : '';
      return ctx.reply(ok(`Queued [${result.track.title}](${result.track.url})${note}`));
    },
  },

  // ───────────── SKIP ─────────────
  {
    name: 'skip',
    aliases: ['s', 'next'],
    description: 'Skip the current song',
    async run(ctx) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      if (queue.tracks.size === 0) {
        return ctx.reply(err('No song is in the queue.'));
      }
      const title = queue.currentTrack?.title || 'song';
      markManual(queue.guild.id);
      queue.node.skip();
      return ctx.reply(ok(`Skipped **${title}**`));
    },
  },

  // ───────────── PREVIOUS ─────────────
  {
    name: 'previous',
    aliases: ['prev', 'back'],
    description: 'Go back to the previous song',
    async run(ctx) {
      const queue = await requireQueue(ctx, { needPlaying: false });
      if (!queue) return;
      if (!queue.history.tracks.size) return ctx.reply(err('There is no previous song.'));
      try {
        markManual(queue.guild.id);
        await queue.history.previous();
        return ctx.reply(ok('Playing the previous song.'));
      } catch (e) {
        console.error('[PREVIOUS]', e);
        return ctx.reply(err('I could not go back.'));
      }
    },
  },

  // ───────────── STOP ─────────────
  {
    name: 'stop',
    aliases: ['leave', 'disconnect', 'dc'],
    description: 'Stop the music and leave the voice channel',
    async run(ctx) {
      const queue = await requireQueue(ctx, { needPlaying: false });
      if (!queue) return;
      queue.delete();
      return ctx.reply(ok('Stopped the music and left the channel.'));
    },
  },

  // ───────────── PAUSE ─────────────
  {
    name: 'pause',
    description: 'Pause the music',
    async run(ctx) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      if (queue.node.isPaused()) return ctx.reply(err('Already paused.'));
      queue.node.setPaused(true);
      return ctx.reply(ok('Paused.'));
    },
  },

  // ───────────── RESUME ─────────────
  {
    name: 'resume',
    aliases: ['unpause'],
    description: 'Resume the music',
    async run(ctx) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      if (!queue.node.isPaused()) return ctx.reply(err('The music is not paused.'));
      queue.node.setPaused(false);
      return ctx.reply(ok('Resumed.'));
    },
  },

  // ───────────── NOW PLAYING ─────────────
  {
    name: 'nowplaying',
    aliases: ['np', 'current'],
    description: 'Show the current song',
    async run(ctx) {
      const queue = getQueue(ctx.guild);
      if (!queue?.currentTrack) return ctx.reply(err('Nothing is playing right now.'));

      const track = queue.currentTrack;
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('Now Playing')
        .setDescription(`[${track.title}](${track.url})\nby **${track.author}**\n\n${queue.node.createProgressBar()}`)
        .setFooter({ text: `Requested by ${track.requestedBy?.username || 'unknown'}` });
      if (track.thumbnail) embed.setThumbnail(track.thumbnail);

      return ctx.reply({ embeds: [embed] });
    },
  },

  // ───────────── QUEUE ─────────────
  {
    name: 'queue',
    aliases: ['q'],
    description: 'Show the queue',
    async run(ctx) {
      const queue = getQueue(ctx.guild);
      if (!queue?.currentTrack) return ctx.reply(err('The queue is empty.'));

      const tracks = queue.tracks.toArray();
      const lines = tracks
        .slice(0, 10)
        .map((t, i) => `\`${i + 1}.\` [${t.title}](${t.url}) • ${t.duration}`);
      const more = tracks.length > 10 ? `\n…and **${tracks.length - 10}** more` : '';

      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('Queue')
        .setDescription(
          `**Now playing:** [${queue.currentTrack.title}](${queue.currentTrack.url})\n\n` +
            (lines.length ? lines.join('\n') + more : 'No songs up next.')
        );

      return ctx.reply({ embeds: [embed] });
    },
  },

  // ───────────── VOLUME ─────────────
  {
    name: 'volume',
    aliases: ['vol'],
    description: 'Set the volume (1-100)',
    arg: { name: 'amount', type: 'number', required: false, description: 'Volume from 1 to 100' },
    async run(ctx, args) {
      const queue = await requireQueue(ctx);
      if (!queue) return;

      if (args.amount === undefined || args.amount === null || Number.isNaN(args.amount)) {
        return ctx.reply(box(`🔊 Current volume: **${queue.node.volume}%**`));
      }
      if (args.amount < 1 || args.amount > 100) return ctx.reply(err('Volume must be between 1 and 100.'));

      queue.node.setVolume(args.amount);
      return ctx.reply(ok(`Volume set to **${args.amount}%**`));
    },
  },

  // ───────────── LOOP ─────────────
  {
    name: 'loop',
    aliases: ['repeat'],
    description: 'Set loop mode: off, track, queue or autoplay',
    arg: {
      name: 'mode',
      type: 'string',
      required: true,
      description: 'off, track, queue or autoplay',
      choices: ['off', 'track', 'queue', 'autoplay'],
    },
    async run(ctx, args) {
      const queue = await requireQueue(ctx);
      if (!queue) return;

      const modes = {
        off: QueueRepeatMode.OFF,
        track: QueueRepeatMode.TRACK,
        queue: QueueRepeatMode.QUEUE,
        autoplay: QueueRepeatMode.AUTOPLAY,
      };
      const mode = String(args.mode || '').toLowerCase();
      if (!(mode in modes)) return ctx.reply(err('Use: `off`, `track`, `queue` or `autoplay`.'));

      queue.setRepeatMode(modes[mode]);
      return ctx.reply(ok(`Loop mode: **${mode}**`));
    },
  },

  // ───────────── SHUFFLE ─────────────
  {
    name: 'shuffle',
    description: 'Shuffle the queue',
    async run(ctx) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      if (queue.tracks.size < 2) return ctx.reply(err('Not enough songs in the queue to shuffle.'));
      queue.tracks.shuffle();
      return ctx.reply(ok('Queue shuffled.'));
    },
  },

  // ───────────── REMOVE ─────────────
  {
    name: 'remove',
    description: 'Remove a song from the queue by its number',
    arg: { name: 'position', type: 'number', required: true, description: 'Song number in the queue' },
    async run(ctx, args) {
      const queue = await requireQueue(ctx);
      if (!queue) return;

      const position = args.position;
      if (!Number.isInteger(position) || position < 1 || position > queue.tracks.size) {
        return ctx.reply(err('That position is not in the queue.'));
      }

      const removed = queue.removeTrack(position - 1);
      return ctx.reply(ok(`Removed **${removed?.title || 'song'}**`));
    },
  },

  // ───────────── SKIPTO ─────────────
  {
    name: 'skipto',
    description: 'Skip to a song in the queue',
    arg: { name: 'position', type: 'number', required: true, description: 'Song number in the queue' },
    async run(ctx, args) {
      const queue = await requireQueue(ctx);
      if (!queue) return;

      const position = args.position;
      if (!Number.isInteger(position) || position < 1 || position > queue.tracks.size) {
        return ctx.reply(err('That position is not in the queue.'));
      }

      markManual(queue.guild.id);
      queue.node.skipTo(position - 1);
      return ctx.reply(ok(`Skipped to song **#${position}**`));
    },
  },

  // ───────────── SEEK ─────────────
  {
    name: 'seek',
    description: 'Jump to a time in the current song (seconds)',
    arg: { name: 'seconds', type: 'number', required: true, description: 'Time in seconds' },
    async run(ctx, args) {
      const queue = await requireQueue(ctx);
      if (!queue) return;

      if (args.seconds === undefined || Number.isNaN(args.seconds) || args.seconds < 0) {
        return ctx.reply(err('Give me a time in seconds.'));
      }

      try {
        await queue.node.seek(args.seconds * 1000);
        return ctx.reply(ok(`Jumped to **${args.seconds}s**`));
      } catch (e) {
        console.error('[SEEK]', e);
        return ctx.reply(err('I could not seek in this song.'));
      }
    },
  },

  // ───────────── CLEAR ─────────────
  {
    name: 'clear',
    description: 'Clear the queue (keeps the current song)',
    async run(ctx) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      queue.tracks.clear();
      return ctx.reply(ok('Queue cleared.'));
    },
  },

  // ───────────── DEPS ─────────────
  {
    name: 'deps',
    description: 'Show the audio dependency report',
    async run(ctx) {
      try {
        const report = String(player.scanDeps()).slice(0, 1800);
        return ctx.reply('```\n' + report + '\n```');
      } catch (e) {
        return ctx.reply(err(`Dependency scan failed: ${e.message}`));
      }
    },
  },

  // ───────────── PANEL ─────────────
  {
    name: 'panel',
    aliases: ['controls'],
    description: 'Show the music control panel (buttons)',
    async run(ctx) {
      const queue = getQueue(ctx.guild);
      if (!queue?.currentTrack) return ctx.reply(err('Nothing is playing right now.'));
      return ctx.reply({ embeds: [nowPlayingEmbed(queue.currentTrack)], components: panelRows(queue) });
    },
  },

  // ───────────── HELP ─────────────
  {
    name: 'help',
    aliases: ['h', 'commands'],
    description: 'Show all commands',
    async run(ctx) {
      const list = commands
        .map((c) => `\`${PREFIX}${c.name}\` or \`/${c.name}\` — ${c.description}`)
        .join('\n');
      return ctx.reply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Music Commands').setDescription(list)] });
    },
  },
];

// ─────────────────────────────────────────────
// COMMAND MAP
// ─────────────────────────────────────────────

const byName = new Map();
for (const command of commands) {
  byName.set(command.name, command);
  for (const alias of command.aliases || []) byName.set(alias, command);
}

// ─────────────────────────────────────────────
// CONTEXT WRAPPERS
// ─────────────────────────────────────────────

function slashCtx(interaction) {
  return {
    user: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,

    // Errors are NOT swallowed here: the main interaction handler reports them.
    defer: async () => {
      if (interaction.deferred || interaction.replied) return;
      await interaction.deferReply();
    },

    reply: async (payload) => {
      const data = typeof payload === 'string' ? { content: payload } : payload;
      if (interaction.deferred || interaction.replied) return interaction.editReply(data);
      return interaction.reply(data);
    },
  };
}

function prefixCtx(message) {
  return {
    user: message.author,
    member: message.member,
    guild: message.guild,
    channel: message.channel,

    defer: () => message.channel.sendTyping().catch(() => {}),

    reply: (payload) => {
      const data = typeof payload === 'string' ? { content: payload } : payload;
      return message
        .reply({ ...data, allowedMentions: { repliedUser: false } })
        .catch(() => message.channel.send({ ...data, allowedMentions: { parse: [] } }).catch(() => {}));
    },
  };
}

// ─────────────────────────────────────────────
// CONTROL PANEL (buttons)
// ─────────────────────────────────────────────

function nowPlayingEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Now Playing')
    .setDescription(`[${track.title}](${track.url})\nby **${track.author}** • ${track.duration}`)
    .setFooter({ text: `Requested by ${track.requestedBy?.username || 'unknown'}` });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

const REPEAT_LABEL = {
  [QueueRepeatMode.OFF]: 'Repeat: Off',
  [QueueRepeatMode.TRACK]: 'Repeat: Song',
  [QueueRepeatMode.QUEUE]: 'Repeat: Queue',
  [QueueRepeatMode.AUTOPLAY]: 'Autoplay',
};

function panelRows(queue) {
  const paused = !!queue?.node?.isPaused?.();
  const mode = queue?.repeatMode ?? QueueRepeatMode.OFF;
  const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`panel:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);

  return [
    new ActionRowBuilder().addComponents(
      btn('previous', 'Previous', '⏮️'),
      paused ? btn('pause', 'Resume', '▶️', ButtonStyle.Success) : btn('pause', 'Pause', '⏸️', ButtonStyle.Primary),
      btn('next', 'Next', '⏭️'),
      btn('stop', 'Stop', '⏹️', ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      btn('queue', 'Queue', '📜'),
      btn('repeat', REPEAT_LABEL[mode] || 'Repeat', '🔁', mode === QueueRepeatMode.OFF ? ButtonStyle.Secondary : ButtonStyle.Success),
      btn('shuffle', 'Shuffle', '🔀'),
      btn('playlist', 'Add playlist', '➕')
    ),
  ];
}

function queueEmbed(queue) {
  const tracks = queue.tracks.toArray();
  const lines = tracks.slice(0, 10).map((t, i) => `\`${i + 1}.\` [${t.title}](${t.url}) • ${t.duration}`);
  const more = tracks.length > 10 ? `\n…and **${tracks.length - 10}** more` : '';
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Queue')
    .setDescription(
      `**Now playing:** [${queue.currentTrack.title}](${queue.currentTrack.url})\n\n` +
        (lines.length ? lines.join('\n') + more : 'No songs up next.')
    );
}

// Only the newest panel keeps its buttons.
const lastPanel = new Map();

async function handlePanelButton(interaction) {
  if (!interaction.guild) return;
  const action = interaction.customId.split(':')[1];
  const deny = (text) => interaction.reply({ ...err(text), flags: MessageFlags.Ephemeral }).catch(() => {});

  const userChannel = interaction.member?.voice?.channel;
  if (!userChannel) return deny('Join a voice channel first.');

  if (action === 'playlist') {
    const modal = new ModalBuilder()
      .setCustomId('panel:playlist_modal')
      .setTitle('Add a playlist or song')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('link')
            .setLabel('Playlist link or song name')
            .setPlaceholder('Spotify or SoundCloud playlist link')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(300)
        )
      );
    return interaction.showModal(modal).catch((e) => console.error('[PANEL] modal:', e.message));
  }

  const queue = getQueue(interaction.guild);
  if (!queue?.currentTrack) return deny('Nothing is playing right now.');

  const botChannel = interaction.guild.members.me?.voice?.channel;
  if (botChannel && botChannel.id !== userChannel.id) return deny(`You need to be in ${botChannel} to use this.`);

  try {
    switch (action) {
      case 'pause':
        queue.node.setPaused(!queue.node.isPaused());
        return interaction.update({ components: panelRows(queue) });

      case 'next':
        if (queue.tracks.size === 0) return deny('No song is in the queue.');
        markManual(queue.guild.id);
        queue.node.skip();
        return interaction.deferUpdate();

      case 'previous':
        if (!queue.history.tracks.size) return deny('There is no previous song.');
        markManual(queue.guild.id);
        await queue.history.previous();
        return interaction.deferUpdate();

      case 'stop':
        queue.delete();
        await interaction.update({ components: [] });
        return interaction.followUp(ok('Stopped the music and left the channel.'));

      case 'queue':
        return interaction.reply({ embeds: [queueEmbed(queue)], flags: MessageFlags.Ephemeral });

      case 'repeat': {
        const next =
          queue.repeatMode === QueueRepeatMode.OFF
            ? QueueRepeatMode.TRACK
            : queue.repeatMode === QueueRepeatMode.TRACK
              ? QueueRepeatMode.QUEUE
              : QueueRepeatMode.OFF;
        queue.setRepeatMode(next);
        return interaction.update({ components: panelRows(queue) });
      }

      case 'shuffle':
        if (queue.tracks.size < 2) return deny('Not enough songs in the queue to shuffle.');
        queue.tracks.shuffle();
        return interaction.reply({ ...ok('Queue shuffled.'), flags: MessageFlags.Ephemeral });

      default:
        return deny('Unknown button.');
    }
  } catch (e) {
    console.error(`[PANEL] ${action} failed:`, e);
    if (!interaction.replied && !interaction.deferred) deny('Something went wrong.');
  }
}

async function handlePlaylistModal(interaction) {
  if (!interaction.guild) return;
  const query = interaction.fields.getTextInputValue('link').trim();
  try {
    await byName.get('play').run(slashCtx(interaction), { query });
  } catch (e) {
    console.error('[PANEL] playlist modal failed:', e);
    const payload = { ...err(`Something went wrong: ${String(e?.message || e).slice(0, 300)}`), flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  }
}

// ─────────────────────────────────────────────
// PLAYER EVENTS
// ─────────────────────────────────────────────

const startedAt = new Map();

// When a person skips on purpose, a short track is not a failure.
const manualEnd = new Set();
function markManual(guildId) {
  manualEnd.add(guildId);
  setTimeout(() => manualEnd.delete(guildId), 5_000).unref?.();
}

const playedFrom = new Map(); // where in the song this play started (ms), for resumes
const resumeAt = new Map();
const resumeTries = new Map();

player.events.on('playerStart', async (queue, track) => {
  startedAt.set(queue.guild.id, Date.now());
  console.log(`🎵 STARTED: ${track.title} | ${track.duration}`);

  const resume = resumeAt.get(queue.guild.id);
  if (resume && resume.url === track.url) {
    resumeAt.delete(queue.guild.id);
    playedFrom.set(queue.guild.id, resume.ms);
    console.log(`[RESUME] seeking ${track.title} to ${Math.round(resume.ms / 1000)}s`);
    setTimeout(() => {
      try { queue.node.seek(resume.ms); } catch (e) { console.error('[RESUME] seek failed:', e.message); }
    }, 1_200);
    return; // no new panel for a resume
  }
  playedFrom.set(queue.guild.id, 0);

  const channel = queue.metadata?.channel;
  if (!channel) return;

  const old = lastPanel.get(queue.guild.id);
  if (old) old.edit({ components: [] }).catch(() => {});

  try {
    const sent = await channel.send({ embeds: [nowPlayingEmbed(track)], components: panelRows(queue) });
    lastPanel.set(queue.guild.id, sent);
  } catch (e) {
    console.error('[PANEL] could not send panel:', e.message);
  }
});

// ── Stream probe: finds out WHY a track dies instantly ──
function probeFfmpeg(input, isStream, binary) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const args = ['-hide_banner', '-loglevel', 'warning', '-rw_timeout', '8000000', '-t', '5'];
    args.push('-i', isStream ? 'pipe:0' : input, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

    const proc = spawn(binary || ffmpegPath || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0;
    let stderr = '';
    let timedOut = false;
    proc.stdout.on('data', (d) => (bytes += d.length));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.stdin.on('error', () => {});
    if (isStream) {
      input.on?.('error', () => {});
      input.pipe(proc.stdin);
    }
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 15_000);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ bytes, stderr: e.message, code: -1, timedOut }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try { if (isStream) input.destroy?.(); } catch {}
      resolve({ bytes, stderr: stderr.trim().slice(-500), code, timedOut });
    });
  });
}

// Can ffmpeg open an https page at all? (DNS + TLS check, no SoundCloud involved.)
async function ffmpegNetTest(binary, label) {
  const r = await probeFfmpeg('https://example.com/', false, binary);
  const text = r.stderr.toLowerCase();
  let verdict;
  if (r.timedOut) verdict = 'HUNG (no answer in 15s)';
  else if (/resolve|name or service|getaddrinfo|temporary failure/.test(text)) verdict = 'DNS FAILED';
  else if (/tls|ssl|certificate|handshake/.test(text)) verdict = 'TLS/CERTIFICATE FAILED';
  else if (/invalid data found|could not find codec|no such|server returned|http error/.test(text) || r.code === 0 || r.code === 183 || r.code === 1) verdict = 'connection OK';
  else verdict = 'unknown';
  console.log(`[NETTEST] ${label}: ${verdict} (exit=${r.code}) ${r.stderr.split('\n').pop() || ''}`.trim());
  return verdict;
}

const probedAt = new Map();
async function runProbe(queue, track, why) {
  const tag = `[PROBE] "${track.title}"`;
  let verdict;
  try {
    if (isYouTubeUrl(track.url)) {
      verdict = ytdlp.lastError
        ? `YouTube (yt-dlp) failed: ${ytdlp.lastError.slice(0, 250)}`
        : 'YouTube gave no audio (yt-dlp produced nothing).';
      console.log(`${tag} RESULT: ${verdict}`);
      const lastY = probedAt.get(queue.guild.id) || 0;
      if (Date.now() - lastY > 60_000) {
        probedAt.set(queue.guild.id, Date.now());
        queue.metadata?.channel?.send(box(`🔎 **Diagnosis:** ${verdict}`)).catch(() => {});
      }
      return;
    }
    console.log(`${tag} source=${track.source || '?'} extractor=${track.extractor?.identifier || '?'} reason: ${why}`);
    console.log(`${tag} voice connection state: ${queue.connection?.state?.status ?? 'none'}`);

    const extractor = track.extractor;
    if (!extractor?.stream) {
      verdict = 'No extractor attached to the track, so it cannot be streamed.';
    } else {
      let streamed;
      try {
        streamed = await withTimeout(extractor.stream(track), 15_000, 'extractor.stream');
      } catch (e) {
        verdict = `The extractor could not produce a stream: ${e.message}`;
      }

      if (!verdict) {
        let result;
        if (typeof streamed === 'string') {
          let host = 'unknown host';
          try { host = new URL(streamed).host; } catch {}
          console.log(`${tag} extractor returned a URL on ${host}`);

          // Try every ffmpeg we have, so we can tell which one is broken.
          const binaries = [...new Set([ffmpegPath, staticFfmpegPath, systemFfmpegPath].filter(Boolean))];
          for (const bin of binaries) {
            const r = await probeFfmpeg(streamed, false, bin);
            console.log(`${tag} [${bin}] exit=${r.code}${r.timedOut ? ' TIMED OUT' : ''} decoded=${r.bytes} bytes${r.stderr ? ` | ${r.stderr.split('\n').pop()}` : ''}`);
            if (!result || r.bytes > result.bytes) result = { ...r, bin };
          }
          if (result && result.bytes <= 100_000) {
            // The URL does not work in any ffmpeg: check whether ffmpeg can reach the internet at all.
            for (const bin of binaries) await ffmpegNetTest(bin, `${bin} → https://example.com`);
          }
        } else if (streamed && typeof streamed.pipe === 'function') {
          console.log(`${tag} extractor returned a readable stream`);
          result = await probeFfmpeg(streamed, true, ffmpegPath);
        } else {
          verdict = `The extractor returned something unexpected (${typeof streamed}).`;
        }

        if (result) {
          console.log(`${tag} ffmpeg exit=${result.code} decoded=${result.bytes} bytes (5s of audio is about 960000)`);
          if (result.stderr) console.log(`${tag} ffmpeg said: ${result.stderr}`);
          if (result.bytes > 100_000) {
            verdict = 'The stream itself is fine (ffmpeg can read it). The problem is on the voice/Discord side.';
          } else if (result.bytes > 0) {
            verdict = `ffmpeg only got ${result.bytes} bytes, which looks like a short preview. ${result.stderr.split('\n').pop() || ''}`.trim();
          } else {
            verdict = `ffmpeg could not read the stream${result.timedOut ? ' (it hung until the 15s limit)' : ''}. ${result.stderr.split('\n').pop() || ''}`.trim();
          }
        }
      }
    }
  } catch (e) {
    verdict = `Probe crashed: ${e.message}`;
  }

  console.log(`${tag} RESULT: ${verdict}`);

  const last = probedAt.get(queue.guild.id) || 0;
  if (Date.now() - last > 60_000) {
    probedAt.set(queue.guild.id, Date.now());
    queue.metadata?.channel?.send(box(`🔎 **Diagnosis:** ${verdict.slice(0, 400)}`)).catch(() => {});
  }
}

// ── Auto-recovery: a song died right away, so try the next-best version ──
const retried = new Set();
function handleDeadTrack(queue, track, why, { lead, probe = true } = {}) {
  const guildId = queue.guild.id;
  const channel = queue.metadata?.channel;

  const key = `${guildId}|${track.url}`;
  if (retried.has(key)) return;
  retried.add(key);
  setTimeout(() => retried.delete(key), 10_000).unref?.();

  if (probe) runProbe(queue, track, why).catch((e) => console.error('[PROBE] failed:', e.message));

  let alts = altsByUrl.get(track.url) || [];
  const botBlocked = isYouTubeUrl(track.url) && BOT_CHECK.test(ytdlp.lastError);
  if (botBlocked) {
    ytdlp.blockedUntil = Date.now() + 10 * 60_000;
    alts = alts.filter((t) => !isYouTubeUrl(t.url)); // they would be blocked too
  }
  const next = alts.shift();
  if (!next) {
    channel
      ?.send(
        err(
          botBlocked
            ? `YouTube is blocking my server ("sign in to confirm you're not a bot") and SoundCloud has no full-length version of **${track.title}**. The bot owner needs to add YouTube cookies (\`YT_COOKIES\` in Railway).`
            : `**${track.title}** would not stream and I have no other version to try.`
        )
      )
      .catch(() => {});
    return;
  }

  altsByUrl.set(next.url, alts);
  channel?.send(box(`⚠️ ${lead || `**${track.title}** would not stream`}, trying another version: **${next.title}**`)).catch(() => {});

  try {
    queue.insertTrack(next, 0);
  } catch (e) {
    console.error('[RETRY] Could not queue the other version:', e.message);
    return;
  }

  // If the player did not move on by itself, start the queue.
  setTimeout(async () => {
    try {
      if (queue.deleted) return;
      if (queue.tracks.size > 0 && !queue.node.isPlaying() && !queue.node.isPaused()) await queue.node.play();
    } catch (e) {
      console.error('[RETRY] Could not start the other version:', e.message);
    }
  }, 1_000);
}

const fmtTime = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// A song stopped in the middle (not at its end).
function handleCutOff(queue, track, playedMs) {
  const guildId = queue.guild.id;
  const channel = queue.metadata?.channel;
  const seconds = Math.round(playedMs / 1000);
  const preview = seconds >= 25 && seconds <= 36; // SoundCloud's 30-second preview limit

  console.error(`[TRUNCATED] ${track.title}: stopped at ${fmtTime(playedMs)} of ${track.duration} (${preview ? 'looks like a 30s preview' : 'stream dropped'})`);

  const key = `${guildId}|${track.url}`;
  const tries = resumeTries.get(key) || 0;

  if (!preview && tries < 2) {
    resumeTries.set(key, tries + 1);
    resumeAt.set(guildId, { url: track.url, ms: Math.max(0, playedMs - 1_500) });
    channel?.send(box(`⚠️ **${track.title}** cut off at ${fmtTime(playedMs)}. Resuming…`)).catch(() => {});
    try {
      queue.insertTrack(track, 0);
    } catch (e) {
      console.error('[RESUME] could not re-queue:', e.message);
      return;
    }
    setTimeout(async () => {
      try {
        if (!queue.deleted && queue.tracks.size > 0 && !queue.node.isPlaying() && !queue.node.isPaused()) await queue.node.play();
      } catch (e) {
        console.error('[RESUME] could not restart:', e.message);
      }
    }, 1_000);
    return;
  }

  handleDeadTrack(
    queue,
    track,
    `cut off at ${fmtTime(playedMs)}`,
    {
      lead: preview
        ? `**${track.title}** is only available as a 30-second preview on SoundCloud`
        : `**${track.title}** keeps cutting off`,
      probe: false,
    }
  );
}

player.events.on('playerFinish', (queue, track) => {
  const guildId = queue.guild.id;
  const elapsed = Date.now() - (startedAt.get(guildId) || 0);
  const manual = manualEnd.delete(guildId);
  console.log(`[FINISH] ${track.title} (${track.duration}) after ${Math.round(elapsed / 1000)}s${manual ? ' (skipped by a person)' : ''}`);

  const playedMs = elapsed + (playedFrom.get(guildId) || 0);

  if (!manual && elapsed < 3000 && track.durationMS > 20_000 && !playedFrom.get(guildId)) {
    console.error(`[ERROR] Track finished too quickly: ${track.title}`);
    handleDeadTrack(queue, track, `finished after ${elapsed}ms`);
  } else if (!manual && elapsed >= 3000 && track.durationMS > 60_000 && playedMs < track.durationMS - 15_000) {
    handleCutOff(queue, track, playedMs);
  }
});

player.events.on('audioTrackAdd', (queue, track) => {
  console.log(`[ADDED] ${track.title} | ${track.duration} | ${track.url}`);
});

player.events.on('connection', () => console.log('[VOICE] connected'));
player.events.on('disconnect', () => console.log('[VOICE] disconnected'));

player.events.on('emptyQueue', (queue) => {
  queue.metadata?.channel
    ?.send(box(`The queue has finished. Add more songs with \`${PREFIX}play\`.`))
    .catch(() => {});
});

player.events.on('error', (queue, error) => {
  console.error('[PLAYER] Queue error:', error);
});

player.events.on('playerError', (queue, error) => {
  console.error('[PLAYER] Player error:', error);
  queue.metadata?.channel
    ?.send(err(`Playback error: \`${String(error?.message || error).slice(0, 500)}\``))
    .catch(() => {});
});

player.events.on('playerSkip', (queue, track, reason, description) => {
  console.log(`[PLAYER] Skipped track: ${track.title} | reason: ${reason} | ${description || ''}`);
  // A person pressed skip: this is NOT a failed song, so do not queue another version.
  const wasManual = manualEnd.has(queue.guild.id) || /manual/i.test(String(reason));
  if (wasManual) return;
  handleDeadTrack(queue, track, `player skipped it (${reason}) ${description || ''}`);
});

// Optional debug output (set DEBUG_PLAYER=1 in Railway to turn it on).
if (process.env.DEBUG_PLAYER === '1') {
  const noisy = /\[NW\]|AsyncQueue|^from |^to |state change|Lag Monitor/;
  player.events.on('debug', (queue, message) => {
    if (!noisy.test(String(message))) console.log(`[DEBUG queue] ${message}`);
  });
  player.on('debug', (message) => {
    if (!noisy.test(String(message))) console.log(`[DEBUG player] ${message}`);
  });
}

// ─────────────────────────────────────────────
// READY
// ─────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag} (${client.user.id})`);
  console.log(daveOk ? '🔒 DAVE (voice encryption) package found.' : '⚠️ DAVE package missing — voice will fail.');

  try {
    await player.extractors.loadMulti(DefaultExtractors);
    console.log('✅ Default extractors loaded.');
  } catch (e) {
    console.error('❌ Default extractors failed:', e);
  }

  if (YoutubeiExtractor) {
    try {
      await player.extractors.register(YoutubeiExtractor, {});
      console.log('✅ YouTubei extractor loaded.');
    } catch (e) {
      console.error('⚠️ YouTubei extractor failed:', e.message);
    }
  }

  setupYtdlp().catch((e) => console.error('[YTDLP] setup error:', e.message));

  // Can ffmpeg reach the internet from this server? (finds DNS / certificate problems)
  (async () => {
    for (const [bin, label] of [[staticFfmpegPath, 'static ffmpeg'], [systemFfmpegPath, 'system ffmpeg']]) {
      if (bin) await ffmpegNetTest(bin, label).catch((e) => console.error('[NETTEST]', e.message));
    }
  })();

  try {
    console.log('🔎 Audio dependency report:');
    console.log(player.scanDeps());
  } catch (e) {
    console.error('Could not scan dependencies:', e.message);
  }

  const body = commands.map((command) => ({
    name: command.name,
    description: command.description,
    options: command.arg
      ? [
          {
            type: command.arg.type === 'number' ? 4 : 3,
            name: command.arg.name,
            description: command.arg.description,
            required: !!command.arg.required,
            ...(command.arg.choices
              ? { choices: command.arg.choices.map((c) => ({ name: c, value: c })) }
              : {}),
          },
        ]
      : [],
  }));

  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(body);
      console.log(`✅ Slash commands registered in guild ${guild.id}.`);
    } else {
      await client.application.commands.set(body);
      console.log('✅ Slash commands registered globally.');
    }
  } catch (e) {
    console.error('❌ Could not register slash commands:', e);
  }

  client.user.setPresence({ activities: [{ name: `${PREFIX}help | /help` }], status: 'online' });
  console.log('🟢 Music bot is ready.');
});

// ─────────────────────────────────────────────
// SLASH COMMANDS
// ─────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('panel:')) return handlePanelButton(interaction);
  if (interaction.isModalSubmit() && interaction.customId === 'panel:playlist_modal') return handlePlaylistModal(interaction);

  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  const command = byName.get(interaction.commandName);
  if (!command) return;

  const args = command.arg
    ? { [command.arg.name]: interaction.options.get(command.arg.name)?.value }
    : {};

  try {
    await command.run(slashCtx(interaction), args);
  } catch (e) {
    console.error(`[INTERACTION] /${interaction.commandName} failed:`, e);

    const payload = {
      embeds: [
        new EmbedBuilder()
          .setColor(0xff3333)
          .setDescription(`❌ **Something went wrong.**\n\`\`\`\n${String(e?.message || e).slice(0, 300)}\n\`\`\``),
      ],
      flags: MessageFlags.Ephemeral,
    };

    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (replyError) {
      console.error('[INTERACTION] Could not send error:', replyError);
    }
  }
});

// ─────────────────────────────────────────────
// PREFIX COMMANDS
// ─────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const [commandName, ...rest] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = byName.get((commandName || '').toLowerCase());
  if (!command) return;

  const text = rest.join(' ').trim();
  const args = {};
  if (command.arg) {
    args[command.arg.name] = command.arg.type === 'number' ? (text ? Number(text) : undefined) : text;
  }

  try {
    await command.run(prefixCtx(message), args);
  } catch (e) {
    console.error('[MESSAGE] Prefix command error:', e);
    message.reply(err(`Something went wrong: ${String(e?.message || e).slice(0, 300)}`)).catch(() => {});
  }
});

// ─────────────────────────────────────────────
// ERRORS (log them, don't crash the whole bot)
// ─────────────────────────────────────────────

client.on('error', (error) => console.error('[CLIENT] Client error:', error));

process.on('unhandledRejection', (error) => console.error('[PROCESS] Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('[PROCESS] Uncaught exception:', error));

// Leave voice cleanly when Railway restarts / redeploys the bot.
function shutdown(signal) {
  console.log(`🛑 ${signal} received, shutting down…`);
  try {
    for (const guild of client.guilds.cache.values()) {
      const queue = player.nodes.get(guild.id);
      if (queue) queue.delete();
    }
    client.destroy();
  } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────

client
  .login(TOKEN)
  .then(() => console.log('🔐 Discord login successful.'))
  .catch((error) => {
    console.error(`❌ Login failed: ${error.message}`);
    console.error('Check DISCORD_TOKEN in Railway Variables.');
    process.exit(1);
  });
