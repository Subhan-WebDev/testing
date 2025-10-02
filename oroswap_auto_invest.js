// oroswap_auto_invest.js — Factory-WS listener → auto-invest 100 ZIG per CSV wallet when pool ZIG ≥ 5000
"use strict";

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { CosmWasmClient, SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { DirectSecp256k1Wallet } = require("@cosmjs/proto-signing");
const { coins } = require("@cosmjs/stargate");

/* =========================
   CONFIG
   ========================= */
const CONFIG = {
  // Endpoints
  RPC_HTTP: "https://zigchain-mainnet-rpc-sanatry-01.wickhub.cc/",
  RPC_WS:   "wss://zigchain-mainnet-rpc-sanatry-01.wickhub.cc/websocket",

  // Oroswap Factory (listen to its txs)
  FACTORY_CONTRACT: "zig17a7mlm84taqmd3enrpcxhrwzclj9pga8efz83vrswnnywr8tv26s7mpq30",

  // Chain info
  BECH32_PREFIX: "zig",
  ZIG_DENOM: "uzig",

  // Liquidity gate: require ≥ 5000 ZIG in pool before investing
  MIN_POOL_ZIG: "10000", // human ZIG

  // Investment
  INVEST_ZIG: "1000", // per wallet
  MAX_SPREAD: "0.50", // 50% slippage ceiling

  // Fees (choose one mode)
  GAS_LIMIT: "350000",
  GAS_PRICE_UZIG: 120,        // uzig per gas (priority mode). Set null/"" to use flat fee below.
  FLAT_FEE_UZIG: "25000",     // used only if GAS_PRICE_UZIG is null/empty

  // CSV
  WALLETS_CSV: path.join(process.cwd(), "oroswap_wallets.csv"), // header must include: privateKey
  CSV_PK_HEADERS: ["privatekey", "private_key"],

  // Behavior
  SNIPE_ONCE_PER_PAIR: true,
  POOL_POLL_MS: 250,
  MAX_WAIT_SEC_FOR_RESERVES: 120, // a bit more time for 5k threshold
  LOG_POLL_EVERY: 1,
};

const ONE_ZIG = 1_000_000n;
const SUB_ID = "sub-factory";

/* =========================
   Helpers
   ========================= */
function now() { return new Date().toISOString().replace("T", " ").replace("Z", ""); }
function log(...a) { console.log(`[${now()}]`, ...a); }
function warn(...a) { console.warn(`[${now()}] ⚠️`, ...a); }
function err(...a) { console.error(`[${now()}] ❌`, ...a); }
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function zigToUzigBI(zigStr){
  let s = String(zigStr || "").trim();
  if (!s) return 0n;
  if (s.startsWith(".")) s = "0" + s;
  const [iRaw, fRaw = ""] = s.split(".");
  const i = BigInt((iRaw || "0").replace(/^0+/, "") || "0");
  const f = BigInt((fRaw || "").padEnd(6, "0").slice(0, 6) || "0");
  return i * ONE_ZIG + f;
}
function uzigToZig(bi){
  const i = bi / ONE_ZIG;
  const f = bi % ONE_ZIG;
  return `${i}.${f.toString().padStart(6, "0")}`.replace(/\.?0+$/, "");
}

function parseCsv(content){
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const pkIdx = header.findIndex(h => CONFIG.CSV_PK_HEADERS.includes(h));
  if (pkIdx === -1) throw new Error(`CSV missing one of headers: ${CONFIG.CSV_PK_HEADERS.join(", ")}`);
  const rows = [];
  for (let i = 1; i < lines.length; i++){
    const cols = lines[i].split(",").map(x => x.trim());
    const pk = cols[pkIdx];
    if (!pk) { warn(`row ${i}: empty privateKey — skipped`); continue; }
    rows.push({ row: i, privateKeyHex: pk.replace(/^0x/i, "") });
  }
  return rows;
}

function loadWallets(csvPath){
  log(`Loading CSV: ${csvPath}`);
  if (!fs.existsSync(csvPath)) throw new Error("wallets.csv not found");
  const txt = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(txt);
  log(`Loaded ${rows.length} wallet(s).`);
  return rows;
}

// Extract pair addresses from WS result (factory-filtered subscription)
function extractPairs(msg) {
  const out = new Set();

  // 1) Map-style events
  const m = msg?.result?.events;
  if (m && typeof m === "object") {
    const a = m["wasm.pair_address"] || [];
    const b = m["wasm.pair_contract_addr"] || [];
    a.concat(b).forEach(p => p && out.add(String(p)));
  }

  // 2) ABCI events
  const evs =
    msg?.result?.data?.value?.TxResult?.result?.events ||
    msg?.result?.data?.txResult?.result?.events ||
    [];
  if (Array.isArray(evs)) {
    for (const ev of evs) {
      if (!ev?.type || !Array.isArray(ev.attributes)) continue;
      for (const { key, value } of ev.attributes.map(a => ({ key: String(a.key ?? ""), value: String(a.value ?? "") }))) {
        if (key === "pair_address" || key === "pair_contract_addr") out.add(String(value));
      }
    }
  }
  return [...out];
}

async function queryPool(qc, pair){
  try { return await qc.queryContractSmart(pair, { pool: {} }); }
  catch { return null; }
}

async function waitForLiquidity(pair, qc, minZigBI){
  const deadline = Date.now() + CONFIG.MAX_WAIT_SEC_FOR_RESERVES * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const pool = await queryPool(qc, pair);
    if (pool?.assets?.length === 2) {
      let zig = null, other = null;
      for (const a of pool.assets) {
        const denom = a?.info?.native_token?.denom;
        if (denom === CONFIG.ZIG_DENOM) zig = a; else other = a;
      }
      if (!zig) zig = pool.assets.find(a => a?.info?.native_token?.denom === CONFIG.ZIG_DENOM);
      if (!other) other = pool.assets.find(a => a !== zig);

      const Rx = BigInt(zig?.amount || "0");
      const Ry = BigInt(other?.amount || "0");

      if (attempt % CONFIG.LOG_POLL_EVERY === 0) {
        log(`pool poll#${attempt}: ZIG=${uzigToZig(Rx)} | other=${Ry.toString()}`);
      }
      if (Rx >= minZigBI && Ry > 0n) {
        const spot = Number(Ry) / Number(Rx || 1n);
        log(`Liquidity gate passed (ZIG ≥ ${uzigToZig(minZigBI)}). Spot≈${spot.toFixed(6)}`);
        return { pool, Rx, Ry };
      }
    } else {
      if (attempt % CONFIG.LOG_POLL_EVERY === 0) log(`pool poll#${attempt}: not ready`);
    }
    await sleep(CONFIG.POOL_POLL_MS);
  }
  throw new Error(`Timeout: pool ZIG never reached ${uzigToZig(minZigBI)} within ${CONFIG.MAX_WAIT_SEC_FOR_RESERVES}s`);
}

