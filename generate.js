import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATES_DIR = join(__dirname, "templates");
const RENDERS_DIR = join(__dirname, "renders");
const PROJECT_DIR = join(__dirname, "_build");

const DEFAULTS = {
  banner_title: "Oferta",
  banner_sub: "Promocao",
  tag_text: "Flash",
  bg1: "#1a1a2e",
  bg2: "#0f3460",
  accent1: "#ffd700",
  accent2: "#ff6b00",
  price_int: "19",
  price_dec: "90",
  price_size: 180,
  price_cents_size: 80,
  unit: "cada",
  product_name: "Produto",
  product_detail: "Marca 900ml",
  old_price: "24,90",
  store_name: "Supermercado Bom Preco",
  validity: "Oferta valida ate 31/12/2026",
  duration: 10,
  fps: 30,
  quality: "draft",
  output: null,
};

function fillTemplate(html, data) {
  return html.replace(/\{(\w+)\}/g, (_, key) => {
    if (data[key] === undefined || data[key] === null) return `{${key}}`;
    return String(data[key]);
  });
}

function slugify(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

export function generate(data) {
  const merged = { ...DEFAULTS, ...data };

  if (!merged.template) merged.template = "classica";
  if (merged.price && !merged.price_int) {
    const parts = String(merged.price).replace("R$", "").trim().split(/[,.]/);
    merged.price_int = parts[0];
    merged.price_dec = parts[1] || "00";
  }

  let html;
  if (merged.custom_html) {
    html = merged.custom_html;
  } else {
    const tmplPath = join(TEMPLATES_DIR, `${merged.template}.html`);
    if (!existsSync(tmplPath)) {
      throw new Error(`Template "${merged.template}" not found at ${tmplPath}`);
    }
    const tmpl = readFileSync(tmplPath, "utf-8");
    html = fillTemplate(tmpl, merged);
  }

  // Build project structure
  if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });
  mkdirSync(join(PROJECT_DIR, "renders"), { recursive: true });

  // Write hyperframes.json
  writeFileSync(join(PROJECT_DIR, "hyperframes.json"), JSON.stringify({
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    paths: { assets: "assets" },
  }, null, 2));

  // Write index.html
  writeFileSync(join(PROJECT_DIR, "index.html"), html);

  // Render
  const outputName = merged.output || `${slugify(merged.product_name)}_${slugify(merged.store_name)}`;
  const outputPath = join(RENDERS_DIR, `${outputName}.mp4`);

  console.log(`Rendering ${merged.template} -> ${outputName}.mp4 ...`);
  const start = Date.now();

  const proc = spawnSync("npx", [
    "hyperframes", "render",
    "-f", String(merged.fps),
    "-q", merged.quality,
    "-w", "1",
    "-o", outputPath,
  ], {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
    timeout: 300000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (proc.stdout) {
    for (const line of proc.stdout.split("\n")) {
      if (line.includes(".mp4") && (line.includes("Render complete") || line.includes("renders"))) {
        console.log(line.trim());
      }
    }
  }

  if (proc.error || proc.status !== 0) {
    const errMsg = proc.stderr?.slice(0, 500) || proc.error?.message || `exit code ${proc.status}`;
    throw new Error(`Render failed: ${errMsg}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const size = existsSync(outputPath) ? (readFileSync(outputPath).length / 1024).toFixed(0) : "?";
  console.log(`Done in ${elapsed}s | ${size} KB`);

  rmSync(PROJECT_DIR, { recursive: true });

  return outputPath;
}

// CLI (só roda quando executado diretamente, não quando importado)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const dataPath = args[0];
  const data = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, "utf-8")) : {};
  const cliOverrides = {};
  for (let i = 1; i < args.length; i++) {
    const m = args[i].match(/^--(\w+)=(.+)$/);
    if (m) cliOverrides[m[1]] = m[2];
  }
  generate({ ...data, ...cliOverrides });
}
