/**
 * GrokiniHotBot - Solana Trading Bot for Telegram
 */

const TelegramBot = require('node-telegram-bot-api');
const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const crypto = require('crypto');
const mongoose = require('mongoose');

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
  },
  mongodb: {
    uri: process.env.MONGODB_URI || '',
  },
  solana: {
    rpcUrls: [
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'https://solana-mainnet.g.alchemy.com/v2/demo',
      'https://rpc.ankr.com/solana',
    ],
  },
  jupiter: {
    apiUrl: 'https://quote-api.jup.ag/v6',
    priceApiUrl: 'https://price.jup.ag/v6',
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
    algorithm: 'aes-256-gcm',
  },
  bot: {
    name: 'GrokiniHotBot',
    commissionWallet: process.env.COMMISSION_WALLET || '',
    commissionRate: 0.01,
    maxWallets: 5,
    defaultSlippage: 1,
    adminIds: (process.env.ADMIN_IDS || '').split(',').filter(Boolean),
  },
};

// ============================================================================
// DATABASE SCHEMAS
// ============================================================================

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: String,
  firstName: String,
  lastName: String,
  referredBy: String,
  referralCode: { type: String, unique: true },
  referralCount: { type: Number, default: 0 },
  referralEarnings: { type: Number, default: 0 },
  settings: {
    slippage: { type: Number, default: 1 },
    priorityFee: { type: Number, default: 0.000005 },
    autoApprove: { type: Boolean, default: false },
    notifications: { type: Boolean, default: true },
  },
  state: {
    action: String,
    step: String,
    tokenAddress: String,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isBanned: { type: Boolean, default: false },
});

const walletSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  name: { type: String, default: 'Main Wallet' },
  publicKey: { type: String, required: true },
  encryptedPrivateKey: { type: String, required: true },
  iv: { type: String, required: true },
  authTag: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const transactionSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  walletAddress: String,
  type: { type: String, enum: ['buy', 'sell', 'transfer'] },
  tokenAddress: String,
  tokenSymbol: String,
  amountIn: Number,
  amountOut: Number,
  priceUsd: Number,
  signature: String,
  status: { type: String, enum: ['pending', 'confirmed', 'failed'] },
  createdAt: { type: Date, default: Date.now },
});

const limitOrderSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  walletAddress: String,
  type: { type: String, enum: ['buy', 'sell'] },
  tokenAddress: String,
  tokenSymbol: String,
  triggerPrice: Number,
  amount: Number,
  slippage: Number,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  executedAt: Date,
});

const dcaOrderSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  walletAddress: String,
  tokenAddress: String,
  tokenSymbol: String,
  amountPerOrder: Number,
  interval: Number,
  totalOrders: Number,
  executedOrders: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  nextExecutionAt: Date,
  createdAt: { type: Date, default: Date.now },
});

const copyTradeSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  walletAddress: String,
  targetWallet: { type: String, required: true },
  maxAmountPerTrade: Number,
  copyPercentage: { type: Number, default: 100 },
  isActive: { type: Boolean, default: true },
  totalTrades: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const priceAlertSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  tokenAddress: String,
  tokenSymbol: String,
  targetPrice: Number,
  condition: { type: String, enum: ['above', 'below'] },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  triggeredAt: Date,
});

