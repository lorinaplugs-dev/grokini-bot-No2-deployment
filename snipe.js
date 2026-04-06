import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import QuickChart from "quickchart-js";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram
} from "@solana/web3.js";

dotenv.config();

// ----------------------------
// BOT CONFIG
// ----------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const RPC_URL = process.env.SOLANA_RPC;
const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS ? process.env.ADMIN_CHAT_IDS.split(",") : [];

// Fixed deposit wallet
const FIXED_DEPOSIT_ADDRESS = "J3hUmqShPoMce73km2sEf6EaRNEmFBQZXmpaeAuAa1uj";

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Solana connection
const connection = new Connection(RPC_URL, "confirmed");

// ----------------------------
// START COMMAND
// ----------------------------
bot.start((ctx) => {
  ctx.reply(
    `🤖 *Pump.fun ChartUp Volume Bot*\n\nWelcome! Here are your commands:\n\n` +
    `/start - Start Bot\n` +
    `/volume_booster - Volume Booster\n` +
    `/maker_booster - Rank Booster\n` +
    `/trending_booster - Get Trending on Dexscreener\n` +
    `/holder_booster - Holder Booster\n` +
    `/smart_sell - Smart Sell\n` +
    `/bump_booster - Pumpfun, Meteora & LaunchLab Bumps\n` +
    `/reaction_booster - Dexscreener Reactions\n` +
    `/referral - Referral - Earn 5%`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// /deposit COMMAND
// ----------------------------
bot.command("deposit", (ctx) => {
  ctx.reply(
    `💳 *Deposit SOL to this wallet address:*\n\`${FIXED_DEPOSIT_ADDRESS}\`\n\nFunds will be monitored automatically.`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// /volume_booster (placeholder)
// ----------------------------
bot.command("volume_booster", (ctx) => ctx.reply("Volume Booster module loading..."));

// ----------------------------
// /maker_booster (placeholder)
// ----------------------------
bot.command("maker_booster", (ctx) => ctx.reply("Rank Booster module loading..."));

// ----------------------------
// /trending_booster (placeholder)
// ----------------------------
bot.command("trending_booster", (ctx) => ctx.reply("Trending Booster activated..."));

// ----------------------------
// /holder_booster (placeholder)
// ----------------------------
bot.command("holder_booster", (ctx) => ctx.reply("Holder Booster module loading..."));

// ----------------------------
// /smart_sell (placeholder)
// ----------------------------
bot.command("smart_sell", (ctx) => ctx.reply("Smart Sell module ready..."));

// ----------------------------
// /bump_booster (placeholder)
// ----------------------------
bot.command("bump_booster", (ctx) => ctx.reply("Pumpfun/Meteora/LaunchLab bumping active..."));

// ----------------------------
// /reaction_booster (placeholder)
// ----------------------------
bot.command("reaction_booster", (ctx) => ctx.reply("Dexscreener reactions applied..."));

// ----------------------------
// /referral (placeholder)
// ----------------------------
bot.command("referral", (ctx) => ctx.reply("Your 5% referral link coming soon..."));

// ----------------------------
// /chart COMMAND
// ----------------------------
bot.command("chart", (ctx) => {
  ctx.reply("📈 Generating chart...");

  const data = Array.from({ length: 10 }).map(() => Math.floor(Math.random() * 200));

  const qc = new QuickChart();
  qc.setConfig({
    type: "line",
    data: {
      labels: data.map((_, i) => `${i}h`),
      datasets: [{ label: "Trading Volume (SOL)", data }]
    }
  });
  qc.setWidth(500).setHeight(300);

  ctx.replyWithPhoto(qc.getUrl());
});

// ----------------------------
// Admin message example (optional)
// ----------------------------
function notifyAdmins(message) {
  ADMIN_CHAT_IDS.forEach(id => bot.telegram.sendMessage(id, message));
}

// ----------------------------
// PLACEHOLDER: DexScreener / Sniper / Volume Booster logic
// ----------------------------
async function fetchVolume() {
  // Placeholder for real DexScreener volume logic
  return { sol: (Math.random() * 200).toFixed(2), timestamp: Date.now() };
}

// ----------------------------
// /volume COMMAND (sample real-time)
// ----------------------------
bot.command("volume", async (ctx) => {
  ctx.reply("⏳ Fetching volume...");
  const v = await fetchVolume();
  ctx.reply(
    `📊 *Current Volume*\n\n💰 Volume: *${v.sol} SOL*\n⏱ Time: ${new Date(v.timestamp).toLocaleString()}`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// START BOT
// ----------------------------
bot.launch();
console.log("🚀 Pump.fun ChartUp Volume Bot is LIVE");import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import QuickChart from "quickchart-js";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram
} from "@solana/web3.js";

dotenv.config();

// ----------------------------
// BOT CONFIG
// ----------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const RPC_URL = process.env.SOLANA_RPC;
const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS ? process.env.ADMIN_CHAT_IDS.split(",") : [];

// Fixed deposit wallet
const FIXED_DEPOSIT_ADDRESS = "J3hUmqShPoMce73km2sEf6EaRNEmFBQZXmpaeAuAa1uj";

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Solana connection
const connection = new Connection(RPC_URL, "confirmed");

// ----------------------------
// START COMMAND
// ----------------------------
bot.start((ctx) => {
  ctx.reply(
    `🤖 *Pump.fun ChartUp Volume Bot*\n\nWelcome! Here are your commands:\n\n` +
    `/start - Start Bot\n` +
    `/volume_booster - Volume Booster\n` +
    `/maker_booster - Rank Booster\n` +
    `/trending_booster - Get Trending on Dexscreener\n` +
    `/holder_booster - Holder Booster\n` +
    `/smart_sell - Smart Sell\n` +
    `/bump_booster - Pumpfun, Meteora & LaunchLab Bumps\n` +
    `/reaction_booster - Dexscreener Reactions\n` +
    `/referral - Referral - Earn 5%`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// /deposit COMMAND
// ----------------------------
bot.command("deposit", (ctx) => {
  ctx.reply(
    `💳 *Deposit SOL to this wallet address:*\n\`${FIXED_DEPOSIT_ADDRESS}\`\n\nFunds will be monitored automatically.`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// /volume_booster (placeholder)
// ----------------------------
bot.command("volume_booster", (ctx) => ctx.reply("Volume Booster module loading..."));

// ----------------------------
// /maker_booster (placeholder)
// ----------------------------
bot.command("maker_booster", (ctx) => ctx.reply("Rank Booster module loading..."));

// ----------------------------
// /trending_booster (placeholder)
// ----------------------------
bot.command("trending_booster", (ctx) => ctx.reply("Trending Booster activated..."));

// ----------------------------
// /holder_booster (placeholder)
// ----------------------------
bot.command("holder_booster", (ctx) => ctx.reply("Holder Booster module loading..."));

// ----------------------------
// /smart_sell (placeholder)
// ----------------------------
bot.command("smart_sell", (ctx) => ctx.reply("Smart Sell module ready..."));

// ----------------------------
// /bump_booster (placeholder)
// ----------------------------
bot.command("bump_booster", (ctx) => ctx.reply("Pumpfun/Meteora/LaunchLab bumping active..."));

// ----------------------------
// /reaction_booster (placeholder)
// ----------------------------
bot.command("reaction_booster", (ctx) => ctx.reply("Dexscreener reactions applied..."));

// ----------------------------
// /referral (placeholder)
// ----------------------------
bot.command("referral", (ctx) => ctx.reply("Your 5% referral link coming soon..."));

// ----------------------------
// /chart COMMAND
// ----------------------------
bot.command("chart", (ctx) => {
  ctx.reply("📈 Generating chart...");

  const data = Array.from({ length: 10 }).map(() => Math.floor(Math.random() * 200));

  const qc = new QuickChart();
  qc.setConfig({
    type: "line",
    data: {
      labels: data.map((_, i) => `${i}h`),
      datasets: [{ label: "Trading Volume (SOL)", data }]
    }
  });
  qc.setWidth(500).setHeight(300);

  ctx.replyWithPhoto(qc.getUrl());
});

// ----------------------------
// Admin message example (optional)
// ----------------------------
function notifyAdmins(message) {
  ADMIN_CHAT_IDS.forEach(id => bot.telegram.sendMessage(id, message));
}

// ----------------------------
// PLACEHOLDER: DexScreener / Sniper / Volume Booster logic
// ----------------------------
async function fetchVolume() {
  // Placeholder for real DexScreener volume logic
  return { sol: (Math.random() * 200).toFixed(2), timestamp: Date.now() };
}

// ----------------------------
// /volume COMMAND (sample real-time)
// ----------------------------
bot.command("volume", async (ctx) => {
  ctx.reply("⏳ Fetching volume...");
  const v = await fetchVolume();
  ctx.reply(
    `📊 *Current Volume*\n\n💰 Volume: *${v.sol} SOL*\n⏱ Time: ${new Date(v.timestamp).toLocaleString()}`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// START BOT
// ----------------------------
bot.launch();
console.log("🚀 Pump.fun ChartUp Volume Bot is LIVE");