require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { Player, QueueRepeatMode, QueryType } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
let YoutubeiExtractor = null;
try {
  ({ YoutubeiExtractor } = require('discord-player-youtubei'));
} catch (e) {
  console.error('⚠️ discord-player-youtubei could not be loaded, YouTube is disabled:', e.message);
}

// ───────────── CONFIG ─────────────
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || '!';
const DEFAULT_VOLUME = Math.min(100, Math.max(1, parseInt(process.env.DEFAULT_VOLUME, 10) || 50));
const GUILD_ID = process.env.GUILD_ID || '';
const COLOR = 0x9b59b6; // purple

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN is missing. Add it in Railway → your service → Variables.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// skipFFmpeg defaults to true in discord-player v7, which feeds SoundCloud's mp3/HLS audio straight to Discord
// without decoding it, so every song "finishes" after ~100ms with no sound. Force ffmpeg to decode every stream.
const player = new Player(client, { skipFFmpeg: false });

// ───────────── FFMPEG SELF-TEST (shows in Railway logs) ─────────────
try {
  const { spawnSync } = require('child_process');
  const ffPath = require('ffmpeg-static');
  const prot = spawnSync(ffPath, ['-hide_banner', '-protocols'], { encoding: 'utf8' });
  const out = String(prot.stdout || '');
  const dec = spawnSync(ffPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
  console.log(
    `[FFMPEG] path=${ffPath} runs=${prot.status === 0} https=${/\bhttps\b/.test(out)} hls=${/\bhls\b/.test(out)} ` +
      `decodeTest=${dec.status === 0 ? (dec.stdout?.length || 0) + ' bytes' : 'FAILED ' + String(dec.stderr || '').slice(0, 200)}`
  );
} catch (e) {
  console.error('[FFMPEG] self-test failed:', e.message);
}

// ───────────── HELPERS ─────────────
const box = (text) => ({ embeds: [new EmbedBuilder().setColor(COLOR).setDescription(text)] });
const err = (text) => box(`❌ ${text}`);
const ok = (text) => box(`✅ ${text}`);

const getQueue = (guild) => player.nodes.get(guild.id);

// Checks the user is in the same voice channel as the bot. Returns the queue or null (and replies).
async function requireQueue(ctx, { needPlaying = true } = {}) {
  const vc = ctx.member.voice.channel;
  if (!vc) {
    await ctx.reply(err('Join a voice channel first.'));
    return null;
  }
  const queue = getQueue(ctx.guild);
  if (!queue || (needPlaying && !queue.currentTrack)) {
    await ctx.reply(err('Nothing is playing right now.'));
    return null;
  }
  const botVc = ctx.guild.members.me.voice.channel;
  if (botVc && botVc.id !== vc.id) {
    await ctx.reply(err(`You need to be in ${botVc} to use this.`));
    return null;
  }
  return queue;
}

// ───────────── COMMANDS ─────────────
// arg: { name, type: 'string' | 'number', required, description, choices }
const commands = [
  {
    name: 'play',
    aliases: ['p'],
    description: 'Play a song or playlist (name or link)',
    arg: { name: 'query', type: 'string', required: true, description: 'Song name or link' },
    async run(ctx, a) {
      const query = String(a.query || '').trim();
      if (!query) return ctx.reply(err(`Give me a song name or link. Example: \`${PREFIX}play lofi hip hop\``));

      const vc = ctx.member.voice.channel;
      if (!vc) return ctx.reply(err('Join a voice channel first.'));
      const botVc = ctx.guild.members.me.voice.channel;
      if (botVc && botVc.id !== vc.id) return ctx.reply(err(`I'm already playing in ${botVc}.`));

      await ctx.defer();

      const withTimeout = (p, ms) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

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

      // Links use the default (auto-detect) engine.
      // Plain text searches try SoundCloud first (YouTube is often blocked/broken), then fall back to the default engine.
      const isUrl = /^https?:\/\//i.test(query);
      const attempts = [];

      if (!isUrl) {
        // Search SoundCloud and prefer a full-length upload over a 30-90s label preview.
        try {
          const found = await withTimeout(
            player.search(query, { requestedBy: ctx.user, searchEngine: QueryType.SOUNDCLOUD_SEARCH }),
            15_000
          );
          const full = found.tracks.find((t) => t.durationMS >= 120_000) || found.tracks[0];
          if (full) attempts.push({ label: 'SoundCloud', target: full, opts: options });
        } catch (e) {
          console.error('SoundCloud search error:', e.message);
        }
      }
      attempts.push({ label: 'default', target: query, opts: options });

      let res;
      for (const { label, target, opts } of attempts) {
        try {
          res = await withTimeout(player.play(vc, target, opts), 25_000);
          break;
        } catch (e) {
          console.error(`Play error (${label} search):`, e.message);
        }
      }

      if (!res) {
        const q = getQueue(ctx.guild);
        if (q && !q.currentTrack) q.delete();
        return ctx.reply(err('I could not find or play that. Try another name or link.'));
      }

      const playlist = res.searchResult?.playlist;
      if (playlist) {
        return ctx.reply(ok(`Queued playlist **${playlist.title}** (${playlist.tracks.length} tracks)`));
      }
      return ctx.reply(ok(`Queued [${res.track.title}](${res.track.url})`));
    },
  },
  {
    name: 'skip',
    aliases: ['s', 'next'],
    description: 'Skip the current song',
    async run(ctx) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      const title = queue.currentTrack.title;
      queue.node.skip();
      return ctx.reply(ok(`Skipped **${title}**`));
    },
  },
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
  {
    name: 'nowplaying',
    aliases: ['np', 'current'],
    description: 'Show the current song',
    async run(ctx) {
      const queue = getQueue(ctx.guild);
      if (!queue?.currentTrack) return ctx.reply(err('Nothing is playing right now.'));
      const t = queue.currentTrack;
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('Now Playing')
        .setDescription(`[${t.title}](${t.url})\nby **${t.author}**\n\n${queue.node.createProgressBar()}`)
        .setFooter({ text: `Requested by ${t.requestedBy?.username || 'unknown'}` });
      if (t.thumbnail) embed.setThumbnail(t.thumbnail);
      return ctx.reply({ embeds: [embed] });
    },
  },
  {
    name: 'queue',
    aliases: ['q'],
    description: 'Show the queue',
    async run(ctx) {
      const queue = getQueue(ctx.guild);
      if (!queue?.currentTrack) return ctx.reply(err('The queue is empty.'));
      const tracks = queue.tracks.toArray();
      const lines = tracks.slice(0, 10).map((t, i) => `\`${i + 1}.\` [${t.title}](${t.url}) • ${t.duration}`);
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
  {
    name: 'volume',
    aliases: ['vol'],
    description: 'Set the volume (1-100)',
    arg: { name: 'amount', type: 'number', required: false, description: 'Volume from 1 to 100' },
    async run(ctx, a) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      if (a.amount === undefined || a.amount === null || Number.isNaN(a.amount)) {
        return ctx.reply(box(`🔊 Current volume: **${queue.node.volume}%**`));
      }
      if (a.amount < 1 || a.amount > 100) return ctx.reply(err('Volume must be between 1 and 100.'));
      queue.node.setVolume(a.amount);
      return ctx.reply(ok(`Volume set to **${a.amount}%**`));
    },
  },
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
    async run(ctx, a) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      const modes = {
        off: QueueRepeatMode.OFF,
        track: QueueRepeatMode.TRACK,
        queue: QueueRepeatMode.QUEUE,
        autoplay: QueueRepeatMode.AUTOPLAY,
      };
      const mode = String(a.mode || '').toLowerCase();
      if (!(mode in modes)) return ctx.reply(err('Use: `off`, `track`, `queue` or `autoplay`.'));
      queue.setRepeatMode(modes[mode]);
      return ctx.reply(ok(`Loop mode: **${mode}**`));
    },
  },
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
  {
    name: 'remove',
    description: 'Remove a song from the queue by its number',
    arg: { name: 'position', type: 'number', required: true, description: 'Song number in the queue' },
    async run(ctx, a) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      const pos = a.position;
      if (!pos || pos < 1 || pos > queue.tracks.size) return ctx.reply(err('That position is not in the queue.'));
      const removed = queue.removeTrack(pos - 1);
      return ctx.reply(ok(`Removed **${removed?.title || 'song'}**`));
    },
  },
  {
    name: 'skipto',
    description: 'Skip to a song in the queue',
    arg: { name: 'position', type: 'number', required: true, description: 'Song number in the queue' },
    async run(ctx, a) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      const pos = a.position;
      if (!pos || pos < 1 || pos > queue.tracks.size) return ctx.reply(err('That position is not in the queue.'));
      queue.node.skipTo(pos - 1);
      return ctx.reply(ok(`Skipped to song **#${pos}**`));
    },
  },
  {
    name: 'seek',
    description: 'Jump to a time in the current song (seconds)',
    arg: { name: 'seconds', type: 'number', required: true, description: 'Time in seconds' },
    async run(ctx, a) {
      const queue = await requireQueue(ctx);
      if (!queue) return;
      if (a.seconds === undefined || Number.isNaN(a.seconds) || a.seconds < 0) {
        return ctx.reply(err('Give me a time in seconds.'));
      }
      try {
        await queue.node.seek(a.seconds * 1000);
        return ctx.reply(ok(`Jumped to **${a.seconds}s**`));
      } catch {
        return ctx.reply(err('I could not seek in this song.'));
      }
    },
  },
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
  {
    name: 'deps',
    description: 'Show the audio dependency report (for debugging)',
    async run(ctx) {
      const report = String(player.scanDeps()).slice(0, 1800);
      return ctx.reply('```\n' + report + '\n```');
    },
  },
  {
    name: 'help',
    aliases: ['h', 'commands'],
    description: 'Show all commands',
    async run(ctx) {
      const list = commands
        .map((c) => `\`${PREFIX}${c.name}\` or \`/${c.name}\` — ${c.description}`)
        .join('\n');
      const embed = new EmbedBuilder().setColor(COLOR).setTitle('Music Commands').setDescription(list);
      return ctx.reply({ embeds: [embed] });
    },
  },
];

