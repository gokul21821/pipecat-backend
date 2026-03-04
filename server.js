// session-broker/server.js
// Session start flow: try local Pipecat runner first (when LOCAL_RUNNER_URL set),
// then fall back to Pipecat Cloud. Both return dailyRoom + dailyToken; no manual Daily API usage.
const express = require("express");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
app.use(express.json());

const LOCAL_RUNNER_URL = process.env.LOCAL_RUNNER_URL || "http://localhost:7860";
const PIPECAT_CLOUD_AGENT = process.env.PIPECAT_CLOUD_AGENT || "quickstart-test";
const LOCAL_HEALTH_TIMEOUT_MS = 500;
const LOCAL_START_TIMEOUT_MS = 15_000;

// Allow requests from the Next.js dev server
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || "http://localhost:3001";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-broker-auth");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Shared-secret auth: only the Next.js server (which holds BROKER_AUTH_SECRET) may
// call /start. Skipped in development so local testing stays frictionless.
const BROKER_AUTH_SECRET = process.env.BROKER_AUTH_SECRET;
app.use((req, res, next) => {
  if (
    (req.path === "/start" || req.path === "/api/start") &&
    process.env.NODE_ENV === "production"
  ) {
    if (!BROKER_AUTH_SECRET || req.headers["x-broker-auth"] !== BROKER_AUTH_SECRET) {
      console.warn(`[Security] Unauthorized /start attempt from ${req.ip}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

app.get("/", (req, res) => {
  res.json({ service: "session-broker", status: "ok", ui: "http://localhost:3001" });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Normalise response from local runner or Pipecat Cloud to client format
function normalise(payload, source) {
  return {
    url: payload.dailyRoom || payload.url,
    token: payload.dailyToken || payload.token,
    sessionId: payload.sessionId || null,
    source, // "local" | "cloud" — for debugging
  };
}

// Try local Pipecat runner (uv run bot.py -t daily). Returns dailyRoom + dailyToken.
async function tryLocal() {
  try {
    // Fast probe: avoid waiting a long time if runner is down.
    {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LOCAL_HEALTH_TIMEOUT_MS);
      try {
        const healthResp = await fetch(`${LOCAL_RUNNER_URL}/openapi.json`, {
          method: "GET",
          signal: controller.signal,
        });
        if (!healthResp.ok) return null;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }

    // Runner is reachable: allow real startup time for /start.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_START_TIMEOUT_MS);
    const resp = await fetch(`${LOCAL_RUNNER_URL}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createDailyRoom: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const payload = await resp.json();
    if (!payload.dailyRoom && !payload.url) {
      return null; // webrtc transport returns only sessionId
    }
    return payload;
  } catch {
    return null;
  }
}

// Pipecat Cloud start (cold start can take 10–15s)
async function tryCloud() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(
      `https://api.pipecat.daily.co/v1/public/${PIPECAT_CLOUD_AGENT}/start`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PIPECAT_PUBLIC_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ createDailyRoom: true }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text();
      if (resp.status === 429) {
        const err = new Error("Agent at capacity. Try again in a moment.");
        err.status = 429;
        throw err;
      }
      throw new Error(errText || "Pipecat Cloud error");
    }
    return await resp.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      const e = new Error("Pipecat Cloud timed out. Try again.");
      e.status = 504;
      throw e;
    }
    throw err;
  }
}

async function handleStart(req, res) {
  const startMs = Date.now();
  try {
    let payload;
    let source;

    if (process.env.NODE_ENV === "production") {
      // Production: skip local, use Pipecat Cloud directly (no 2s delay)
      payload = await tryCloud();
      source = "cloud";
    } else {
      // Development: try local first, then fall back to Cloud
      const localPayload = await tryLocal();
      if (localPayload) {
        payload = localPayload;
        source = "local";
      } else {
        console.log("[session-broker] Local runner unavailable, using Pipecat Cloud...");
        payload = await tryCloud();
        source = "cloud";
      }
    }

    const elapsed = Date.now() - startMs;
    console.log(`[session-broker] Session started via: ${source} (${elapsed}ms)`);
    res.json(normalise(payload, source));
  } catch (err) {
    const elapsed = Date.now() - startMs;
    console.error(`[session-broker] Start error after ${elapsed}ms:`, err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || "internal" });
  }
}

app.post("/start", handleStart);
app.post("/api/start", handleStart);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const isProd = process.env.NODE_ENV === "production";
  console.log(`Session broker listening on :${PORT}`);
  console.log(`  Mode: ${isProd ? "production (Cloud only)" : "development (local first, then Cloud)"}`);
  console.log(`  Pipecat Cloud: ${PIPECAT_CLOUD_AGENT}`);
});