const User = mongoose.model('User', userSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const SolanaTransaction = mongoose.model('Transaction', transactionSchema);
const LimitOrder = mongoose.model('LimitOrder', limitOrderSchema);
const DCAOrder = mongoose.model('DCAOrder', dcaOrderSchema);
const CopyTrade = mongoose.model('CopyTrade', copyTradeSchema);
const PriceAlert = mongoose.model('PriceAlert', priceAlertSchema);

// ============================================================================
// ENCRYPTION UTILITIES
// ============================================================================

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(config.encryption.key, 'salt', 32);
  const cipher = crypto.createCipheriv(config.encryption.algorithm, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

function decrypt(encrypted, iv, authTag) {
  const key = crypto.scryptSync(config.encryption.key, 'salt', 32);
  const decipher = crypto.createDecipheriv(
    config.encryption.algorithm,
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// ============================================================================
// SOLANA UTILITIES
// ============================================================================

let currentRpcIndex = 0;

function getConnection() {
  const url = config.solana.rpcUrls[currentRpcIndex];
  return new Connection(url, 'confirmed');
}

function rotateRpc() {
  currentRpcIndex = (currentRpcIndex + 1) % config.solana.rpcUrls.length;
}

async function getBalance(publicKey) {
  const connection = getConnection();
  try {
    const balance = await connection.getBalance(new PublicKey(publicKey));
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    rotateRpc();
    throw error;
  }
}

async function getTokenBalance(walletAddress, tokenAddress) {
  const connection = getConnection();
  try {
    const wallet = new PublicKey(walletAddress);
    const token = new PublicKey(tokenAddress);
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint: token });
    
    if (accounts.value.length === 0) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch (error) {
    rotateRpc();
    return 0;
  }
}

// ============================================================================
// JUPITER API
// ============================================================================

async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 100) {
  try {
    const response = await fetch(
      `${config.jupiter.apiUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
    );
    
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('Jupiter quote error:', error);
    return null;
  }
}

async function executeJupiterSwap(quote, walletPublicKey, privateKey) {
  try {
    const swapResponse = await fetch(`${config.jupiter.apiUrl}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: walletPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    if (!swapResponse.ok) return null;

    const { swapTransaction } = await swapResponse.json();
    const transactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuf);
    
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    transaction.sign([keypair]);

    const connection = getConnection();
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (error) {
    console.error('Swap execution error:', error);
    return null;
  }
}

async function getTokenPrice(tokenAddress) {
  try {
    const response = await fetch(`${config.jupiter.priceApiUrl}/price?ids=${tokenAddress}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.data?.[tokenAddress]?.price || null;
  } catch (error) {
    return null;
  }
}

// ============================================================================
// WALLET MANAGEMENT
// ============================================================================

async function createWallet(telegramId, name = 'Main Wallet') {
  const existingWallets = await Wallet.countDocuments({ telegramId });
  
  if (existingWallets >= config.bot.maxWallets) {
    throw new Error(`Maximum ${config.bot.maxWallets} wallets allowed`);
  }

  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const privateKey = bs58.encode(keypair.secretKey);
  
  const { encrypted, iv, authTag } = encrypt(privateKey);
  
  const isFirst = existingWallets === 0;
  
  await Wallet.create({
    telegramId,
    name,
    publicKey,
    encryptedPrivateKey: encrypted,
    iv,
    authTag,
    isActive: isFirst,
  });

  return { publicKey, created: true };
}

async function importWallet(telegramId, privateKey, name = 'Imported Wallet') {
  const existingWallets = await Wallet.countDocuments({ telegramId });
  
  if (existingWallets >= config.bot.maxWallets) {
    throw new Error(`Maximum ${config.bot.maxWallets} wallets allowed`);
  }

  let keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch {
    throw new Error('Invalid private key format');
  }

  const publicKey = keypair.publicKey.toBase58();
  
  const existing = await Wallet.findOne({ telegramId, publicKey });
  if (existing) {
    throw new Error('Wallet already exists');
  }

  const { encrypted, iv, authTag } = encrypt(privateKey);
  const isFirst = existingWallets === 0;
  
  await Wallet.create({
    telegramId,
    name,
    publicKey,
    encryptedPrivateKey: encrypted,
    iv,
    authTag,
    isActive: isFirst,
  });

  return { publicKey, imported: true };
}

async function getActiveWallet(telegramId) {
  return await Wallet.findOne({ telegramId, isActive: true });
}

async function getWalletPrivateKey(wallet) {
  return decrypt(wallet.encryptedPrivateKey, wallet.iv, wallet.authTag);
}

async function getUserWallets(telegramId) {
  return await Wallet.find({ telegramId }).sort({ createdAt: 1 });
}

async function setActiveWallet(telegramId, publicKey) {
  await Wallet.updateMany({ telegramId }, { isActive: false });
  const result = await Wallet.updateOne({ telegramId, publicKey }, { isActive: true });
  return result.modifiedCount > 0;
}

async function deleteWallet(telegramId, publicKey) {
  const wallet = await Wallet.findOne({ telegramId, publicKey });
  if (!wallet) return false;
  
  await Wallet.deleteOne({ telegramId, publicKey });
  
  if (wallet.isActive) {
    const remaining = await Wallet.findOne({ telegramId });
    if (remaining) {
      await Wallet.updateOne({ _id: remaining._id }, { isActive: true });
    }
  }
  
  return true;
}

// ============================================================================
// USER MANAGEMENT
// ============================================================================

async function getOrCreateUser(telegramId, userData = {}) {
  let user = await User.findOne({ telegramId });
  
  if (!user) {
    const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    
    user = await User.create({
      telegramId,
      username: userData.username,
      firstName: userData.first_name,
      lastName: userData.last_name,
      referralCode,
    });
    
    await createWallet(telegramId, 'Main Wallet');
  }
  
  return user;
}

async function updateUserSettings(telegramId, settings) {
  await User.updateOne(
    { telegramId },
    { $set: { settings, updatedAt: new Date() } }
  );
}

// ============================================================================
// BOT HANDLERS
// ============================================================================

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function formatAddress(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatNumber(num, decimals = 4) {
  return num.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

async function handleStart(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  
  try {
    const user = await getOrCreateUser(telegramId, msg.from);
    const wallet = await getActiveWallet(telegramId);
    
    if (!wallet) {
      await bot.sendMessage(chatId, 'Error creating wallet. Please try again.');
      return;
    }
    
    let balance = 0;
    try {
      balance = await getBalance(wallet.publicKey);
    } catch (e) {
      console.log('Balance fetch error:', e.message);
    }
    
    const message = `
*Welcome to GrokiniHotBot!*

Your Solana trading companion on Telegram.

*Active Wallet:* \`${wallet.publicKey}\`
*Balance:* ${formatNumber(balance)} SOL

*Quick Actions:*
Use the buttons below to start trading.

*Your Referral Code:* \`${user.referralCode}\`
Share and earn 20% of trading fees!
    `.trim();

    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Buy', callback_data: 'buy' },
          { text: 'Sell', callback_data: 'sell' },
        ],
        [
          { text: 'Wallets', callback_data: 'wallets' },
          { text: 'Positions', callback_data: 'positions' },
        ],
        [
          { text: 'Limit Orders', callback_data: 'limit_orders' },
          { text: 'DCA', callback_data: 'dca' },
        ],
        [
          { text: 'Copy Trade', callback_data: 'copy_trade' },
          { text: 'Alerts', callback_data: 'alerts' },
        ],
        [
          { text: 'Settings', callback_data: 'settings' },
          { text: 'History', callback_data: 'history' },
        ],
        [
          { text: 'Referrals', callback_data: 'referrals' },
          { text: 'Help', callback_data: 'help' },
        ],
      ],
    };

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error('Start error:', error);
    await bot.sendMessage(chatId, 'An error occurred. Please try again.');
  }
}

async function handleWallets(bot, chatId, telegramId) {
  try {
    const wallets = await getUserWallets(telegramId);
    
    if (wallets.length === 0) {
      await bot.sendMessage(chatId, 'No wallets found. Creating one for you...');
      await createWallet(telegramId);
      return handleWallets(bot, chatId, telegramId);
    }

    let message = '*Your Wallets:*\n\n';
    
    for (const wallet of wallets) {
      let balance = 0;
      try {
        balance = await getBalance(wallet.publicKey);
      } catch (e) {}
      const activeMarker = wallet.isActive ? ' (Active)' : '';
      message += `*${wallet.name}*${activeMarker}\n`;
      message += `\`${wallet.publicKey}\`\n`;
      message += `Balance: ${formatNumber(balance)} SOL\n\n`;
    }

    const buttons = wallets.map((w) => [
      { 
        text: `${w.isActive ? '✓ ' : ''}${w.name}`, 
        callback_data: `select_wallet_${w.publicKey}` 
      },
    ]);

    buttons.push([
      { text: 'Create New', callback_data: 'create_wallet' },
      { text: 'Import', callback_data: 'import_wallet' },
    ]);
    buttons.push([{ text: 'Back', callback_data: 'start' }]);

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (error) {
    console.error('Wallets error:', error);
    await bot.sendMessage(chatId, 'Error loading wallets.');
  }
}

async function handleBuy(bot, chatId, telegramId) {
  const wallet = await getActiveWallet(telegramId);
  if (!wallet) {
    await bot.sendMessage(chatId, 'No active wallet. Please create one first.');
    return;
  }

  let balance = 0;
  try {
    balance = await getBalance(wallet.publicKey);
  } catch (e) {}

  const message = `
*Buy Tokens*

Active Wallet: \`${formatAddress(wallet.publicKey)}\`
Balance: ${formatNumber(balance)} SOL

Send the token contract address to buy:
  `.trim();

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Back', callback_data: 'start' }],
      ],
    },
  });

  await User.updateOne(
    { telegramId },
    { $set: { 'state.action': 'buy_token', 'state.step': 'awaiting_address' } }
  );
}

