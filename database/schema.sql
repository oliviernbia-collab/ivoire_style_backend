-- =====================================================================
-- IVOIRE STYLE - Schéma MySQL / MariaDB (InnoDB, utf8mb4)
-- Montants en DECIMAL (jamais de flottants) - devise XOF (FCFA)
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS audit_logs, notifications, platform_settings, promotion_products, promotion_users, promotion_shops, promotions,
  reviews, seller_payouts, seller_ledger_entries, return_items, return_requests, shipments,
  refunds, payment_events, payments, order_status_history, order_items, orders,
  wishlist_items, cart_items, inventory_movements, product_variants, product_images, products,
  categories, seller_documents, shops, login_handoffs, password_resets, refresh_tokens, addresses, user_roles, roles, users;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------
-- Utilisateurs et sécurité
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  first_name      VARCHAR(80)  NOT NULL,
  last_name       VARCHAR(80)  NOT NULL,
  email           VARCHAR(160) NOT NULL,
  phone           VARCHAR(30)  NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  avatar_url      VARCHAR(255) NULL,
  status          ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  email_verified_at DATETIME NULL,
  phone_verified_at DATETIME NULL,
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    DATETIME NULL,
  last_login_at   DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE roles (
  id    TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code  VARCHAR(30) NOT NULL UNIQUE,      -- customer | seller | admin | support
  label VARCHAR(60) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_roles (
  user_id INT UNSIGNED NOT NULL,
  role_id TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE refresh_tokens (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  user_agent  VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE password_resets (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Passage de l'application au site web : codes de connexion à usage unique (2 minutes)
CREATE TABLE login_handoffs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  code_hash   CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_lh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE addresses (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED NOT NULL,
  label           VARCHAR(60)  NOT NULL DEFAULT 'Domicile',
  recipient_name  VARCHAR(160) NOT NULL,
  phone           VARCHAR(30)  NOT NULL,
  city            VARCHAR(80)  NOT NULL,
  commune         VARCHAR(80)  NULL,
  district        VARCHAR(120) NULL,          -- quartier
  street          VARCHAR(255) NULL,          -- rue ou repère
  instructions    VARCHAR(255) NULL,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_addr_user (user_id),
  CONSTRAINT fk_addr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Boutiques (vendeurs)
-- ---------------------------------------------------------------------
CREATE TABLE shops (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  owner_user_id    INT UNSIGNED NOT NULL,
  name             VARCHAR(120) NOT NULL,
  slug             VARCHAR(140) NOT NULL,
  responsible_name VARCHAR(160) NOT NULL,
  description      TEXT NULL,
  logo_url         VARCHAR(255) NULL,
  banner_url       VARCHAR(255) NULL,
  phone            VARCHAR(30)  NOT NULL,
  email            VARCHAR(160) NOT NULL,
  city             VARCHAR(80)  NOT NULL,
  commune          VARCHAR(80)  NULL,
  address          VARCHAR(255) NULL,
  rccm             VARCHAR(80)  NULL,           -- registre du commerce (facultatif)
  payout_method    VARCHAR(40)  NULL,           -- orange_money, wave...
  payout_account   VARCHAR(60)  NULL,
  payout_holder    VARCHAR(120) NULL,           -- titulaire du compte de reversement
  -- Livraison gérée par le vendeur (frais encaissés par le vendeur)
  delivery_fee_abidjan    DECIMAL(12,2) NOT NULL DEFAULT 1500,
  delivery_fee_other      DECIMAL(12,2) NOT NULL DEFAULT 3000,
  free_delivery_threshold DECIMAL(12,2) NOT NULL DEFAULT 0,   -- 0 = jamais offerte
  allow_shop_pickup       TINYINT(1) NOT NULL DEFAULT 1,
  delivery_info           VARCHAR(500) NULL,
  status           ENUM('pending','approved','rejected','suspended') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(255) NULL,
  commission_rate  DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  is_featured      TINYINT(1) NOT NULL DEFAULT 0,
  is_official      TINYINT(1) NOT NULL DEFAULT 0,   -- boutique de la plateforme (super admin)
  approved_at      DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shops_slug (slug),
  UNIQUE KEY uq_shops_owner (owner_user_id),
  KEY idx_shops_status (status),
  CONSTRAINT fk_shops_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE seller_documents (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id     INT UNSIGNED NOT NULL,
  doc_type    VARCHAR(40) NOT NULL,           -- cni, rccm, autre
  file_path   VARCHAR(255) NOT NULL,          -- public_id Cloudinary (type « authenticated », non public)
  original_name VARCHAR(255) NULL,
  mime_type   VARCHAR(80) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sd_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------
-- Tarifs de livraison du vendeur par commune d'Abidjan / ville (à défaut : tarifs de la boutique)
CREATE TABLE shop_delivery_zones (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id    INT UNSIGNED NOT NULL,
  zone_type  ENUM('commune','city') NOT NULL,   -- commune d'Abidjan ou ville de l'intérieur
  name       VARCHAR(80) NOT NULL,
  name_key   VARCHAR(80) NOT NULL,              -- nom normalisé (sans accents ni casse) pour la recherche
  fee        DECIMAL(12,2) NULL,                -- NULL = tarif par défaut de la boutique
  delivers   TINYINT(1) NOT NULL DEFAULT 1,     -- 0 = la boutique ne livre pas dans cette zone
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sdz_zone (shop_id, zone_type, name_key),
  CONSTRAINT fk_sdz_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE categories (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id   INT UNSIGNED NULL,
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(120) NOT NULL UNIQUE,
  icon        VARCHAR(60)  NULL,              -- nom d'icône Font Awesome
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cat_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id      INT UNSIGNED NOT NULL,
  category_id  INT UNSIGNED NOT NULL,
  name         VARCHAR(160) NOT NULL,
  slug         VARCHAR(190) NOT NULL UNIQUE,
  description  TEXT NULL,
  audience     ENUM('homme','femme','enfant','bebe','unisexe') NOT NULL DEFAULT 'unisexe',
  material     VARCHAR(120) NULL,
  fit          VARCHAR(80)  NULL,             -- coupe
  care         VARCHAR(255) NULL,             -- entretien
  origin       VARCHAR(80)  NULL,
  size_guide   TEXT NULL,
  status       ENUM('draft','pending','published','rejected','disabled') NOT NULL DEFAULT 'pending',
  moderation_note VARCHAR(255) NULL,
  is_featured  TINYINT(1) NOT NULL DEFAULT 0,
  sales_count  INT UNSIGNED NOT NULL DEFAULT 0,
  views_count  INT UNSIGNED NOT NULL DEFAULT 0,
  rating_avg   DECIMAL(3,2) NOT NULL DEFAULT 0,
  rating_count INT UNSIGNED NOT NULL DEFAULT 0,
  min_price    DECIMAL(12,2) NOT NULL DEFAULT 0, -- dénormalisé pour tri/filtre
  published_at DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_prod_shop (shop_id),
  KEY idx_prod_cat (category_id),
  KEY idx_prod_status (status, published_at),
  KEY idx_prod_price (min_price),
  FULLTEXT KEY ft_prod_search (name, description),
  CONSTRAINT fk_prod_shop FOREIGN KEY (shop_id) REFERENCES shops(id),
  CONSTRAINT fk_prod_cat  FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_images (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id  INT UNSIGNED NOT NULL,
  url         VARCHAR(255) NOT NULL,            -- URL CDN Cloudinary
  public_id   VARCHAR(255) NULL,                -- identifiant Cloudinary (suppression)
  media_type  ENUM('image','video') NOT NULL DEFAULT 'image',
  alt         VARCHAR(160) NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pi_prod (product_id),
  CONSTRAINT fk_pi_prod FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_variants (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id        INT UNSIGNED NOT NULL,
  sku               VARCHAR(80) NOT NULL UNIQUE,
  size              VARCHAR(20) NOT NULL,
  color             VARCHAR(40) NOT NULL,
  color_hex         VARCHAR(9)  NULL,
  seller_price      DECIMAL(12,2) NULL,           -- prix fixé par le vendeur (ce qu'il reçoit)
  seller_compare_at_price DECIMAL(12,2) NULL,
  price             DECIMAL(12,2) NOT NULL,       -- prix affiché au client = prix vendeur + frais plateforme
  compare_at_price  DECIMAL(12,2) NULL,
  stock_quantity    INT NOT NULL DEFAULT 0,
  reserved_quantity INT NOT NULL DEFAULT 0,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pv_prod (product_id),
  KEY idx_pv_size_color (size, color),
  CONSTRAINT chk_pv_stock CHECK (stock_quantity >= 0),
  CONSTRAINT fk_pv_prod FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory_movements (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  variant_id  INT UNSIGNED NOT NULL,
  quantity    INT NOT NULL,                   -- négatif = sortie
  reason      ENUM('initial','adjustment','order','cancel','return') NOT NULL,
  reference   VARCHAR(80) NULL,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_im_variant (variant_id),
  CONSTRAINT fk_im_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Panier et favoris
-- ---------------------------------------------------------------------
CREATE TABLE cart_items (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  variant_id  INT UNSIGNED NOT NULL,
  quantity    INT UNSIGNED NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cart_user_variant (user_id, variant_id),
  CONSTRAINT fk_ci_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ci_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wishlist_items (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  product_id  INT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wish_user_product (user_id, product_id),
  CONSTRAINT fk_wi_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wi_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Commandes
-- ---------------------------------------------------------------------
CREATE TABLE orders (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_number     VARCHAR(30) NOT NULL UNIQUE,
  user_id          INT UNSIGNED NOT NULL,
  shop_id          INT UNSIGNED NULL,             -- une commande = une boutique
  status           ENUM('pending','confirmed','preparing','ready','shipped','in_delivery','delivered',
                        'cancelled','return_requested','return_accepted','refunding','refunded')
                   NOT NULL DEFAULT 'pending',
  payment_status   ENUM('initiated','pending','partially_paid','succeeded','failed','cancelled','refunding',
                        'partially_refunded','refunded') NOT NULL DEFAULT 'pending',
  payment_method   VARCHAR(30) NOT NULL,           -- opérateur Mobile Money du paiement en ligne
  payment_plan     ENUM('full','half','deposit') NOT NULL DEFAULT 'full', -- totalité / moitié / acompte (paiement à la livraison)
  delivery_mode    ENUM('home','office','pickup_point','shop_pickup') NOT NULL DEFAULT 'home',
  subtotal         DECIMAL(12,2) NOT NULL,
  discount_total   DECIMAL(12,2) NOT NULL DEFAULT 0,  -- remise promotionnelle (prise en charge par la plateforme)
  promotion_id     INT UNSIGNED NULL,
  promo_code       VARCHAR(40) NULL,
  platform_fee     DECIMAL(12,2) NOT NULL DEFAULT 0, -- part plateforme (+5 % sur les produits)
  seller_commission DECIMAL(12,2) NOT NULL DEFAULT 0,   -- commission vendeur (% du prix du produit) retenue au reversement
  delivery_fee     DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount     DECIMAL(12,2) NOT NULL,
  upfront_amount   DECIMAL(12,2) NOT NULL DEFAULT 0, -- payé en ligne à la commande
  balance_amount   DECIMAL(12,2) NOT NULL DEFAULT 0, -- solde réglé au vendeur à la livraison
  balance_paid_at  DATETIME NULL,
  currency         CHAR(3) NOT NULL DEFAULT 'XOF',
  -- Instantané de l'adresse
  ship_recipient   VARCHAR(160) NOT NULL,
  ship_phone       VARCHAR(30)  NOT NULL,
  ship_city        VARCHAR(80)  NOT NULL,
  ship_commune     VARCHAR(80)  NULL,
  ship_district    VARCHAR(120) NULL,
  ship_street      VARCHAR(255) NULL,
  ship_instructions VARCHAR(255) NULL,
  customer_note    VARCHAR(500) NULL,
  cancelled_reason VARCHAR(255) NULL,
  paid_at          DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_orders_user (user_id, created_at),
  KEY idx_orders_status (status),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_items (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id          INT UNSIGNED NOT NULL,
  shop_id           INT UNSIGNED NOT NULL,
  product_id        INT UNSIGNED NULL,
  variant_id        INT UNSIGNED NULL,
  product_name      VARCHAR(160) NOT NULL,     -- valeurs historiques
  sku               VARCHAR(80)  NOT NULL,
  size              VARCHAR(20)  NOT NULL,
  color             VARCHAR(40)  NOT NULL,
  image_url         VARCHAR(255) NULL,
  unit_price        DECIMAL(12,2) NOT NULL,
  quantity          INT UNSIGNED NOT NULL,
  line_total        DECIMAL(12,2) NOT NULL,
  commission_rate   DECIMAL(5,2) NOT NULL,
  commission_amount DECIMAL(12,2) NOT NULL,
  seller_amount     DECIMAL(12,2) NOT NULL,
  fulfillment_status ENUM('pending','confirmed','preparing','ready','shipped','in_delivery','delivered',
                          'cancelled','return_requested','return_accepted','refunded') NOT NULL DEFAULT 'pending',
  tracking_number   VARCHAR(80) NULL,
  carrier           VARCHAR(80) NULL,
  shipped_at        DATETIME NULL,
  delivered_at      DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_oi_order (order_id),
  KEY idx_oi_shop (shop_id, fulfillment_status),
  CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_oi_shop FOREIGN KEY (shop_id) REFERENCES shops(id),
  CONSTRAINT fk_oi_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  CONSTRAINT fk_oi_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_status_history (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id    INT UNSIGNED NOT NULL,
  order_item_id INT UNSIGNED NULL,
  status      VARCHAR(30) NOT NULL,
  comment     VARCHAR(255) NULL,
  changed_by  INT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_osh_order (order_id),
  CONSTRAINT fk_osh_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Paiements
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id         INT UNSIGNED NOT NULL,
  provider         VARCHAR(30) NOT NULL,       -- orange_money, mtn_momo, wave, moov_money, card, cash_on_delivery
  reference        VARCHAR(60) NOT NULL UNIQUE,
  provider_reference VARCHAR(120) NULL,        -- Jèko : identifiant de la demande de paiement
  provider_transaction_id VARCHAR(120) NULL,   -- identifiant de la transaction encaissée
  checkout_url     VARCHAR(500) NULL,
  idempotency_key  VARCHAR(80) NOT NULL UNIQUE,
  amount           DECIMAL(12,2) NOT NULL,
  currency         CHAR(3) NOT NULL DEFAULT 'XOF',
  payer_phone      VARCHAR(30) NULL,            -- numéro saisi sur le site
  payer_account    VARCHAR(40) NULL,            -- numéro réellement débité (renvoyé par Jèko) : reçoit les remboursements
  status           ENUM('initiated','pending','succeeded','failed','cancelled','refunding',
                        'partially_refunded','refunded') NOT NULL DEFAULT 'initiated',
  failure_reason   VARCHAR(255) NULL,
  confirmed_at     DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pay_order (order_id),
  CONSTRAINT fk_pay_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_events (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payment_id   INT UNSIGNED NULL,
  provider     VARCHAR(30) NOT NULL,
  event_id     VARCHAR(120) NOT NULL,
  event_type   VARCHAR(60) NOT NULL,
  payload      LONGTEXT NOT NULL,
  signature_valid TINYINT(1) NOT NULL DEFAULT 0,
  processed_at DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pe_event (provider, event_id),
  CONSTRAINT fk_pe_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE refunds (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payment_id   INT UNSIGNED NOT NULL,
  order_id     INT UNSIGNED NOT NULL,
  reference    VARCHAR(60) NOT NULL UNIQUE,
  provider_reference VARCHAR(120) NULL,
  amount       DECIMAL(12,2) NOT NULL,          -- montant versé au client
  fee_amount   DECIMAL(12,2) NOT NULL DEFAULT 0, -- frais de remboursement conservés par la plateforme
  reason       VARCHAR(255) NULL,
  status       ENUM('pending','processing','succeeded','failed') NOT NULL DEFAULT 'pending',
  failure_reason VARCHAR(255) NULL,
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ref_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  CONSTRAINT fk_ref_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Logistique et retours
-- ---------------------------------------------------------------------
CREATE TABLE shipments (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id        INT UNSIGNED NOT NULL,
  shop_id         INT UNSIGNED NOT NULL,
  carrier         VARCHAR(80) NULL,
  tracking_number VARCHAR(80) NULL,
  status          VARCHAR(30) NOT NULL DEFAULT 'ready',
  shipped_at      DATETIME NULL,
  delivered_at    DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sh_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_sh_shop FOREIGN KEY (shop_id) REFERENCES shops(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE return_requests (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id    INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  reason      VARCHAR(500) NOT NULL,
  status      ENUM('requested','accepted','rejected','refunded') NOT NULL DEFAULT 'requested',
  decision_note VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rr_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_rr_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE return_items (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  return_request_id INT UNSIGNED NOT NULL,
  order_item_id     INT UNSIGNED NOT NULL,
  quantity          INT UNSIGNED NOT NULL,
  CONSTRAINT fk_ri_rr FOREIGN KEY (return_request_id) REFERENCES return_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_ri_oi FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Finances vendeurs
-- ---------------------------------------------------------------------
CREATE TABLE seller_ledger_entries (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id       INT UNSIGNED NOT NULL,
  order_id      INT UNSIGNED NULL,
  order_item_id INT UNSIGNED NULL,
  payout_id     INT UNSIGNED NULL,
  entry_type    ENUM('sale','commission','payout','refund','adjustment') NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,       -- + crédit vendeur, - débit
  description   VARCHAR(255) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sle_shop (shop_id),
  CONSTRAINT fk_sle_shop FOREIGN KEY (shop_id) REFERENCES shops(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE seller_payouts (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shop_id     INT UNSIGNED NOT NULL,
  reference   VARCHAR(60) NOT NULL UNIQUE,
  provider_reference VARCHAR(120) NULL,
  amount      DECIMAL(12,2) NOT NULL,
  method      VARCHAR(40) NULL,
  status      ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  failure_reason VARCHAR(255) NULL,
  note        VARCHAR(255) NULL,
  paid_at     DATETIME NULL,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sp_shop FOREIGN KEY (shop_id) REFERENCES shops(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Avis et promotions
-- ---------------------------------------------------------------------
CREATE TABLE reviews (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id  INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  order_item_id INT UNSIGNED NULL,
  rating      TINYINT UNSIGNED NOT NULL,
  comment     VARCHAR(1000) NULL,
  status      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'approved',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_review_user_product (user_id, product_id),
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_rev_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_rev_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Promotions ciblées :
--  target = 'clients' : code de réduction réservé aux clients choisis (promotion_users)
--  target = 'sellers' : commission réduite (+ mise en avant) pour les boutiques choisies (promotion_shops)
CREATE TABLE promotions (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  target           ENUM('clients','sellers') NOT NULL DEFAULT 'clients',
  code             VARCHAR(40) NULL UNIQUE,
  title            VARCHAR(120) NOT NULL,
  description      VARCHAR(500) NULL,
  discount_type    ENUM('percent','fixed') NOT NULL DEFAULT 'percent',
  discount_value   DECIMAL(12,2) NOT NULL DEFAULT 0,
  min_order_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  max_uses_per_user INT UNSIGNED NOT NULL DEFAULT 1,
  commission_rate  DECIMAL(5,2) NULL,             -- taux de commission promotionnel (vendeurs)
  feature_shops    TINYINT(1) NOT NULL DEFAULT 0, -- boutiques mises en avant pendant la promotion
  starts_at        DATETIME NULL,
  ends_at          DATETIME NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_by       INT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_promo_active (target, is_active, starts_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE promotion_users (
  promotion_id INT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED NOT NULL,
  used_count   INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (promotion_id, user_id),
  KEY idx_pu_user (user_id),
  CONSTRAINT fk_pu_promo FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
  CONSTRAINT fk_pu_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE promotion_shops (
  promotion_id INT UNSIGNED NOT NULL,
  shop_id      INT UNSIGNED NOT NULL,
  PRIMARY KEY (promotion_id, shop_id),
  KEY idx_ps_shop (shop_id),
  CONSTRAINT fk_ps_promo FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE promotion_products (
  promotion_id INT UNSIGNED NOT NULL,
  product_id   INT UNSIGNED NOT NULL,
  PRIMARY KEY (promotion_id, product_id),
  CONSTRAINT fk_pp_promo FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
  CONSTRAINT fk_pp_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- Administration
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  type        VARCHAR(40) NOT NULL,
  title       VARCHAR(160) NOT NULL,
  body        VARCHAR(500) NULL,
  link        VARCHAR(255) NULL,
  read_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif_user (user_id, read_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NULL,
  action      VARCHAR(80) NOT NULL,
  entity      VARCHAR(40) NULL,
  entity_id   VARCHAR(40) NULL,
  details     VARCHAR(1000) NULL,
  ip_address  VARCHAR(45) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entity (entity, entity_id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_settings (
  setting_key   VARCHAR(80) PRIMARY KEY,
  setting_value VARCHAR(500) NOT NULL,
  description   VARCHAR(255) NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
