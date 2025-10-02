// singlesnipe_multi.js — WS-triggered multi-wallet sniper with batching
"use strict";

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { CosmWasmClient, SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { DirectSecp256k1Wallet } = require("@cosmjs/proto-signing");
const { coins } = require("@cosmjs/stargate");

/* =========================
   CONFIG — tune as needed
   ========================= */
const CONFIG = {
  // Endpoints
  RPC_HTTP: "https://zigchain-mainnet-rpc-sanatry-01.wickhub.cc/",
  RPC_WS:   "wss://zigchain-mainnet-rpc-sanatry-01.wickhub.cc/websocket",

  // Factory (WS watch)
  FACTORY_CONTRACT: "zig1armcr7lme0ac3l59dx6ne3et3pe9mfyv57d8pc9m5tyxtzm64dpqlgjvp7",

  // Chain
  BECH32_PREFIX: "zig",
  ZIG_DENOM: "uzig",

  // Pool readiness
  MAX_WAIT_SEC_FOR_RESERVES: 60,
  POOL_POLL_MS: 250,
  LOG_POLL_EVERY: 1,
  MIN_POOL_ZIG: 1_000_000n, // ≥1 ZIG (in uzig)

  // Slippage
  MAX_SPREAD: "0.50",       // e.g. "0.50" (50%)

  // Fallback sizing (per wallet)
  STEP_DECREASE_ZIG: 500n,  // decrease 500 ZIG each failure
  FINAL_ATTEMPT_ZIG: 100n,  // last try at 100 ZIG (if starting ≥ 100)

  // Gas / fee
  GAS_LIMIT: "350000",
  GAS_PRICE_UZIG: 120,      // uzig per gas (priority). Set null to use FLAT_FEE_UZIG
  // FLAT_FEE_UZIG: null,      // e.g., "25000" to force flat fee when GAS_PRICE_UZIG=null
  FEE_UZIG : '1000000',

  // CSV (now: multi-wallet)
  WALLETS_CSV: path.join(process.cwd(), "wallets.csv"),
  DEFAULT_AMOUNT_ZIG: null, // optional: if CSV row missing amount, use this (e.g., "50")

  // De-dupe
  SNIPE_ONCE_PER_PAIR: true, // run once per new pair

  // === NEW: Batching ===
  // How many wallets to fire in parallel at a time
  WALLETS_PER_BATCH: 15,          // e.g., 10 wallets concurrently
  // Delay between batches (ms) — set to e.g. 2 * 60 * 1000 for 2 minutes
  DELAY_BETWEEN_BATCHES_MS: 3000,
};

const SUB_ID = "sub-pair-created";

/* =========================
   Logging helpers
   ========================= */
function now(){ return new Date().toISOString().replace("T"," ").replace("Z",""); }
function log(...a){ console.log(`[${now()}]`, ...a); }
function warn(...a){ console.warn(`[${now()}] ⚠️`, ...a); }
function err(...a){ console.error(`[${now()}] ❌`, ...a); }
function maskCenter(s, show=6){ if(!s) return ""; const str=String(s); return str.length<=show*2? "*".repeat(Math.max(0,str.length-show))+str.slice(-show) : str.slice(0,show)+"…"+str.slice(-show); }
function safeStringify(obj){ return JSON.stringify(obj, (k,v)=> typeof v==="bigint" ? v.toString() : v, 2); }
function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }

/* =========================
   Amount utils
   ========================= */
const ONE_ZIG = 1_000_000n; // 1 ZIG = 1e6 uzig

function zigToUzigBI(zigStr){
  let s = String(zigStr||"").trim();
  if (!s) return 0n;
  if (s.startsWith(".")) s = "0"+s;
  const [iRaw, fRaw=""] = s.split(".");
  const i = BigInt((iRaw||"0").replace(/^0+/,"") || "0");
  const f = BigInt((fRaw||"").padEnd(6,"0").slice(0,6) || "0");
  return i*ONE_ZIG + f;
}
function uzigToZig(amountBI){
  const i = amountBI / ONE_ZIG;
  const f = amountBI % ONE_ZIG;
  return `${i}.${f.toString().padStart(6,"0")}`.replace(/\.?0+$/,"");
}

