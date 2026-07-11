const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const commandPrefix = process.env.COMMAND_PREFIX || "!sticky";
const moveDelayMs = Number(process.env.MOVE_DELAY_MS || 3500);
const dataFile = process.env.DATA_FILE || path.join(process.cwd(), "data", "sticky-messages.json");
const marker = "\u200B\u200C\u200D";
const state = new Map();
const timers = new Map();
const stickyConfig = loadStickyConfig();

if (!token) {
  console.error("DISCORD_TOKEN is required.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Sticky channels: ${stickyConfig.size}`);
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  if (message.content.startsWith(commandPrefix)) {
    await handleStickyCommand(message);
    return;
  }

  if (!stickyConfig.has(message.channelId)) return;
  scheduleStickyMove(message.channelId);
});

client.login(token);
startHealthServer();

function loadStickyConfig() {
  const config = new Map();
  loadFromJsonEnv(config);
  loadFromDataFile(config);
  return config;
}

function loadFromJsonEnv(config) {
  const raw = process.env.STICKY_MESSAGES_JSON;
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed).map(([channelId, content]) => ({ channelId, content }));

    for (const entry of entries) {
      if (!entry.channelId || !entry.content) continue;
      config.set(String(entry.channelId), {
        guildId: entry.guildId ? String(entry.guildId) : null,
        channelId: String(entry.channelId),
        content: String(entry.content),
      });
    }
  } catch (error) {
    console.error("STICKY_MESSAGES_JSON must be valid JSON.", error);
    process.exit(1);
  }
}

function loadFromDataFile(config) {
  if (!fs.existsSync(dataFile)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    for (const [channelId, item] of Object.entries(parsed.channels || {})) {
      if (!item?.content) continue;
      config.set(channelId, {
        guildId: item.guildId || null,
        channelId,
        content: item.content,
      });
    }
  } catch (error) {
    console.error(`Could not read ${dataFile}.`, error);
  }
}

function saveStickyConfig() {
  const channels = {};

  for (const [channelId, item] of stickyConfig.entries()) {
    channels[channelId] = {
      guildId: item.guildId,
      content: item.content,
    };
  }

  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(
    dataFile,
    JSON.stringify({ channels, updatedAt: new Date().toISOString() }, null, 2),
  );
}

function scheduleStickyMove(channelId) {
  clearTimeout(timers.get(channelId));
  timers.set(
    channelId,
    setTimeout(() => {
      timers.delete(channelId);
      moveStickyMessage(channelId).catch((error) => {
        console.error(`Failed to move sticky message for ${channelId}:`, error);
      });
    }, moveDelayMs),
  );
}

async function moveStickyMessage(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) return;

  const item = stickyConfig.get(channelId);
  if (!item?.content) return;

  await ensureManageable(channel);
  await deletePreviousSticky(channel);

  const sent = await channel.send({
    content: `${marker}\n${item.content}`,
    allowedMentions: { parse: [] },
  });

  state.set(channelId, sent.id);
}

async function deletePreviousSticky(channel) {
  const knownMessageId = state.get(channel.id);

  if (knownMessageId) {
    try {
      const knownMessage = await channel.messages.fetch(knownMessageId);
      await knownMessage.delete();
      return;
    } catch {
      state.delete(channel.id);
    }
  }

  const recentMessages = await channel.messages.fetch({ limit: 25 });
  const oldSticky = recentMessages.find(
    (message) =>
      message.author.id === client.user.id &&
      message.content.startsWith(marker),
  );

  if (oldSticky) {
    await oldSticky.delete();
  }
}

async function handleStickyCommand(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await message.reply("この設定はサーバー管理権限のある人だけが使えます。");
    return;
  }

  const [, subcommand, ...rest] = message.content.split(/\s+/);

  if (subcommand === "set") {
    const content = rest.join(" ").trim();
    if (!content) {
      await message.reply(`使い方: \`${commandPrefix} set 表示したい文章\``);
      return;
    }

    stickyConfig.set(message.channelId, {
      guildId: message.guildId,
      channelId: message.channelId,
      content,
    });
    saveStickyConfig();
    await message.reply("このチャンネルの sticky message を保存しました。");
    await moveStickyMessage(message.channelId);
    return;
  }

  if (subcommand === "unset" || subcommand === "clear") {
    stickyConfig.delete(message.channelId);
    saveStickyConfig();
    await deletePreviousSticky(message.channel).catch(() => {});
    await message.reply("このチャンネルの sticky message を解除しました。");
    return;
  }

  if (subcommand === "move") {
    if (!stickyConfig.has(message.channelId)) {
      await message.reply("このチャンネルには sticky message が設定されていません。");
      return;
    }

    await message.delete().catch(() => {});
    await moveStickyMessage(message.channelId);
    return;
  }

  if (subcommand === "preview") {
    const item = stickyConfig.get(message.channelId);
    await message.reply(item?.content || "このチャンネルには sticky message が設定されていません。");
    return;
  }

  if (subcommand === "list") {
    const items = [...stickyConfig.values()].filter((item) => item.guildId === message.guildId);
    if (items.length === 0) {
      await message.reply("このサーバーには sticky message がまだ設定されていません。");
      return;
    }

    await message.reply(
      items
        .map((item) => `<#${item.channelId}>`)
        .join("\n"),
    );
    return;
  }

  await message.reply(
    [
      "使い方:",
      `\`${commandPrefix} set 文章\` このチャンネルに sticky message を設定`,
      `\`${commandPrefix} unset\` このチャンネルの設定を解除`,
      `\`${commandPrefix} move\` sticky message を一番下へ移動`,
      `\`${commandPrefix} preview\` 現在の文章を確認`,
      `\`${commandPrefix} list\` このサーバーの設定済みチャンネルを表示`,
    ].join("\n"),
  );
}

async function ensureManageable(channel) {
  const me = channel.guild.members.me || (await channel.guild.members.fetchMe());
  const permissions = channel.permissionsFor(me);
  const required = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
  ];

  const missing = required.filter((permission) => !permissions?.has(permission));
  if (missing.length > 0) {
    throw new Error(
      "Missing Discord permissions: View Channel, Send Messages, Manage Messages, Read Message History",
    );
  }
}

function getInviteUrl() {
  const resolvedClientId = clientId || client.user?.id;
  if (!resolvedClientId) return null;

  const permissions = "76800";
  const scope = encodeURIComponent("bot");
  return `https://discord.com/oauth2/authorize?client_id=${resolvedClientId}&permissions=${permissions}&scope=${scope}`;
}

function startHealthServer() {
  const app = express();
  const port = process.env.PORT || 3000;

  app.get("/", (_request, response) => {
    response.json({
      ok: true,
      bot: client.user?.tag || "starting",
      guilds: client.guilds.cache.size,
      stickyChannels: stickyConfig.size,
      inviteUrl: getInviteUrl(),
    });
  });

  app.get("/invite", (_request, response) => {
    const inviteUrl = getInviteUrl();
    if (!inviteUrl) {
      response.status(503).send("Bot is still starting.");
      return;
    }

    response.redirect(inviteUrl);
  });

  app.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
  });
}
