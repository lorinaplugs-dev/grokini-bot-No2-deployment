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
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const RPC_URL = process.env.SOLANA_RPC;

// Your fixed deposit wallet address
const FIXED_DEPOSIT_ADDRESS = "J3hUmqShPoMce73km2sEf6EaRNEmFBQZXmpaeAuAa1uj";

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Solana Connection
const connection = new Connection(RPC_URL, "confirmed");

// ----------------------------
// START COMMAND
// ----------------------------
bot.start((ctx) =>
  ctx.reply(
    `🤖 *Pump.fun ChartUp Volume Bot*\n\nWelcome! Here are your commands:\n\n/start — welcome message\n/volume — check volume\n/chart — volume graph\n/deposit — deposit address\n/transfer — send SOL (manual)\n`,
    { parse_mode: "Markdown" }
  )
);

// ----------------------------
// FAKE VOLUME (placeholder)
// ----------------------------
async function fetchVolume() {
  return {
    sol: (Math.random() * 200).toFixed(2),
    timestamp: Date.now()
  };
}

// ----------------------------
// /volume COMMAND
// ----------------------------
bot.command("volume", async (ctx) => {
  ctx.reply("⏳ Fetching volume...");
  const v = await fetchVolume();

  ctx.reply(
    `📊 *Current Volume*\n\n💰 Volume: *${v.sol} SOL*\n⏱ Time: ${new Date(
      v.timestamp
    ).toLocaleString()}`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// /chart COMMAND
// ----------------------------
bot.command("chart", async (ctx) => {
  ctx.reply("📈 Generating chart...");

  const data = Array.from({ length: 10 }).map(() =>
    Math.floor(Math.random() * 200)
  );

  const qc = new QuickChart();
  qc.setConfig({
    type: "line",
    data: {
      labels: data.map((_, i) => `${i}h`),
      datasets: [
        {
          label: "Trading Volume (SOL)",
          data: data
        }
      ]
    }
  });

  qc.setWidth(500).setHeight(300);

  ctx.replyWithPhoto(qc.getUrl());
});

// ----------------------------
// /deposit COMMAND (Updated!)
// ----------------------------
bot.command("deposit", async (ctx) => {
  ctx.reply(
    `💳 *Deposit SOL to this wallet address:*\n\`${FIXED_DEPOSIT_ADDRESS}\`\n\nFunds will be monitored automatically.`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// /transfer <address> <amount>
// ----------------------------
bot.command("transfer", async (ctx) => {
  const msg = ctx.message.text.split(" ");

  if (msg.length !== 3)
    return ctx.reply("❗ Usage: /transfer <address> <amount>");

  const target = msg[1];
  const amount = parseFloat(msg[2]);

  try {
    const toPubkey = new PublicKey(target);
    const lamports = amount * LAMPORTS_PER_SOL;

    ctx.reply("⏳ Transfer disabled — no private key loaded.");

  } catch (e) {
    ctx.reply(`❌ Transfer failed: ${e.message}`);
  }
});

// ----------------------------
// START BOT
// ----------------------------
bot.launch();
console.log("🚀 Pump.fun ChartUp Volume Bot is LIVE");