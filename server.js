require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const TOKEN_PATH = path.join(DATA_DIR, "token.json");

let lastRun = null;
let isRunning = false;
const log = [];
function pushLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  log.push(line);
  if (log.length > 200) log.shift();
}

/* ───────────────────── 1. RESEARCH + SCRIPT (Claude) ───────────────────── */
async function researchAndWrite({ niche }) {
  const nicheInstruction =
    niche && niche !== "auto"
      ? `The channel niche is fixed: "${niche}". Stay within this niche.`
      : `Pick whichever single niche is most likely to go viral on YouTube right now.`;

  const prompt = `You are a top YouTube growth strategist and scriptwriter for a faceless channel.
${nicheInstruction}

Write ONE complete, ready-to-produce video. Return ONLY valid JSON, no markdown fences, no commentary:
{
  "niche": "niche name",
  "title": "viral-optimized title, under 65 characters",
  "hook": "first 15-second spoken hook",
  "script": "full narration script, 250-350 words, plain spoken text only, no stage directions or brackets",
  "scenes": ["visual description for scene 1", "visual description for scene 2", "visual description for scene 3", "visual description for scene 4", "visual description for scene 5"],
  "thumbnailPrompt": "one-sentence image-generation prompt for the thumbnail background",
  "description": "YouTube description, 2-3 sentences plus relevant hashtags",
  "tags": ["tag1","tag2","tag3","tag4","tag5","tag6"]
}`;

  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-sonnet-4-6", max_tokens: 1800, messages: [{ role: "user", content: prompt }] },
    { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
  );

  const text = res.data.content.map((b) => b.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

/* ───────────────────── 2. VOICEOVER (OpenAI or ElevenLabs) ───────────────────── */
async function generateVoiceover(text, outPath) {
  const provider = process.env.TTS_PROVIDER || "openai";

  if (provider === "elevenlabs") {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: "eleven_multilingual_v2" },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" }, responseType: "arraybuffer" }
    );
    fs.writeFileSync(outPath, res.data);
    return outPath;
  }

  const res = await axios.post(
    "https://api.openai.com/v1/audio/speech",
    { model: "gpt-4o-mini-tts", voice: process.env.OPENAI_VOICE || "onyx", input: text },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" }, responseType: "arraybuffer" }
  );
  fs.writeFileSync(outPath, res.data);
  return outPath;
}

/* ───────────────────── 3. VISUALS (OpenAI Images) ───────────────────── */
async function generateImage(prompt, outPath) {
  const res = await axios.post(
    "https://api.openai.com/v1/images/generations",
    { model: "gpt-image-1", prompt: `${prompt}. Cinematic, high detail, no text, no watermark, 16:9.`, size: "1792x1024" },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" } }
  );
  fs.writeFileSync(outPath, Buffer.from(res.data.data[0].b64_json, "base64"));
  return outPath;
}

/* ───────────────────── 4. VIDEO ASSEMBLY (ffmpeg) ───────────────────── */
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, data) => (err ? reject(err) : resolve(data.format.duration)));
  });
}

async function assembleVideo({ imagePaths, audioPath, outPath }) {
  const totalDuration = await getAudioDuration(audioPath);
  const perImage = totalDuration / imagePaths.length;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    imagePaths.forEach((img) => cmd.input(img).loop(perImage));
    cmd.input(audioPath);

    const filters = [];
    imagePaths.forEach((_, i) => {
      filters.push(`[${i}:v]scale=1920:1080,zoompan=z='min(zoom+0.0015,1.1)':d=${Math.ceil(perImage * 25)}:s=1920x1080,setsar=1[v${i}]`);
    });
    const concatInputs = imagePaths.map((_, i) => `[v${i}]`).join("");
    filters.push(`${concatInputs}concat=n=${imagePaths.length}:v=1:a=0[outv]`);

    cmd
      .complexFilter(filters, "outv")
      .outputOptions(["-map", "outv", "-map", `${imagePaths.length}:a`, "-c:v", "libx264", "-c:a", "aac", "-shortest", "-pix_fmt", "yuv420p"])
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", reject)
      .run();
  });
}