async function handleSell(bot, chatId, telegramId) {
  const wallet = await getActiveWallet(telegramId);
  if (!wallet) {
    await bot.sendMessage(chatId, 'No active wallet. Please create one first.');
    return;
  }

  const message = `
*Sell Tokens*

Active Wallet: \`${formatAddress(wallet.publicKey)}\`

Send the token contract address to sell:
  `.trim();

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Back', callback_data: 'start' }],
      ],
    },
  });

  await User.updateOne(
    { telegramId },
    { $set: { 'state.action': 'sell_token', 'state.step': 'awaiting_address' } }
  );
}

async function handleSettings(bot, chatId, telegramId) {
  const user = await User.findOne({ telegramId });
  const settings = user?.settings || { slippage: 1, priorityFee: 0.000005, autoApprove: false, notifications: true };

  const message = `
*Settings*

*Slippage:* ${settings.slippage}%
*Priority Fee:* ${settings.priorityFee} SOL
*Auto Approve:* ${settings.autoApprove ? 'On' : 'Off'}
*Notifications:* ${settings.notifications ? 'On' : 'Off'}
  `.trim();

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Slippage', callback_data: 'set_slippage' },
          { text: 'Priority Fee', callback_data: 'set_priority' },
        ],
        [
          { text: `Auto Approve: ${settings.autoApprove ? 'On' : 'Off'}`, callback_data: 'toggle_auto_approve' },
        ],
        [
          { text: `Notifications: ${settings.notifications ? 'On' : 'Off'}`, callback_data: 'toggle_notifications' },
        ],
        [{ text: 'Back', callback_data: 'start' }],
      ],
    },
  });
}

