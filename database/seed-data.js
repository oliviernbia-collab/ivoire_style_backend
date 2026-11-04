// Données de référence et de démonstration (sans secrets).

export const ROLES = [
  ['customer', 'Client'],
  ['seller', 'Vendeur'],
  ['admin', 'Administrateur'],
  ['support', 'Support'],
];

// icon = nom d'icône Font Awesome 6 (web) ; le mobile fait la correspondance FA5
export const CATEGORIES = [
  ['Hommes', 'hommes', 'person'],
  ['Femmes', 'femmes', 'person-dress'],
  ['Enfants', 'enfants', 'child'],
  ['Bébés', 'bebes', 'baby'],
  ['Tenues africaines', 'tenues-africaines', 'crown'],
  ['Cérémonie', 'ceremonie', 'champagne-glasses'],
  ['Professionnel', 'professionnel', 'briefcase'],
  ['Sport', 'sport', 'person-running'],
  ['Décontracté', 'decontracte', 'shirt'],
  ['Soirée', 'soiree', 'wand-magic-sparkles'],
];

export const SETTINGS = [
  ['platform_fee_rate', '5', 'Frais plateforme (%) ajoutés au prix de chaque produit et versés à la plateforme'],
  ['deposit_rate', '10', 'Acompte (%) payé en ligne pour un paiement à la livraison'],
  ['half_payment_rate', '50', 'Part (%) payée en ligne pour un paiement en deux fois'],
  ['refund_fee_rate', '3', 'Frais de remboursement (%) conservés par la plateforme sur chaque remboursement'],
  ['auto_payouts', '1', 'Reversements automatiques aux vendeurs après livraison via Jèko (1 = oui, 0 = non)'],
  ['payout_delay_days', '0', 'Délai (jours) après livraison avant de reverser le vendeur (0 = immédiat ; ex. 7 pour couvrir les retours)'],
  ['payment_methods', 'orange_money,mtn_momo,wave,moov_money,cash_on_delivery', 'Moyens de paiement actifs : opérateurs Mobile Money, et cash_on_delivery pour le paiement à la livraison (avec acompte)'],
  ['product_moderation', '1', 'Validation des produits avant publication (1 = oui, 0 = non)'],
  ['reservation_minutes', '60', 'Durée de réservation du stock pour une commande non payée (minutes)'],
  ['return_days', '7', 'Délai de demande de retour après livraison (jours)'],
  ['low_stock_threshold', '3', 'Seuil d’alerte de stock faible'],
  ['contact_phone', '+225 07 12176799', 'Téléphone du service client'],
  ['contact_email', 'contact@ivoirestyle.ci', 'E-mail du service client'],
];

export const USERS = [
  { key: 'admin', first_name: 'Awa', last_name: 'Koné', email: 'admin@ivoirestyle.ci', phone: '0700000001', password: 'Admin@2026', roles: ['admin', 'customer'] },
  { key: 'support', first_name: 'Yao', last_name: 'Kouassi', email: 'support@ivoirestyle.ci', phone: '0700000002', password: 'Support@2026', roles: ['support', 'customer'] },
  { key: 'akwaba', first_name: 'Aïcha', last_name: 'Traoré', email: 'vendeur@ivoirestyle.ci', phone: '0700000003', password: 'Vendeur@2026', roles: ['customer', 'seller'] },
  { key: 'urban', first_name: 'Koffi', last_name: 'N’Guessan', email: 'urban@ivoirestyle.ci', phone: '0700000004', password: 'Vendeur@2026', roles: ['customer', 'seller'] },
  { key: 'kente', first_name: 'Mariam', last_name: 'Bamba', email: 'kente@ivoirestyle.ci', phone: '0700000005', password: 'Vendeur@2026', roles: ['customer'] },
  { key: 'client', first_name: 'Jean-Marc', last_name: 'Gbagbo', email: 'client@ivoirestyle.ci', phone: '0700000006', password: 'Client@2026', roles: ['customer'] },
];

