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

  // Call the free Google Gemini 2.5 Flash model
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
  
  // Clean text from symbols
  const cleanText = text.replace(/[*#()\[\]]/g, "").trim();
  
  // Google Translate speech endpoint allows 200 char chunks max. We chunk it seamlessly:
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
  
  // Clean up special characters from the prompt string for safe URI conversion
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
    // Note: If you have your remaining trailing code logic below this block, paste it here.
