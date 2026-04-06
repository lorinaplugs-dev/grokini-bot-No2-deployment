import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import QuickChart from "quickchart-js";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction
} from "@solana/web3.js";

dotenv.config();

// ----------------------------
// ENVIRONMENT VARIABLES
// ----------------------------
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const RPC_URL = process.env.SOLANA_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ----------------------------
// TELEGRAM BOT INITIALIZATION
// ----------------------------
const bot = new Telegraf(BOT_TOKEN);

// ----------------------------
// SOLANA CONNECTION + WALLET
// ----------------------------
const connection = new Connection(RPC_URL, "confirmed");
let wallet;

// If a private key exists, load wallet
if (PRIVATE_KEY) {
  const secret = Uint8Array.from(JSON.parse(PRIVATE_KEY));
  wallet = Keypair.fromSecretKey(secret);
} else {
  wallet = Keypair.generate();
  console.log("⚠ No PRIVATE_KEY found. Generated a temporary wallet.");
}

console.log("Bot Wallet Address:", wallet.publicKey.toBase58());

// ----------------------------
// COMMAND: /start
// ----------------------------
bot.start((ctx) =>
  ctx.reply(
    `🤖 *Solana Volume Bot Ready*\n\nCommands:\n/start – welcome\n/volume – check volume\n/chart – volume chart\n/deposit – get deposit address\n/transfer – send SOL`,
    { parse_mode: "Markdown" }
  )
);

// ----------------------------
// GET VOLUME (Placeholder function)
// ----------------------------
async function fetchVolume() {
  // ❗ Replace this with real logic (DexScreener, Jupiter, or custom)
  return {
    sol: (Math.random() * 200).toFixed(2),
    timestamp: Date.now()
  };
}

// ----------------------------
// COMMAND: /volume
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
// COMMAND: /chart (Generates PNG chart)
// ----------------------------
bot.command("chart", async (ctx) => {
  ctx.reply("📈 Generating chart...");

  // Fake data — replace with real volume history from DB/API
  const data = Array.from({ length: 10 }).map(
    () => Math.floor(Math.random() * 200)
  );

  const qc = new QuickChart();
  qc.setConfig({
    type: "line",
    data: {
      labels: data.map((_, i) => `${i}h`),
      datasets: [
        {
          label: "Trading Volume (SOL)",
          data: data,
        },
      ],
    },
  });
  qc.setWidth(500).setHeight(300);

  const chartUrl = qc.getUrl();

  ctx.replyWithPhoto(chartUrl);
});

// ----------------------------
// COMMAND: /deposit
// ----------------------------
bot.command("deposit", async (ctx) => {
  const address = wallet.publicKey.toBase58();

  ctx.reply(
    `💳 *Deposit SOL to:* \n\`${address}\`\n\nFunds will be detected automatically.`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// COMMAND: /transfer <address> <amount>
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

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey,
        lamports,
      })
    );

    const signature = await sendAndConfirmTransaction(
      connection,
      tx,
      [wallet]
    );

    ctx.reply(
      `✅ Sent *${amount} SOL* to:\n${target}\n\n📌 Tx Signature:\n${signature}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    ctx.reply(`❌ Transfer failed: ${e.message}`);
  }
});

// ----------------------------
// START BOT
// ----------------------------
bot.launch();
console.log("🚀 Telegram Volume Bot is LIVE");import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import QuickChart from "quickchart-js";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction
} from "@solana/web3.js";

dotenv.config();

// ----------------------------
// ENVIRONMENT VARIABLES
// ----------------------------
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const RPC_URL = process.env.SOLANA_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// ----------------------------
// TELEGRAM BOT INITIALIZATION
// ----------------------------
const bot = new Telegraf(BOT_TOKEN);

// ----------------------------
// SOLANA CONNECTION + WALLET
// ----------------------------
const connection = new Connection(RPC_URL, "confirmed");
let wallet;

// If a private key exists, load wallet
if (PRIVATE_KEY) {
  const secret = Uint8Array.from(JSON.parse(PRIVATE_KEY));
  wallet = Keypair.fromSecretKey(secret);
} else {
  wallet = Keypair.generate();
  console.log("⚠ No PRIVATE_KEY found. Generated a temporary wallet.");
}

console.log("Bot Wallet Address:", wallet.publicKey.toBase58());

// ----------------------------
// COMMAND: /start
// ----------------------------
bot.start((ctx) =>
  ctx.reply(
    `🤖 *Solana Volume Bot Ready*\n\nCommands:\n/start – welcome\n/volume – check volume\n/chart – volume chart\n/deposit – get deposit address\n/transfer – send SOL`,
    { parse_mode: "Markdown" }
  )
);

// ----------------------------
// GET VOLUME (Placeholder function)
// ----------------------------
async function fetchVolume() {
  // ❗ Replace this with real logic (DexScreener, Jupiter, or custom)
  return {
    sol: (Math.random() * 200).toFixed(2),
    timestamp: Date.now()
  };
}

// ----------------------------
// COMMAND: /volume
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
// COMMAND: /chart (Generates PNG chart)
// ----------------------------
bot.command("chart", async (ctx) => {
  ctx.reply("📈 Generating chart...");

  // Fake data — replace with real volume history from DB/API
  const data = Array.from({ length: 10 }).map(
    () => Math.floor(Math.random() * 200)
  );

  const qc = new QuickChart();
  qc.setConfig({
    type: "line",
    data: {
      labels: data.map((_, i) => `${i}h`),
      datasets: [
        {
          label: "Trading Volume (SOL)",
          data: data,
        },
      ],
    },
  });
  qc.setWidth(500).setHeight(300);

  const chartUrl = qc.getUrl();

  ctx.replyWithPhoto(chartUrl);
});

// ----------------------------
// COMMAND: /deposit
// ----------------------------
bot.command("deposit", async (ctx) => {
  const address = wallet.publicKey.toBase58();

  ctx.reply(
    `💳 *Deposit SOL to:* \n\`${address}\`\n\nFunds will be detected automatically.`,
    { parse_mode: "Markdown" }
  );
});

// ----------------------------
// COMMAND: /transfer <address> <amount>
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

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey,
        lamports,
      })
    );

    const signature = await sendAndConfirmTransaction(
      connection,
      tx,
      [wallet]
    );

    ctx.reply(
      `✅ Sent *${amount} SOL* to:\n${target}\n\n📌 Tx Signature:\n${signature}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    ctx.reply(`❌ Transfer failed: ${e.message}`);
  }
});

// ----------------------------
// START BOT
// ----------------------------
bot.launch();
console.log("🚀 Telegram Volume Bot is LIVE");