/* ============================================================
   échecs dune — serveur v1b (Railway)
   1. Sert la page du jeu (index.html)
   2. /api/coach    : commentaire d'un coup (API Anthropic)
   3. /api/partie   : enregistre une partie terminée (Postgres)
   4. /api/parties  : liste des parties enregistrées
   5. /api/debrief  : débrief rédigé de la partie complète
   La clé API et l'accès base restent côté serveur.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CLE = process.env.ANTHROPIC_API_KEY;
const BDD_URL = process.env.DATABASE_URL;

/* ---------- Base de données (Postgres via pg) ---------- */
let pool = null;
if(BDD_URL){
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: BDD_URL,
    ssl: BDD_URL.includes('railway.internal') ? false : { rejectUnauthorized: false }
  });
  pool.query(`CREATE TABLE IF NOT EXISTS parties (
    id SERIAL PRIMARY KEY,
    date TIMESTAMPTZ DEFAULT now(),
    niveau TEXT,
    resultat TEXT,
    nb_coups INT,
    pgn TEXT
  )`).then(() => console.log('Table parties prête.'))
    .catch(e => console.log('Erreur création table :', e.message));
}

/* ---------- Consignes du coach ---------- */
const CONSIGNE_COUP =
  "Tu es coach d'échecs. Tu t'adresses à Jérôme, joueur occasionnel, en français, en le tutoyant. " +
  "Ton direct, pragmatique, zéro flatterie, zéro jargon inutile. " +
  "Explique le dernier demi-coup indiqué : ce qu'il fait concrètement sur l'échiquier (pièce, case, ce qu'il attaque, défend, ouvre ou affaiblit) et pourquoi l'évaluation a bougé ou non. " +
  "Appuie-toi uniquement sur les données fournies : ne calcule pas de variantes longues, n'invente aucune pièce ni aucune case. " +
  "Ne conseille jamais le coup à jouer ensuite ; si le coup était imprécis, dis-le et nomme l'idée que le moteur préférait, sans dérouler la suite. " +
  "3 courts paragraphes maximum, 160 mots maximum au total, pas de titres, pas de listes.\n\n" +
  "Données de la position :\n";

const CONSIGNE_DEBRIEF =
  "Tu es coach d'échecs. Tu t'adresses à Jérôme, joueur occasionnel, en français, en le tutoyant. " +
  "Ton direct, pragmatique, zéro flatterie. Son adversaire est le moteur Stockfish, surnommé Hartwig — désigne-le par ce nom. " +
  "Jérôme avait les noirs, Hartwig les blancs. " +
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

  /* --- Commentaire d'un coup --- */
  if(req.method === 'POST' && req.url === '/api/coach'){
    try{
      const { contexte } = await lireCorps(req);
      if(typeof contexte !== 'string' || contexte.length < 10 || contexte.length > 8000) throw new Error('contexte invalide');
      const texte = await demanderClaude(CONSIGNE_COUP, contexte, 600);
      repondre(res, 200, { texte });
    }catch(e){ repondre(res, e.http || 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Enregistrement d'une partie --- */
  if(req.method === 'POST' && req.url === '/api/partie'){
    try{
      if(!pool) throw new Error('Base de données non branchée (variable DATABASE_URL absente).');
      const { pgn, resultat, niveau, nb_coups } = await lireCorps(req);
      if(typeof pgn !== 'string' || pgn.length < 3 || pgn.length > 20000) throw new Error('pgn invalide');
      const r = await pool.query(
        'INSERT INTO parties (niveau, resultat, nb_coups, pgn) VALUES ($1,$2,$3,$4) RETURNING id',
        [String(niveau || '').slice(0,30), String(resultat || '').slice(0,30), parseInt(nb_coups,10) || 0, pgn]
      );
      repondre(res, 200, { id: r.rows[0].id });
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Liste des parties --- */
  if(req.method === 'GET' && req.url === '/api/parties'){
    try{
      if(!pool) throw new Error('Base de données non branchée (variable DATABASE_URL absente).');
      const r = await pool.query('SELECT id, date, niveau, resultat, nb_coups FROM parties ORDER BY date DESC LIMIT 50');
      repondre(res, 200, { parties: r.rows });
    }catch(e){ repondre(res, 400, { erreur: String(e.message || e) }); }
    return;
  }

  /* --- Débrief de fin de partie --- */
  if(req.method === 'POST' && req.url === '/api/debrief'){
    try{
      const { pgn, resultat, niveau, evals } = await lireCorps(req);
      if(typeof pgn !== 'string' || pgn.length < 3 || pgn.length > 20000) throw new Error('pgn invalide');
      if(!Array.isArray(evals) || evals.length > 400) throw new Error('évaluations invalides');
      const contenu =
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
  console.log('échecs dune — serveur v1b en écoute sur le port ' + PORT);
  if(!CLE) console.log('ATTENTION : ANTHROPIC_API_KEY absente, le coach ne répondra pas.');
  if(!BDD_URL) console.log('ATTENTION : DATABASE_URL absente, la mémoire des parties est inactive.');
});
