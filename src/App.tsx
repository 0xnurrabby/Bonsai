import React, { useEffect, useMemo, useRef, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import { Attribution } from "https://esm.sh/ox/erc8021";

/**
 * Domain: https://bonsai-ashy.vercel.app/
 * Network: Base Mainnet (0x2105)
 * USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 * Game Contract: 0xB331328F506f2D35125e367A190e914B1b6830cF
 */

// ===== Builder code attribution (REQUIRED) =====
const BUILDER_CODE = "bc_z79ttk8w";
const dataSuffix = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

// ===== Contracts =====
// All game actions (plant / water / revive / graft) hit this contract.
const GAME_CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// Tips (USDC) go to your tip wallet ONLY.
const TIP_RECIPIENT = "0x5eC6AF0798b25C563B102d3469971f1a8d598121";

// ===== Chain constants =====
const BASE_MAINNET = "0x2105";
const BASE_SEPOLIA = "0x14a34";
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// ===== Utilities =====
function utf8ToHex(str: string) {
  const enc = new TextEncoder();
  const bytes = enc.encode(str);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function padRightTo32Bytes(hexNoPrefix: string) {
  return hexNoPrefix.padEnd(64, "0");
}

function padLeftTo32Bytes(hexNoPrefix: string) {
  return hexNoPrefix.padStart(64, "0");
}

function strip0x(hex: string) {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/**
 * ABI-encode logAction(bytes32,bytes)
 * selector: 0x2d9bc1fb
 */
function encodeLogAction(action: string, dataHex: string = "0x") {
  const selector = "2d9bc1fb";
  const actionHex = strip0x(utf8ToHex(action));
  const actionWord = padRightTo32Bytes(actionHex); // bytes32("plant") style
  const offsetWord = padLeftTo32Bytes("40"); // 0x40 (64) bytes offset to dynamic bytes arg

  const data = strip0x(dataHex || "0x");
  if (data.length % 2 !== 0) throw new Error("Invalid data hex (odd length).");
  const dataLen = data.length / 2;
  const lenWord = padLeftTo32Bytes(dataLen.toString(16));

  const paddedData = data.padEnd(Math.ceil(dataLen / 32) * 64, "0"); // right-pad to 32-byte boundary
  return "0x" + selector + actionWord + offsetWord + lenWord + paddedData;
}

function isHexPrefixed(s: string) {
  return typeof s === "string" && s.startsWith("0x");
}

function isLikelyAddress(addr: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function nowMs() {
  return Date.now();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function bytes32Pad(hexNo0x: string) {
  return hexNo0x.padStart(64, "0");
}

// Manual ERC-20 transfer encoding
function encodeUsdcTransfer(to: string, amountBaseUnits: bigint) {
  if (!isLikelyAddress(to)) throw new Error("Invalid recipient address.");
  if (amountBaseUnits <= 0n) throw new Error("Amount must be greater than 0.");
  const selector = "a9059cbb";
  const toNo0x = to.toLowerCase().replace(/^0x/, "");
  const toPadded = bytes32Pad(toNo0x);
  const amtHex = amountBaseUnits.toString(16);
  const amtPadded = bytes32Pad(amtHex);
  return "0x" + selector + toPadded + amtPadded;
}

function formatUsdc(amount: number) {
  const fixed = amount < 1 ? amount.toFixed(2) : amount.toFixed(2);
  return fixed.replace(/\.00$/, "");
}

function shortAddr(addr: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}

function hashToUnitFloat(hex: string) {
  const clean = hex.replace(/^0x/, "");
  const chunk = clean.slice(0, 12);
  const n = parseInt(chunk || "0", 16);
  return (n % 1000000) / 1000000;
}

// ===== RPC helpers (public Base RPC) =====
const BASE_RPC = "https://mainnet.base.org";

async function rpc(method: string, params: any[]) {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  if (!res.ok) throw new Error("RPC request failed.");
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

async function getBalanceWei(address: string) {
  const bal = await rpc("eth_getBalance", [address, "latest"]);
  return BigInt(bal);
}

async function getNonce(address: string) {
  const n = await rpc("eth_getTransactionCount", [address, "latest"]);
  return BigInt(n);
}

function weiToEth(wei: bigint) {
  const eth = Number(wei) / 1e18;
  if (!Number.isFinite(eth)) return 0;
  return eth;
}

// ===== Bonsai generative drawing =====
type BonsaiParams = {
  seed: string;
  richness: number; // 0..1 from balance
  activity: number; // 0..1 from nonce
  growth: number; // integer growth stages
  health: number; // 0..1
  breeze: number; // 0..1 oscillation
  friendHue?: number; // optional accent
};

function drawInkStroke(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w: number,
  alpha: number,
  gray: number
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = Math.round(gray);
  ctx.strokeStyle = `rgb(${g},${g},${g})`;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo(
    (x1 + x2) / 2 + (Math.random() - 0.5) * 6,
    (y1 + y2) / 2 + (Math.random() - 0.5) * 6,
    x2,
    y2
  );
  ctx.stroke();
  ctx.restore();
}

function renderBonsai(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: BonsaiParams
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#f5f0e8";
  ctx.fillRect(0, 0, w, h);

  // fiber noise (cheap ink-wash paper feel)
  const imgData = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const n = (Math.random() * 10) | 0;
    imgData.data[i] = clamp(imgData.data[i] + n, 0, 255);
    imgData.data[i + 1] = clamp(imgData.data[i + 1] + n, 0, 255);
    imgData.data[i + 2] = clamp(imgData.data[i + 2] + n, 0, 255);
  }
  ctx.putImageData(imgData, 0, 0);

  const wither = 1 - p.health; // 0..1
  const inkBase = 20 + wither * 90; // greyer when withered

  // pot
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = `rgb(${inkBase},${inkBase},${inkBase})`;
  ctx.lineWidth = 6;
  const potW = w * 0.52;
  const potH = h * 0.12;
  const potX = w * 0.5 - potW / 2;
  const potY = h * 0.8;
  roundRect(ctx, potX, potY, potW, potH, 18);
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(potX + 20, potY + potH * 0.34);
  ctx.lineTo(potX + potW - 20, potY + potH * 0.34);
  ctx.stroke();
  ctx.restore();

  const cx = w * 0.5;
  const baseY = potY + 8;

  // trunk thickness from richness
  const trunkBase = 10 + p.richness * 24;
  const height = h * 0.58;

  // deterministic RNG from address
  const seedUnit = hashToUnitFloat(p.seed);
  let rng = mulberry32(Math.floor(seedUnit * 2 ** 31));
  const sway = (p.breeze - 0.5) * 22; // px
  const bend = sway * (0.55 + p.activity * 0.55);

  const maxDepth = clamp(3 + Math.floor(p.growth / 1.5), 3, 10);
  const leafiness = clamp(0.1 + p.activity * 0.9, 0, 1);
  const bloomChance = clamp(0.04 + p.activity * 0.18, 0.04, 0.25);

  function branch(
    x: number,
    y: number,
    ang: number,
    len: number,
    thick: number,
    depth: number
  ) {
    const t = depth / maxDepth;
    const jitter = (rng() - 0.5) * 0.25;
    const a = ang + jitter;
    const ex = x + Math.cos(a) * len + bend * t * 0.18;
    const ey = y - Math.sin(a) * len;

    const alpha = 0.88 - t * 0.35;
    drawInkStroke(ctx, x, y, ex, ey, thick, alpha, inkBase);

    // leaves / flowers
    if (depth > maxDepth - 3 && rng() < leafiness) {
      const count = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        const lx = ex + (rng() - 0.5) * 16;
        const ly = ey + (rng() - 0.5) * 16;
        drawLeaf(ctx, lx, ly, 3 + rng() * 5, inkBase, wither);
        if (rng() < bloomChance && p.friendHue !== undefined) {
          drawBloom(ctx, lx + 2, ly - 2, 3 + rng() * 4, p.friendHue);
        }
      }
    }

    if (depth >= maxDepth) return;
    const splits = depth < 2 ? 1 : rng() < 0.65 ? 2 : 1;

    for (let i = 0; i < splits; i++) {
      const dir = i === 0 ? -1 : 1;
      const nextAng =
        a + dir * (0.45 + rng() * 0.35) * (0.85 + t * 0.3);
      const nextLen = len * (0.74 + rng() * 0.08);
      const nextThick = Math.max(1.2, thick * (0.7 + rng() * 0.06));
      branch(ex, ey, nextAng, nextLen, nextThick, depth + 1);
    }
    if (rng() < 0.28) {
      const nextAng = a + (rng() - 0.5) * 0.35;
      branch(
        ex,
        ey,
        nextAng,
        len * (0.55 + rng() * 0.12),
        Math.max(1.0, thick * 0.55),
        depth + 1
      );
    }
  }

  // trunk as stacked strokes for ink texture
  const trunkSteps = 10;
  for (let i = 0; i < trunkSteps; i++) {
    const y0 = baseY - (i / trunkSteps) * height;
    const y1 = baseY - ((i + 1) / trunkSteps) * height;
    const x0 = cx + (bend * (i / trunkSteps)) * 0.35;
    const x1 = cx + (bend * ((i + 1) / trunkSteps)) * 0.35;
    const tw = trunkBase * (1 - (i / trunkSteps) * 0.75);
    drawInkStroke(ctx, x0, y0, x1, y1, tw, 0.92, inkBase);
  }

  // start branches
  const startX = cx + bend * 0.16;
  const startY = baseY - height * 0.55;
  const baseLen = 70 + p.growth * 10;

  rng = mulberry32(Math.floor(seedUnit * 2 ** 31)); // reset for stable tree
  branch(startX, startY, Math.PI / 2 - 0.3, baseLen, trunkBase * 0.55, 1);
  branch(
    startX,
    startY,
    Math.PI / 2 + 0.3,
    baseLen * 0.96,
    trunkBase * 0.55,
    1
  );

  // occasional falling leaves (visual only)
  for (let i = 0; i < 3; i++) {
    if (rng() < 0.12) {
      const fx = w * (0.2 + rng() * 0.6);
      const fy = h * (0.25 + rng() * 0.6);
      drawLeaf(ctx, fx, fy, 2.5 + rng() * 3.5, inkBase + 20, wither);
    }
  }

  // subtle vignette
  const grd = ctx.createRadialGradient(cx, h * 0.35, 50, cx, h * 0.35, h);
  grd.addColorStop(0, "rgba(0,0,0,0)");
  grd.addColorStop(1, "rgba(0,0,0,0.06)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  inkBase: number,
  wither: number
) {
  ctx.save();
  ctx.globalAlpha = 0.65 - wither * 0.3;
  const g = Math.round(inkBase + 12 + wither * 35);
  ctx.fillStyle = `rgba(${g},${g},${g},${0.7 - wither * 0.2})`;
  ctx.beginPath();
  ctx.ellipse(
    x,
    y,
    s * 1.2,
    s * 0.8,
    Math.random() * Math.PI,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();
}

function drawBloom(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, hue: number) {
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = `hsla(${hue}, 60%, 52%, 0.9)`;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(
      x + Math.cos(a) * s * 0.9,
      y + Math.sin(a) * s * 0.9,
      s * 0.9,
      s * 0.6,
      a,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.beginPath();
  ctx.arc(x, y, s * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== Tip UI state machine =====
type TipState = "idle" | "preparing" | "confirm" | "sending" | "done";

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2800);
    return () => clearTimeout(t);
  }, [msg]);
  return {
    msg,
    show: (m: string) => setMsg(m),
  };
}

function getProvider(): any {
  const p = (sdk as any)?.wallet?.ethProvider;
  if (p) return p;
  return (window as any).ethereum;
}

async function requestAccounts(provider: any): Promise<string[]> {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || accounts.length === 0)
    throw new Error("No accounts returned.");
  return accounts;
}

async function getChainId(provider: any): Promise<string> {
  const chainId = await provider.request({ method: "eth_chainId" });
  if (typeof chainId !== "string" || !isHexPrefixed(chainId))
    throw new Error("Invalid chainId");
  return chainId;
}

async function switchToBase(provider: any): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_MAINNET }],
    });
  } catch {
    throw new Error(
      "Please switch to Base Mainnet (0x2105) in your wallet to continue."
    );
  }
}

