/**
 * tts.js - Integração com o servidor TTS (Qwen3) 
 * Lida com geração de narração, remoção de fundo e sincronização
 */
import { execSync, spawnSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TTS_SERVER = "http://209.94.63.163:3459";
const TTS_TIMEOUT = 600000; // 10 min max
const RENDERS_DIR = join(import.meta.dirname, "renders");

// Vozes disponíveis
export const VOICES = ["Marlon"];
const MARLON_REF_TEXT = "Ofertas imbatíveis no setor de carnes! Prepare o churrasco e o almoço da semana economizando de verdade!";

function curlGet(url, timeoutMs = 10000) {
  const out = execSync(`curl -s --connect-timeout 5 --max-time ${Math.floor(timeoutMs / 1000)} "${url}"`, {
    encoding: "utf-8",
    timeout: timeoutMs + 5000,
  });
  return out;
}

function curlPostForm(url, formData, outPath, timeoutMs = 600000) {
  const args = Object.entries(formData)
    .map(([k, v]) => `--data-urlencode ${k}=${JSON.stringify(v)}`)
    .join(" ");
  execSync(
    `curl -s --connect-timeout 10 --max-time ${Math.floor(timeoutMs / 1000)} -X POST ${args} -o "${outPath}" -w '%{http_code}|%{size_download}' "${url}"`,
    { encoding: "utf-8", timeout: timeoutMs + 10000 }
  );
}

/**
 * Lista vozes disponíveis no servidor TTS
 */
export async function listVoices() {
  try {
    const raw = curlGet(`${TTS_SERVER}/saved`, 10000);
    const data = JSON.parse(raw);
    return (data.files || []).map(f => ({
      name: f.name,
      size: f.size,
    }));
  } catch {
    return VOICES.map(n => ({ name: n, size: 0 }));
  }
}

/**
 * Gera um único segmento de áudio TTS com retry.
 */
function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function generateTTSSegment(text, voiceName, wavPath, maxNewTokens = 1024, retries = 4) {
  const refText = MARLON_REF_TEXT;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    const cmd = [
      "curl -s --connect-timeout 10 --max-time 120 -X POST",
      `--data-urlencode ${shellEscape("text=" + text)}`,
      `--data-urlencode ${shellEscape("voice_name=" + voiceName)}`,
      `--data-urlencode ${shellEscape("ref_text=" + refText)}`,
      `--data-urlencode language=Portuguese`,
      `--data-urlencode ${shellEscape("max_new_tokens=" + String(maxNewTokens))}`,
      `-o ${shellEscape(wavPath)}`,
      `-w '%{http_code}'`,
      shellEscape(`${TTS_SERVER}/generate-from-saved`),
    ].join(" ");

    console.log(`[tts] attempt ${attempt}/${retries}: "${text.slice(0, 30)}..."`);
    try {
      const httpCode = execSync(cmd, { encoding: "utf-8", timeout: 120000 }).trim();
      const code = parseInt(httpCode) || 0;
      if (code === 200 && existsSync(wavPath)) {
        console.log(`[tts] success on attempt ${attempt}`);
        return;
      }
      console.log(`[tts] attempt ${attempt} failed (HTTP ${code})`);
    } catch (e) {
      console.log(`[tts] attempt ${attempt} error: ${e.message.slice(0, 100)}`);
    }
    if (attempt < retries) execSync(`sleep ${attempt * 3}`);
  }
  throw new Error(`TTS failed after ${retries} attempts`);
}

/**
 * Gera áudio TTS a partir de texto e voz salva.
 * Divide em frases curtas para evitar timeout do servidor.
 */
export async function generateTTS(text, voiceName = "Marcos", opts = {}) {
  const { maxNewTokens = 300 } = opts;
  const tmpDir = mkdtempSync(join(tmpdir(), "tts_"));

  try {
    const words = text.split(/\s+/);
    const chunks = [];
    let buffer = "";
    for (const w of words) {
      if ((buffer + " " + w).trim().length > 25) {
        if (buffer) chunks.push(buffer.trim());
        buffer = w;
      } else {
        buffer = buffer ? buffer + " " + w : w;
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());

    console.log(`[tts] ${text.length} chars -> ${chunks.length} chunks, voice=${voiceName}`);

    const segmentPaths = [];
    for (let i = 0; i < chunks.length; i++) {
      const segPath = join(tmpDir, `seg_${i}.wav`);
      console.log(`[tts] Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars): "${chunks[i].slice(0, 50)}..."`);
      generateTTSSegment(chunks[i], voiceName, segPath, maxNewTokens);
      segmentPaths.push(segPath);
      if (i < chunks.length - 1) {
        console.log(`[tts] Waiting 3s before next chunk...`);
        execSync("sleep 3");
      }
    }

    let finalWav;
    if (segmentPaths.length === 1) {
      finalWav = readFileSync(segmentPaths[0]);
    } else {
      const listPath = join(tmpDir, "list.txt");
      const segments = segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
      writeFileSync(listPath, segments);
      
      const mergedPath = join(tmpDir, "merged.wav");
      spawnSync("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", mergedPath,
      ], { cwd: tmpDir, timeout: 30000, stdio: "pipe" });
      
      if (!existsSync(mergedPath)) throw new Error("ffmpeg concat failed");
      finalWav = readFileSync(mergedPath);
    }

    console.log(`[tts] Final audio: ${(finalWav.length / 1024).toFixed(0)}KB`);

    let duration = 0;
    const finalPath = join(tmpDir, "final.wav");
    writeFileSync(finalPath, finalWav);
    try {
      const durOut = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalPath}"`,
        { encoding: "utf-8", timeout: 10000 }
      );
      duration = parseFloat(durOut.trim()) || 0;
    } catch {}

    return { wavBytes: finalWav, duration };
  } finally {
    try {
      const { readdirSync } = await import("fs");
      for (const f of readdirSync(tmpDir)) {
        try { unlinkSync(join(tmpDir, f)); } catch {}
      }
      require("fs").rmdirSync(tmpDir);
    } catch {}
  }
}

