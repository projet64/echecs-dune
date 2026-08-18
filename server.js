/* ============================================================
   échecs dune — serveur v2 (Railway)
   1. Sert la page du jeu (index.html)
   2. /api/entree   : vérifie le code d'accès famille
   3. /api/profils  : liste / création des profils joueurs
   4. /api/profil   : mise à jour du niveau préféré
   5. /api/coach    : commentaire d'un coup (API Anthropic)
   6. /api/partie   : enregistre une partie terminée (Postgres)
   7. /api/parties  : parties + stats du profil actif
   8. /api/debrief  : débrief rédigé de la partie complète
   9. /api/indice   : une piste sans jamais donner le coup
  10. /api/partie?id=N : relire une partie enregistrée
   La clé API, le code d'accès et la base restent côté serveur.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CLE = process.env.ANTHROPIC_API_KEY;
const BDD_URL = process.env.DATABASE_URL;
function normaliserCode(c){
  return String(c || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // accents éventuels du correcteur
    .replace(/\s+/g, '')                                // espaces, où qu'ils soient
    .toLowerCase();
}
const CODE_ACCES = normaliserCode(process.env.CODE_ACCES || 'dune64');

/* ---------- Base de données (Postgres via pg) ---------- */
let pool = null;
if(BDD_URL){
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: BDD_URL,
    ssl: BDD_URL.includes('railway.internal') ? false : { rejectUnauthorized: false }
  });
  const init = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS parties (
      id SERIAL PRIMARY KEY,
      date TIMESTAMPTZ DEFAULT now(),
      niveau TEXT,
      resultat TEXT,
      nb_coups INT,
      pgn TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS profils (
      id SERIAL PRIMARY KEY,
      nom TEXT UNIQUE NOT NULL,
      niveau_prefere INT DEFAULT 1,
      note_coach TEXT DEFAULT '',
      cree_le TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS profil_id INT`);
    // Profils de départ (ignorés s'ils existent déjà)
    await pool.query(`INSERT INTO profils (nom, niveau_prefere, note_coach) VALUES
      ('Jérôme', 1, 'Jérôme, 57 ans, architecte. Ton direct, pragmatique, zéro flatterie, zéro jargon inutile.'),
      ('Théa', 0, 'Théa, la petite-fille de Jérôme, bonne joueuse déjà. Vocabulaire simple et direct, encourage la progression sans niaiserie.'),
      ('Charles', 1, 'Charles, le beau-père de Jérôme, joueur d''expérience. Ton classique et respectueux, tutoiement.')
      ON CONFLICT (nom) DO NOTHING`);
    // Correction d'un prénom improvisé lors d'un premier déploiement :
    // les parties éventuelles passent à Charles, puis l'intrus est supprimé.
    await pool.query(`UPDATE parties SET profil_id = (SELECT id FROM profils WHERE nom = 'Charles')
      WHERE profil_id = (SELECT id FROM profils WHERE nom = 'Papi Gérard')`);
    await pool.query(`DELETE FROM profils WHERE nom = 'Papi Gérard'`);
    console.log('Tables parties et profils prêtes.');
  };
  init().catch(e => console.log('Erreur création tables :', e.message));
}

/* ---------- Consignes du coach ---------- */
const CONSIGNE_COUP =
  "Tu es coach d'échecs. Tu t'adresses au joueur en français, en le tutoyant ; son identité et le ton à adopter sont précisés dans les données. " +
  "Ton direct, pragmatique, zéro flatterie, zéro jargon inutile. " +
  "Explique le dernier demi-coup indiqué : ce qu'il fait concrètement sur l'échiquier (pièce, case, ce qu'il attaque, défend, ouvre ou affaiblit) et pourquoi l'évaluation a bougé ou non. " +
  "Appuie-toi uniquement sur les données fournies : ne calcule pas de variantes longues, n'invente aucune pièce ni aucune case. " +
  "Ne conseille jamais le coup à jouer ensuite ; si le coup était imprécis, dis-le et nomme l'idée que le moteur préférait, sans dérouler la suite. " +
  "3 courts paragraphes maximum, 160 mots maximum au total, pas de titres, pas de listes.\n\n" +
  "Données de la position :\n";

const CONSIGNE_INDICE =
  "Tu es coach d'échecs. Tu t'adresses au joueur en français, en le tutoyant ; son identité est précisée dans les données. " +
  "On te fournit le meilleur coup selon Stockfish : il est STRICTEMENT INTERDIT de le nommer, de nommer la pièce à jouer ou une case précise. " +
  "Donne UNE seule piste qui oriente le regard : une menace à voir, une pièce adverse mal défendue, une de ses pièces qui ne participe pas, une colonne ou une diagonale à exploiter — en termes généraux. " +
  "2 phrases maximum, 45 mots maximum, pas de titres ni de listes.\n\nDonnées :\n";

const CONSIGNE_DEBRIEF =
  "Tu es coach d'échecs. Tu t'adresses au joueur en français, en le tutoyant ; son identité et le ton à adopter sont précisés dans les données. " +
  "Son adversaire est le moteur Stockfish, surnommé Hartwig — désigne-le par ce nom. " +
  "Le joueur avait les noirs, Hartwig les blancs. " +
  "Tu reçois le PGN complet et la liste des évaluations après chaque demi-coup, du point de vue de Jérôme " +
  "(positif = avantage Jérôme, en centipions ; ±9999 = mat forcé ; null = non chiffré). " +
  "Rédige le débrief de la partie : la physionomie générale en une ou deux phrases, " +
  "puis les deux ou trois moments clés où l'évaluation a réellement basculé — cite les numéros de coups et ce qui s'est joué concrètement — " +
  "et termine par UNE leçon claire à retenir pour la prochaine partie. " +
  "N'invente aucun coup qui n'est pas dans le PGN. 4 courts paragraphes maximum, 230 mots maximum, pas de titres, pas de listes.\n\n" +
  "Données de la partie :\n";

/* ---------- Utilitaires ---------- */
function servirFichier(res, fichier, type){
  fs.readFile(path.join(__dirname, fichier), (err, data) => {
    if(err){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Introuvable'); return; }
    res.writeHead(200, {'Content-Type': type, 'Cache-Control':'no-cache'});
    res.end(data);
  });
}

function lireCorps(req){
  return new Promise((res, rej) => {
    let corps = '';
    req.on('data', (c) => { corps += c; if(corps.length > 300000) req.destroy(); });
    req.on('end', () => { try{ res(JSON.parse(corps || '{}')); }catch(e){ rej(new Error('JSON invalide')); } });
  });
}

function repondre(res, code, objet){
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(objet));
}

async function demanderClaude(consigne, contenu, maxTokens){
  if(!CLE) throw new Error('ANTHROPIC_API_KEY absente : ajoute la variable dans Railway.');
  const rep = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': CLE,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: consigne + contenu }]
    })
  });
  if(!rep.ok){
    const detail = (await rep.text()).slice(0, 300);
    const e = new Error('API Anthropic : ' + rep.status + ' — ' + detail);
    e.http = 502;
    throw e;
  }
  const data = await rep.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

/* ---------- Serveur ---------- */
const server = http.createServer(async (req, res) => {

  if(req.method === 'GET' && (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/?'))){
    return servirFichier(res, 'index.html', 'text/html; charset=utf-8');
  }
  if(req.method === 'GET' && req.url === '/apple-touch-icon.png'){
    return servirFichier(res, 'apple-touch-icon.png', 'image/png');
  }
  if(req.method === 'GET' && req.url === '/icon-512.png'){
    return servirFichier(res, 'icon-512.png', 'image/png');
  }

  /* --- Code d'accès famille --- */
  if(req.method === 'POST' && req.url === '/api/entree'){
    try{
      const { code } = await lireCorps(req);
      if(typeof code !== 'string' || normaliserCode(code) !== CODE_ACCES){
        repondre(res, 403, { erreur: 'Code incorrect.' });
        return;
      }
      repondre(res, 200, { ok: true });
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Profils : liste et création --- */
  if(req.url === '/api/profils' && (req.method === 'GET' || req.method === 'POST')){
    try{
      if(!pool) throw new Error('Base de données non branchée.');
      if(req.method === 'POST'){
        const { nom } = await lireCorps(req);
        const propre = String(nom || '').trim().slice(0, 24);
        if(propre.length < 2) throw new Error('Nom trop court (2 caractères minimum).');
        await pool.query(
          `INSERT INTO profils (nom, note_coach) VALUES ($1, $2) ON CONFLICT (nom) DO NOTHING`,
          [propre, 'Invité de la famille ou proche de dune. Ton amical et direct, tutoiement.']
        );
      }
      const r = await pool.query('SELECT id, nom, niveau_prefere FROM profils ORDER BY cree_le');
      repondre(res, 200, { profils: r.rows });
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Profil : mémoriser le niveau préféré --- */
  if(req.method === 'POST' && req.url === '/api/profil'){
    try{
      if(!pool) throw new Error('Base de données non branchée.');
      const { id, niveau_prefere } = await lireCorps(req);
      const n = parseInt(niveau_prefere, 10);
      if(!Number.isInteger(parseInt(id,10)) || !(n >= 0 && n <= 3)) throw new Error('paramètres invalides');
      await pool.query('UPDATE profils SET niveau_prefere = $1 WHERE id = $2', [n, parseInt(id,10)]);
      repondre(res, 200, { ok: true });
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Commentaire d'un coup --- */
  if(req.method === 'POST' && req.url === '/api/coach'){
    try{
      const { contexte, profil } = await lireCorps(req);
      if(typeof contexte !== 'string' || contexte.length < 10 || contexte.length > 8000) throw new Error('contexte invalide');
      let note = '';
      if(pool && profil){
        const r = await pool.query('SELECT nom, note_coach FROM profils WHERE id = $1', [parseInt(profil,10) || 0]);
        if(r.rows[0]) note = 'Ton interlocuteur : ' + r.rows[0].nom + '. ' + (r.rows[0].note_coach || '') + '\n';
      }
      const texte = await demanderClaude(CONSIGNE_COUP, note + contexte, 600);
      repondre(res, 200, { texte });
    }catch(e){ repondre(res, e.http || 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Un indice, sans donner le coup --- */
  if(req.method === 'POST' && req.url === '/api/indice'){
    try{
      const { contexte, profil } = await lireCorps(req);
      if(typeof contexte !== 'string' || contexte.length < 10 || contexte.length > 8000) throw new Error('contexte invalide');
      let note = '';
      if(pool && profil){
        const r = await pool.query('SELECT nom, note_coach FROM profils WHERE id = $1', [parseInt(profil,10) || 0]);
        if(r.rows[0]) note = 'Ton interlocuteur : ' + r.rows[0].nom + '. ' + (r.rows[0].note_coach || '') + '\n';
      }
      const texte = await demanderClaude(CONSIGNE_INDICE, note + contexte, 250);
      repondre(res, 200, { texte });
    }catch(e){ repondre(res, e.http || 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Relire une partie enregistrée --- */
  if(req.method === 'GET' && req.url.indexOf('/api/partie?') === 0){
    try{
      if(!pool) throw new Error('Base de données non branchée.');
      const m = req.url.match(/[?&]id=(\d+)/);
      if(!m) throw new Error('identifiant manquant');
      const r = await pool.query('SELECT id, date, niveau, resultat, nb_coups, pgn FROM parties WHERE id = $1', [parseInt(m[1],10)]);
      if(!r.rows[0]) throw new Error('partie introuvable');
      repondre(res, 200, r.rows[0]);
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Enregistrement d'une partie --- */
  if(req.method === 'POST' && req.url === '/api/partie'){
    try{
      if(!pool) throw new Error('Base de données non branchée (variable DATABASE_URL absente).');
      const { pgn, resultat, niveau, nb_coups, profil } = await lireCorps(req);
      if(typeof pgn !== 'string' || pgn.length < 3 || pgn.length > 20000) throw new Error('pgn invalide');
      const r = await pool.query(
        'INSERT INTO parties (niveau, resultat, nb_coups, pgn, profil_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [String(niveau || '').slice(0,30), String(resultat || '').slice(0,30), parseInt(nb_coups,10) || 0, pgn, parseInt(profil,10) || null]
      );
      repondre(res, 200, { id: r.rows[0].id });
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Liste des parties --- */
  if(req.method === 'GET' && req.url.indexOf('/api/parties') === 0){
    try{
      if(!pool) throw new Error('Base de données non branchée (variable DATABASE_URL absente).');
      const m = req.url.match(/[?&]profil=(\d+)/);
      const pid = m ? parseInt(m[1], 10) : null;
      const r = pid
        ? await pool.query('SELECT id, date, niveau, resultat, nb_coups FROM parties WHERE profil_id = $1 ORDER BY date DESC LIMIT 50', [pid])
        : await pool.query('SELECT id, date, niveau, resultat, nb_coups FROM parties ORDER BY date DESC LIMIT 50');
      const stats = { victoires:0, defaites:0, nulles:0 };
      r.rows.forEach(x => {
        if(x.resultat === 'Victoire') stats.victoires++;
        else if(x.resultat === 'Défaite') stats.defaites++;
        else stats.nulles++;
      });
      repondre(res, 200, { parties: r.rows, stats });
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Débrief de fin de partie --- */
  if(req.method === 'POST' && req.url === '/api/debrief'){
    try{
      const { pgn, resultat, niveau, evals, profil } = await lireCorps(req);
      if(typeof pgn !== 'string' || pgn.length < 3 || pgn.length > 20000) throw new Error('pgn invalide');
      if(!Array.isArray(evals) || evals.length > 400) throw new Error('évaluations invalides');
      let note = '';
      if(pool && profil){
        const r = await pool.query('SELECT nom, note_coach FROM profils WHERE id = $1', [parseInt(profil,10) || 0]);
        if(r.rows[0]) note = 'Ton interlocuteur : ' + r.rows[0].nom + '. ' + (r.rows[0].note_coach || '') + '\n';
      }
      const contenu = note +
        'Résultat (point de vue de Jérôme) : ' + String(resultat || 'inconnu') + '\n' +
        'Niveau de Hartwig : ' + String(niveau || 'inconnu') + '\n' +
        'PGN : ' + pgn + '\n' +
        'Évaluations après chaque demi-coup (point de vue Jérôme, centipions) : ' +
        evals.map(v => (v === null || v === undefined) ? 'null' : Math.round(v)).join(', ');
      const texte = await demanderClaude(CONSIGNE_DEBRIEF, contenu, 900);
      repondre(res, 200, { texte });
    }catch(e){ repondre(res, e.http || 400, { erreur: String(e.message || e) }); }
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('Introuvable');
});

server.listen(PORT, () => {
  console.log('échecs dune — serveur v2 en écoute sur le port ' + PORT);
  if(!CLE) console.log('ATTENTION : ANTHROPIC_API_KEY absente, le coach ne répondra pas.');
  if(!BDD_URL) console.log('ATTENTION : DATABASE_URL absente, la mémoire des parties est inactive.');
});
