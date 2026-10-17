require('dotenv').config();

const {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const { spawnSync } = require('child_process');
const { Player, QueueRepeatMode, QueryType } = require('discord-player');
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

  if (wantedDurationMS > 0 && ms > 0) {
    const diff = Math.abs(ms - wantedDurationMS);
    if (diff <= 5_000) score += 25;
    else if (diff <= 15_000) score += 15;
    else if (diff > 90_000) score -= 30;
  }

  return { score, coverage, bad };
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

// Returns SoundCloud tracks, best first. Empty array = nothing close enough.
async function findCandidates(wanted, requestedBy, { strict = false } = {}) {
  const isObject = wanted && typeof wanted === 'object';
  const title = isObject ? wanted.title : String(wanted || '');
  const author = isObject ? wanted.author || '' : '';
  const durationMS = isObject ? wanted.durationMS || 0 : 0;

  const cleanTitle = isObject ? norm(title) || fold(title) : title;
  const firstArtist = String(author).split(/,|&| feat\.? | x /i)[0].trim();
  const matchText = `${firstArtist} ${cleanTitle}`.trim(); // what we score against

  const queries = [
    ...new Set(
      (isObject
        ? [`${firstArtist} ${cleanTitle}`, `${cleanTitle} ${author}`, cleanTitle]
        : [title.trim(), tokens(title).join(' ')]
      )
        .map((q) => q.trim())
        .filter(Boolean)
    ),
  ];

  const minCoverage = strict ? 0.75 : 0.55;
  const seen = new Map();

  for (const query of queries) {
    const tracks = await searchSoundCloud(query, requestedBy);
    for (const t of tracks) if (t?.url && !seen.has(t.url)) seen.set(t.url, t);

    const scored = [...seen.values()]
      .map((track) => ({ track, ...scoreQuery(track, matchText, durationMS) }))
      .sort((a, b) => b.score - a.score);

    console.log(`[SOUNDCLOUD] Query: "${query}" (${tracks.length} results)`);
    scored.slice(0, 3).forEach((s, i) =>
      console.log(
        `  ${i + 1}. [${Math.round(s.score)}pts, ${Math.round(s.coverage * 100)}% words] ${s.track.title} by ${s.track.author} (${Math.round((s.track.durationMS || 0) / 1000)}s)${s.bad ? ' [remix/alt version]' : ''}`
      )
    );

    // A clean, near-perfect match on the first query is good enough. Stop searching.
    if (scored[0] && !scored[0].bad && scored[0].coverage >= 0.95 && scored[0].score >= 70) break;
  }

  const good = [...seen.values()]
    .map((track) => ({ track, ...scoreQuery(track, matchText, durationMS) }))
    .filter((s) => s.coverage >= minCoverage && s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Original versions first; remixes and slowed versions only as a last resort.
  const ranked = [...good.filter((s) => !s.bad), ...good.filter((s) => s.bad)].map((s) => s.track);

  if (!ranked.length) {
    console.log(`[SOUNDCLOUD] ✗ No close match for: ${matchText}`);
    return [];
  }

  console.log(`[SOUNDCLOUD] ✓ Selected: ${ranked[0].title} by ${ranked[0].author}`);
  altsByUrl.set(ranked[0].url, ranked.slice(1, 5));
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
            const sc = await findOnSoundCloud(list[index], ctx.user, { strict: true });
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
              const sc = await findOnSoundCloud(list[index], ctx.user, { strict: true });
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
          best = await withTimeout(findOnSoundCloud(query, ctx.user), 40_000, 'SoundCloud match');
        } catch (e) {
          console.error('[SOUNDCLOUD SEARCH]', e.message);
        }
        if (!best) {
          const queue = getQueue(ctx.guild);
          if (queue && !queue.currentTrack) {
            try { queue.delete(); } catch {}
          }
          return ctx.reply(
            err(`I couldn't find a close match for **${query.slice(0, 100)}** on SoundCloud. Try the song name plus the artist.`)
          );
        }
        attempts.push({ label: 'SoundCloud', target: best });
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
      return ctx.reply(ok(`Queued [${result.track.title}](${result.track.url})`));
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
// PLAYER EVENTS
// ─────────────────────────────────────────────

const startedAt = new Map();

// When a person skips on purpose, a short track is not a failure.
const manualEnd = new Set();
function markManual(guildId) {
  manualEnd.add(guildId);
  setTimeout(() => manualEnd.delete(guildId), 5_000).unref?.();
}

player.events.on('playerStart', (queue, track) => {
  startedAt.set(queue.guild.id, Date.now());
  console.log(`🎵 STARTED: ${track.title} | ${track.duration}`);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Now Playing')
    .setDescription(`[${track.title}](${track.url})\nby **${track.author}** • ${track.duration}`)
    .setFooter({ text: `Requested by ${track.requestedBy?.username || 'unknown'}` });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  queue.metadata?.channel?.send({ embeds: [embed] }).catch(() => {});
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
function handleDeadTrack(queue, track, why) {
  const guildId = queue.guild.id;
  const channel = queue.metadata?.channel;

  const key = `${guildId}|${track.url}`;
  if (retried.has(key)) return;
  retried.add(key);
  setTimeout(() => retried.delete(key), 10_000).unref?.();

  runProbe(queue, track, why).catch((e) => console.error('[PROBE] failed:', e.message));

  const alts = altsByUrl.get(track.url) || [];
  const next = alts.shift();
  if (!next) {
    channel?.send(err(`**${track.title}** would not stream and I have no other version to try.`)).catch(() => {});
    return;
  }

  altsByUrl.set(next.url, alts);
  channel?.send(box(`⚠️ **${track.title}** would not stream, trying another version: **${next.title}**`)).catch(() => {});

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

player.events.on('playerFinish', (queue, track) => {
  const guildId = queue.guild.id;
  const elapsed = Date.now() - (startedAt.get(guildId) || 0);
  const manual = manualEnd.delete(guildId);
  console.log(`[FINISH] ${track.title} (${track.duration}) after ${Math.round(elapsed / 1000)}s${manual ? ' (skipped by a person)' : ''}`);

  if (!manual && elapsed < 3000 && track.durationMS > 20_000) {
    console.error(`[ERROR] Track finished too quickly: ${track.title}`);
    handleDeadTrack(queue, track, `finished after ${elapsed}ms`);
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