/* =========================
   CSV (multi-wallet loader)
   ========================= */
function parseCsvLine(line){
  // simple CSV split; if you need quotes/escapes later, swap for a proper CSV parser
  return line.split(",").map(s=>s.trim());
}

function loadWallets(csvPath){
  log(`CSV: reading ${csvPath}`);
  if (!fs.existsSync(csvPath)) { err("CSV not found."); return []; }
  const raw = fs.readFileSync(csvPath, "utf8");
  if (!raw.trim()) { err("CSV empty."); return []; }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  log(`CSV lines (incl header): ${lines.length}`);
  if (lines.length < 2){ err("CSV has header only."); return []; }

  const header = parseCsvLine(lines[0]).map(s=>s.toLowerCase());
  log("CSV header:", header);

  const pkIdx  = header.findIndex(h=>h==="privatekey"||h==="private_key");
  const amtIdx = header.findIndex(h=>["amount","zig","buyzig","buyuzig","buyamountzig"].includes(h));
  if (pkIdx===-1){ err("CSV missing 'privateKey' column."); return []; }

  const wallets = [];
  for (let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const pk = cols[pkIdx];
    const amtStr = (amtIdx>=0 ? cols[amtIdx] : null) || CONFIG.DEFAULT_AMOUNT_ZIG;
    if (!pk){
      warn(`Row ${i}: missing private key — skipped`);
      continue;
    }
    if (!amtStr){
      warn(`Row ${i}: missing amount and DEFAULT_AMOUNT_ZIG not set — skipped`);
      continue;
    }
    const uzig = zigToUzigBI(amtStr);
    if (uzig<=0n){
      warn(`Row ${i}: non-positive amount "${amtStr}" — skipped`);
      continue;
    }
    wallets.push({ row:i, privateKeyHex: pk, amountZig: amtStr, amountUzig: uzig });
  }

  if (!wallets.length) err("No valid wallet rows found in CSV.");
  else log(`Loaded ${wallets.length} wallet(s).`);
  return wallets;
}

/* =========================
   WS event extraction (unchanged)
   ========================= */
function extractFromEventsMap(evMap) {
  const out = new Set();

  const fromFactory =
    (evMap["wasm._contract_address"]||[]).some(v=>String(v)===CONFIG.FACTORY_CONTRACT) ||
    (evMap["execute._contract_address"]||[]).some(v=>String(v)===CONFIG.FACTORY_CONTRACT) ||
    (evMap["reply._contract_address"]||[]).some(v=>String(v)===CONFIG.FACTORY_CONTRACT);

  const actions = (evMap["wasm.action"]||evMap["wasm.action\u0000"]||[]).map(v=>String(v).toLowerCase());
  const isCreate = actions.includes("create_pair") || actions.includes("pair_created");

  const pairsA = evMap["wasm.pair_address"] || [];
  const pairsB = evMap["wasm.pair_contract_addr"] || [];
  pairsA.concat(pairsB).forEach(p=>out.add(String(p)));

  if (out.size===0 && fromFactory && (isCreate || (evMap["wasm.pair_type"]||[]).length || (evMap["wasm.lp_denom"]||[]).length)) {
    const inst = evMap["instantiate._contract_address"] || [];
    inst.forEach(a=>out.add(String(a)));
  }

  log(`Map-path summary: fromFactory=${fromFactory} isCreate=${isCreate} pairsFound=${out.size}`);
  return [...out];
}
function extractFromAbciEvents(events) {
  const out = new Set();
  let factorySeen=false, isCreate=false;
  const instAddrs=new Set();

  for (const ev of (events||[])) {
    if (!ev?.type || !Array.isArray(ev.attributes)) continue;
    const attrs = ev.attributes.map(a=>({key:String(a.key??""), value:String(a.value??"")}));
    if (ev.type==="wasm"){
      for (const {key,value} of attrs){
        if (key==="_contract_address" && value===CONFIG.FACTORY_CONTRACT) factorySeen=true;
        if (key==="action"){ const v=String(value).toLowerCase(); if (v==="create_pair"||v==="pair_created") isCreate=true; }
        if (key==="pair_address"||key==="pair_contract_addr"){ out.add(String(value)); }
      }
    }
    if (ev.type==="instantiate"){
      for (const {key,value} of attrs){ if (key==="_contract_address" && value) instAddrs.add(String(value)); }
    }
  }
  if (out.size===0 && factorySeen && isCreate) instAddrs.forEach(a=>out.add(a));
  log(`ABCI-path summary: factorySeen=${factorySeen} isCreate=${isCreate} pairsFound=${out.size}`);
  return [...out];
}
function extractPairAddressesFromWsResult(msg){
  const found = new Set();
  const evMap = msg?.result?.events;
  if (evMap && typeof evMap==="object"){
    log(`WS result.events keys: ${Object.keys(evMap).join(", ")}`);
    extractFromEventsMap(evMap).forEach(p=>found.add(p));
  }
  const abci = msg?.result?.data?.value?.TxResult?.result?.events || msg?.result?.data?.txResult?.result?.events || [];
  if (Array.isArray(abci)) {
    log(`WS ABCI events length: ${abci.length}`);
    extractFromAbciEvents(abci).forEach(p=>found.add(p));
  }
  const arr=[...found];
  if (arr.length) log(`Extracted pair_address(es): ${arr.join(", ")}`);
  return arr;
}

