const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const sessions = new Map();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], products: [], orders: [], payments: [] }, null, 2));

function readDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    db.users ||= []; db.products ||= []; db.orders ||= []; db.payments ||= [];
    return db;
  } catch {
    return { users: [], products: [], orders: [], payments: [] };
  }
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function cookieToken(req) {
  const cookies = (req.headers.cookie || "").split(";").map(x => x.trim());
  const item = cookies.find(x => x.startsWith("atlas_session="));
  return item ? decodeURIComponent(item.split("=").slice(1).join("=")) : null;
}
function currentUser(req) {
  const token = cookieToken(req);
  const userId = token && sessions.get(token);
  return userId ? readDB().users.find(u => u.id === userId) || null : null;
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, userId);
  res.setHeader("Set-Cookie", `atlas_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${IS_PRODUCTION ? "; Secure" : ""}`);
}
function clearSession(req, res) {
  const token = cookieToken(req);
  if (token) sessions.delete(token);
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
      if (raw.length > 1_000_000) { reject(new Error("Requête trop volumineuse")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function cleanText(value, max = 500) { return String(value || "").trim().slice(0, max); }
function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { return send(res, 400, { message: "Adresse invalide." }); }
  if (pathname === "/") pathname = "/index.html";
  const target = path.resolve(PUBLIC, "." + pathname);
  if (!target.startsWith(path.resolve(PUBLIC) + path.sep) && target !== path.resolve(PUBLIC))
    return send(res, 403, { message: "Accès refusé" });
  fs.readFile(target, (err, content) => {
    if (err) return send(res, 404, { message: "Fichier introuvable" });
    const ext = path.extname(target);
    const types = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".webp":"image/webp" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname;
  if (req.method === "GET" && route === "/api/health") return send(res, 200, { ok: true, app: "ATLAS", payments: "sandbox" });

  try {
    if (req.method === "GET" && route === "/api/me") return send(res, 200, { user: safeUser(currentUser(req)) });

    if (req.method === "POST" && route === "/api/register") {
      const body = await readBody(req);
      const name = cleanText(body.name, 70);
      const email = cleanText(body.email, 150).toLowerCase();
      const password = String(body.password || "");
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8)
        return send(res, 400, { message: "Nom, e-mail valide et mot de passe de 8 caractères minimum requis." });
      const db = readDB();
      if (db.users.some(u => u.email === email)) return send(res, 409, { message: "Cette adresse e-mail est déjà utilisée." });
      const user = { id: crypto.randomUUID(), name, email, passwordHash: hashPassword(password), isSeller: false, createdAt: new Date().toISOString() };
      db.users.push(user); writeDB(db); setSession(res, user.id);
      return send(res, 201, { user: safeUser(user) });
    }

    if (req.method === "POST" && route === "/api/login") {
      const body = await readBody(req);
      const email = cleanText(body.email, 150).toLowerCase();
      const db = readDB();
      const user = db.users.find(u => u.email === email);
      if (!user || !verifyPassword(String(body.password || ""), user.passwordHash))
        return send(res, 401, { message: "E-mail ou mot de passe incorrect." });
      setSession(res, user.id);
      return send(res, 200, { user: safeUser(user) });
    }

    if (req.method === "POST" && route === "/api/logout") {
      clearSession(req, res); return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && route === "/api/products") {
      const db = readDB();
      const q = cleanText(url.searchParams.get("q"), 100).toLowerCase();
      const products = db.products.filter(p => !q || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q));
      return send(res, 200, { products });
    }

    if (req.method === "POST" && route === "/api/seller/activate") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const db = readDB(); const target = db.users.find(u => u.id === user.id);
      target.isSeller = true; writeDB(db);
      return send(res, 200, { user: safeUser(target), message: "Ton espace vendeur est activé." });
    }

    if (route === "/api/seller/products" && req.method === "GET") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const db = readDB();
      return send(res, 200, { products: db.products.filter(p => p.sellerId === user.id) });
    }

    if (route === "/api/seller/products" && req.method === "POST") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      if (!user.isSeller) return send(res, 403, { message: "Active d'abord ton espace vendeur." });
      const body = await readBody(req);
      const name = cleanText(body.name, 100), description = cleanText(body.description, 1000);
      const price = Number(body.price), stock = Math.floor(Number(body.stock));
      const category = cleanText(body.category, 50) || "Autres";
      const image = cleanText(body.image, 1000);
      if (name.length < 2 || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0)
        return send(res, 400, { message: "Vérifie le nom, le prix et le stock." });
      if (image && !/^https?:\/\//i.test(image)) return send(res, 400, { message: "L'image doit être une adresse URL http(s)." });
      const db = readDB();
      const product = { id: crypto.randomUUID(), sellerId: user.id, name, description, price, stock, category, image, createdAt: new Date().toISOString() };
      db.products.unshift(product); writeDB(db);
      return send(res, 201, { product });
    }

    const productMatch = route.match(/^\/api\/seller\/products\/([a-f0-9-]+)$/i);
    if (productMatch && ["PUT", "DELETE"].includes(req.method)) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const db = readDB(); const product = db.products.find(p => p.id === productMatch[1] && p.sellerId === user.id);
      if (!product) return send(res, 404, { message: "Produit introuvable." });
      if (req.method === "DELETE") {
        db.products = db.products.filter(p => p.id !== product.id); writeDB(db);
        return send(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const price = Number(body.price), stock = Math.floor(Number(body.stock));
      if (!cleanText(body.name, 100) || !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0)
        return send(res, 400, { message: "Vérifie le nom, le prix et le stock." });
      Object.assign(product, { name: cleanText(body.name,100), description: cleanText(body.description,1000), price, stock, category: cleanText(body.category,50) || "Autres", image: cleanText(body.image,1000) });
      writeDB(db); return send(res, 200, { product });
    }

    if (req.method === "POST" && route === "/api/orders") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connecte-toi pour passer une commande." });
      const body = await readBody(req);
      if (!Array.isArray(body.items) || !body.items.length) return send(res, 400, { message: "Ton panier est vide." });
      const db = readDB(); const lines = [];
      for (const item of body.items) {
        const product = db.products.find(p => p.id === item.id);
        const qty = Math.floor(Number(item.quantity));
        if (!product || !Number.isInteger(qty) || qty < 1 || product.stock < qty)
          return send(res, 400, { message: "Un produit n'est plus disponible dans cette quantité." });
        lines.push({ productId: product.id, name: product.name, price: product.price, quantity: qty, sellerId: product.sellerId });
      }
      for (const line of lines) db.products.find(p => p.id === line.productId).stock -= line.quantity;
      const order = {
        id: crypto.randomUUID(), userId: user.id, items: lines,
        total: Number(lines.reduce((s,x) => s + x.price*x.quantity, 0).toFixed(2)),
        status: "En attente de paiement", paymentStatus: "pending",
        createdAt: new Date().toISOString()
      };
      db.orders.unshift(order); writeDB(db);
      return send(res, 201, { order, message: "Commande créée. Choisis maintenant un moyen de paiement de démonstration." });
    }

    if (req.method === "POST" && route === "/api/payments") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const body = await readBody(req);
      const allowed = ["orange_money", "airtel_money", "mpesa", "card"];
      if (!allowed.includes(body.method)) return send(res, 400, { message: "Choisis un moyen de paiement disponible." });
      const db = readDB();
      const order = db.orders.find(o => o.id === body.orderId && o.userId === user.id);
      if (!order) return send(res, 404, { message: "Commande introuvable." });
      if (order.paymentStatus === "paid") return send(res, 409, { message: "Cette commande est déjà payée." });
      const existing = db.payments.find(p => p.orderId === order.id && p.userId === user.id && p.status === "pending");
      if (existing) return send(res, 200, { payment: existing, message: "Une transaction est déjà en attente." });
      const payment = {
        id: crypto.randomUUID(), orderId: order.id, userId: user.id,
        method: body.method, amount: order.total, currency: "EUR",
        status: "pending", reference: "AT-" + crypto.randomBytes(5).toString("hex").toUpperCase(),
        createdAt: new Date().toISOString()
      };
      db.payments.unshift(payment); order.paymentStatus = "pending"; order.status = "En attente de paiement";
      writeDB(db);
      return send(res, 201, { payment, message: "Transaction de démonstration créée. Aucun paiement réel n'a été lancé." });
    }

    const simulateMatch = route.match(/^\/api\/payments\/([a-f0-9-]+)\/simulate-success$/i);
    if (req.method === "POST" && simulateMatch) {
      if (IS_PRODUCTION) return send(res, 403, { message: "La simulation de paiement est désactivée en production." });
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const db = readDB();
      const payment = db.payments.find(p => p.id === simulateMatch[1] && p.userId === user.id);
      if (!payment) return send(res, 404, { message: "Transaction introuvable." });
      if (payment.status === "paid") return send(res, 200, { payment, message: "Cette simulation est déjà confirmée." });
      if (payment.status !== "pending") return send(res, 409, { message: "Cette transaction ne peut pas être confirmée." });
      const order = db.orders.find(o => o.id === payment.orderId && o.userId === user.id);
      if (!order) return send(res, 404, { message: "Commande associée introuvable." });
      payment.status = "paid"; payment.paidAt = new Date().toISOString();
      order.paymentStatus = "paid"; order.status = "Payée (simulation)";
      writeDB(db);
      return send(res, 200, { payment, order, message: "Paiement simulé avec succès. Aucun argent réel n'a été débité." });
    }

    if (req.method === "GET" && route === "/api/orders") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { message: "Connexion obligatoire." });
      const db = readDB();
      return send(res, 200, { orders: db.orders.filter(o => o.userId === user.id) });
    }

    if (req.method === "GET" && route.startsWith("/api/")) return send(res, 404, { message: "Route API inconnue." });
    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return send(res, 500, { message: "Erreur serveur. Vérifie les données envoyées." });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`ATLAS prêt sur le port ${PORT}${IS_PRODUCTION ? " (production)" : " (développement)"}`));