async function walletSendCalls(provider: any, payload: any) {
  return await provider.request({ method: "wallet_sendCalls", params: [payload] });
}

// ===== Local persistence (growth + watering) =====
type LocalState = {
  plantedAt?: number;
  growth: number;
  lastWateredAt?: number;
  missedStreak: number;
  revivedAt?: number;
  lastGraftedAt?: number;
};

function lsKey(addr: string) {
  return `basebonsai:v1:${addr.toLowerCase()}`;
}

function loadState(addr: string): LocalState {
  try {
    const raw = localStorage.getItem(lsKey(addr));
    if (!raw) return { growth: 0, missedStreak: 0 };
    const j = JSON.parse(raw);
    return {
      plantedAt: typeof j.plantedAt === "number" ? j.plantedAt : undefined,
      growth: typeof j.growth === "number" ? j.growth : 0,
      lastWateredAt: typeof j.lastWateredAt === "number" ? j.lastWateredAt : undefined,
      missedStreak: typeof j.missedStreak === "number" ? j.missedStreak : 0,
      revivedAt: typeof j.revivedAt === "number" ? j.revivedAt : undefined,
      lastGraftedAt: typeof j.lastGraftedAt === "number" ? j.lastGraftedAt : undefined,
    };
  } catch {
    return { growth: 0, missedStreak: 0 };
  }
}

