/**
 * Turso database client using HTTP API (no native client needed).
 * Uses native fetch() which is available in Node 18+.
 */

const DB_URL = process.env.TURSO_DB_URL || "";
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "";

// Convert libsql:// URL to https:// URL for the HTTP API
function httpUrl() {
  if (!DB_URL) return null;
  // libsql://videodb-elan2021.aws-us-west-2.turso.io
  // → https://videodb-elan2021.aws-us-west-2.turso.io
  return DB_URL.replace(/^libsql:/, "https:") + "/v2/pipeline";
}

async function tursoFetch(sql, args = []) {
  const url = httpUrl();
  if (!url) {
    console.warn("[turso] TURSO_DB_URL not set");
    return null;
  }

  const body = JSON.stringify({
    requests: [
      {
        type: "execute",
        stmt: { sql, args: args.map((a) => ({ type: typeof a === "number" ? "integer" : "text", value: String(a) })) },
      },
    ],
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Turso HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  // Handle pipeline response - get results from first response
  const resp = data?.results?.[0];
  if (!resp) {
    // Could be a success response with no results (INSERT/UPDATE)
    return { rows: [], cols: [] };
  }
  if (resp.type === "error") {
    throw new Error(`Turso error: ${resp.error?.message || JSON.stringify(resp.error)}`);
  }

  const resultResp = resp.response?.result || resp.response;
  const cols = resultResp?.cols || [];
  const rows = (resultResp?.rows || []).map((r) => {
    const row = {};
    r.forEach((cell, i) => {
      const colName = cols[i]?.name || `col${i}`;
      row[colName] = cell.value;
    });
    return row;
  });

  return { rows, cols };
}

/**
 * List all saved templates.
 */
export async function listTemplates() {
  const result = await tursoFetch(
    "SELECT id, name, category, scenes, html, css, created_at, updated_at FROM templates ORDER BY updated_at DESC"
  );
  if (!result) return [];
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category || "",
    scenes: safeJson(r.scenes, {}),
    html: r.html || "",
    css: r.css || "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Get a single template by id.
 */
export async function getTemplate(id) {
  const result = await tursoFetch(
    "SELECT id, name, category, scenes, html, css, created_at, updated_at FROM templates WHERE id = ?",
    [Number(id)]
  );
  if (!result || result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    id: r.id,
    name: r.name,
    category: r.category || "",
    scenes: safeJson(r.scenes, {}),
    html: r.html || "",
    css: r.css || "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Create a new template.
 */
export async function createTemplate(data) {
  const name = data.name || "Untitled";
  const category = data.category || "";
  const scenes = JSON.stringify(data.scenes || {});
  const html = data.html || "";
  const css = data.css || "";

  const result = await tursoFetch(
    "INSERT INTO templates (name, category, scenes, html, css) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at",
    [name, category, scenes, html, css]
  );

  if (!result) throw new Error("Database not configured (TURSO_DB_URL missing)");

  const row = result.rows[0] || {};
  return {
    id: row.id,
    name,
    category,
    scenes: data.scenes || {},
    html,
    css,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

/**
 * Update an existing template.
 */
export async function updateTemplate(id, data) {
  const existing = await getTemplate(id);
  if (!existing) throw new Error("Template not found");

  const name = data.name ?? existing.name;
  const category = data.category ?? existing.category;
  const scenes = data.scenes ? JSON.stringify(data.scenes) : (typeof existing.scenes === "object" ? JSON.stringify(existing.scenes) : existing.scenes);
  const html = data.html ?? existing.html;
  const css = data.css ?? existing.css;

  await tursoFetch(
    "UPDATE templates SET name = ?, category = ?, scenes = ?, html = ?, css = ?, updated_at = datetime('now') WHERE id = ?",
    [name, category, scenes, html, css, Number(id)]
  );

  return getTemplate(id);
}

/**
 * Delete a template.
 */
export async function deleteTemplate(id) {
  await tursoFetch("DELETE FROM templates WHERE id = ?", [Number(id)]);
  return { ok: true };
}

function safeJson(str, fallback) {
  if (!str) return fallback;
  try {
    return typeof str === "string" ? JSON.parse(str) : str;
  } catch {
    return fallback;
  }
}