export const SHOPS = [
  {
    owner: 'akwaba', name: 'Maison Akwaba', slug: 'maison-akwaba', responsible_name: 'Aïcha Traoré', status: 'approved', is_featured: 1,
    description: 'Créations en pagne wax, bazin et kita tissés à la main. Tenues africaines modernes pour toutes les occasions, confectionnées à Cocody.',
    phone: '0700000003', email: 'vendeur@ivoirestyle.ci', city: 'Abidjan', commune: 'Cocody', payout_method: 'orange_money', payout_account: '0700000003',
  },
  {
    owner: 'urban', name: 'Urban Babi', slug: 'urban-babi', responsible_name: 'Koffi N’Guessan', status: 'approved', is_featured: 1,
    description: 'Streetwear et sportswear made in Babi : t-shirts, joggings, sweats et casquettes pour un style urbain affirmé.',
    phone: '0700000004', email: 'urban@ivoirestyle.ci', city: 'Abidjan', commune: 'Yopougon', payout_method: 'wave', payout_account: '0700000004',
  },
  {
    owner: 'kente', name: 'Kente Couture', slug: 'kente-couture', responsible_name: 'Mariam Bamba', status: 'pending', is_featured: 0,
    description: 'Atelier de couture sur mesure à Bouaké : robes de soirée, ensembles de cérémonie et tenues traditionnelles.',
    phone: '0700000005', email: 'kente@ivoirestyle.ci', city: 'Bouaké', commune: 'Commerce', payout_method: 'mtn_momo', payout_account: '0500000005',
  },
];

const S = ['S', 'M', 'L', 'XL'];