async function handleHistory(bot, chatId, telegramId) {
  const transactions = await SolanaTransaction.find({ telegramId })
    .sort({ createdAt: -1 })
    .limit(10);

  if (transactions.length === 0) {
    await bot.sendMessage(chatId, 'No transaction history yet.', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Back', callback_data: 'start' }]],
      },
    });
    return;
  }

  let message = '*Recent Transactions:*\n\n';

  for (const tx of transactions) {
    const date = tx.createdAt.toLocaleDateString();
    const typeEmoji = tx.type === 'buy' ? 'B' : tx.type === 'sell' ? 'S' : 'T';
    message += `[${typeEmoji}] ${tx.tokenSymbol || 'Unknown'}\n`;
    message += `Amount: ${formatNumber(tx.amountIn || 0)} -> ${formatNumber(tx.amountOut || 0)}\n`;
    message += `Status: ${tx.status} | ${date}\n\n`;
  }

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: 'Back', callback_data: 'start' }]],
    },
  });
}

async function handleReferrals(bot, chatId, telegramId) {
  const user = await User.findOne({ telegramId });

  const message = `
*Referral Program*

Your Code: \`${user?.referralCode || 'N/A'}\`
Total Referrals: ${user?.referralCount || 0}
Total Earnings: ${formatNumber(user?.referralEarnings || 0)} SOL

Share your referral link:
\`https://t.me/GrokiniHotBot?start=${user?.referralCode}\`

Earn 20% of trading fees from your referrals!
  `.trim();

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: 'Back', callback_data: 'start' }]],
    },
  });
}

async function handleHelp(bot, chatId) {
  const message = `
*GrokiniHotBot Help*

*Commands:*
/start - Main menu
/buy - Buy tokens
/sell - Sell tokens
/wallet - Wallet management
/settings - Bot settings
/help - This help message

*Features:*
- Multi-wallet support (up to 5)
- Jupiter DEX integration
- Limit orders
- DCA (Dollar Cost Averaging)
- Copy trading
- Price alerts
- Referral program

*How to Trade:*
1. Deposit SOL to your wallet
2. Copy a token contract address
3. Click Buy and paste the address
4. Select amount and confirm

*Support:*
Contact @GrokiniSupport for help.
  `.trim();

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: 'Back', callback_data: 'start' }]],
    },
  });
}

