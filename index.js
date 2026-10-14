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

const BAD_WORDS =
  /\b(remix|slowed|sped ?up|speed ?up|nightcore|cover|live|mashup|bootleg|edit|reverb|8d|bass ?boost(?:ed)?|instrumental|karaoke|acoustic|flip|vip|lofi|rework|remaster|version|but its|but it's|refix|reprise|demo)\b/i;

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

function scoreTrack(track, wanted) {
  if (!track || !wanted) return -Infinity;

  const trackTitle = norm(track.title);
  const trackAuthor = norm(track.author);
  const wantedTitle = norm(wanted.title);
  const wantedAuthor = norm(wanted.author);

  let score = 0;

  // TITLE
  if (wantedTitle && trackTitle === wantedTitle) {
    score += 60;
  } else if (wantedTitle && trackTitle.includes(wantedTitle)) {
    score += 45;
  } else if (wantedTitle && trackTitle && wantedTitle.includes(trackTitle) && trackTitle.length > 4) {
    score += 35;
  } else {
    const words = wantedTitle.split(' ').filter(Boolean);
    const hits = words.filter((w) => trackTitle.includes(w)).length;
    score += words.length ? Math.round((25 * hits) / words.length) : 0;
  }

  // ARTIST
  if (wantedAuthor) {
    const artistWords = wantedAuthor.split(' ').filter((w) => w.length > 2);
    const combined = `${trackTitle} ${trackAuthor}`;

    if (trackAuthor === wantedAuthor) {
      score += 30;
    } else if (trackAuthor && (trackAuthor.includes(wantedAuthor) || wantedAuthor.includes(trackAuthor))) {
      score += 25;
    } else if (artistWords.length) {
      const hits = artistWords.filter((w) => combined.includes(w)).length;
      score += Math.round((20 * hits) / artistWords.length);
    }
  }

  // WRONG VERSION PENALTY
  if (!BAD_WORDS.test(String(wanted.title)) && BAD_WORDS.test(String(track.title))) score -= 150;

  // DURATION
  if (wanted.durationMS > 0) {
    const diff = Math.abs((track.durationMS || 0) - wanted.durationMS);
    if (diff <= 5_000) score += 50;
    else if (diff <= 15_000) score += 30;
    else if (diff <= 30_000) score += 10;
    else if (diff > 90_000) score -= 50;
  }

  // SHORT PREVIEW PENALTY
  if ((track.durationMS || 0) < 120_000 && wanted.durationMS && wanted.durationMS >= 120_000) score -= 60;

  // EXTREMELY LONG TRACK PENALTY
  if ((track.durationMS || 0) > 600_000 && (!wanted.durationMS || wanted.durationMS < 600_000)) score -= 40;

  // UNKNOWN DURATION + SHORT TRACK
  if (!wanted.durationMS && (track.durationMS || 0) < 120_000) score -= 40;

  return score;
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

async function findOnSoundCloud(wanted, requestedBy, { strict = false } = {}) {
  const searchData = typeof wanted === 'string' ? { title: wanted } : wanted;
  const firstArtist = String(searchData.author || '').split(/,|&| feat\.? | x /i)[0].trim();

  const queries = [
    ...new Set(
      [
        `${firstArtist} ${searchData.title}`.trim(),
        `${searchData.title} ${searchData.author || ''}`.trim(),
        searchData.title,
      ].filter(Boolean)
    ),
  ];

  let fallback = null;
  const minimumScore = strict ? 60 : 30;

  for (const query of queries) {
    const tracks = await searchSoundCloud(query, requestedBy);
    if (!tracks.length) continue;

    const scored = tracks
      .map((track) => ({ track, score: scoreTrack(track, searchData) }))
      .sort((a, b) => b.score - a.score);

    console.log(`[SOUNDCLOUD] Query: "${query}"`);
    scored.slice(0, 3).forEach((item, i) => {
      console.log(
        `  ${i + 1}. [${item.score}pts] ${item.track.title} by ${item.track.author} (${Math.round(
          (item.track.durationMS || 0) / 1000
        )}s)`
      );
    });

    const best = scored[0];
    if (best && best.score >= minimumScore) {
      console.log(`[SOUNDCLOUD] ✓ Selected: ${best.track.title} (${best.score}pts)`);
      return best.track;
    }

    if (!fallback && !strict) {
      fallback =
        tracks.find((t) => t.durationMS >= 120_000 && !BAD_WORDS.test(t.title)) || tracks[0] || null;
    }
  }

  if (fallback && !strict) {
    console.log(`[SOUNDCLOUD] ⚠ Using fallback: ${fallback.title}`);
    return fallback;
  }

  console.log(`[SOUNDCLOUD] ✗ No good match found for: ${searchData.title} by ${searchData.author || 'unknown'}`);
  return null;
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

      if (!isUrl) {
        try {
          const best = await withTimeout(findOnSoundCloud(query, ctx.user), 40_000, 'SoundCloud match');
          if (best) attempts.push({ label: 'SoundCloud', target: best });
        } catch (e) {
          console.error('[SOUNDCLOUD SEARCH]', e.message);
        }
      }
      attempts.push({ label: 'default', target: query });

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

player.events.on('playerFinish', (queue, track) => {
  const elapsed = Date.now() - (startedAt.get(queue.guild.id) || 0);
  console.log(`[FINISH] ${track.title} (${track.duration}) after ${Math.round(elapsed / 1000)}s`);

  if (elapsed < 3000 && track.durationMS > 20_000) {
    console.error(`[ERROR] Track finished too quickly: ${track.title}`);
  }
});

// Do not assume dispatcherConfig exists.
player.events.on('willPlayTrack', (queue, track, config, resolve) => {
  try {
    if (config?.dispatcherConfig) {
      config.dispatcherConfig.disableEqualizer = true;
      config.dispatcherConfig.disableBiquad = true;
      config.dispatcherConfig.disableResampler = true;
      config.dispatcherConfig.disableFilters = true;
    }
  } catch (e) {
    console.error('[PLAYER] willPlayTrack configuration error:', e.message);
  }
  if (typeof resolve === 'function') resolve();
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
  queue.metadata?.channel?.send(err(`I could not stream **${track.title}** (${reason}).`)).catch(() => {});
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