const byName = new Map();
for (const c of commands) {
  byName.set(c.name, c);
  for (const al of c.aliases || []) byName.set(al, c);
}

// ───────────── CONTEXT WRAPPERS (same command code for slash + prefix) ─────────────
function slashCtx(i) {
  return {
    user: i.user,
    member: i.member,
    guild: i.guild,
    channel: i.channel,
    defer: () => i.deferReply(),
    reply: (p) => (i.deferred || i.replied ? i.editReply(p) : i.reply(p)),
  };
}

function prefixCtx(m) {
  return {
    user: m.author,
    member: m.member,
    guild: m.guild,
    channel: m.channel,
    defer: () => m.channel.sendTyping().catch(() => {}),
    reply: (p) => {
      const payload = typeof p === 'string' ? { content: p } : p;
      return m.reply({ ...payload, allowedMentions: { repliedUser: false } });
    },
  };
}

// ───────────── PLAYER EVENTS ─────────────
player.events.on('playerStart', (queue, track) => {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Now Playing')
    .setDescription(`[${track.title}](${track.url})\nby **${track.author}** • ${track.duration}`)
    .setFooter({ text: `Requested by ${track.requestedBy?.username || 'unknown'}` });
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  queue.metadata?.channel?.send({ embeds: [embed] }).catch(() => {});
});