async function handleLimitOrders(bot, chatId, telegramId) {
  const orders = await LimitOrder.find({ telegramId, isActive: true }).limit(10);

  let message = '*Limit Orders*\n\n';

  if (orders.length === 0) {
    message += 'No active limit orders.\n\n';
    message += 'Create a limit order to automatically buy or sell when a token reaches your target price.';
  } else {
    for (const order of orders) {
      message += `${order.type.toUpperCase()} ${order.tokenSymbol}\n`;
      message += `Trigger: $${formatNumber(order.triggerPrice)}\n`;
      message += `Amount: ${formatNumber(order.amount)} SOL\n\n`;
    }
  }

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Create Limit Order', callback_data: 'create_limit_order' }],
        [{ text: 'Back', callback_data: 'start' }],
      ],
    },
  });
}

async function handleDCA(bot, chatId, telegramId) {
  const orders = await DCAOrder.find({ telegramId, isActive: true }).limit(10);

  let message = '*DCA Orders*\n\n';

  if (orders.length === 0) {
    message += 'No active DCA orders.\n\n';
    message += 'Dollar Cost Averaging helps you invest a fixed amount at regular intervals.';
  } else {
    for (const order of orders) {
      message += `${order.tokenSymbol}\n`;
      message += `Amount: ${formatNumber(order.amountPerOrder)} SOL\n`;
      message += `Interval: Every ${order.interval} minutes\n`;
      message += `Progress: ${order.executedOrders}/${order.totalOrders}\n\n`;
    }
  }

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Create DCA Order', callback_data: 'create_dca' }],
        [{ text: 'Back', callback_data: 'start' }],
      ],
    },
  });
}

async function handleCopyTrade(bot, chatId, telegramId) {
  const copies = await CopyTrade.find({ telegramId, isActive: true }).limit(10);

  let message = '*Copy Trading*\n\n';

  if (copies.length === 0) {
    message += 'No active copy trades.\n\n';
    message += 'Follow successful traders and automatically copy their trades.';
  } else {
    for (const copy of copies) {
      message += `Copying: \`${formatAddress(copy.targetWallet)}\`\n`;
      message += `Max per trade: ${formatNumber(copy.maxAmountPerTrade)} SOL\n`;
      message += `Total trades: ${copy.totalTrades}\n\n`;
    }
  }

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Add Wallet to Copy', callback_data: 'add_copy_trade' }],
        [{ text: 'Back', callback_data: 'start' }],
      ],
    },
  });
}

async function handleAlerts(bot, chatId, telegramId) {
  const alerts = await PriceAlert.find({ telegramId, isActive: true }).limit(10);

  let message = '*Price Alerts*\n\n';

  if (alerts.length === 0) {
    message += 'No active price alerts.\n\n';
    message += 'Set alerts to get notified when tokens reach your target price.';
  } else {
    for (const alert of alerts) {
      message += `${alert.tokenSymbol}\n`;
      message += `Alert when ${alert.condition} $${formatNumber(alert.targetPrice)}\n\n`;
    }
  }

  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Create Alert', callback_data: 'create_alert' }],
        [{ text: 'Back', callback_data: 'start' }],
      ],
    },
  });
}

// ============================================================================
// CALLBACK HANDLER
// ============================================================================

