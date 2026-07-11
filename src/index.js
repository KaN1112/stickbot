const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const moveDelayMs = Number(process.env.MOVE_DELAY_MS || 3500);
const autoRefreshMinutes = Number(process.env.AUTO_REFRESH_MINUTES || 5);
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
  ],
  partials: [Partials.Channel],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Sticky channels: ${stickyConfig.size}`);
  await registerSlashCommands();
  startAutoRefresh();
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!stickyConfig.has(message.channelId)) return;
  scheduleStickyMove(message.channelId);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "sticky") return;
  await handleStickyInteraction(interaction);
});

client.login(token);
startHealthServer();

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("sticky")
      .setDescription("Manage sticky messages")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set a sticky message in this channel")
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("Message to keep at the bottom")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("unset")
          .setDescription("Remove the sticky message from this channel"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("move")
          .setDescription("Move the sticky message to the bottom now"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("preview")
          .setDescription("Show the sticky message for this channel"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List sticky channels in this server"),
      )
      .toJSON(),
  ];
}

async function registerSlashCommands() {
  const resolvedClientId = clientId || client.user?.id;
  if (!resolvedClientId) {
    console.warn("CLIENT_ID is missing. Slash commands were not registered.");
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(
      Routes.applicationCommands(resolvedClientId),
      { body: buildSlashCommands() },
    );
    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Failed to register slash commands.", error);
  }
}

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

function startAutoRefresh() {
  if (!Number.isFinite(autoRefreshMinutes) || autoRefreshMinutes <= 0) {
    console.log("Auto refresh is disabled.");
    return;
  }

  const intervalMs = autoRefreshMinutes * 60 * 1000;
  setInterval(() => {
    refreshAllStickyMessages().catch((error) => {
      console.error("Auto refresh failed.", error);
    });
  }, intervalMs);

  setTimeout(() => {
    refreshAllStickyMessages().catch((error) => {
      console.error("Initial auto refresh failed.", error);
    });
  }, 15_000);

  console.log(`Auto refresh every ${autoRefreshMinutes} minute(s).`);
}

async function refreshAllStickyMessages() {
  for (const channelId of stickyConfig.keys()) {
    await ensureStickyIsLast(channelId).catch((error) => {
      console.error(`Failed to refresh sticky message for ${channelId}:`, error);
    });
  }
}

async function ensureStickyIsLast(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) return;

  const item = stickyConfig.get(channelId);
  if (!item?.content) return;

  await ensureManageable(channel);

  const recentMessages = await channel.messages.fetch({ limit: 10 });
  const latest = recentMessages.first();
  if (latest?.author.id === client.user.id && latest.content.startsWith(marker)) {
    state.set(channelId, latest.id);
    return;
  }

  await moveStickyMessage(channelId);
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

async function handleStickyInteraction(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await interaction.reply({
      content: "Only server managers can change sticky messages.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "set") {
    const content = interaction.options.getString("message", true).trim();
    stickyConfig.set(interaction.channelId, {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      content,
    });
    saveStickyConfig();

    await interaction.reply({
      content: "Sticky message saved. It will stay at the bottom automatically.",
      ephemeral: true,
    });
    await moveStickyMessage(interaction.channelId);
    return;
  }

  if (subcommand === "unset") {
    stickyConfig.delete(interaction.channelId);
    saveStickyConfig();
    await deletePreviousSticky(interaction.channel).catch(() => {});
    await interaction.reply({
      content: "Sticky message removed from this channel.",
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "move") {
    if (!stickyConfig.has(interaction.channelId)) {
      await interaction.reply({
        content: "No sticky message is set in this channel.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    await moveStickyMessage(interaction.channelId);
    await interaction.editReply("Sticky message moved to the bottom.");
    return;
  }

  if (subcommand === "preview") {
    const item = stickyConfig.get(interaction.channelId);
    await interaction.reply({
      content: item?.content || "No sticky message is set in this channel.",
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "list") {
    const items = [...stickyConfig.values()].filter(
      (item) => item.guildId === interaction.guildId,
    );

    await interaction.reply({
      content: items.length > 0
        ? items.map((item) => `<#${item.channelId}>`).join("\n")
        : "No sticky messages are set in this server.",
      ephemeral: true,
    });
  }
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
  const scope = encodeURIComponent("bot applications.commands");
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
      autoRefreshMinutes,
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
