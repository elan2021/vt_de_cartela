import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { generate } from "/opt/cartelas/generate.js";

const PORT = 3461;
const RENDERS_DIR = "/opt/cartelas/renders";

const renders = {};

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Async render
  if (path === "/render-async" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const data = JSON.parse(body);
        
        const slugify = (t) => String(t || "")
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        const outputName = data.output || `${slugify(data.product_name)}_${slugify(data.store_name)}_${Date.now()}`;
        data.output = outputName;
        
        renders[outputName] = { status: "processing", started: Date.now() };
        
        // Run render in next tick to not block response
        setImmediate(() => {
          try {
            generate(data);
            renders[outputName].status = "done";
            renders[outputName].finished = Date.now();
            renders[outputName].duration = ((Date.now() - renders[outputName].started) / 1000).toFixed(1);
            console.log(`[render-async] Done: ${outputName}.mp4 (${renders[outputName].duration}s)`);
          } catch (e) {
            renders[outputName].status = "error";
            renders[outputName].error = e.message;
            console.error(`[render-async] Error: ${e.message}`);
          }
        });
        
        json(res, 200, {
          render_id: outputName,
          status: "processing",
          check_url: `http://57.130.65.27:3461/render-status/${outputName}`,
          download_url: `http://57.130.65.27:3460/renders/${outputName}.mp4`,
        });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Render status
  if (path.startsWith("/render-status/")) {
    const renderId = path.slice(15);
    const render = renders[renderId];
    
    if (!render) {
      const filePath = join(RENDERS_DIR, `${renderId}.mp4`);
      if (existsSync(filePath)) {
        const stat = readFileSync(filePath);
        json(res, 200, {
          render_id: renderId,
          status: "done",
          download_url: `http://57.130.65.27:3460/renders/${renderId}.mp4`,
          size_kb: Math.round(stat.length / 1024),
        });
      } else {
        json(res, 404, { error: "Render not found" });
      }
      return;
    }
    
    const resp = { render_id: renderId, status: render.status };
    if (render.status === "done") {
      resp.download_url = `http://57.130.65.27:3460/renders/${renderId}.mp4`;
      resp.duration = render.duration;
      const filePath = join(RENDERS_DIR, `${renderId}.mp4`);
      resp.size_kb = existsSync(filePath) ? Math.round(readFileSync(filePath).length / 1024) : 0;
    } else if (render.status === "error") {
      resp.error = render.error;
    }
    json(res, 200, resp);
    return;
  }

  // Health check
  if (path === "/health") {
    json(res, 200, { status: "ok", renders: Object.keys(renders).length });
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Render Async Server on http://0.0.0.0:${PORT}`);
});