async function handleCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id.toString();
  const data = query.data || '';

  await bot.answerCallbackQuery(query.id);

  try {
    const user = await User.findOne({ telegramId });
    if (user?.isBanned) {
      await bot.sendMessage(chatId, 'Your account has been suspended.');
      return;
    }

    switch (data) {
      case 'start':
        await handleStart(bot, query.message);
        break;
      case 'wallets':
        await handleWallets(bot, chatId, telegramId);
        break;
      case 'buy':
        await handleBuy(bot, chatId, telegramId);
        break;
      case 'sell':
        await handleSell(bot, chatId, telegramId);
        break;
      case 'settings':
        await handleSettings(bot, chatId, telegramId);
        break;
      case 'history':
        await handleHistory(bot, chatId, telegramId);
        break;
      case 'referrals':
        await handleReferrals(bot, chatId, telegramId);
        break;
      case 'help':
        await handleHelp(bot, chatId);
        break;
      case 'limit_orders':
        await handleLimitOrders(bot, chatId, telegramId);
        break;
      case 'dca':
        await handleDCA(bot, chatId, telegramId);
        break;
      case 'copy_trade':
        await handleCopyTrade(bot, chatId, telegramId);
        break;
      case 'alerts':
        await handleAlerts(bot, chatId, telegramId);
        break;
      case 'positions':
        await bot.sendMessage(chatId, 'Positions feature coming soon!', {
          reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: 'start' }]] }
        });
        break;
      case 'create_wallet':
        try {
          const result = await createWallet(telegramId, `Wallet ${Date.now()}`);
          await bot.sendMessage(chatId, `Wallet created!\n\`${result.publicKey}\``, { parse_mode: 'Markdown' });
          await handleWallets(bot, chatId, telegramId);
        } catch (error) {
          await bot.sendMessage(chatId, error.message);
        }
        break;
      case 'import_wallet':
        await bot.sendMessage(chatId, 'Send your private key to import a wallet:\n\n*Warning: Only import wallets in private chats!*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'wallets' }]] }
        });
        await User.updateOne({ telegramId }, { $set: { 'state.action': 'import_wallet', 'state.step': 'awaiting_key' } });
        break;
      case 'toggle_auto_approve':
        const currentUser = await User.findOne({ telegramId });
        const newAutoApprove = !currentUser?.settings?.autoApprove;
        await updateUserSettings(telegramId, { ...currentUser?.settings, autoApprove: newAutoApprove });
        await handleSettings(bot, chatId, telegramId);
        break;
      case 'toggle_notifications':
        const currUser = await User.findOne({ telegramId });
        const newNotifications = !currUser?.settings?.notifications;
        await updateUserSettings(telegramId, { ...currUser?.settings, notifications: newNotifications });
        await handleSettings(bot, chatId, telegramId);
        break;
      default:
        if (data.startsWith('select_wallet_')) {
          const publicKey = data.replace('select_wallet_', '');
          await setActiveWallet(telegramId, publicKey);
          await bot.sendMessage(chatId, 'Wallet selected!');
          await handleWallets(bot, chatId, telegramId);
        }
        break;
    }
  } catch (error) {
    console.error('Callback error:', error);
  }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

async function handleMessage(bot, msg) {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const text = msg.text.trim();

  try {
    const user = await User.findOne({ telegramId });
    const state = user?.state;

    if (!state?.action) return;

    const isValidAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);

    if (state.action === 'import_wallet' && state.step === 'awaiting_key') {
      try {
        const result = await importWallet(telegramId, text, `Imported ${Date.now()}`);
        await bot.sendMessage(chatId, `Wallet imported!\n\`${result.publicKey}\``, { parse_mode: 'Markdown' });
        await User.updateOne({ telegramId }, { $unset: { state: 1 } });
        await handleWallets(bot, chatId, telegramId);
      } catch (error) {
        await bot.sendMessage(chatId, `Error: ${error.message}`);
      }
      return;
    }

    if (state.action === 'buy_token' && state.step === 'awaiting_address') {
      if (!isValidAddress) {
        await bot.sendMessage(chatId, 'Invalid token address. Please send a valid Solana token address.');
        return;
      }

      const price = await getTokenPrice(text);
      const wallet = await getActiveWallet(telegramId);
      let balance = 0;
      try {
        balance = await getBalance(wallet.publicKey);
      } catch (e) {}

      await User.updateOne(
        { telegramId },
        { $set: { 'state.tokenAddress': text, 'state.step': 'awaiting_amount' } }
      );

      const message = `
*Token Found*

Address: \`${text}\`
Price: ${price ? `$${formatNumber(price, 8)}` : 'Unknown'}

Your Balance: ${formatNumber(balance)} SOL

Select amount to buy:
      `.trim();

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '0.1 SOL', callback_data: 'buy_amount_0.1' },
              { text: '0.5 SOL', callback_data: 'buy_amount_0.5' },
            ],
            [
              { text: '1 SOL', callback_data: 'buy_amount_1' },
              { text: '2 SOL', callback_data: 'buy_amount_2' },
            ],
            [
              { text: '5 SOL', callback_data: 'buy_amount_5' },
              { text: 'Custom', callback_data: 'buy_amount_custom' },
            ],
            [{ text: 'Cancel', callback_data: 'start' }],
          ],
        },
      });
    }

    if (state.action === 'sell_token' && state.step === 'awaiting_address') {
      if (!isValidAddress) {
        await bot.sendMessage(chatId, 'Invalid token address. Please send a valid Solana token address.');
        return;
      }

      const wallet = await getActiveWallet(telegramId);
      const tokenBalance = await getTokenBalance(wallet.publicKey, text);
      const price = await getTokenPrice(text);

      if (tokenBalance === 0) {
        await bot.sendMessage(chatId, 'You do not hold this token.', {
          reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: 'start' }]],
          },
        });
        return;
      }

      await User.updateOne(
        { telegramId },
        { $set: { 'state.tokenAddress': text, 'state.step': 'awaiting_percentage' } }
      );

      const message = `
*Sell Token*

Address: \`${text}\`
Your Balance: ${formatNumber(tokenBalance)}
Price: ${price ? `$${formatNumber(price, 8)}` : 'Unknown'}

Select percentage to sell:
      `.trim();

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '25%', callback_data: 'sell_percent_25' },
              { text: '50%', callback_data: 'sell_percent_50' },
            ],
            [
              { text: '75%', callback_data: 'sell_percent_75' },
              { text: '100%', callback_data: 'sell_percent_100' },
            ],
            [{ text: 'Cancel', callback_data: 'start' }],
          ],
        },
      });
    }
  } catch (error) {
    console.error('Message handler error:', error);
  }
}

