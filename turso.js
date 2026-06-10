import { createClient } from "@libsql/client";

let db = null;

function getDb() {
  if (db) return db;
  const url = process.env.TURSO_DB_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    console.warn("[turso] TURSO_DB_URL not set — running without database");
    return null;
  }
  db = createClient({ url, authToken });
  return db;
}

/**
 * List all saved templates.
 */
export async function listTemplates() {
  const client = getDb();
  if (!client) return [];
  const rs = await client.execute(
    "SELECT id, name, category, scenes, html, css, created_at, updated_at FROM templates ORDER BY updated_at DESC"
  );
  return rs.rows.map((r) => ({
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
  const client = getDb();
  if (!client) return null;
  const rs = await client.execute(
    "SELECT id, name, category, scenes, html, css, created_at, updated_at FROM templates WHERE id = ?",
    [Number(id)]
  );
  if (rs.rows.length === 0) return null;
  const r = rs.rows[0];
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
 * @param {object} data - { name, category, scenes, html, css }
 * @returns created template object
 */
export async function createTemplate(data) {
  const client = getDb();
  if (!client) throw new Error("Database not configured (TURSO_DB_URL missing)");
  const name = data.name || "Untitled";
  const category = data.category || "";
  const scenes = JSON.stringify(data.scenes || {});
  const html = data.html || "";
  const css = data.css || "";

  const rs = await client.execute(
    "INSERT INTO templates (name, category, scenes, html, css) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at",
    [name, category, scenes, html, css]
  );
  const row = rs.rows[0];
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
  const client = getDb();
  if (!client) throw new Error("Database not configured (TURSO_DB_URL missing)");

  const existing = await getTemplate(id);
  if (!existing) throw new Error("Template not found");

  const name = data.name ?? existing.name;
  const category = data.category ?? existing.category;
  const scenes = data.scenes ? JSON.stringify(data.scenes) : existing.scenes;
  const html = data.html ?? existing.html;
  const css = data.css ?? existing.css;

  // For scenes, if it's a string (JSON), keep it; if it's an object, stringify it
  const scenesStr = typeof scenes === "string" ? scenes : JSON.stringify(scenes);

  await client.execute(
    "UPDATE templates SET name = ?, category = ?, scenes = ?, html = ?, css = ?, updated_at = datetime('now') WHERE id = ?",
    [name, category, scenesStr, html, css, Number(id)]
  );

  return getTemplate(id);
}

/**
 * Delete a template.
 */
export async function deleteTemplate(id) {
  const client = getDb();
  if (!client) throw new Error("Database not configured (TURSO_DB_URL missing)");
  await client.execute("DELETE FROM templates WHERE id = ?", [Number(id)]);
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