const startedAt = new Map();
player.events.on('playerStart', (queue) => startedAt.set(queue.guild.id, Date.now()));
player.events.on('playerFinish', (queue, track) => {
  const elapsed = Date.now() - (startedAt.get(queue.guild.id) || 0);
  console.log(`[FINISH] ${track.title} (${track.duration}) after ${Math.round(elapsed / 1000)}s`);
  if (elapsed < 5000 && track.durationMS > 20_000) {
    queue.metadata?.channel?.send(err('The audio stream ended instantly. Try another song or link.')).catch(() => {});
  }
});
player.events.on('audioTrackAdd', (queue, track) => console.log(`[ADDED] ${track.title} | ${track.duration} | ${track.url}`));
player.events.on('connection', () => console.log('[VOICE] connected'));
player.events.on('disconnect', () => console.log('[VOICE] disconnected'));

player.events.on('emptyQueue', (queue) => {
  queue.metadata?.channel?.send(box('The queue has finished. Add more songs with `' + PREFIX + 'play`.')).catch(() => {});
});

player.events.on('error', (queue, error) => console.error('Queue error:', error));
player.events.on('playerError', (queue, error) => {
  console.error('Player error:', error);
  queue.metadata?.channel
    ?.send(err(`Playback error: \`${String(error?.message || error).slice(0, 300)}\``))
    .catch(() => {});
});

