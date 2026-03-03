// session-broker/server.js
const express = require("express");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
app.use(express.json());

const LOCAL_RUNNER_URL = process.env.LOCAL_RUNNER_URL || "http://localhost:7860";
const PIPECAT_CLOUD_AGENT = process.env.PIPECAT_CLOUD_AGENT || "quickstart-test";

// Allow requests from the Next.js dev server
app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || "http://localhost:3001";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({ service: "session-broker", status: "ok", ui: "http://localhost:3001" });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Normalise response from either local runner or Pipecat Cloud
function normalise(payload) {
  return {
    url: payload.dailyRoom || payload.url,
    token: payload.dailyToken || payload.token,
    sessionId: payload.sessionId || null,
  };
}

// Try the local Pipecat runner first (uv run bot.py -t daily → port 7860)
async function tryLocal() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`${LOCAL_RUNNER_URL}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createDailyRoom: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const payload = await resp.json();
    // The runner must return room credentials; the webrtc transport's /start
    // only returns a sessionId which is not enough for our Daily-based frontend.
    if (!payload.dailyRoom && !payload.url) {
      console.warn("Local runner responded but without room credentials (wrong transport?).");
      console.warn("  Hint: run  uv run bot.py -t daily  (not webrtc)");
      return null;
    }
    return payload;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// Fall back to Pipecat Cloud (cold start can take 10–15s)
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
      const err = new Error(errText);
      err.status = 502;
      throw err;
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
    // 1. Try local runner (uv run bot.py -t daily)
    const localPayload = await tryLocal();
    if (localPayload) {
      const elapsed = Date.now() - startMs;
      console.log(`Using local Pipecat runner (${elapsed}ms)`);
      res.json(normalise(localPayload));
      return;
    }

    // 2. Fall back to Pipecat Cloud
    const cloudPayload = await tryCloud();
    const elapsed = Date.now() - startMs;
    console.log(`Using Pipecat Cloud (${elapsed}ms)`);
    res.json(normalise(cloudPayload));
  } catch (err) {
    const elapsed = Date.now() - startMs;
    console.error(`Start error after ${elapsed}ms:`, err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || "internal" });
  }
}

app.post("/start", handleStart);
app.post("/api/start", handleStart);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Session broker listening on :${PORT}`);
  console.log(`  Local runner: ${LOCAL_RUNNER_URL}`);
  console.log(`  Cloud agent:  ${PIPECAT_CLOUD_AGENT}`);
});