function saveState(addr: string, st: LocalState) {
  localStorage.setItem(lsKey(addr), JSON.stringify(st));
}

function hoursSince(ts?: number) {
  if (!ts) return Infinity;
  return (nowMs() - ts) / 36e5;
}

function daysSince(ts?: number) {
  if (!ts) return Infinity;
  return (nowMs() - ts) / 864e5;
}

function computeHealth(st: LocalState) {
  const missed = st.missedStreak ?? 0;
  if (missed <= 0) return 1;
  if (missed === 1) return 0.86;
  if (missed === 2) return 0.68;
  return 0.42;
}

function canWater(st: LocalState) {
  return hoursSince(st.lastWateredAt) >= 1;
}

function computeMissedStreak(st: LocalState) {
  if (!st.lastWateredAt) return 0;
  const d = Math.floor(daysSince(st.lastWateredAt));
  return clamp(d, 0, 30);
}

// ===== UI =====
export default function App() {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [account, setAccount] = useState<string>("");
  const [chainId, setChainId] = useState<string>("");

  const [balanceWei, setBalanceWei] = useState<bigint>(0n);
  const [nonce, setNonce] = useState<bigint>(0n);

  const [local, setLocal] = useState<LocalState>({ growth: 0, missedStreak: 0 });
  const [friendAddress, setFriendAddress] = useState<string>("");
  const [friendHue, setFriendHue] = useState<number | undefined>(undefined);

  // Tip state
  const [tipOpen, setTipOpen] = useState(false);
  const [tipUsd, setTipUsd] = useState<number>(5);
  const [tipCustom, setTipCustom] = useState<string>("");
  const [tipState, setTipState] = useState<TipState>("idle");

  const planted = !!local.plantedAt;

  // ===== Mini App SDK ready gate (MANDATORY) =====
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await sdk.actions.ready();
      } catch {
        // If opened outside a host, keep working (but this will be browser-mode).
      } finally {
        if (!cancelled) {
          // no-op: we just need to ensure ready() ran at least once.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function connect() {
    const provider = getProvider();
    if (!provider) {
      toast.show("No wallet provider found. Open inside a Farcaster/Base Mini App host.");
      return;
    }
    try {
      const accounts = await requestAccounts(provider);
      setAccount(accounts[0]);
      const cid = await getChainId(provider);
      setChainId(cid);
    } catch (e: any) {
      toast.show(e?.message || "Wallet connection failed.");
    }
  }

  async function ensureBase(): Promise<boolean> {
    const provider = getProvider();
    if (!provider) {
      toast.show("No wallet provider found.");
      return false;
    }
    try {
      const cid = await getChainId(provider);
      if (cid === BASE_MAINNET || cid === BASE_SEPOLIA) {
        setChainId(cid);
        if (cid !== BASE_MAINNET) toast.show("You're on Base Sepolia. Switch to Base Mainnet for the real tree.");
        return true;
      }
      await switchToBase(provider);
      const after = await getChainId(provider);
      setChainId(after);
      return after === BASE_MAINNET;
    } catch (e: any) {
      toast.show(e?.message || "Couldn't switch to Base.");
      return false;
    }
  }

  async function refreshSignals(addr: string) {
    try {
      const [bal, n] = await Promise.all([getBalanceWei(addr), getNonce(addr)]);
      setBalanceWei(bal);
      setNonce(n);
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    if (!account) return;
    const st = loadState(account);
    const missed = computeMissedStreak(st);
    const merged = { ...st, missedStreak: missed };
    setLocal(merged);
    saveState(account, merged);
    refreshSignals(account);
  }, [account]);

  const richness = useMemo(() => {
    const eth = weiToEth(balanceWei);
    const x = Math.log10(1 + eth) / 4;
    return clamp(x, 0, 1);
  }, [balanceWei]);

  const activity = useMemo(() => {
    const x = Number(nonce > 0n ? nonce : 0n);
    const y = Math.log10(1 + x) / 4;
    return clamp(y, 0, 1);
  }, [nonce]);

  const health = useMemo(() => computeHealth(local), [local]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    function resize() {
      const rect = c.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      c.width = Math.floor(rect.width * dpr);
      c.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(c);

    const seed = account || "0x0000000000000000000000000000000000000000";
    const growth = planted ? Math.max(1, local.growth) : 0;

    function frame(ts: number) {
      const breeze = 0.5 + Math.sin(ts / 1600) * 0.5;
      renderBonsai(ctx, c.getBoundingClientRect().width, c.getBoundingClientRect().height, {
        seed,
        richness,
        activity,
        growth,
        health,
        breeze,
        friendHue,
      });
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [account, richness, activity, planted, local.growth, health, friendHue]);

  async function sendGameTx(intent: "plant" | "water" | "revive" | "graft") {
    const provider = getProvider();
    if (!provider) {
      toast.show("No wallet provider found.");
      return false;
    }
    if (!BUILDER_CODE) {
      toast.show("Builder code missing. Sending disabled.");
      return false;
    }
    if (!isLikelyAddress(GAME_CONTRACT)) {
      toast.show("Game contract address invalid.");
      return false;
    }

    const ok = await ensureBase();
    if (!ok) return false;

    try {
      const [from] = await requestAccounts(provider);

      // Avoid wallet-side "Error generating transaction" by checking gas first.
      // (The game call costs only gas; no tokens are required.)
      const balHex = await provider.request({ method: "eth_getBalance", params: [from, "latest"] });
      const balWei = BigInt(balHex);
      if (balWei <= 0n) {
        toast.show("You need a small amount of ETH on Base for gas to plant/water.");
        return false;
      }

      const call = {
        to: GAME_CONTRACT,
        value: "0x0",
        data: encodeLogAction(intent),
      };

      const payload = {
        version: "2.0.0",
        from,
        chainId: BASE_MAINNET,
        atomicRequired: true,
        calls: [call],
        capabilities: { dataSuffix },
      };

      // Pre-tx UX: 1–1.5s before wallet opens
      toast.show(intent === "water" ? "A breeze… then water." : "Ink settles… then onchain.");
      await sleep(1100);

      await walletSendCalls(provider, payload);
      return true;
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      if (msg.includes("user rejected") || msg.includes("rejected")) {
        toast.show("Canceled in wallet.");
        return false;
      }
      toast.show(e?.message || "Transaction failed.");
      return false;
    }
  }

  async function plant() {
    if (!account) return toast.show("Connect your wallet first.");
    if (planted) return toast.show("Already planted.");

    const ok = await sendGameTx("plant");
    if (!ok) return;

    const next: LocalState = { plantedAt: nowMs(), growth: 1, lastWateredAt: nowMs(), missedStreak: 0 };
    setLocal(next);
    saveState(account, next);
    refreshSignals(account);
    toast.show("Seed planted. Welcome to your bonsai.");
  }

  async function water() {
    if (!account) return toast.show("Connect your wallet first.");
    if (!planted) return toast.show("Plant your seed first.");
    if (!canWater(local)) {
      const hrs = Math.max(0, 24 - hoursSince(local.lastWateredAt));
      return toast.show(`Water is ready in ~${hrs.toFixed(1)}h.`);
    }

    const ok = await sendGameTx("water");
    if (!ok) return;

    const next: LocalState = { ...local, growth: (local.growth || 1) + 1, lastWateredAt: nowMs(), missedStreak: 0 };
    setLocal(next);
    saveState(account, next);
    refreshSignals(account);
    toast.show("Watered. A new branch appears.");
  }

  async function revive() {
    if (!account) return toast.show("Connect your wallet first.");
    if (!planted) return toast.show("Plant your seed first.");
    if ((local.missedStreak || 0) < 3) return toast.show("Your bonsai isn't withered yet.");

    const ok = await sendGameTx("revive");
    if (!ok) return;

    const next: LocalState = { ...local, missedStreak: 0, revivedAt: nowMs(), lastWateredAt: nowMs() };
    setLocal(next);
    saveState(account, next);
    refreshSignals(account);
    toast.show("Revived. Ink returns to life.");
  }

  async function graft() {
    if (!account) return toast.show("Connect your wallet first.");
    if (!planted) return toast.show("Plant your seed first.");
    const addr = friendAddress.trim();
    if (!isLikelyAddress(addr)) return toast.show("Enter a valid friend's address (0x...).");

    const hue = Math.floor(hashToUnitFloat(addr) * 360);
    setFriendHue(hue);

    const ok = await sendGameTx("graft");
    if (!ok) return;

    const next: LocalState = { ...local, lastGraftedAt: nowMs() };
    setLocal(next);
    saveState(account, next);
    toast.show("Grafted. A flower blooms (your color).");
  }

  function resolvedTipUsd() {
    const c = Number(tipCustom);
    if (tipCustom.trim() !== "" && Number.isFinite(c)) return c;
    return tipUsd;
  }

  async function sendTip() {
    const provider = getProvider();
    if (!provider) return toast.show("No wallet provider found.");

    if (!BUILDER_CODE) return toast.show("Builder code missing. Sending disabled.");
    if (!isLikelyAddress(TIP_RECIPIENT)) return toast.show("Tip recipient not set. Sending disabled.");

    const usd = resolvedTipUsd();
    if (!Number.isFinite(usd) || usd <= 0) return toast.show("Enter a valid amount.");

    setTipState("preparing");
    await sleep(1250); // pre-transaction UX (MANDATORY)

    try {
      const ok = await ensureBase();
      if (!ok) {
        setTipState("idle");
        return;
      }

      setTipState("confirm");
      const [from] = await requestAccounts(provider);

      const amountBaseUnits = BigInt(Math.round(usd * 1_000_000)); // USDC decimals: 6
      const data = encodeUsdcTransfer(TIP_RECIPIENT, amountBaseUnits);

      const payload = {
        version: "2.0.0",
        from,
        chainId: BASE_MAINNET,
        atomicRequired: true,
        calls: [{ to: USDC_CONTRACT, value: "0x0", data }],
        capabilities: { dataSuffix },
      };

      setTipState("sending");
      await walletSendCalls(provider, payload);

      setTipState("done");
      setTipCustom("");
      toast.show("Tip sent. Thank you.");
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      if (msg.includes("user rejected") || msg.includes("rejected")) toast.show("Canceled in wallet.");
      else toast.show(e?.message || "Tip failed.");
      setTipState("idle");
    }
  }

  const missed = local.missedStreak || 0;
  const withered = missed >= 3;

  const waterLabel = planted ? (canWater(local) ? "Water (on-chain)" : "Water (cooldown)") : "Plant seed (on-chain)";

  const statusLine = !account
    ? "Connect your wallet to begin."
    : !planted
    ? "Plant a seed to generate your soul-tree."
    : withered
    ? "Withered — revive within the ink."
    : "Alive. water daily to grow🌲.";

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">
          <img src="/assets/icon.png" alt="Base Bonsai" />
          <div>
            <h1>Base Bonsai</h1>
            <p>The On-Chain Living Art</p>
          </div>
        </div>

        <div className="row">
          <button className="btn" onClick={() => setTipOpen(true)}>Tip</button>
          <button className="btn primary" onClick={account ? () => toast.show(shortAddr(account)) : connect}>
            {account ? "Connected" : "Connect"}
          </button>
        </div>
      </div>

      <div className="card canvasCard">
        <div className="canvasShell">
          <canvas ref={canvasRef} aria-label="Generative bonsai canvas" />
        </div>

        {/* Keep controls BELOW the tree so the art stays the hero (per mobile UI feedback). */}
        <div className="dock">
          <div className="dockRow">
            <div className="pill"><strong>Growth</strong><span>{planted ? local.growth : 0}</span></div>
            <div className="pill"><strong>Health</strong><span>{withered ? "Withered" : health > 0.8 ? "Vibrant" : health > 0.6 ? "Tired" : "Fading"}</span></div>
            <div className="pill"><strong>Chain</strong><span>{chainId ? (chainId === BASE_MAINNET ? "Base" : chainId === BASE_SEPOLIA ? "Sepolia" : "Other") : "—"}</span></div>
          </div>

          <div className="dockRow">
            <button className="btn primary" onClick={planted ? water : plant} disabled={!account || (planted && !canWater(local)) || withered}>
              {waterLabel}
            </button>
            <button className="btn" onClick={revive} disabled={!account || !planted || !withered}>Revive</button>
            <button className="btn" onClick={() => setTipOpen(true)}>Send USDC</button>
          </div>

          <div className="pill"><strong>Status</strong><span>{statusLine}</span></div>

          <div className="pill" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <strong>Graft</strong>
            <input
              className="input"
              style={{ padding: "10px 12px", borderRadius: 999, fontSize: 12, background: "rgba(255,255,255,.55)" }}
              placeholder="Friend wallet (0x...)"
              value={friendAddress}
              onChange={(e) => setFriendAddress(e.target.value)}
            />
            <button className="btn" onClick={graft} disabled={!account || !planted}>Bloom</button>
          </div>

          {planted && (
            <p className="small">
              Water every 1h. Miss 3 days and the tree withers (revive required). Balance affects trunk thickness; activity affects leafiness.
            </p>
          )}
        </div>
      </div>

      {tipOpen && (
        <TipSheet
          onClose={() => {
            setTipOpen(false);
            setTipState("idle");
            setTipCustom("");
          }}
          tipUsd={tipUsd}
          setTipUsd={setTipUsd}
          tipCustom={tipCustom}
          setTipCustom={setTipCustom}
          tipState={tipState}
          resolvedUsd={resolvedTipUsd()}
          onSend={sendTip}
          recipient={TIP_RECIPIENT}
          builderCode={BUILDER_CODE}
        />
      )}

      {toast.msg && <div className="toast">{toast.msg}</div>}
    </div>
  );
}

function TipSheet(props: {
  onClose: () => void;
  tipUsd: number;
  setTipUsd: (n: number) => void;
  tipCustom: string;
  setTipCustom: (s: string) => void;
  tipState: TipState;
  resolvedUsd: number;
  onSend: () => void;
  recipient: string;
  builderCode: string;
}) {
  const { onClose, tipUsd, setTipUsd, tipCustom, setTipCustom, tipState, resolvedUsd, onSend, recipient, builderCode } =
    props;

  const disabled = !builderCode || !recipient || !isLikelyAddress(recipient);

  const cta =
    tipState === "idle"
      ? "Send USDC"
      : tipState === "preparing"
      ? "Preparing tip…"
      : tipState === "confirm"
      ? "Confirm in wallet"
      : tipState === "sending"
      ? "Sending…"
      : "Send again";

  return (
    <div className="sheetBack" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <div>
            <h2>Tip the gardener</h2>
            <p>USDC on Base — your support grows the ecosystem.</p>
          </div>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid">
          {[1, 5, 10, 25].map((v) => (
            <button
              key={v}
              className={"btn" + (tipCustom.trim() === "" && tipUsd === v ? " primary" : "")}
              onClick={() => {
                setTipCustom("");
                setTipUsd(v);
              }}
            >
              ${v}
            </button>
          ))}
        </div>

        <input
          className="input"
          inputMode="decimal"
          placeholder="Custom amount (USD)"
          value={tipCustom}
          onChange={(e) => setTipCustom(e.target.value.replace(/[^0-9.]/g, ""))}
        />

        <p className="small">
          Sending <strong>${formatUsdc(resolvedUsd)}</strong> USDC to <strong>{shortAddr(recipient)}</strong>.
          {disabled && " Recipient/builder code not configured; sending is disabled."}
        </p>

        <button
          className="btn primary"
          style={{ width: "100%", marginTop: 10 }}
          onClick={onSend}
          disabled={disabled || tipState === "preparing" || tipState === "sending" || resolvedUsd <= 0}
        >
          {cta}
        </button>

        <p className="small">
          Pre-wallet animation is intentional (1–1.5s) so the modal doesn’t freeze mid-transition.
        </p>
      </div>
    </div>
  );
}
