import { query } from '../config/db.js';

/**
 * Colonnes d'une « carte produit ». userId (facultatif) sert à calculer is_favorite.
 * Les paramètres de la sous-requête favoris sont renvoyés dans `params`.
 */
export function productCardSelect(userId) {
  return {
    sql: `
      p.id, p.name, p.slug, p.audience, p.status, p.min_price AS price, p.rating_avg, p.rating_count,
      p.sales_count, p.is_featured, p.created_at,
      s.id AS shop_id, s.name AS shop_name, s.slug AS shop_slug,
      c.name AS category_name, c.slug AS category_slug,
      (SELECT url FROM product_images pi WHERE pi.product_id = p.id AND pi.media_type = 'image' ORDER BY pi.sort_order, pi.id LIMIT 1) AS image,
      (SELECT MAX(v.compare_at_price) FROM product_variants v
         WHERE v.product_id = p.id AND v.status = 'active' AND v.price = p.min_price) AS compare_at_price,
      (SELECT COALESCE(SUM(v.stock_quantity - v.reserved_quantity), 0) FROM product_variants v
         WHERE v.product_id = p.id AND v.status = 'active') AS stock,
      ${userId ? '(SELECT COUNT(*) FROM wishlist_items w WHERE w.product_id = p.id AND w.user_id = ?) > 0' : '0'} AS is_favorite`,
    params: userId ? [userId] : [],
  };
}

export const PRODUCT_FROM = `
  FROM products p
  JOIN shops s ON s.id = p.shop_id
  JOIN categories c ON c.id = p.category_id`;

export const PUBLIC_WHERE = `p.status = 'published' AND s.status = 'approved'`;

export function normalizeCard(row) {
  return {
    ...row,
    is_favorite: Boolean(row.is_favorite),
    is_featured: Boolean(row.is_featured),
    stock: Number(row.stock),
    in_stock: Number(row.stock) > 0,
    on_sale: row.compare_at_price != null && Number(row.compare_at_price) > Number(row.price),
  };
}

export async function listCards(where, params, { userId, orderBy = 'p.created_at DESC', limit = 12, offset = 0 } = {}) {
  const sel = productCardSelect(userId);
  const rows = await query(
    `SELECT ${sel.sql} ${PRODUCT_FROM} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...sel.params, ...params, limit, offset],
  );
  return rows.map(normalizeCard);
}

/** Recalcule le prix minimal dénormalisé d'un produit. */
export async function refreshMinPrice(productId, conn) {
  const sql = `UPDATE products SET min_price = COALESCE(
      (SELECT MIN(price) FROM product_variants WHERE product_id = ? AND status = 'active'), 0) WHERE id = ?`;
  if (conn) await conn.query(sql, [productId, productId]);
  else await query(sql, [productId, productId]);
}

export async function refreshRating(productId) {
  await query(
    `UPDATE products p SET
       rating_avg = COALESCE((SELECT AVG(rating) FROM reviews WHERE product_id = p.id AND status = 'approved'), 0),
       rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id AND status = 'approved')
     WHERE p.id = ?`,
    [productId],
  );
}

export const SORTS = {
  newest: 'p.published_at DESC, p.id DESC',
  price_asc: 'p.min_price ASC',
  price_desc: 'p.min_price DESC',
  popular: 'p.sales_count DESC, p.views_count DESC',
  rating: 'p.rating_avg DESC, p.rating_count DESC',
};
