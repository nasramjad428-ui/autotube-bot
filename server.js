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

/* ───────────────────── 1. RESEARCH + SCRIPT (Google Gemini - Free Tier) ───────────────────── */
async function researchAndWrite({ niche }) {
  const nicheInstruction =
    niche && niche !== "auto"
      ? `The channel niche is fixed: "${niche}". Stay within this niche.`
      : `Pick whichever single niche is most likely to go viral on YouTube right now.`;

  const prompt = `You are a top YouTube growth strategist and scriptwriter for a faceless channel.
${nicheInstruction}

Write ONE complete, ready-to-produce video. Return ONLY valid JSON, no markdown fences, no commentary, no \`\`\`json blocks.
The response must match this schema exactly:
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

  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json"
    }
  });

  const text = res.data.candidates[0].content.parts[0].text;
  return JSON.parse(text.trim());
}

/* ───────────────────── 2. VOICEOVER (Free Google Translation TTS Engine) ───────────────────── */
async function generateVoiceover(text, outPath) {
  pushLog("Generating voiceover using free TTS backend...");
  const cleanText = text.replace(/[*#()\[\]]/g, "").trim();
  const chunks = cleanText.match(/[^.!?]+[.!?]*|.{1,200}/g) || [cleanText];
  const audioBuffers = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(chunk.trim())}`;
    const response = await axios.get(ttsUrl, { responseType: "arraybuffer" });
    audioBuffers.push(Buffer.from(response.data));
  }

  const finalBuffer = Buffer.concat(audioBuffers);
  fs.writeFileSync(outPath, finalBuffer);
  return outPath;
}

/* ───────────────────── 3. VISUALS (Pollinations AI - 100% Free Images) ───────────────────── */
async function generateImage(prompt, outPath) {
  pushLog(`Generating free image for prompt: "${prompt.substring(0, 40)}..."`);
  const formattedPrompt = encodeURIComponent(`${prompt}, Cinematic, high detail, 8k, no text, no watermark, 16:9 aspect ratio`);
  const pollinationsUrl = `https://image.pollinations.ai/p/${formattedPrompt}?width=1280&height=720&seed=${Math.floor(Math.random() * 100000)}&nologo=true`;

  const res = await axios.get(pollinationsUrl, { responseType: "arraybuffer" });
  fs.writeFileSync(outPath, res.data);
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
    cmd.outputOptions(["-c:v libx264", "-pix_fmt yuv420p", "-c:a aac", "-shortest"]);
    cmd.output(outPath)
       .on("end", () => resolve(outPath))
       .on("error", (err) => reject(err))
       .run();
  });
}

/* ───────────────────── 5. OAUTH & BOT RUNNERS ───────────────────── */
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || "https://autotube-bot-production.up.railway.app/oauth2callback"
);

if (fs.existsSync(TOKEN_PATH)) {
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
}

async function uploadToYouTube({ videoPath, title, description, tags }) {
  const youtube = google.youtube({ version: "v3", auth: oauth2Client });
  await youtube.videos.insert({
    part: "snippet,status",
    requestBody: {
      snippet: { title, description, tags, categoryId: "22" },
      status: { privacyStatus: process.env.VIDEO_PRIVACY || "public" }
    },
    media: { body: fs.createReadStream(videoPath) }
  });
}

async function runPipeline() {
  if (isRunning) return pushLog("Pipeline is already running.");
  isRunning = true;
  lastRun = new Date().toISOString();
  pushLog("Starting automated content pipeline...");

  try {
    const data = await researchAndWrite({ niche: process.env.CHANNEL_NICHE || "auto" });
    pushLog(`Script ready. Title: ${data.title}`);

    const audioPath = path.join(DATA_DIR, "voiceover.mp3");
    await generateVoiceover(data.script, audioPath);

    const imagePaths = [];
    for (let i = 0; i < data.scenes.length; i++) {
      const imgPath = path.join(DATA_DIR, `scene_${i}.jpg`);
      await generateImage(data.scenes[i], imgPath);
      imagePaths.push(imgPath);
    }

    const videoPath = path.join(DATA_DIR, "output.mp4");
    pushLog("Assembling final video file...");
    await assembleVideo({ imagePaths, audioPath, outPath: videoPath });

    pushLog("Uploading finished video to YouTube...");
    await uploadToYouTube({ videoPath, title: data.title, description: data.description, tags: data.tags });

    pushLog("✅ Pipeline completed successfully! Video published.");
  } catch (err) {
    pushLog(`❌ Pipeline failed: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/* ───────────────────── 6. SERVER & ROUTES ───────────────────── */
cron.schedule(process.env.CRON_SCHEDULE || "0 14 * * *", () => {
  pushLog("Cron triggered schedule run...");
  runPipeline();
});

app.get("/", (req, res) => {
  const connected = oauth2Client.credentials && oauth2Client.credentials.refresh_token ? "YES ✓" : "NO";
  res.send(`<pre>AutoTube Bot Status\n\nYouTube connected: ${connected}\nSchedule: ${process.env.CRON_SCHEDULE || "0 14 * * *"}\nLast run starting: ${lastRun || "none yet"}\n\nRoutes:\n  GET /auth     - Link account\n  GET /run-now  - Trigger pipeline\n  GET /logs     - View activity</pre>`);
});

app.get("/auth", (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: "offline", scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"] });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  const { tokens } = await oauth2Client.getToken(req.query.code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  res.send("✅ YouTube connected! You can close this tab.");
});

app.get("/run-now", (req, res) => {
  runPipeline();
  res.send("Pipeline started. Check /logs for progress.");
});

app.get("/logs", (req, res) => {
  res.send(`<pre>${log.join("\n") || "No logs available yet."}</pre>`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