/* ───────────────────── 5. YOUTUBE OAUTH + UPLOAD ───────────────────── */
function getOAuthClient() {
  return new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET, process.env.YOUTUBE_REDIRECT_URI);
}
function getAuthUrl() {
  return getOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube"],
  });
}
async function saveTokenFromCode(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}
function hasToken() {
  return fs.existsSync(TOKEN_PATH);
}
function getAuthedClient() {
  if (!hasToken()) throw new Error("Not authenticated yet. Visit /auth first.");
  const client = getOAuthClient();
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...tokens, ...newTokens }, null, 2)));
  return client;
}
async function uploadVideo({ filePath, title, description, tags }) {
  const youtube = google.youtube({ version: "v3", auth: getAuthedClient() });
  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description, tags, categoryId: "22" },
      status: { privacyStatus: process.env.VIDEO_VISIBILITY || "public", selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  return res.data;
}

/* ───────────────────── PIPELINE ───────────────────── */
async function runPipeline() {
  if (isRunning) { pushLog("Skipped run — previous run still in progress."); return; }
  isRunning = true;
  const workDir = path.join(DATA_DIR, `run-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    pushLog("Step 1/5: Researching trends & writing script…");
    const plan = await researchAndWrite({ niche: process.env.NICHE });
    fs.writeFileSync(path.join(workDir, "plan.json"), JSON.stringify(plan, null, 2));

    pushLog(`Step 2/5: Generating voiceover for "${plan.title}"…`);
    const audioPath = path.join(workDir, "voice.mp3");
    await generateVoiceover(plan.script, audioPath);

    pushLog("Step 3/5: Generating scene visuals…");
    const imagePaths = [];
    for (let i = 0; i < plan.scenes.length; i++) {
      const imgPath = path.join(workDir, `scene-${i}.png`);
      await generateImage(plan.scenes[i], imgPath);
      imagePaths.push(imgPath);
    }

    pushLog("Step 4/5: Assembling final video…");
    const videoPath = path.join(workDir, "final.mp4");
    await assembleVideo({ imagePaths, audioPath, outPath: videoPath });

    if (hasToken()) {
      pushLog("Step 5/5: Uploading to YouTube…");
      const result = await uploadVideo({ filePath: videoPath, title: plan.title, description: plan.description, tags: plan.tags });
      pushLog(`✅ Uploaded! https://youtu.be/${result.id}`);
    } else {
      pushLog("⚠️ Not connected to YouTube yet — video saved but not uploaded. Visit /auth.");
    }
    lastRun = { time: new Date().toISOString(), title: plan.title, success: true };
  } catch (err) {
    pushLog(`❌ Pipeline failed: ${err.message}`);
    lastRun = { time: new Date().toISOString(), error: err.message, success: false };
  } finally {
    isRunning = false;
  }
}

/* ───────────────────── ROUTES ───────────────────── */
app.get("/", (req, res) => {
  res.send(`<pre style="font-family:monospace;font-size:14px;line-height:1.6;padding:20px;background:#0a0a16;color:#ddd;">
AutoTube Bot — Status

YouTube connected: ${hasToken() ? "YES ✓" : "NO — visit /auth"}
Schedule: ${process.env.CRON_SCHEDULE || "0 14 * * *"} (${process.env.TIMEZONE || "server time"})
Last run: ${lastRun ? JSON.stringify(lastRun, null, 2) : "none yet"}

Routes:
  GET  /auth      - connect your YouTube channel (one time)
  GET  /run-now    - trigger the pipeline immediately
  GET  /logs       - view recent activity

${log.slice(-30).join("\n")}
</pre>`);
});

app.get("/auth", (req, res) => {
  if (hasToken()) return res.send("Already connected to YouTube. Delete data/token.json to reconnect.");
  res.redirect(getAuthUrl());
});

app.get("/auth/callback", async (req, res) => {
  try {
    await saveTokenFromCode(req.query.code);
    res.send("✅ YouTube connected! You can close this tab. The bot will now post automatically.");
  } catch (err) {
    res.status(500).send("Auth failed: " + err.message);
  }
});

app.get("/run-now", async (req, res) => {
  res.send("Pipeline started. Check /logs for progress.");
  runPipeline();
});

app.get("/logs", (req, res) => res.type("text/plain").send(log.join("\n") || "No activity yet."));

/* ───────────────────── SCHEDULER ───────────────────── */
const schedule = process.env.CRON_SCHEDULE || "0 14 * * *";
cron.schedule(schedule, () => { pushLog(`Cron triggered (${schedule}) — starting pipeline.`); runPipeline(); }, { timezone: process.env.TIMEZONE || "UTC" });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => pushLog(`AutoTube bot running on port ${PORT}. Schedule: ${schedule}`));