player.events.on('playerSkip', (queue, track, reason, description) => {
  console.log(`Skipped track: ${track.title} | reason: ${reason} | ${description}`);
  queue.metadata?.channel?.send(err(`I could not stream **${track.title}** (${reason}).`)).catch(() => {});
});

const NOISY = /\[NW\]|AsyncQueue|^from |^to |state change/;
if (process.env.DEBUG_PLAYER !== '0') {
  player.events.on('debug', (queue, message) => {
    if (!NOISY.test(message)) console.log(`[DEBUG queue] ${message}`);
  });
  player.on('debug', (message) => {
    if (!NOISY.test(message)) console.log(`[DEBUG player] ${message}`);
  });
}

// ───────────── EVENTS ─────────────
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  await player.extractors.loadMulti(DefaultExtractors);
  try {
    if (YoutubeiExtractor) await player.extractors.register(YoutubeiExtractor, {});
  } catch (e) {
    console.error('⚠️ YouTube extractor failed to load, continuing without it:', e.message);
  }
  console.log('✅ Extractors loaded.');
  console.log(player.scanDeps());

  const body = commands.map((c) => ({
    name: c.name,
    description: c.description,
    options: c.arg
      ? [
          {
            type: c.arg.type === 'number' ? 4 : 3, // 4 = integer, 3 = string
            name: c.arg.name,
            description: c.arg.description,
            required: !!c.arg.required,
            ...(c.arg.choices ? { choices: c.arg.choices.map((x) => ({ name: x, value: x })) } : {}),
          },
        ]
      : [],
  }));

  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(body);
      console.log('✅ Slash commands registered for your server.');
    } else {
      await client.application.commands.set(body);
      console.log('✅ Slash commands registered globally (can take up to an hour to show).');
    }
  } catch (e) {
    console.error('❌ Could not register slash commands:', e.message);
  }

  client.user.setPresence({ activities: [{ name: `${PREFIX}help | /help` }] });
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || !i.guild) return;
  const cmd = byName.get(i.commandName);
  if (!cmd) return;
  const args = cmd.arg ? { [cmd.arg.name]: i.options.get(cmd.arg.name)?.value } : {};
  try {
    await cmd.run(slashCtx(i), args);
  } catch (e) {
    console.error('Slash command error:', e);
    const msg = { ...err('Something went wrong.'), flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
});

client.on('messageCreate', async (m) => {
  if (m.author.bot || !m.guild || !m.content.startsWith(PREFIX)) return;
  const [name, ...rest] = m.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = byName.get((name || '').toLowerCase());
  if (!cmd) return;

  const text = rest.join(' ').trim();
  let args = {};
  if (cmd.arg) {
    args[cmd.arg.name] = cmd.arg.type === 'number' ? (text ? Number(text) : undefined) : text;
  }
  try {
    await cmd.run(prefixCtx(m), args);
  } catch (e) {
    console.error('Prefix command error:', e);
    m.reply(err('Something went wrong.')).catch(() => {});
  }
});

client.on('error', (e) => console.error('Client error:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

client.login(TOKEN).catch((e) => {
  console.error(`❌ Login failed: ${e.message}. The token is wrong or was reset — paste the NEW token in Railway Variables.`);
  process.exit(1);
});