// shape = silhouette utilisée pour générer le visuel de démonstration
export const PRODUCTS = [
  { shop: 'maison-akwaba', cat: 'tenues-africaines', name: 'Boubou brodé Bazin riche', audience: 'homme', shape: 'boubou', material: 'Bazin riche', featured: 1,
    description: 'Grand boubou en bazin riche, broderies dorées faites main au col et aux manches. Idéal pour les mariages et les fêtes.',
    colors: [['Blanc ivoire', '#F4EFE3'], ['Bleu nuit', '#1F2A44']], sizes: ['M', 'L', 'XL', 'XXL'], price: 45000, compare: 55000 },
  { shop: 'maison-akwaba', cat: 'femmes', name: 'Robe pagne wax « Akwaba »', audience: 'femme', shape: 'dress', material: 'Coton wax',
    description: 'Robe évasée en pagne wax aux motifs géométriques, taille cintrée, longueur midi. Fermeture éclair au dos.',
    colors: [['Orange', '#E07A1F'], ['Vert', '#2E7D4F']], sizes: S, price: 22000, compare: null },
  { shop: 'maison-akwaba', cat: 'ceremonie', name: 'Ensemble Kita tissé main', audience: 'femme', shape: 'dress', material: 'Kita (Kente ivoirien)', featured: 1,
    description: 'Ensemble pagne Kita tissé à la main à Bonwire, haut ajusté et jupe portefeuille. Pièce d’exception pour vos cérémonies.',
    colors: [['Or et vert', '#C9A227']], sizes: ['S', 'M', 'L'], price: 85000, compare: 95000 },
  { shop: 'maison-akwaba', cat: 'hommes', name: 'Chemise wax manches courtes', audience: 'homme', shape: 'shirt', material: 'Coton wax',
    description: 'Chemise coupe droite en wax, col classique, boutons nacrés. Légère et parfaite pour le climat d’Abidjan.',
    colors: [['Bleu roi', '#1D4E9E'], ['Bordeaux', '#7A1F2B']], sizes: S, price: 15000, compare: 18000 },
  { shop: 'maison-akwaba', cat: 'enfants', name: 'Ensemble enfant wax', audience: 'enfant', shape: 'shirt', material: 'Coton wax',
    description: 'Ensemble chemise et pantalon en wax pour garçon. Coutures renforcées, coton doux.',
    colors: [['Jaune', '#E5B728']], sizes: ['4 ans', '6 ans', '8 ans', '10 ans'], price: 12000, compare: null },
  { shop: 'maison-akwaba', cat: 'soiree', name: 'Robe de soirée sirène bazin', audience: 'femme', shape: 'dress', material: 'Bazin brodé',
    description: 'Robe sirène en bazin brodé, dos nu, finitions perlées. Élégance garantie pour vos soirées.',
    colors: [['Noir', '#1A1A1A'], ['Or', '#C9A227']], sizes: S, price: 60000, compare: null },
  { shop: 'maison-akwaba', cat: 'bebes', name: 'Barboteuse bébé wax', audience: 'bebe', shape: 'shirt', material: 'Coton bio',
    description: 'Barboteuse douce en coton bio avec empiècement wax. Pressions à l’entrejambe pour faciliter le change.',
    colors: [['Rose', '#E8A0B4'], ['Bleu ciel', '#8EC5E8']], sizes: ['3 mois', '6 mois', '12 mois'], price: 7500, compare: null },
  { shop: 'maison-akwaba', cat: 'professionnel', name: 'Tailleur pantalon col wax', audience: 'femme', shape: 'pants', material: 'Crêpe et wax',
    description: 'Tailleur pantalon en crêpe avec revers de col en wax. Le chic africain au bureau.',
    colors: [['Beige', '#D8C3A5'], ['Noir', '#1A1A1A']], sizes: S, price: 38000, compare: 42000 },
  { shop: 'urban-babi', cat: 'decontracte', name: 'T-shirt « Babi City »', audience: 'unisexe', shape: 'shirt', material: '100 % coton', featured: 1,
    description: 'T-shirt oversize 100 % coton peigné, sérigraphie « Babi City ». Coupe unisexe.',
    colors: [['Blanc', '#FFFFFF'], ['Noir', '#1A1A1A'], ['Orange', '#F28C28']], sizes: ['S', 'M', 'L', 'XL', 'XXL'], price: 8000, compare: 10000 },
  { shop: 'urban-babi', cat: 'sport', name: 'Jogging Éléphants', audience: 'homme', shape: 'pants', material: 'Molleton',
    description: 'Pantalon de jogging en molleton gratté, bandes latérales orange-blanc-vert. Poches zippées.',
    colors: [['Gris chiné', '#9AA0A6'], ['Noir', '#1A1A1A']], sizes: S, price: 14000, compare: null },
  { shop: 'urban-babi', cat: 'sport', name: 'Maillot d’entraînement respirant', audience: 'unisexe', shape: 'shirt', material: 'Polyester recyclé',
    description: 'Maillot technique respirant, séchage rapide, idéal pour le foot et la course.',
    colors: [['Orange', '#F28C28'], ['Vert', '#2E9E5B']], sizes: S, price: 9500, compare: null },
  { shop: 'urban-babi', cat: 'hommes', name: 'Sweat à capuche « Plateau »', audience: 'homme', shape: 'shirt', material: 'Coton et polyester',
    description: 'Sweat à capuche épais, poche kangourou, broderie « Plateau » sur la poitrine.',
    colors: [['Bleu marine', '#22304F'], ['Kaki', '#6B6B3A']], sizes: S, price: 18000, compare: 22000 },
  { shop: 'urban-babi', cat: 'femmes', name: 'Crop top côtelé', audience: 'femme', shape: 'shirt', material: 'Coton côtelé',
    description: 'Crop top ajusté en maille côtelée stretch. Se marie avec tout.',
    colors: [['Blanc', '#FFFFFF'], ['Terracotta', '#C2603D']], sizes: ['XS', 'S', 'M', 'L'], price: 6500, compare: null },
  { shop: 'urban-babi', cat: 'decontracte', name: 'Short cargo', audience: 'homme', shape: 'pants', material: 'Toile de coton',
    description: 'Short cargo en toile robuste, six poches, ceinture élastiquée.',
    colors: [['Sable', '#C8B48A'], ['Olive', '#5E6B3A']], sizes: S, price: 11000, compare: null },
];