function makeFee() {
  if (CONFIG.GAS_PRICE_UZIG !== null && CONFIG.GAS_PRICE_UZIG !== "" && Number(CONFIG.GAS_PRICE_UZIG) > 0) {
    const amount = BigInt(CONFIG.GAS_PRICE_UZIG) * BigInt(CONFIG.GAS_LIMIT);
    return { amount: coins(amount.toString(), CONFIG.ZIG_DENOM), gas: CONFIG.GAS_LIMIT };
  }
  const flat = CONFIG.FLAT_FEE_UZIG || "25000";
  return { amount: coins(flat, CONFIG.ZIG_DENOM), gas: CONFIG.GAS_LIMIT };
}

async function sendSwap100Zig(pair, pkHex, askInfo) {
  const signer = await DirectSecp256k1Wallet.fromKey(Buffer.from(pkHex, "hex"), CONFIG.BECH32_PREFIX);
  const [account] = await signer.getAccounts();
  const sender = account.address;

  const amountBI = zigToUzigBI(CONFIG.INVEST_ZIG);
  const fee = makeFee();
  const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.RPC_HTTP, signer);

  const msg = {
    swap: {
      offer_asset: { info: { native_token: { denom: CONFIG.ZIG_DENOM } }, amount: amountBI.toString() },
      max_spread: CONFIG.MAX_SPREAD,
      ...(askInfo ? { ask_asset_info: askInfo } : {}),
    },
  };

  const res = await client.execute(
    sender,
    pair,
    msg,
    fee,
    undefined,
    [{ denom: CONFIG.ZIG_DENOM, amount: amountBI.toString() }]
  );
  log(`✅ ${sender} invested ${CONFIG.INVEST_ZIG} ZIG | tx=${res?.transactionHash || "?"} height=${res?.height}`);
}

