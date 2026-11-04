import { Router } from 'express';
import env from '../config/env.js';
import { query, queryOne } from '../config/db.js';

/**
 * Référencement côté serveur :
 * - /robots.txt et /sitemap.xml (à exposer à la racine du site web : proxy Vite en développement,
 *   règle de réécriture vers l'API en production) ;
 * - /partage/... : aperçus de partage (WhatsApp, Facebook, X…) des boutiques et produits. Ces robots
 *   n'exécutent pas JavaScript : ils reçoivent une page avec les balises Open Graph, les visiteurs sont
 *   redirigés vers le site.
 */
const router = Router();
const SITE = env.webUrl.replace(/\/$/, '');
const STATIC_PAGES = ['a-propos', 'faq', 'livraison', 'retours', 'cgu', 'cgv', 'confidentialite', 'conditions-vendeurs', 'contact'];
// Robots des réseaux sociaux et messageries (aperçu des liens partagés)
const PREVIEW_BOTS = /facebookexternalhit|facebot|whatsapp|twitterbot|linkedinbot|slackbot|telegrambot|discordbot|pinterest|skypeuripreview|googlebot|bingbot|applebot|snapchat|viber/i;

const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);
const ogImage = (url) => {
  const m = String(url || '').match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/);
  return m ? `${m[1]}c_fill,g_auto,w_1200,h_630,f_jpg,q_auto/${m[2]}` : `${SITE}/favicon.png`;
};
const plain = (t, max = 200) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s;
};

router.get('/robots.txt', (_req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /compte',
    'Disallow: /vendeur',
    'Disallow: /admin',
    'Disallow: /panier',
    'Disallow: /commande',
    'Disallow: /paiement',
    'Disallow: /connexion',
    'Disallow: /inscription',
    'Disallow: /mot-de-passe-oublie',
    'Disallow: /reinitialiser-mot-de-passe',
    'Disallow: /*?q=',
    '',
    `Sitemap: ${SITE}/sitemap.xml`,
    '',
  ].join('\n'));
});

router.get('/sitemap.xml', async (_req, res) => {
  const [products, shops, categories] = await Promise.all([
    query(`SELECT p.slug, p.name, p.updated_at,
              (SELECT i.url FROM product_images i WHERE i.product_id = p.id AND i.media_type = 'image' ORDER BY i.sort_order, i.id LIMIT 1) AS image
             FROM products p JOIN shops s ON s.id = p.shop_id
            WHERE p.status = 'published' AND s.status = 'approved' ORDER BY p.updated_at DESC LIMIT 45000`),
    query(`SELECT slug, updated_at FROM shops WHERE status = 'approved'`),
    query(`SELECT slug FROM categories WHERE is_active = 1`),
  ]);
  const url = (loc, { lastmod, freq, priority, image, title } = {}) => [
    '  <url>',
    `    <loc>${xml(SITE + loc)}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
    freq ? `    <changefreq>${freq}</changefreq>` : null,
    priority ? `    <priority>${priority}</priority>` : null,
    image ? `    <image:image><image:loc>${xml(image)}</image:loc><image:title>${xml(title)}</image:title></image:image>` : null,
    '  </url>',
  ].filter(Boolean).join('\n');
  const body = [
    url('/', { freq: 'daily', priority: '1.0' }),
    url('/catalogue', { freq: 'daily', priority: '0.9' }),
    url('/boutiques', { freq: 'weekly', priority: '0.8' }),
    url('/vendre', { freq: 'monthly', priority: '0.7' }),
    ...categories.map((c) => url(`/catalogue?category=${encodeURIComponent(c.slug)}`, { freq: 'daily', priority: '0.8' })),
    ...shops.map((s) => url(`/boutique/${s.slug}`, { lastmod: day(s.updated_at), freq: 'weekly', priority: '0.7' })),
    ...products.map((p) => url(`/produit/${p.slug}`, { lastmod: day(p.updated_at), freq: 'weekly', priority: '0.8', image: p.image, title: p.name })),
    ...STATIC_PAGES.map((s) => url(`/page/${s}`, { freq: 'yearly', priority: '0.3' })),
  ];
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" `
    + `xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body.join('\n')}\n</urlset>\n`,
  );
});

/** Page d'aperçu pour les robots ; redirection immédiate vers le site pour les visiteurs. */
function sharePage(req, res, { target, title, description, image, type = 'website' }) {
  if (!PREVIEW_BOTS.test(req.get('user-agent') || '')) return res.redirect(302, target);
  const self = `${env.publicUrl}${req.originalUrl}`;
  res.type('html').set('Cache-Control', 'public, max-age=600').send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${xml(title)}</title>
<meta name="description" content="${xml(description)}">
<link rel="canonical" href="${xml(target)}">
<meta property="og:site_name" content="Ivoire Style">
<meta property="og:locale" content="fr_CI">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${xml(title)}">
<meta property="og:description" content="${xml(description)}">
<meta property="og:url" content="${xml(self)}">
<meta property="og:image" content="${xml(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${xml(title)}">
<meta name="twitter:description" content="${xml(description)}">
<meta name="twitter:image" content="${xml(image)}">
</head><body><p><a href="${xml(target)}">${xml(title)}</a></p></body></html>`);
}

/** Lien de vitrine d'une boutique (celui que le vendeur partage dans ses publicités). */
router.get('/partage/b/:slug', async (req, res) => {
  const s = await queryOne(
    `SELECT s.name, s.slug, s.description, s.city, s.logo_url, s.banner_url,
            (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.status = 'published') AS n
       FROM shops s WHERE s.slug = ? AND s.status = 'approved'`, [req.params.slug]);
  if (!s) return res.redirect(302, `${SITE}/boutiques`);
  return sharePage(req, res, {
    target: `${SITE}/b/${s.slug}`,
    title: `${s.name} – boutique de mode à ${s.city} | Ivoire Style`,
    description: plain(`${s.n} article(s) à découvrir. ${s.description || ''} Paiement Mobile Money et livraison en Côte d’Ivoire.`),
    image: ogImage(s.banner_url || s.logo_url),
  });
});

/** Lien de partage d'un produit. */
router.get('/partage/p/:slug', async (req, res) => {
  const p = await queryOne(
    `SELECT p.name, p.slug, p.description, p.min_price, s.name AS shop_name,
            (SELECT i.url FROM product_images i WHERE i.product_id = p.id AND i.media_type = 'image' ORDER BY i.sort_order, i.id LIMIT 1) AS image
       FROM products p JOIN shops s ON s.id = p.shop_id
      WHERE p.slug = ? AND p.status = 'published' AND s.status = 'approved'`, [req.params.slug]);
  if (!p) return res.redirect(302, `${SITE}/catalogue`);
  const amount = Math.round(Number(p.min_price)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return sharePage(req, res, {
    target: `${SITE}/produit/${p.slug}`,
    title: `${p.name} – ${amount} FCFA | ${p.shop_name}`,
    description: plain(`${p.description || ''} En vente chez ${p.shop_name} sur Ivoire Style.`),
    image: ogImage(p.image),
    type: 'product',
  });
});

export default router;