/* =========================
   Pool readiness (unchanged)
   ========================= */
async function queryPool(qc, pair){
  try { return await qc.queryContractSmart(pair, { pool:{} }); }
  catch(e){ return null; }
}
async function waitForNonZeroReserves(pair){
  log(`Connecting CosmWasmClient: ${CONFIG.RPC_HTTP}`);
  const qc = await CosmWasmClient.connect(CONFIG.RPC_HTTP);
  const deadline = Date.now() + CONFIG.MAX_WAIT_SEC_FOR_RESERVES*1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const pool = await queryPool(qc, pair);
    if (pool?.assets?.length === 2) {
      let zig=null, other=null;
      for (const a of pool.assets){
        const denom=a?.info?.native_token?.denom;
        if (denom===CONFIG.ZIG_DENOM) zig=a; else other=a;
      }
      if (!zig || !other){
        for (const a of pool.assets) if (a?.info?.native_token?.denom===CONFIG.ZIG_DENOM) zig=a;
        other = pool.assets.find(x=>x!==zig);
      }
      const Rx = BigInt(zig?.amount||"0");
      const Ry = BigInt(other?.amount||"0");

      if (attempt % CONFIG.LOG_POLL_EVERY === 0) {
        log(`poll#${attempt}: zig=${Rx.toString()} other=${Ry.toString()} total_share=${pool.total_share}`);
      }
      if (Rx >= CONFIG.MIN_POOL_ZIG && Ry > 0n){
        const spot = Number(Ry)/Number(Rx);
        log(`Reserves ready. spot≈${spot}`);
        return { qc, Rx, Ry, pool };
      }
    } else {
      if (attempt % CONFIG.LOG_POLL_EVERY === 0) log(`poll#${attempt}: pool not ready; retry in ${CONFIG.POOL_POLL_MS}ms`);
    }
    await sleep(CONFIG.POOL_POLL_MS);
  }
  throw new Error(`Timeout: no usable reserves within ${CONFIG.MAX_WAIT_SEC_FOR_RESERVES}s`);
}

/* =========================
   Swap helpers (unchanged core)
   ========================= */
