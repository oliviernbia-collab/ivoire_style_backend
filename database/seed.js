/**
 * Données de référence + démonstration. Appelé par init.js (ou seul : npm run db:seed sur une base vide).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { CATEGORIES, PRODUCTS, ROLES, SETTINGS, SHOPS, USERS } from './seed-data.js';
import { uploadPath } from '../src/services/storage.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Envoie un visuel de démonstration sur Cloudinary (identifiant fixe : pas de doublon si on relance). */
const seedUrls = new Map();
async function seedImageUrl(file) {
  if (!seedUrls.has(file)) {
    const src = path.join(dir, 'seed-images', file);
    if (!fs.existsSync(src)) return null;
    const r = await uploadPath(src, { folder: 'seed', public_id: path.parse(file).name, overwrite: false, resource_type: 'image' });
    seedUrls.set(file, { url: r.secure_url, public_id: r.public_id });
  }
  return seedUrls.get(file);
}

const PLATFORM_FEE_RATE = 5;
const withFee = (sellerPrice) => Math.round(sellerPrice * (1 + PLATFORM_FEE_RATE / 100));

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function seed(conn) {

  for (const [code, label] of ROLES) await conn.query(`INSERT INTO roles (code, label) VALUES (?, ?)`, [code, label]);
  const [roles] = await conn.query(`SELECT id, code FROM roles`);
  const roleId = Object.fromEntries(roles.map((r) => [r.code, r.id]));

  for (const [i, [name, s, icon]] of CATEGORIES.entries()) {
    await conn.query(`INSERT INTO categories (name, slug, icon, sort_order) VALUES (?, ?, ?, ?)`, [name, s, icon, i]);
  }
  const [cats] = await conn.query(`SELECT id, slug FROM categories`);
  const catId = Object.fromEntries(cats.map((c) => [c.slug, c.id]));

  for (const [k, v, d] of SETTINGS) {
    await conn.query(`INSERT INTO platform_settings (setting_key, setting_value, description) VALUES (?, ?, ?)`, [k, v, d]);
  }

  const userId = {};
  for (const u of USERS) {
    const [r] = await conn.query(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash, email_verified_at) VALUES (?, ?, ?, ?, ?, NOW())`,
      [u.first_name, u.last_name, u.email, u.phone, await bcrypt.hash(u.password, 10)]);
    userId[u.key] = r.insertId;
    for (const role of u.roles) await conn.query(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`, [r.insertId, roleId[role]]);
  }

  await conn.query(
    `INSERT INTO addresses (user_id, label, recipient_name, phone, city, commune, district, street, instructions, is_default)
     VALUES (?, 'Domicile', 'Jean-Marc Gbagbo', '0700000006', 'Abidjan', 'Cocody', 'Riviera 3', 'Rue des Jardins', 'Portail bleu, après la pharmacie', 1)`,
    [userId.client]);

  const shopId = {};
  for (const s of SHOPS) {
    const [r] = await conn.query(
      `INSERT INTO shops (owner_user_id, name, slug, responsible_name, description, phone, email, city, commune,
         payout_method, payout_account, payout_holder, status, is_featured, commission_rate, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, IF(? = 'approved', NOW(), NULL))`,
      [userId[s.owner], s.name, s.slug, s.responsible_name, s.description, s.phone, s.email, s.city, s.commune,
        s.payout_method, s.payout_account, s.responsible_name, s.status, s.is_featured, s.status]);
    shopId[s.slug] = r.insertId;
  }

  const variantsByProduct = [];
  for (const [pi, p] of PRODUCTS.entries()) {
    const [r] = await conn.query(
      `INSERT INTO products (shop_id, category_id, name, slug, description, audience, material, care, origin, status, is_featured,
         published_at, sales_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Lavage à 30°C, repassage doux', 'Côte d’Ivoire', 'published', ?,
         DATE_SUB(NOW(), INTERVAL ? DAY), ?, DATE_SUB(NOW(), INTERVAL ? DAY))`,
      [shopId[p.shop], catId[p.cat], p.name, `${slug(p.name)}-${pi + 1}`, p.description, p.audience, p.material,
        p.featured ? 1 : 0, pi * 2, (pi * 7) % 23, pi * 2]);
    const productId = r.insertId;
    for (const [ci] of p.colors.entries()) {
      const img = await seedImageUrl(`seed-${pi}-${ci}.png`);
      if (!img) continue;
      await conn.query(`INSERT INTO product_images (product_id, url, public_id, media_type, alt, sort_order) VALUES (?, ?, ?, 'image', ?, ?)`,
        [productId, img.url, img.public_id, `${p.name} - ${p.colors[ci][0]}`, ci]);
    }
    const ids = [];
    for (const [color, hex] of p.colors) {
      for (const size of p.sizes) {
        const stock = (pi + size.length + color.length) % 9 === 0 ? 2 : 5 + ((pi * 3 + size.length) % 12);
        const sku = `IVS-${shopId[p.shop]}-${productId}-${slug(size)}-${slug(color)}`.toUpperCase();
        // p.price = prix vendeur ; le client voit ce prix + frais plateforme
        const [v] = await conn.query(
          `INSERT INTO product_variants (product_id, sku, size, color, color_hex, seller_price, seller_compare_at_price, price, compare_at_price, stock_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [productId, sku, size, color, hex, p.price, p.compare, withFee(p.price), p.compare ? withFee(p.compare) : null, stock]);
        await conn.query(`INSERT INTO inventory_movements (variant_id, quantity, reason) VALUES (?, ?, 'initial')`, [v.insertId, stock]);
        ids.push({ id: v.insertId, sku, size, color, price: withFee(p.price), seller_price: p.price });
      }
    }
    await conn.query(`UPDATE products SET min_price = ? WHERE id = ?`, [withFee(p.price), productId]);
    variantsByProduct.push({ productId, shop: p.shop, name: p.name, image: (await seedImageUrl(`seed-${pi}-0.png`))?.url || null, variants: ids });
  }

  // Une commande livrée (paiement à la livraison : acompte 10 % en ligne, solde encaissé par le vendeur)
  const p = variantsByProduct[1];
  const v = p.variants[1];
  const subtotal = v.price * 2;
  const sellerTotal = v.seller_price * 2;
  const fee = subtotal - sellerTotal;
  const delivery = 1500;
  const total = subtotal + delivery;
  const upfront = Math.round(subtotal * 0.10);
  const [o] = await conn.query(
    `INSERT INTO orders (order_number, user_id, shop_id, status, payment_status, payment_method, payment_plan, delivery_mode, subtotal,
       platform_fee, delivery_fee, total_amount, upfront_amount, balance_amount, balance_paid_at, ship_recipient, ship_phone, ship_city,
       ship_commune, ship_district, ship_street, paid_at, created_at)
     VALUES ('IVS-DEMO-000001', ?, ?, 'delivered', 'succeeded', 'wave', 'deposit', 'home', ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 2 DAY),
       'Jean-Marc Gbagbo', '0700000006', 'Abidjan', 'Cocody', 'Riviera 3', 'Rue des Jardins', DATE_SUB(NOW(), INTERVAL 5 DAY), DATE_SUB(NOW(), INTERVAL 5 DAY))`,
    [userId.client, shopId[p.shop], subtotal, fee, delivery, total, upfront, total - upfront]);
  const [oi] = await conn.query(
    `INSERT INTO order_items (order_id, shop_id, product_id, variant_id, product_name, sku, size, color, image_url, unit_price, quantity,
       line_total, commission_rate, commission_amount, seller_amount, fulfillment_status, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, 5, ?, ?, 'delivered', DATE_SUB(NOW(), INTERVAL 2 DAY))`,
    [o.insertId, shopId[p.shop], p.productId, v.id, p.name, v.sku, v.size, v.color, p.image, v.price, subtotal, fee, sellerTotal]);
  await conn.query(
    `INSERT INTO payments (order_id, provider, reference, idempotency_key, amount, status, confirmed_at)
     VALUES (?, 'wave', 'PAY-DEMO-000001', 'demo-1', ?, 'succeeded', DATE_SUB(NOW(), INTERVAL 5 DAY))`, [o.insertId, upfront]);
  for (const [status, days] of [['pending', 5], ['confirmed', 5], ['preparing', 4], ['shipped', 3], ['delivered', 2]]) {
    await conn.query(`INSERT INTO order_status_history (order_id, status, comment, created_at) VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))`,
      [o.insertId, status, 'Démonstration', days]);
  }
  // Le vendeur est crédité de l'acompte encaissé en ligne, moins les frais plateforme (le solde, il l'a encaissé lui-même)
  await conn.query(
    `INSERT INTO seller_ledger_entries (shop_id, order_id, order_item_id, entry_type, amount, description)
     VALUES (?, ?, ?, 'sale', ?, ?), (?, ?, ?, 'commission', ?, 'Frais plateforme 5 %')`,
    [shopId[p.shop], o.insertId, oi.insertId, upfront, 'Paiement en ligne IVS-DEMO-000001',
      shopId[p.shop], o.insertId, oi.insertId, -fee]);

  await conn.query(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, 'seller_request', 'Nouvelle demande vendeur', 'Kente Couture', '/admin/boutiques')`,
    [userId.admin]);

  console.log('✔ Données de démonstration insérées');
  console.log('  Comptes (e-mail / mot de passe) :');
  for (const u of USERS) console.log(`   - ${u.email.padEnd(26)} ${u.password.padEnd(14)} ${u.roles.join(', ')}`);
}

// Exécution directe : npm run db:seed
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { pool } = await import('../src/config/db.js');
  const conn = await pool.getConnection();
  await seed(conn);
  conn.release();
  await pool.end();
}
