/**
 * Mise à jour d'une base existante vers le schéma courant, sans perte de données.
 * Chaque étape vérifie l'état actuel avant d'agir : relançable sans risque.
 * Utilisée par « npm run db:migrate » et au démarrage de l'API (déploiement continu).
 * Renvoie le nombre de modifications appliquées.
 */
export async function migrate(conn, log = console.log) {
  let changes = 0;

  async function hasColumn(table, column) {
    const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
    return rows.length > 0;
  }
  async function addColumn(table, column, definition) {
    if (await hasColumn(table, column)) return;
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    log(`✔ ${table}.${column} ajoutée`);
    changes++;
  }
  async function createTable(name, sql) {
    const [rows] = await conn.query(`SHOW TABLES LIKE ?`, [name]);
    if (rows.length) return;
    await conn.query(sql);
    log(`✔ Table ${name} créée`);
    changes++;
  }

  // Médias Cloudinary
  await addColumn('product_images', 'public_id', 'VARCHAR(255) NULL AFTER url');
  await addColumn('product_images', 'media_type', "ENUM('image','video') NOT NULL DEFAULT 'image' AFTER public_id");

  // Boutique officielle du super admin
  await addColumn('shops', 'is_official', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER is_featured');

  // Promotions ciblées (clients actifs / vendeurs très actifs)
  await addColumn('promotions', 'target', "ENUM('clients','sellers') NOT NULL DEFAULT 'clients' AFTER id");
  await addColumn('promotions', 'description', 'VARCHAR(500) NULL AFTER title');
  await addColumn('promotions', 'min_order_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER discount_value');
  await addColumn('promotions', 'max_uses_per_user', 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER min_order_amount');
  await addColumn('promotions', 'commission_rate', 'DECIMAL(5,2) NULL AFTER max_uses_per_user');
  await addColumn('promotions', 'feature_shops', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER commission_rate');
  await addColumn('promotions', 'created_by', 'INT UNSIGNED NULL AFTER is_active');
  const [[dv]] = await conn.query(`SHOW COLUMNS FROM promotions LIKE 'discount_value'`);
  if (dv && dv.Default === null) {
    await conn.query(`ALTER TABLE promotions MODIFY discount_value DECIMAL(12,2) NOT NULL DEFAULT 0`);
    log('✔ promotions.discount_value : valeur par défaut 0');
    changes++;
  }
  await createTable('promotion_users', `CREATE TABLE promotion_users (
      promotion_id INT UNSIGNED NOT NULL,
      user_id      INT UNSIGNED NOT NULL,
      used_count   INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (promotion_id, user_id),
      KEY idx_pu_user (user_id),
      CONSTRAINT fk_pu_promo FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
      CONSTRAINT fk_pu_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await createTable('promotion_shops', `CREATE TABLE promotion_shops (
      promotion_id INT UNSIGNED NOT NULL,
      shop_id      INT UNSIGNED NOT NULL,
      PRIMARY KEY (promotion_id, shop_id),
      KEY idx_ps_shop (shop_id),
      CONSTRAINT fk_ps_promo FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
      CONSTRAINT fk_ps_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await addColumn('orders', 'promotion_id', 'INT UNSIGNED NULL AFTER discount_total');
  await addColumn('orders', 'promo_code', 'VARCHAR(40) NULL AFTER promotion_id');

  // ---------------------------------------------------------------------------------------------
  // Modèle économique simplifié : +5 % plateforme sur chaque produit, livraison gérée par le vendeur,
  // paiement total / moitié / acompte 10 % (solde encaissé par le vendeur à la livraison)
  // ---------------------------------------------------------------------------------------------
  await addColumn('product_variants', 'seller_price', 'DECIMAL(12,2) NULL AFTER color_hex');
  await addColumn('product_variants', 'seller_compare_at_price', 'DECIMAL(12,2) NULL AFTER seller_price');

  await addColumn('shops', 'delivery_fee_abidjan', 'DECIMAL(12,2) NOT NULL DEFAULT 1500 AFTER payout_account');
  await addColumn('shops', 'delivery_fee_other', 'DECIMAL(12,2) NOT NULL DEFAULT 3000 AFTER delivery_fee_abidjan');
  await addColumn('shops', 'free_delivery_threshold', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER delivery_fee_other');
  await addColumn('shops', 'allow_shop_pickup', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER free_delivery_threshold');
  await addColumn('shops', 'delivery_info', 'VARCHAR(500) NULL AFTER allow_shop_pickup');
  await addColumn('shops', 'payout_holder', 'VARCHAR(120) NULL AFTER payout_account');

  await addColumn('orders', 'shop_id', 'INT UNSIGNED NULL AFTER user_id');
  await addColumn('orders', 'payment_plan', "ENUM('full','half','deposit') NOT NULL DEFAULT 'full' AFTER payment_method");
  await addColumn('orders', 'platform_fee', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER promo_code');
  await addColumn('orders', 'upfront_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER total_amount');
  await addColumn('orders', 'balance_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER upfront_amount');
  await addColumn('orders', 'balance_paid_at', 'DATETIME NULL AFTER balance_amount');
  const [[ps]] = await conn.query(`SHOW COLUMNS FROM orders LIKE 'payment_status'`);
  if (!ps.Type.includes('partially_paid')) {
    await conn.query(`ALTER TABLE orders MODIFY payment_status ENUM('initiated','pending','partially_paid','succeeded','failed',
      'cancelled','refunding','partially_refunded','refunded') NOT NULL DEFAULT 'pending'`);
    log('✔ orders.payment_status : statut « partially_paid » (acompte payé) ajouté');
    changes++;
  }
  await addColumn('seller_ledger_entries', 'order_id', 'INT UNSIGNED NULL AFTER shop_id');
  // Commandes antérieures : boutique d'origine et montant considéré comme payé en totalité
  const [legacy] = await conn.query(
    `UPDATE orders o SET shop_id = (SELECT MIN(oi.shop_id) FROM order_items oi WHERE oi.order_id = o.id),
       upfront_amount = total_amount, platform_fee = (SELECT COALESCE(SUM(oi.commission_amount), 0) FROM order_items oi WHERE oi.order_id = o.id)
     WHERE o.shop_id IS NULL`);
  if (legacy.affectedRows) { log(`✔ ${legacy.affectedRows} commande(s) existante(s) mise(s) à jour`); changes++; }
  await conn.query(`UPDATE seller_ledger_entries e JOIN order_items oi ON oi.id = e.order_item_id SET e.order_id = oi.order_id WHERE e.order_id IS NULL`);

  // Paramètres : frais plateforme / acompte / paiement en deux fois ; les anciens réglages
  // (livraison et commission gérées par la plateforme) sont retirés
  const newSettings = [
    ['platform_fee_rate', '5', 'Frais plateforme (%) ajoutés au prix de chaque produit et versés à la plateforme'],
    ['deposit_rate', '10', 'Acompte (%) payé en ligne pour un paiement à la livraison'],
    ['half_payment_rate', '50', 'Part (%) payée en ligne pour un paiement en deux fois'],
  ];
  for (const [k, v, d] of newSettings) {
    const [r] = await conn.query(`INSERT IGNORE INTO platform_settings (setting_key, setting_value, description) VALUES (?, ?, ?)`, [k, v, d]);
    if (r.affectedRows) { log(`✔ Paramètre ${k} = ${v}`); changes++; }
  }
  const [del] = await conn.query(`DELETE FROM platform_settings WHERE setting_key IN
    ('delivery_fee_abidjan', 'delivery_fee_other', 'free_delivery_threshold', 'default_commission_rate')`);
  if (del.affectedRows) { log(`✔ ${del.affectedRows} ancien(s) paramètre(s) de livraison/commission retiré(s)`); changes++; }
  await conn.query(`UPDATE platform_settings SET description = ? WHERE setting_key = 'payment_methods'`,
    ['Moyens de paiement actifs : opérateurs Mobile Money, et cash_on_delivery pour le paiement à la livraison (avec acompte)']);

  // Prix existants → prix vendeur ; prix affiché au client = prix vendeur + frais plateforme
  const [[{ setting_value: feeRate }]] = await conn.query(`SELECT setting_value FROM platform_settings WHERE setting_key = 'platform_fee_rate'`);
  const [conv] = await conn.query(
    `UPDATE product_variants SET seller_price = price, seller_compare_at_price = compare_at_price,
       price = ROUND(price * (1 + ? / 100)), compare_at_price = IF(compare_at_price IS NULL, NULL, ROUND(compare_at_price * (1 + ? / 100)))
     WHERE seller_price IS NULL`, [feeRate, feeRate]);
  if (conv.affectedRows) {
    await conn.query(`UPDATE products p SET min_price = COALESCE((SELECT MIN(price) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active'), 0)`);
    log(`✔ ${conv.affectedRows} variante(s) : prix vendeur conservé, prix client recalculé (+${feeRate} %)`);
    changes++;
  }

  // Jèko : lien de paiement de l'opérateur, suivi des virements (remboursements et reversements)
  await addColumn('payments', 'checkout_url', 'VARCHAR(500) NULL AFTER provider_reference');
  await addColumn('refunds', 'provider_reference', 'VARCHAR(120) NULL AFTER reference');
  await addColumn('refunds', 'failure_reason', 'VARCHAR(255) NULL AFTER status');
  await addColumn('seller_payouts', 'provider_reference', 'VARCHAR(120) NULL AFTER reference');
  await addColumn('seller_payouts', 'failure_reason', 'VARCHAR(255) NULL AFTER status');
  const [[rs]] = await conn.query(`SHOW COLUMNS FROM refunds LIKE 'status'`);
  if (!rs.Type.includes('processing')) {
    await conn.query(`ALTER TABLE refunds MODIFY status ENUM('pending','processing','succeeded','failed') NOT NULL DEFAULT 'pending'`);
    log('✔ refunds.status : statut « processing » (virement en cours) ajouté');
    changes++;
  }

  // Jèko : numéro réellement débité (remboursement au bon compte) et transaction, distincte de la demande de paiement
  await addColumn('payments', 'payer_account', 'VARCHAR(40) NULL AFTER payer_phone');
  await addColumn('payments', 'provider_transaction_id', 'VARCHAR(120) NULL AFTER provider_reference');

  // Frais de remboursement : part de la somme remboursée conservée par la plateforme
  await addColumn('refunds', 'fee_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER amount');
  const [rf] = await conn.query(`INSERT IGNORE INTO platform_settings (setting_key, setting_value, description) VALUES (?, ?, ?)`,
    ['refund_fee_rate', '3', 'Frais de remboursement (%) conservés par la plateforme sur chaque remboursement']);
  if (rf.affectedRows) { log('✔ Paramètre refund_fee_rate = 3'); changes++; }

  // Commission vendeur : 5 % du prix enregistré par le vendeur, retenus au reversement (en plus des 5 % payés par le client)
  await addColumn('orders', 'seller_commission', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER platform_fee');
  const [sc] = await conn.query(`INSERT IGNORE INTO platform_settings (setting_key, setting_value, description) VALUES (?, ?, ?)`,
    ['seller_commission_rate', '5', 'Commission vendeur (%) retenue au reversement sur le prix enregistré du produit (hors livraison)']);
  if (sc.affectedRows) { log('✔ Paramètre seller_commission_rate = 5'); changes++; }

  // Reversements automatiques aux vendeurs après livraison
  for (const [k, v, d] of [
    ['auto_payouts', '1', 'Reversements automatiques aux vendeurs après livraison via Jèko (1 = oui, 0 = non)'],
    ['payout_delay_days', '0', 'Délai (jours) après livraison avant de reverser le vendeur (0 = immédiat ; ex. 7 pour couvrir les retours)'],
  ]) {
    const [r] = await conn.query(`INSERT IGNORE INTO platform_settings (setting_key, setting_value, description) VALUES (?, ?, ?)`, [k, v, d]);
    if (r.affectedRows) { log(`✔ Paramètre ${k} = ${v}`); changes++; }
  }

  // Tarifs de livraison du vendeur par commune d'Abidjan et par ville (sinon tarifs par défaut de la boutique)
  await createTable('shop_delivery_zones', `CREATE TABLE shop_delivery_zones (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    shop_id    INT UNSIGNED NOT NULL,
    zone_type  ENUM('commune','city') NOT NULL,
    name       VARCHAR(80) NOT NULL,
    name_key   VARCHAR(80) NOT NULL,
    fee        DECIMAL(12,2) NULL,
    delivers   TINYINT(1) NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sdz_zone (shop_id, zone_type, name_key),
    CONSTRAINT fk_sdz_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Passage de l'application au site web : codes de connexion à usage unique (2 minutes)
  await createTable('login_handoffs', `CREATE TABLE login_handoffs (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    INT UNSIGNED NOT NULL,
    code_hash  CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at    DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_lh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  return changes;
}
