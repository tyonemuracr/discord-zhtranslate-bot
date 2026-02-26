// server.js (discord.js v13) - Render/Free向け 安定版 (ja + zh, マルチサーバー対応)

const http = require("http");
const fs = require("fs");
const fetch = require("node-fetch");
const { Client, Intents } = require("discord.js");

// ================== KEEP ALIVE (Render用) ==================
http
  .createServer((req, res) => {
    // UptimeRobotはここを叩く
    if (req.url === "/healthz") {
      res.statusCode = 200;
      return res.end("ok");
    }
    res.statusCode = 200;
    res.end("ok");
  })
  .listen(process.env.PORT || 3000);

// ================== SETTINGS (マルチサーバー) ==================
let settings = {};
try {
  settings = require("./settings.json");
} catch {
  settings = {};
}
if (!settings.guilds) settings.guilds = {};

// trst: 1=ON / msgch: 対象チャンネル
function ensureGuild(gid) {
  if (!settings.guilds[gid]) settings.guilds[gid] = { trst: 0, msgch: 0 };
}

function saveSettings() {
  // 壊れにくい保存（tmp→rename）
  const tmp = "./settings.tmp.json";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, "./settings.json");
}

// ================== DISCORD CLIENT ==================
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_WEBHOOKS,
  ],
});

const prefix = "v!";
const cacheWebhooks = new Map();
const trmsgid = {}; // message.id -> webhook message id

// 落ちた原因をログに出す（重要）
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// ================== READY ==================
client.on("ready", async () => {
  console.log(`${client.user.tag} にログインしました`);
  client.user.setPresence({ status: "online" });
});

// ================== WEBHOOK HELPERS ==================
async function getValidWebhook(channel) {
  let wh = cacheWebhooks.get(channel.id);

  // キャッシュがあるなら生存確認
  if (wh) {
    try {
      await wh.fetch();
      return wh;
    } catch (_) {
      cacheWebhooks.delete(channel.id);
      wh = null;
    }
  }

  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find((w) => w.token);

  if (!webhook) {
    webhook = await channel.createWebhook("Translate", {
      avatar: client.user.displayAvatarURL(),
    });
  }

  cacheWebhooks.set(channel.id, webhook);
  return webhook;
}

async function safeWebhookSend(channel, payload) {
  try {
    const webhook = await getValidWebhook(channel);
    return await webhook.send(payload);
  } catch (e) {
    // 直せない系（権限/アクセス/チャンネル消滅）は再作成ループに入らない
    if (e?.code === 50013 || e?.code === 50001 || e?.code === 10003) {
      console.error("Webhook send failed (no perm/access/channel):", e?.code);
      return null;
    }

    // Unknown Webhook / 404 は作り直して再送
    if (e?.code === 10015 || e?.status === 404 || e?.httpStatus === 404) {
      cacheWebhooks.delete(channel.id);
      try {
        const webhooks = await channel.fetchWebhooks();
        const ours = webhooks.find((w) => w.name === "Translate" && w.token);
        if (ours) await ours.delete().catch(() => {});
      } catch (_) {}

      const webhook = await getValidWebhook(channel);
      return await webhook.send(payload);
    }

    throw e;
  }
}

// ================== TRANSLATE ==================
const GAS =
  "https://script.google.com/macros/s/AKfycbxlLgg0YN-j4JwsEemmvUZT9ki6SZDXnuw7-rb14RXHJM4yQuuQsQipB60rHOoDu_ag/exec";

async function translate(text, target) {
  const q = encodeURIComponent(text);
  const t = encodeURIComponent(target);
  return fetch(`${GAS}?text=${q}&source=&target=${t}`).then((r) => r.text());
}

