import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { generate } from "./generate.js";

import { listVoices, generateTTS } from "./tts.js";
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } from "./turso.js";
const PORT = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] || process.env.PORT || "3459", 10);
const TEMPLATES_DIR = join(import.meta.dirname, "templates");
const RENDERS_DIR = join(import.meta.dirname, "renders");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

function serveFile(res, filePath) {
  if (!existsSync(filePath)) return false;
  const ext = filePath.match(/\.[^.]+$/)?.[0] || "";
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
  return true;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Static files
  if (path === "/" || path === "/index.html") {
    if (serveFile(res, join(import.meta.dirname, "index.html"))) return;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Cartelas - API</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-zinc-900 text-zinc-100 min-h-screen p-6">
<div class="max-w-2xl mx-auto">
<h1 class="text-2xl font-bold mb-2">Gerador de Cartelas</h1>
<p class="text-zinc-400 mb-6">POST /render com JSON para gerar video.</p>

<form id="form" class="space-y-3 bg-zinc-800 p-6 rounded-lg" enctype="multipart/form-data">
<select id="template" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<option value="classica">Classica</option>
<option value="flash">Flash</option>
</select>
<input id="product_name" placeholder="Produto" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<input id="product_detail" placeholder="Detalhe (marca 900ml)" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<input id="price_int" placeholder="Preco inteiro (19)" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<input id="price_dec" placeholder="Preco decimal (90)" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<input id="old_price" placeholder="Preco antigo (24,90)" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<input id="store_name" placeholder="Supermercado" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<input id="validity" placeholder="Validade" value="Oferta valida ate 31/12/2026" class="w-full bg-zinc-700 rounded px-3 py-2 text-sm">
<button type="submit" class="w-full bg-violet-600 hover:bg-violet-700 rounded py-2 font-semibold">Gerar Video</button>
</form>

<div id="result" class="hidden mt-4"></div>

<script>
document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Renderizando... (~1 min)";
  const res = await fetch("/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      template: document.getElementById("template").value,
      product_name: document.getElementById("product_name").value || "Produto",
      product_detail: document.getElementById("product_detail").value || "",
      price_int: document.getElementById("price_int").value || "0",
      price_dec: document.getElementById("price_dec").value || "00",
      old_price: document.getElementById("old_price").value || "",
      store_name: document.getElementById("store_name").value || "Supermercado",
      validity: document.getElementById("validity").value || "Oferta valida",
    }),
  });
  const r = document.getElementById("result");
  r.classList.remove("hidden");
  if (res.ok) {
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    r.innerHTML = '<video controls class="w-full rounded-lg" src="' + url + '"></video><a href="' + url + '" download="cartela.mp4" class="inline-block mt-3 bg-emerald-600 px-4 py-2 rounded text-sm">Baixar MP4</a>';
  } else {
    const err = await res.text();
    r.innerHTML = '<p class="text-red-400">' + err + "</p>";
  }
  btn.disabled = false;
  btn.textContent = "Gerar Video";
});
</script>
</div></body></html>`);
    return;
  }

  // Builder page
  if (path === "/builder.html") {
    if (serveFile(res, join(import.meta.dirname, "builder.html"))) return;
  }

  // Chat page
  if (path === "/chat.html") {
    if (serveFile(res, join(import.meta.dirname, "chat.html"))) return;
  }

  // Render endpoint
  if (path === "/render" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        console.log("BODY:", body);
        const data = JSON.parse(body);
        const result = generate(data);
        if (existsSync(result)) {
          const stat = readFileSync(result);
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Disposition": 'attachment; filename="cartela.mp4"',
            "Content-Length": stat.length,
          });
          res.end(stat);
        } else {
          json(res, 500, { error: "Render failed - no output file" });
        }
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Renders listing
  if (path === "/renders") {
    const { readdirSync } = await import("fs");
    const files = existsSync(RENDERS_DIR) ? readdirSync(RENDERS_DIR) : [];
    json(res, 200, { files: files.filter(f => f.endsWith(".mp4")) });
    return;
  }

  // Serve render files
  if (path.startsWith("/renders/")) {
    if (serveFile(res, join(RENDERS_DIR, path.slice(9)))) return;
  }


  // TTS - List voices
  if (path === "/tts-voices" && req.method === "GET") {
    try {
      const voices = await listVoices();
      json(res, 200, { voices });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // === Template CRUD (Turso) ===

  // GET /templates — list all
  if (path === "/templates" && req.method === "GET") {
    try {
      const list = await listTemplates();
      json(res, 200, { templates: list });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // GET /templates/:id — get one
  const templatesMatch = path.match(/^\/templates\/(\d+)$/);
  if (templatesMatch && req.method === "GET") {
    try {
      const tmpl = await getTemplate(templatesMatch[1]);
      if (!tmpl) { json(res, 404, { error: "Template not found" }); return; }
      json(res, 200, tmpl);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // POST /templates — create
  if (path === "/templates" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const tmpl = await createTemplate(body);
        json(res, 201, tmpl);
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // PUT /templates/:id — update
  if (templatesMatch && req.method === "PUT") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const tmpl = await updateTemplate(templatesMatch[1], body);
        json(res, 200, tmpl);
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // DELETE /templates/:id — delete
  if (templatesMatch && req.method === "DELETE") {
    try {
      await deleteTemplate(templatesMatch[1]);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // TTS - Generate audio
  if (path === "/tts-generate" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const { text, voice_name, max_new_tokens } = JSON.parse(body);
        if (!text) throw new Error("text is required");
        
        const { wavBytes, duration } = await generateTTS(text, voice_name || "Marlon", { maxNewTokens: max_new_tokens || 1024 });
        
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "X-Audio-Duration": String(duration),
        });
        res.end(wavBytes);
      } catch (e) {
        console.error("TTS error:", e.message);
        json(res, 500, { error: e.message });
      }
    });
    return;
  }
  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Cartela API on http://0.0.0.0:${PORT}`);
});
