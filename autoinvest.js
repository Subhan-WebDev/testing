// watch_deployer_and_invest_500.js
// Node 18+
// Packages: npm i ws csv-parser @cosmjs/proto-signing @cosmjs/cosmwasm-stargate @cosmjs/stargate

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const csv = require("csv-parser");
const { DirectSecp256k1Wallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { GasPrice, coins } = require("@cosmjs/stargate");

// ==========================
// INLINE CONFIG
// ==========================
const CONFIG = {
  // RPC / chain
  RPC_HTTP: "https://zigchain-mainnet-rpc-sanatry-01.wickhub.cc/",
  RPC_WS:   "wss://zigchain-mainnet-rpc-sanatry-01.wickhub.cc/websocket",
  CHAIN_ID: "zigchain-1",
  BECH32_PREFIX: "zig",
  ZIG_DENOM: "uzig",

  // Listen to deployer; token is instantiated in same tx
  DEPLOYER_CONTRACT: "zig1armcr7lme0ac3l59dx6ne3et3pe9mfyv57d8pc9m5tyxtzm64dpqlgjvp7",

  // Buy settings
  BUY_MSG: (slippageBps = 150) => ({ buy_token: { slippage_bps: slippageBps } }),
  INVEST_ZIG: 500,
  GAS_PRICE: "0.05uzig",
  GAS_LIMIT: 600000,
  FEE_UZIG: 2000000, // fee amount in uzig

  // Files
  TOKENS_JSON: path.resolve(__dirname, "tokens.json"),
  WALLETS_CSV: path.resolve(__dirname, "wallets_watch.csv"),

  // WS reconnect
  RECONNECT_DELAY_MS: 3000,
};

// ==========================
// Helpers
// ==========================
const zigToUzig = (zig) => Math.round(Number(zig) * 1_000_000);

// atomic save to avoid partial JSON
function saveTokens(map) {
  const tmp = CONFIG.TOKENS_JSON + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, CONFIG.TOKENS_JSON);
}
function ensureTokensFile() {
  if (!fs.existsSync(CONFIG.TOKENS_JSON)) fs.writeFileSync(CONFIG.TOKENS_JSON, "{}");
}
function loadTokens(maxRetries = 3) {
  ensureTokensFile();
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const raw = fs.readFileSync(CONFIG.TOKENS_JSON, "utf8").trim();
      if (!raw) return {};
      return JSON.parse(raw);
    } catch (e) {
      if (i === maxRetries) {
        console.warn(`[watch] tokens.json unreadable; resetting. (${e.message})`);
        saveTokens({});
        return {};
      }
      // tiny sleep before retry
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return {};
}

async function readFirstPrivateKey(csvPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(csvPath)) return reject(new Error(`CSV not found: ${csvPath}`));
    let resolved = false;
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on("data", (row) => {
        if (resolved) return;
        const pk = (row.private_key || row.key || row.pk || "").trim();
        if (!pk) return;
        resolved = true;
        resolve(pk.startsWith("0x") ? pk.slice(2) : pk);
      })
      .on("end", () => {
        if (!resolved) reject(new Error("CSV empty or missing 'private_key' in first row"));
      })
      .on("error", reject);
  });
}

async function makeSigningClient(privateKeyHex) {
  const wallet = await DirectSecp256k1Wallet.fromKey(Buffer.from(privateKeyHex, "hex"), CONFIG.BECH32_PREFIX);
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.RPC_HTTP, wallet, {
    prefix: CONFIG.BECH32_PREFIX,
    gasPrice: GasPrice.fromString(CONFIG.GAS_PRICE),
  });
  return { client, address: account.address };
}

async function execBuyOnce(client, sender, tokenAddr, amountZig) {
  const funds = coins(String(zigToUzig(amountZig)), CONFIG.ZIG_DENOM);
  const fee = { amount: coins(String(CONFIG.FEE_UZIG), CONFIG.ZIG_DENOM), gas: String(CONFIG.GAS_LIMIT) };
  return await client.execute(sender, tokenAddr, CONFIG.BUY_MSG(150), fee, undefined, funds);
}

// Retry helper for sequence mismatches
async function execBuyWithRetry(client, sender, tokenAddr, amountZig, maxRetries = 5) {
  let attempt = 0;
  let delay = 800; // ms
  for (;;) {
    try {
      return await execBuyOnce(client, sender, tokenAddr, amountZig);
    } catch (e) {
      const msg = e?.message || String(e);
      const isSeq = /account sequence mismatch/i.test(msg) || /code 32/i.test(msg);
      if (!isSeq || attempt >= maxRetries) throw e;
      attempt++;
      // Exponential backoff; give previous tx time to commit so sequence advances
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.6, 5000);
    }
  }
}