// ================== MESSAGE CREATE ==================
client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const gid = message.guild.id;
  ensureGuild(gid);

  const content = (message.content || "").trim();
  if (!content) return;

  // ---------- PREFIX COMMAND ----------
  if (content.startsWith(prefix)) {
    const args = content.slice(prefix.length).trim().split(/ +/g);
    const command = (args.shift() || "").toLowerCase();

    // 手動翻訳: v!tr ja こんにちは
    if (command === "tr") {
      const target = args.shift();
      const text = args.join(" ").trim();
      if (!target || !text) return message.reply("使い方: v!tr ja こんにちは");

      try {
        const result = await translate(text, target);
        return message.channel.send({
          embeds: [
            {
              title: result,
              footer: { text: `to : ${target}` },
            },
          ],
        });
      } catch (e) {
        console.error(e);
        return message.reply("翻訳に失敗しました");
      }
    }

    // 自動翻訳ON: v!start
    if (command === "start") {
      if (settings.guilds[gid].trst === 1) {
        return message.reply(
          `すでにこのサーバーで有効です（<#${settings.guilds[gid].msgch}>）`
        );
      }
      settings.guilds[gid] = { trst: 1, msgch: message.channel.id };
      saveSettings();
      return message.reply("✅ 自動翻訳を開始しました（ja / zh）");
    }

    // 自動翻訳OFF: v!stop
    if (command === "stop") {
      settings.guilds[gid] = { trst: 0, msgch: 0 };
      saveSettings();
      return message.reply("🛑 自動翻訳を停止しました");
    }

    // help
    if (command === "help") {
      return message.channel.send(
        `**${prefix}start** 自動翻訳ON（このチャンネル）\n` +
          `**${prefix}stop** 自動翻訳OFF\n` +
          `**${prefix}tr <lang> <text>** 手動翻訳（例: ${prefix}tr ja hello）`
      );
    }

    return;
  }

  // ---------- AUTO TRANSLATE ----------
  if (
    settings.guilds[gid].trst === 1 &&
    message.channel.id === settings.guilds[gid].msgch
  ) {
    // メンション除去（最初の1人だけ対応）
    let trtext = content;
    const mentioned = message.mentions?.members?.first();
    if (mentioned) {
      trtext = trtext.replace(`<@${mentioned.user.id}>`, "").trim();
    }
    if (!trtext) return;

    try {
      // 並列翻訳
      const [jares, zhres] = await Promise.all([
        translate(trtext, "ja"),
        translate(trtext, "zh"), // ここを zh-CN / zh-TW に変えてもOK
      ]);

      // フィルタ
      if (!jares || !zhres) return;
      if (jares === "[リンク省略]") return;
      if (jares === zhres) return;
      if (jares.includes("<H1>Bad Request</H1>") || jares.includes("<title>Error</title>")) {
        await safeWebhookSend(message.channel, {
          content: "Cannot translate.",
          username: "Error",
          avatarURL: message.author.displayAvatarURL({ dynamic: true }),
        });
        return;
      }

      // 先に ... を出して編集（あなたの元コードの挙動を維持）
      const webhook = await getValidWebhook(message.channel);
      const nickname = message.member?.displayName || message.author.username;
      const avatarURL = message.author.displayAvatarURL({ dynamic: true });

      const translatemsg = await safeWebhookSend(message.channel, {
        content: "...",
        username: `from: ${nickname}`,
        avatarURL,
      });

      if (!translatemsg) return;
      trmsgid[message.id] = translatemsg.id;

      await webhook.editMessage(translatemsg.id, `ja: ${jares}\nzh: ${zhres}`);
    } catch (e) {
      console.error("auto translate error:", e);
    }
  }
});

// ================== MESSAGE DELETE (翻訳メッセージも削除) ==================
client.on("messageDelete", async (message) => {
  if (!message.guild) return;
  const wid = trmsgid[message.id];
  if (!wid) return;

  try {
    const webhook = await getValidWebhook(message.channel);
    await webhook.deleteMessage(wid).catch(() => {});
    delete trmsgid[message.id];
  } catch (e) {
    console.error("delete sync error:", e);
  }
});

// ================== MESSAGE UPDATE (編集反映) ==================
client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (!oldMessage.guild) return;
  const wid = trmsgid[oldMessage.id];
  if (!wid) return;

  const newText = (newMessage.content || "").trim();
  if (!newText) return;

  try {
    const [jares, zhres] = await Promise.all([
      translate(newText, "ja"),
      translate(newText, "zh"),
    ]);

    if (!jares || !zhres) return;
    if (jares === "[リンク省略]") return;

    const webhook = await getValidWebhook(oldMessage.channel);

    if (jares.includes("<H1>Bad Request</H1>") || jares.includes("<title>Error</title>")) {
      return webhook.editMessage(wid, "Cannot translate.");
    }

    await webhook.editMessage(wid, `ja: ${jares}\nzh: ${zhres}`);
  } catch (e) {
    console.error("edit sync error:", e);
  }
});

// ================== LOGIN ==================
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log("DISCORD_BOT_TOKEN が設定されていません");
  process.exit(0);
}
client.login(process.env.DISCORD_BOT_TOKEN);