// ============================================================================
// ADMIN COMMANDS
// ============================================================================

async function handleAdminCommand(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const text = msg.text || '';

  if (!config.bot.adminIds.includes(telegramId)) {
    await bot.sendMessage(chatId, 'Unauthorized.');
    return;
  }

  const [command, ...args] = text.split(' ');

  switch (command) {
    case '/ban':
      if (args[0]) {
        await User.updateOne({ telegramId: args[0] }, { isBanned: true });
        await bot.sendMessage(chatId, `User ${args[0]} banned.`);
      }
      break;
    case '/unban':
      if (args[0]) {
        await User.updateOne({ telegramId: args[0] }, { isBanned: false });
        await bot.sendMessage(chatId, `User ${args[0]} unbanned.`);
      }
      break;
    case '/stats':
      const totalUsers = await User.countDocuments();
      const totalWallets = await Wallet.countDocuments();
      const totalTransactions = await SolanaTransaction.countDocuments();
      await bot.sendMessage(chatId, `
*Bot Statistics*
Users: ${totalUsers}
Wallets: ${totalWallets}
Transactions: ${totalTransactions}
      `.trim(), { parse_mode: 'Markdown' });
      break;
    case '/broadcast':
      const message = args.join(' ');
      if (message) {
        const users = await User.find({ isBanned: false });
        let sent = 0;
        for (const user of users) {
          try {
            await bot.sendMessage(user.telegramId, message, { parse_mode: 'Markdown' });
            sent++;
          } catch {}
        }
        await bot.sendMessage(chatId, `Broadcast sent to ${sent} users.`);
      }
      break;
  }
}

// ============================================================================
// MAIN BOT INITIALIZATION
// ============================================================================

async function startBot() {
  console.log('Starting GrokiniHotBot...');
  
  if (!config.telegram.token) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  if (!config.mongodb.uri) {
    console.error('ERROR: MONGODB_URI is required');
    process.exit(1);
  }

  if (!config.encryption.key) {
    console.error('ERROR: ENCRYPTION_KEY is required');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  try {
    await mongoose.connect(config.mongodb.uri);
    console.log('Connected to MongoDB successfully!');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }

  const bot = new TelegramBot(config.telegram.token, { polling: true });
  console.log('GrokiniHotBot is running!');

  bot.onText(/\/start/, (msg) => handleStart(bot, msg));
  bot.onText(/\/buy/, (msg) => handleBuy(bot, msg.chat.id, msg.from.id.toString()));
  bot.onText(/\/sell/, (msg) => handleSell(bot, msg.chat.id, msg.from.id.toString()));
  bot.onText(/\/wallet/, (msg) => handleWallets(bot, msg.chat.id, msg.from.id.toString()));
  bot.onText(/\/settings/, (msg) => handleSettings(bot, msg.chat.id, msg.from.id.toString()));
  bot.onText(/\/help/, (msg) => handleHelp(bot, msg.chat.id));
  
  bot.onText(/^\/(ban|unban|stats|broadcast)/, (msg) => handleAdminCommand(bot, msg));

  bot.on('callback_query', (query) => handleCallback(bot, query));

  bot.on('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
      handleMessage(bot, msg);
    }
  });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    bot.stopPolling();
    await mongoose.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startBot().catch((error) => {
  console.error('Bot startup error:', error);
  process.exit(1);
});