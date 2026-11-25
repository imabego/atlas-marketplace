const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.RENDER === "true";

if (!process.env.DATABASE_URL) {
  console.error("ERREUR: DATABASE_URL est absente. Configure-la dans les variables d'environnement.");
  process.exit(1);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], products: [], orders: [], payments: [] }, null, 2));
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render PostgreSQL utilise TLS. Cette option évite les erreurs de certificat
  // dans les environnements Render gérés.
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function cookieToken(req) {
  const cookies = (req.headers.cookie || "").split(";").map(x => x.trim());
  const item = cookies.find(x => x.startsWith("atlas_session="));
  return item ? decodeURIComponent(item.slice("atlas_session=".length)) : null;
}
function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
async function currentUser(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.is_seller AS "isSeller"
     FROM atlas_sessions s JOIN atlas_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash(token)]
  );
  return result.rows[0] || null;
}
async function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO atlas_sessions(token_hash, user_id, expires_at)
     VALUES($1, $2, NOW() + INTERVAL '7 days')
     ON CONFLICT(token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
    [tokenHash(token), userId]
  );
  res.setHeader("Set-Cookie", `atlas_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${IS_PRODUCTION ? "; Secure" : ""}`);
}
async function clearSession(req, res) {
  const token = cookieToken(req);
  if (token) await pool.query("DELETE FROM atlas_sessions WHERE token_hash = $1", [tokenHash(token)]);
  res.setHeader("Set-Cookie", `atlas_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${IS_PRODUCTION ? "; Secure" : ""}`);
}
function safeUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email, isSeller: !!user.isSeller } : null;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Requête trop volumineuse"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}
function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { return send(res, 400, { message: "Adresse invalide." }); }
  if (pathname === "/") pathname = "/index.html";
  const publicRoot = path.resolve(PUBLIC);
  const target = path.resolve(PUBLIC, "." + pathname);
  if (!target.startsWith(publicRoot + path.sep) && target !== publicRoot) {
    return send(res, 403, { message: "Accès refusé" });
  }
  fs.readFile(target, (err, content) => {
    if (err) return send(res, 404, { message: "Fichier introuvable" });
    const ext = path.extname(target);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml", ".png": "image/png",
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(content);
  });
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS atlas_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_seller BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS atlas_products (
      id TEXT PRIMARY KEY,
      seller_id TEXT REFERENCES atlas_users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price NUMERIC(12,2) NOT NULL CHECK (price > 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      category TEXT NOT NULL DEFAULT 'Autres',
      image TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS atlas_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES atlas_users(id),
      items JSONB NOT NULL,
      total NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS atlas_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES atlas_orders(id),
      user_id TEXT NOT NULL REFERENCES atlas_users(id),
      method TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS atlas_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS atlas_products_created_idx ON atlas_products(created_at DESC);
    CREATE INDEX IF NOT EXISTS atlas_orders_user_idx ON atlas_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS atlas_payments_user_idx ON atlas_payments(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS atlas_sessions_expiry_idx ON atlas_sessions(expires_at);
  `);
}

// Importe une seule fois les anciennes données JSON, sans écraser PostgreSQL.
async function importLegacyJson() {
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return; }
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM atlas_users) AS users,
      (SELECT COUNT(*) FROM atlas_products) AS products,
      (SELECT COUNT(*) FROM atlas_orders) AS orders,
      (SELECT COUNT(*) FROM atlas_payments) AS payments
  `);
  const c = counts.rows[0];
  if (Number(c.users) + Number(c.products) + Number(c.orders) + Number(c.payments) > 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of (legacy.users || [])) {
      await client.query(
        `INSERT INTO atlas_users(id,name,email,password_hash,is_seller,created_at)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
        [u.id, u.name, u.email, u.passwordHash, !!u.isSeller, u.createdAt || new Date().toISOString()]
      );
    }
    for (const p of (legacy.products || [])) {
      await client.query(
        `INSERT INTO atlas_products(id,seller_id,name,description,price,stock,category,image,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
        [p.id, p.sellerId || null, p.name, p.description || "", p.price, p.stock || 0, p.category || "Autres", p.image || "", p.createdAt || new Date().toISOString()]
      );
    }
    for (const o of (legacy.orders || [])) {
      await client.query(
        `INSERT INTO atlas_orders(id,user_id,items,total,status,payment_status,created_at)
         VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
        [o.id, o.userId, JSON.stringify(o.items || []), o.total, o.status || "En attente de paiement", o.paymentStatus || "pending", o.createdAt || new Date().toISOString()]
      );
    }
    for (const p of (legacy.payments || [])) {
      await client.query(
        `INSERT INTO atlas_payments(id,order_id,user_id,method,amount,currency,status,reference,created_at,paid_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
        [p.id, p.orderId, p.userId, p.method, p.amount, p.currency || "EUR", p.status || "pending", p.reference, p.createdAt || new Date().toISOString(), p.paidAt || null]
      );
    }
    await client.query("COMMIT");
    console.log("Import JSON terminé (si des données existaient).");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function productRow(row) {
  return {
    id: row.id, sellerId: row.seller_id, name: row.name,
    description: row.description, price: Number(row.price),
    stock: row.stock, category: row.category, image: row.image,
    createdAt: row.created_at
  };
}
function orderRow(row) {
  return {
    id: row.id, userId: row.user_id, items: row.items,
    total: Number(row.total), status: row.status,
    paymentStatus: row.payment_status, createdAt: row.created_at
  };
}
function paymentRow(row) {
  return {
    id: row.id, orderId: row.order_id, userId: row.user_id,
    method: row.method, amount: Number(row.amount), currency: row.currency,
    status: row.status, reference: row.reference,
    createdAt: row.created_at, paidAt: row.paid_at
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname;

  if (req.method === "GET" && route === "/api/health") {
    try {
      await pool.query("SELECT 1");
      return send(res, 200, { ok: true, app: "ATLAS", database: "PostgreSQL", payments: "sandbox" });
    } catch {
      return send(res, 503, { ok: false, message: "Base de données indisponible." });
    }
  }

  try {
    if (req.method === "GET" && route === "/api/me") {
      return send(res, 200, { user: safeUser(await currentUser(req)) });
    }

    if (req.method === "POST" && route === "/api/register") {
      const body = await readBody(req);
      const name = cleanText(body.name, 70);
      const email = cleanText(body.email, 150).toLowerCase();
      const password = String(body.password || "");
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
        return send(res, 400, { message: "Nom, e-mail valide et mot de passe de 8 caractères minimum requis." });
      }
      const user = {
        id: crypto.randomUUID(), name, email,
        passwordHash: hashPassword(password), isSeller: false,
        createdAt: new Date().toISOString()
      };
      try {
        await pool.query(
          `INSERT INTO atlas_users(id,name,email,password_hash,is_seller,created_at)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [user.id, user.name, user.email, user.passwordHash, false, user.createdAt]
        );
      } catch (err) {
        if (err.code === "23505") return send(res, 409, { message: "Cette adresse e-mail est déjà utilisée." });
        throw err;
      }
      await setSession(res, user.id);
      return send(res, 201, { user: safeUser(user) });
    }

    if (req.method === "POST" && route === "/api/login") {
      const body = await readBody(req);
      const email = cleanText(body.email, 150).toLowerCase();
      const result = await pool.query(
        `SELECT id,name,email,password_hash,is_seller AS "isSeller"
         FROM atlas_users WHERE email=$1`,
        [email]
      );
      const user = result.rows[0];
      if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) {
        return send(res, 401, { message: "E-mail ou mot de passe incorrect." });
      }
      await setSession(res, user.id);
      return send(res, 200, { user: safeUser(user) });
    }

    if (req.method === "POST" && route === "/api/logout") {
      await clearSession(req, res);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && route === "/api/products") {
      const q = cleanText(url.searchParams.get("q"), 100);
      const result = await pool.query(
        `SELECT * FROM atlas_products
         WHERE $1 = '' OR name ILIKE $2 OR description ILIKE $2 OR category ILIKE $2
         ORDER BY created_at DESC`,
        [q, `%${q}%`]
      );
      return send(res, 200, { products: result.rows.map(productRow) });
    }

    if (req.method === "POST" && route === "/api/seller/activate") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      await pool.query("UPDATE atlas_users SET is_seller=TRUE WHERE id=$1", [user.id]);
      const updated = { ...user, isSeller: true };
      return send(res, 200, { user: safeUser(updated), message: "Ton espace vendeur est activé." });
    }

    if (route === "/api/seller/products" && req.method === "GET") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const result = await pool.query("SELECT * FROM atlas_products WHERE seller_id=$1 ORDER BY created_at DESC", [user.id]);
      return send(res, 200, { products: result.rows.map(productRow) });
    }

    if (route === "/api/seller/products" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      if (!user.isSeller) return send(res, 403, { message: "Active d'abord ton espace vendeur." });
      const body = await readBody(req);
      const name = cleanText(body.name, 100);
      const description = cleanText(body.description, 1000);
      const price = Number(body.price);
      const stock = Math.floor(Number(body.stock));
      const category = cleanText(body.category, 50) || "Autres";
      const image = cleanText(body.image, 1000);
      if (name.length < 2 || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0) {
        return send(res, 400, { message: "Vérifie le nom, le prix et le stock." });
      }
      if (image && !/^https?:\/\//i.test(image)) return send(res, 400, { message: "L'image doit être une adresse URL http(s)." });
      const id = crypto.randomUUID();
      const result = await pool.query(
        `INSERT INTO atlas_products(id,seller_id,name,description,price,stock,category,image)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, user.id, name, description, price, stock, category, image]
      );
      return send(res, 201, { product: productRow(result.rows[0]) });
    }

    const productMatch = route.match(/^\/api\/seller\/products\/([a-f0-9-]+)$/i);
    if (productMatch && ["PUT", "DELETE"].includes(req.method)) {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      if (req.method === "DELETE") {
        const result = await pool.query("DELETE FROM atlas_products WHERE id=$1 AND seller_id=$2 RETURNING id", [productMatch[1], user.id]);
        if (!result.rowCount) return send(res, 404, { message: "Produit introuvable." });
        return send(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const name = cleanText(body.name, 100);
      const price = Number(body.price);
      const stock = Math.floor(Number(body.stock));
      if (!name || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0) {
        return send(res, 400, { message: "Vérifie le nom, le prix et le stock." });
      }
      const result = await pool.query(
        `UPDATE atlas_products SET name=$1,description=$2,price=$3,stock=$4,category=$5,image=$6
         WHERE id=$7 AND seller_id=$8 RETURNING *`,
        [name, cleanText(body.description, 1000), price, stock, cleanText(body.category, 50) || "Autres", cleanText(body.image, 1000), productMatch[1], user.id]
      );
      if (!result.rowCount) return send(res, 404, { message: "Produit introuvable." });
      return send(res, 200, { product: productRow(result.rows[0]) });
    }

    if (req.method === "POST" && route === "/api/orders") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connecte-toi pour passer une commande." });
      const body = await readBody(req);
      if (!Array.isArray(body.items) || !body.items.length) return send(res, 400, { message: "Ton panier est vide." });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lines = [];
        for (const item of body.items) {
          const qty = Math.floor(Number(item.quantity));
          if (!Number.isInteger(qty) || qty < 1) {
            await client.query("ROLLBACK");
            return send(res, 400, { message: "Quantité de produit invalide." });
          }
          const found = await client.query("SELECT * FROM atlas_products WHERE id=$1 FOR UPDATE", [item.id]);
          const p = found.rows[0];
          if (!p || p.stock < qty) {
            await client.query("ROLLBACK");
            return send(res, 400, { message: "Un produit n'est plus disponible dans cette quantité." });
          }
          lines.push({ productId: p.id, name: p.name, price: Number(p.price), quantity: qty, sellerId: p.seller_id });
        }
        for (const line of lines) {
          await client.query("UPDATE atlas_products SET stock=stock-$1 WHERE id=$2", [line.quantity, line.productId]);
        }
        const total = Number(lines.reduce((sum, line) => sum + line.price * line.quantity, 0).toFixed(2));
        const order = {
          id: crypto.randomUUID(), userId: user.id, items: lines, total,
          status: "En attente de paiement", paymentStatus: "pending",
          createdAt: new Date().toISOString()
        };
        await client.query(
          `INSERT INTO atlas_orders(id,user_id,items,total,status,payment_status,created_at)
           VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)`,
          [order.id, order.userId, JSON.stringify(order.items), order.total, order.status, order.paymentStatus, order.createdAt]
        );
        await client.query("COMMIT");
        return send(res, 201, { order, message: "Commande créée. Choisis maintenant un moyen de paiement de démonstration." });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && route === "/api/payments") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const body = await readBody(req);
      const allowed = ["orange_money", "airtel_money", "mpesa", "card"];
      if (!allowed.includes(body.method)) return send(res, 400, { message: "Choisis un moyen de paiement disponible." });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query("SELECT * FROM atlas_orders WHERE id=$1 AND user_id=$2 FOR UPDATE", [body.orderId, user.id]);
        const row = found.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return send(res, 404, { message: "Commande introuvable." });
        }
        if (row.payment_status === "paid") {
          await client.query("ROLLBACK");
          return send(res, 409, { message: "Cette commande est déjà payée." });
        }
        const pending = await client.query(
          "SELECT * FROM atlas_payments WHERE order_id=$1 AND user_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1",
          [row.id, user.id]
        );
        if (pending.rows[0]) {
          await client.query("COMMIT");
          return send(res, 200, { payment: paymentRow(pending.rows[0]), message: "Une transaction est déjà en attente." });
        }
        const payment = {
          id: crypto.randomUUID(), orderId: row.id, userId: user.id,
          method: body.method, amount: Number(row.total), currency: "EUR",
          status: "pending", reference: "AT-" + crypto.randomBytes(5).toString("hex").toUpperCase(),
          createdAt: new Date().toISOString()
        };
        const inserted = await client.query(
          `INSERT INTO atlas_payments(id,order_id,user_id,method,amount,currency,status,reference,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [payment.id, payment.orderId, payment.userId, payment.method, payment.amount, payment.currency, payment.status, payment.reference, payment.createdAt]
        );
        await client.query("UPDATE atlas_orders SET payment_status='pending',status='En attente de paiement' WHERE id=$1", [row.id]);
        await client.query("COMMIT");
        return send(res, 201, { payment: paymentRow(inserted.rows[0]), message: "Transaction de démonstration créée. Aucun paiement réel n'a été lancé." });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    const simulateMatch = route.match(/^\/api\/payments\/([a-f0-9-]+)\/simulate-success$/i);
    if (req.method === "POST" && simulateMatch) {
      if (IS_PRODUCTION) return send(res, 403, { message: "La simulation de paiement est désactivée en production." });
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query("SELECT * FROM atlas_payments WHERE id=$1 AND user_id=$2 FOR UPDATE", [simulateMatch[1], user.id]);
        const payment = found.rows[0];
        if (!payment) {
          await client.query("ROLLBACK");
          return send(res, 404, { message: "Transaction introuvable." });
        }
        if (payment.status === "paid") {
          await client.query("ROLLBACK");
          return send(res, 200, { payment: paymentRow(payment), message: "Cette simulation est déjà confirmée." });
        }
        if (payment.status !== "pending") {
          await client.query("ROLLBACK");
          return send(res, 409, { message: "Cette transaction ne peut pas être confirmée." });
        }
        const orderResult = await client.query("SELECT * FROM atlas_orders WHERE id=$1 AND user_id=$2 FOR UPDATE", [payment.order_id, user.id]);
        const order = orderResult.rows[0];
        if (!order) {
          await client.query("ROLLBACK");
          return send(res, 404, { message: "Commande associée introuvable." });
        }
        const paidAt = new Date().toISOString();
        const updatedPayment = await client.query(
          "UPDATE atlas_payments SET status='paid',paid_at=$1 WHERE id=$2 RETURNING *",
          [paidAt, payment.id]
        );
        const updatedOrder = await client.query(
          "UPDATE atlas_orders SET payment_status='paid',status='Payée (simulation)' WHERE id=$1 RETURNING *",
          [order.id]
        );
        await client.query("COMMIT");
        return send(res, 200, {
          payment: paymentRow(updatedPayment.rows[0]),
          order: orderRow(updatedOrder.rows[0]),
          message: "Paiement simulé avec succès. Aucun argent réel n'a été débité."
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    if (req.method === "GET" && route === "/api/orders") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const result = await pool.query("SELECT * FROM atlas_orders WHERE user_id=$1 ORDER BY created_at DESC", [user.id]);
      return send(res, 200, { orders: result.rows.map(orderRow) });
    }

    if (req.method === "GET" && route.startsWith("/api/")) {
      return send(res, 404, { message: "Route API inconnue." });
    }
    return serveStatic(req, res);
  } catch (err) {
    console.error("Erreur API:", err);
    return send(res, 500, { message: "Erreur serveur. Vérifie les données envoyées." });
  }
});

async function start() {
  await pool.query("SELECT 1");
  await createSchema();
  await importLegacyJson();
  await pool.query("DELETE FROM atlas_sessions WHERE expires_at < NOW()");
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ATLAS prêt sur le port ${PORT}${IS_PRODUCTION ? " (production)" : " (développement)"} — PostgreSQL connecté`);
  });
}
start().catch(err => {
  console.error("Impossible de démarrer ATLAS avec PostgreSQL:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