// Robust WS message parse (handles empty/newline-batched frames)
function handleWsFrames(raw, cb) {
  const s = raw?.toString?.() ?? "";
  if (!s.trim()) return;
  const parts = s.split(/\n+/).filter(Boolean);
  for (const part of parts) {
    try { cb(JSON.parse(part)); } catch {}
  }
}

// Try several event shapes to recover the new token contract
function extractNewContractFromWsEvent(json) {
  // Newer CometBFT: events as a map
  if (json?.result?.events) {
    const evmap = json.result.events;
    for (const k of ["instantiate._contract_address","wasm._contract_address","_contract_address","contract_address"]) {
      const vals = evmap[k];
      if (Array.isArray(vals)) for (const v of vals) if (v && v !== CONFIG.DEPLOYER_CONTRACT) return v;
    }
  }
  // Legacy: events as array
  const events = json?.result?.data?.value?.TxResult?.result?.events || [];
  for (const ev of events) {
    for (const a of (ev.attributes || [])) {
      const key = String(a.key||""); const val = String(a.value||"");
      if (["wasm._contract_address","_contract_address","contract_address"].includes(key) && val && val !== CONFIG.DEPLOYER_CONTRACT) {
        return val;
      }
    }
  }
  return null;
}

// ==========================
// QUEUE: serialize broadcasts
// ==========================
const buyQueue = [];
const enqueued = new Set(); // dedupe enqueues
let processing = false;

function enqueueBuy(tokenAddr) {
  if (enqueued.has(tokenAddr)) return;
  enqueued.add(tokenAddr);
  buyQueue.push(tokenAddr);
}

async function processQueue(client, address) {
  if (processing) return;
  processing = true;
  try {
    while (buyQueue.length) {
      const tokenAddr = buyQueue.shift();
      try {
        // double-check tokens.json (maybe marked by a previous run)
        const map = loadTokens();
        if (map[tokenAddr]?.invested500) {
          console.log(`[watch][queue] already invested for ${tokenAddr}, skipping`);
          continue;
        }

        console.log(`[watch][queue] investing ${CONFIG.INVEST_ZIG} ZIG into ${tokenAddr}…`);
        const res = await execBuyWithRetry(client, address, tokenAddr, CONFIG.INVEST_ZIG);
        console.log("[watch][queue] tx hash:", res?.transactionHash || "(unknown)");

        const map2 = loadTokens();
        if (!map2[tokenAddr]) map2[tokenAddr] = {};
        map2[tokenAddr].invested500 = true;
        map2[tokenAddr].invested500At = new Date().toISOString();
        saveTokens(map2);
      } catch (e) {
        console.error(`[watch][queue] buy failed for ${tokenAddr}:`, e?.message || e);
        // allow future attempts: remove from enqueued so it can be re-enqueued on next event if desired
        enqueued.delete(tokenAddr);
      }
      // small gap between txs helps mempool ordering
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    processing = false;
  }
}

// ==========================
// Main
// ==========================
async function main() {
  console.log("[watch] starting…");
  ensureTokensFile();

  const pk = await readFirstPrivateKey(CONFIG.WALLETS_CSV);
  const { client, address } = await makeSigningClient(pk);
  console.log("[watch] using wallet:", address);

  let ws;
  const connect = () => {
    ws = new WebSocket(CONFIG.RPC_WS);

    ws.on("open", () => {
      console.log("[ws] connected");
      const query = `tm.event='Tx' AND wasm._contract_address='${CONFIG.DEPLOYER_CONTRACT}'`;
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "subscribe", id: `sub-${Date.now()}`, params: { query } }));
    });

    ws.on("message", async (data) => {
      handleWsFrames(data, (msg) => {
        // subscription ack
        if (msg?.result && !msg.result.events && !msg?.result?.data) {
          console.log("[ws] ✅ subscribed (ack). Waiting for tx events…");
          return;
        }
        const tokenAddr = extractNewContractFromWsEvent(msg);
        if (!tokenAddr) return;

        // ensure it’s tracked in tokens.json
        const map = loadTokens();
        if (!map[tokenAddr]) {
          map[tokenAddr] = { createdAt: new Date().toISOString(), invested500: false, invested1000: false };
          saveTokens(map);
        }
        if (map[tokenAddr].invested500) {
          console.log(`[watch] already invested for ${tokenAddr}, skipping`);
          return;
        }

        // enqueue and start worker
        console.log(`[watch] new token ${tokenAddr} — queued invest ${CONFIG.INVEST_ZIG} ZIG`);
        enqueueBuy(tokenAddr);
        processQueue(client, address);
      });
    });

    ws.on("close", () => {
      console.log("[ws] closed — reconnecting…");
      setTimeout(connect, CONFIG.RECONNECT_DELAY_MS);
    });

    ws.on("error", (err) => {
      console.log("[ws] error:", err?.message || err);
      try { ws.close(); } catch {}
    });
  };

  connect();
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