function makeFee(){
  if (CONFIG.GAS_PRICE_UZIG && Number(CONFIG.GAS_PRICE_UZIG)>0){
    const amount = (BigInt(CONFIG.GAS_PRICE_UZIG) * BigInt(CONFIG.GAS_LIMIT));
    return { amount: coins(amount.toString(), CONFIG.ZIG_DENOM), gas: CONFIG.GAS_LIMIT };
  }
  const flat = CONFIG.FLAT_FEE_UZIG || "25000";
  return { amount: coins(flat, CONFIG.ZIG_DENOM), gas: CONFIG.GAS_LIMIT };
}
async function getAskAssetInfo(qc, pair){
  try{
    const pool = await qc.queryContractSmart(pair, { pool:{} });
    const other = pool.assets.find(a => a?.info?.native_token?.denom !== CONFIG.ZIG_DENOM);
    return other?.info; // {native_token:{denom}} or {token:{contract_addr}}
  }catch{ return undefined; }
}
function makeSigner(pkHex){
  const clean = pkHex.replace(/^0x/i,"");
  return DirectSecp256k1Wallet.fromKey(Buffer.from(clean,"hex"), CONFIG.BECH32_PREFIX);
}
async function sendSwapOnce(pair, signer, sender, offerUzigBI, askInfo){
  // const fee = makeFee();
  const fee = { amount: coins(String(CONFIG.FEE_UZIG), CONFIG.ZIG_DENOM), gas: String(CONFIG.GAS_LIMIT) };
  const client = await SigningCosmWasmClient.connectWithSigner(CONFIG.RPC_HTTP, signer);

  const msg = {
    swap: {
      offer_asset: {
        info: { native_token: { denom: CONFIG.ZIG_DENOM } },
        amount: offerUzigBI.toString(),
      },
      // Omit belief_price; rely on max_spread only
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
    [{ denom: CONFIG.ZIG_DENOM, amount: offerUzigBI.toString() }]
  );
  return res;
}
async function tryExactThenFallbacks(pair, signer, sender, startAmountBI, askInfo){
  // exact → then −500 ZIG per fail → final 100 ZIG (if starting ≥100)
  const stepBI = CONFIG.STEP_DECREASE_ZIG * ONE_ZIG;
  const finalBI = CONFIG.FINAL_ATTEMPT_ZIG * ONE_ZIG;
  const minFinal = startAmountBI >= finalBI ? finalBI : startAmountBI;

  let current = startAmountBI;
  let attempt = 0;

  while (true) {
    attempt++;
    log(`Attempt #${attempt}: amount=${current.toString()} uzig (~${uzigToZig(current)} ZIG), max_spread=${CONFIG.MAX_SPREAD}`);

    try{
      const res = await sendSwapOnce(pair, signer, sender, current, askInfo);
      log(`✅ TX success tx=${res?.transactionHash||"?"} height=${res?.height}`);
      return true;
    }catch(e){
      const m = String(e?.message||e);
      err(`Swap failed: ${m}`);
      // choose next size
      if (current > minFinal + stepBI) {
        current -= stepBI;
        continue;
      }
      if (current !== minFinal) {
        log(`Falling back to final size: ${minFinal.toString()} uzig (~${uzigToZig(minFinal)} ZIG)`);
        current = minFinal;
        continue;
      }
      warn("All fallback attempts exhausted.");
      return false;
    }
  }
}

/* =========================
   Orchestration — MULTI wallet
   ========================= */
async function snipeOneWallet(pair, qc, w, askInfo){
  try{
    const signer = await makeSigner(w.privateKeyHex);
    const [account] = await signer.getAccounts();
    const sender = account.address;
    log(`→ Wallet row#${w.row} addr=${sender} | amount=${w.amountUzig.toString()} uzig (~${w.amountZig} ZIG)`);

    const ok = await tryExactThenFallbacks(pair, signer, sender, w.amountUzig, askInfo);
    if (!ok) warn(`row#${w.row} ${sender}: final status NOT executed`);
    else log(`row#${w.row} ${sender}: ✅ done`);
  }catch(e){
    err(`row#${w.row} snipe error: ${e?.message||e}`);
  }
}

async function runBatchesForPair(pair, qc, wallets){
  if (!wallets?.length){ warn("No wallets loaded; skipping batches."); return; }

  const askInfo = await getAskAssetInfo(qc, pair);
  if (askInfo) log(`ask_asset_info: ${JSON.stringify(askInfo)}`);

  const batchSize = Math.max(1, Number(CONFIG.WALLETS_PER_BATCH||1));
  const delayMs   = Math.max(0, Number(CONFIG.DELAY_BETWEEN_BATCHES_MS||0));

  log(`Starting batches for ${wallets.length} wallet(s): size=${batchSize}, delay=${delayMs}ms`);

  for (let start=0, batchNo=1; start < wallets.length; start += batchSize, batchNo++){
    const batch = wallets.slice(start, start + batchSize);
    log(`===== BATCH ${batchNo} (${batch.length} wallets) for pair ${pair} =====`);

    // Fire all in parallel for this batch
    await Promise.all(batch.map(w => snipeOneWallet(pair, qc, w, askInfo)));

    if (start + batchSize < wallets.length && delayMs > 0){
      log(`Waiting ${delayMs}ms before next batch…`);
      await sleep(delayMs);
    }
  }

  log(`All batches completed for pair ${pair}.`);
}

/* =========================
   WS client (ACK-safe)
   ========================= */
const processedPairs = new Set();
let cachedWallets = null; // load once, reuse for every pair

function makeQuery(){
  const q = `tm.event='Tx' AND wasm.method='save_migration'`;
  log(`WS subscribe query: ${q}`);
  return q;
}
function startWs(){
  let ws, pingTimer, acked=false;

  const connect = ()=>{
    log(`Connecting WS: ${CONFIG.WS_URL}`);
    ws = new WebSocket(CONFIG.WS_URL);

    ws.on("open", ()=>{
      log("WS connected. Sending subscribe…");
      const sub = { jsonrpc:"2.0", method:"subscribe", id: SUB_ID, params:{ query: makeQuery() } };
      log("Subscribe payload:", JSON.stringify(sub));
      ws.send(JSON.stringify(sub));
      pingTimer = setInterval(()=>{ if (ws.readyState===WebSocket.OPEN){ log("WS ping"); ws.ping(); }}, 25000);
    });

    ws.on("pong", ()=>log("WS pong"));

    ws.on("message", async (data)=>{
      let msg; try{ msg=JSON.parse(data.toString()); }catch{ warn("WS message not JSON"); return; }

      const isAckLike = (msg.id===SUB_ID) && !!msg?.result?.query && !msg?.result?.events && !acked;
      if (isAckLike){ log("✅ Subscribed OK."); acked=true; }

      if (!msg?.result) return;

      log("WS message received; extracting pair_address…");
      const pairs = extractPairAddressesFromWsResult(msg);
      if (!pairs.length){ log("No pair_address here; ignore."); return; }

      if (!cachedWallets){
        cachedWallets = loadWallets(CONFIG.WALLETS_CSV);
        if (!cachedWallets.length){ warn("No wallets loaded; ignoring WS events."); return; }
      }

      for (const pair of pairs){
        if (CONFIG.SNIPE_ONCE_PER_PAIR && processedPairs.has(pair)){ log(`Skip already processed ${pair}`); continue; }
        processedPairs.add(pair);

        (async()=>{
          try{
            const { qc } = await waitForNonZeroReserves(pair);
            await runBatchesForPair(pair, qc, cachedWallets);
          }catch(e){
            err(`Pair ${pair} flow error: ${e?.message||e}`);
          }
        })();
      }
    });

    ws.on("error", e=>err("WS error:", e?.message||e));
    ws.on("close", (code, reason)=>{ 
      warn(`WS closed code=${code} reason=${reason?.toString?.()||""}; reconnecting in 3s`);
      clearInterval(pingTimer);
      setTimeout(connect,3000);
    });
  };

  connect();
}

/* =========================
   Boot
   ========================= */
(async function main(){
  log("=== ZigChain Multi-Wallet Sniper — WS + parallel batches ===");
  log("CONFIG:", safeStringify({
    ...CONFIG,
    FACTORY_CONTRACT: maskCenter(CONFIG.FACTORY_CONTRACT),
    GAS_FEE_MODE: CONFIG.GAS_PRICE_UZIG ? `gasPrice=${CONFIG.GAS_PRICE_UZIG} uzig/gas` : `flatFee=${CONFIG.FLAT_FEE_UZIG||"25000"}`
  }));
  // peek CSV for visibility (does not block)
  loadWallets(CONFIG.WALLETS_CSV);
  startWs();
})();
process.on("unhandledRejection", e=>err("unhandledRejection:", e?.message||e));
process.on("uncaughtException", e=>err("uncaughtException:", e?.message||e));