/**
 * Remove background de imagem usando rembg no servidor TTS.
 * @param {Buffer} imageBuffer - Buffer da imagem original
 * @returns {Promise<Buffer>} - Buffer da imagem com fundo removido
 */
export async function removeBackground(imageBuffer) {
  // Envia para o servidor TTS processar via rembg
  // (precisa instalar rembg no servidor TTS)
  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: "image/png" });
  form.append("image", blob, "product.png");

  const res = await fetch(`${TTS_SERVER}/remove-bg`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    throw new Error(`remove-bg error: ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Faz mux de vídeo MP4 + áudio WAV em um único arquivo MP4.
 * Usa FFmpeg para sincronizar.
 * @param {string} videoPath - Caminho do arquivo MP4
 * @param {string} audioWavPath - Caminho do arquivo WAV
 * @param {string} outputPath - Caminho de saída MP4
 * @param {number} [audioOffset] - Atraso do áudio em ms
 * @returns {string} Caminho do arquivo final
 */
export function muxAudioVideo(
  videoPath,
  audioWavPath,
  outputPath,
  audioOffset = 0
) {
  const args = [
    "-y",
    "-i", videoPath,
    "-i", audioWavPath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-shortest",
    outputPath,
  ];

  if (audioOffset > 0) {
    args.splice(args.length - 1, 0, "-af", `adelay=${audioOffset}|${audioOffset}`);
  }

  const proc = spawnSync("ffmpeg", args, {
    cwd: import.meta.dirname,
    timeout: 120000,
    stdio: "pipe",
  });

  if (proc.error || proc.status !== 0) {
    const errMsg = proc.stderr?.slice(0, 500)?.toString() || proc.error?.message || `exit code ${proc.status}`;
    throw new Error(`FFmpeg mux failed: ${errMsg}`);
  }

  return outputPath;
}

/**
 * Obtém duração de um arquivo WAV em segundos.
 */
export function getWavDuration(wavPath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`,
    { encoding: "utf-8", timeout: 10000 }
  );
  return parseFloat(out.trim());
}

/**
 * Gera slug para nome de arquivo
 */
function slugify(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

/**
 * Pipeline completa: TTS -> Render -> Mux
 */
export async function generateNarratedVideo({
  storeName,
  ownerName,
  products,
  badge,
  template,
  voiceName = "Marcos",
  narrationText,
}) {
  // 1. Gerar narração
  if (!narrationText) {
    narrationText = buildNarrationText({ storeName, products, badge });
  }

  console.log(`[tts] Generating narration: "${narrationText.slice(0, 60)}..."`);
  const { wavBytes, duration } = await generateTTS(narrationText, voiceName);
  
  const audioPath = join(RENDERS_DIR, `narration_${Date.now()}.wav`);
  writeFileSync(audioPath, wavBytes);
  console.log(`[tts] Audio generated: ${(wavBytes.length / 1024).toFixed(0)}KB, ${duration.toFixed(1)}s`);

  return {
    audioPath,
    wavBytes,
    duration,
    narrationText,
  };
}

/**
 * Gera TTS e faz mux com um vídeo já renderizado.
 * @param {object} opts
 * @param {string} opts.renderName - Nome do output do render (sem .mp4)
 * @param {string} opts.text - Texto para narração
 * @param {string} [opts.voiceName] - Nome da voz
 * @param {number} [opts.maxNewTokens] - Máx tokens TTS
 * @returns {Promise<Buffer>} Buffer do MP4 final
 */
export async function generateAndMux({ renderName, text, voiceName = "Marcos", maxNewTokens = 1024 }) {
  const videoPath = join(RENDERS_DIR, `${renderName}.mp4`);
  if (!existsSync(videoPath)) {
    throw new Error(`Render not found: ${renderName}.mp4`);
  }

  // 1. Gerar narração
  console.log(`[tts] Generating TTS for mux: "${text.slice(0, 60)}..."`);
  const { wavBytes, duration } = await generateTTS(text, voiceName, { maxNewTokens });

  // 2. Salvar WAV temporário
  const audioPath = join(RENDERS_DIR, `_mux_${renderName}.wav`);
  writeFileSync(audioPath, wavBytes);
  console.log(`[tts] TTS generated: ${(wavBytes.length / 1024).toFixed(0)}KB, ${duration.toFixed(1)}s`);

  // 3. Fazer mux
  const finalPath = join(RENDERS_DIR, `_final_${renderName}.mp4`);
  muxAudioVideo(videoPath, audioPath, finalPath);

  // 4. Limpar WAV temporário
  try { unlinkSync(audioPath); } catch {}

  // 5. Retornar buffer
  return readFileSync(finalPath);
}

/**
 * Constrói texto de narração a partir dos dados do vídeo.
 */
function buildNarrationText({ storeName, products, badge }) {
  const lines = [];
  lines.push(`Atenção, clientes do ${storeName}!`);
  
  products.forEach((p, i) => {
    if (i === 0) {
      lines.push(`Oferta imperdível: ${p.name} por apenas R$ ${p.newPrice}!`);
    } else {
      lines.push(`Temos também ${p.name} por R$ ${p.newPrice}!`);
    }
  });
  
  lines.push(`${badge || "Corre"} que é por tempo limitado!`);
  lines.push(`Não perca esta oportunidade!`);
  
  return lines.join(" ");
}