async function getAskAssetInfo(qc, pair) {
  try {
    const pool = await qc.queryContractSmart(pair, { pool: {} });
    const other = pool.assets.find(a => a?.info?.native_token?.denom !== CONFIG.ZIG_DENOM);
    return other?.info;
  } catch {
    return undefined;
  }
}

/* =========================
   Main WS flow
   ========================= */
const processedPairs = new Set();
let qcShared = null;
let wallets = [];

async function handleNewPair(pair){
  if (CONFIG.SNIPE_ONCE_PER_PAIR && processedPairs.has(pair)) {
    log(`Skip already processed ${pair}`);
    return;
  }
  processedPairs.add(pair);

  try {
    if (!qcShared) qcShared = await CosmWasmClient.connect(CONFIG.RPC_HTTP);

    const minBI = zigToUzigBI(CONFIG.MIN_POOL_ZIG);
    log(`Pair detected: ${pair} → waiting for ZIG ≥ ${CONFIG.MIN_POOL_ZIG}`);
    await waitForLiquidity(pair, qcShared, minBI);

    const askInfo = await getAskAssetInfo(qcShared, pair);

    // Fire each wallet sequentially (safe) — change to Promise.all for full parallel
    for (const w of wallets) {
      try { await sendSwap100Zig(pair, w.privateKeyHex, askInfo); }
      catch (e) { err(`Wallet row#${w.row}: ${e?.message || e}`); }
    }

    log(`All wallets invested for pair ${pair}.`);
  } catch (e) {
    err(`Pair ${pair} flow error: ${e?.message || e}`);
  }
}

function subscribeQuery(){
  return `tm.event='Tx' AND wasm._contract_address='${CONFIG.FACTORY_CONTRACT}'`;
}

function startWs(){
  let ws, pingInt;
  const connect = () => {
    log(`Connecting WS: ${CONFIG.WS_URL}`);
    ws = new WebSocket(CONFIG.WS_URL);

    ws.on("open", () => {
      const query = subscribeQuery();
      log(`WS open → subscribe: ${query}`);
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "subscribe", id: SUB_ID, params: { query } }));
      pingInt = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 25000);
    });

    ws.on("pong", () => log("WS pong"));

    ws.on("message", async (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

      // ACK
      if (msg?.id === SUB_ID && msg?.result?.query && !msg?.result?.events) {
        log("✅ subscribed");
        return;
      }

      if (!msg?.result) return;
      const pairs = extractPairs(msg);
      if (!pairs.length) return;
      for (const p of pairs) handleNewPair(p);
    });

    ws.on("error", (e) => err("WS error:", e?.message || e));
    ws.on("close", (code) => {
      warn(`WS closed code=${code}; reconnect 3s`);
      clearInterval(pingInt);
      setTimeout(connect, 3000);
    });
  };
  connect();
}

/* =========================
   Boot
   ========================= */
(async function main(){
  try {
    wallets = loadWallets(CONFIG.WALLETS_CSV);
    if (!wallets.length) throw new Error("No wallets in CSV");
    log(`Config: RPC=${CONFIG.RPC_HTTP} | WS=${CONFIG.WS_URL} | Factory=${CONFIG.FACTORY_CONTRACT}`);
    log(`Gate: ZIG ≥ ${CONFIG.MIN_POOL_ZIG} | Invest per wallet: ${CONFIG.INVEST_ZIG} ZIG`);
    startWs();
  } catch (e) {
    err(e?.message || e);
    process.exit(1);
  }
})();

process.on("unhandledRejection", (e) => err("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => err("uncaughtException:", e?.message || e));
