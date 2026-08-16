/* ============================================================
   échecs dune — serveur v1a (Railway)
   Rôles :
   1. Servir la page du jeu (index.html)
   2. /api/coach : relayer la demande de commentaire vers
      l'API Anthropic, avec la clé gardée côté serveur.
   La clé n'apparaît JAMAIS dans le navigateur.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CLE = process.env.ANTHROPIC_API_KEY;

const CONSIGNE_COACH =
  "Tu es coach d'échecs. Tu t'adresses à Jérôme, joueur occasionnel, en français, en le tutoyant. " +
  "Ton direct, pragmatique, zéro flatterie, zéro jargon inutile. " +
  "Explique le dernier demi-coup indiqué : ce qu'il fait concrètement sur l'échiquier (pièce, case, ce qu'il attaque, défend, ouvre ou affaiblit) et pourquoi l'évaluation a bougé ou non. " +
  "Appuie-toi uniquement sur les données fournies : ne calcule pas de variantes longues, n'invente aucune pièce ni aucune case. " +
  "Ne conseille jamais le coup à jouer ensuite ; si le coup était imprécis, dis-le et nomme l'idée que le moteur préférait, sans dérouler la suite. " +
  "3 courts paragraphes maximum, 160 mots maximum au total, pas de titres, pas de listes.\n\n" +
  "Données de la position :\n";

function servirFichier(res, fichier, type){
  fs.readFile(path.join(__dirname, fichier), (err, data) => {
    if(err){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Introuvable'); return; }
    res.writeHead(200, {'Content-Type': type, 'Cache-Control':'no-cache'});
    res.end(data);
  });
}

const server = http.createServer((req, res) => {

  // --- La page du jeu ---
  if(req.method === 'GET' && (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/?'))){
    return servirFichier(res, 'index.html', 'text/html; charset=utf-8');
  }

  // --- Le coach ---
  if(req.method === 'POST' && req.url === '/api/coach'){
    let corps = '';
    req.on('data', (c) => { corps += c; if(corps.length > 100000) req.destroy(); });
    req.on('end', async () => {
      try{
        if(!CLE) throw new Error('ANTHROPIC_API_KEY absente : ajoute la variable dans Railway.');
        const { contexte } = JSON.parse(corps || '{}');
        if(typeof contexte !== 'string' || contexte.length < 10 || contexte.length > 8000){
          throw new Error('contexte invalide');
        }

        const rep = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': CLE,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 600,
            messages: [{ role: 'user', content: CONSIGNE_COACH + contexte }]
          })
        });

        if(!rep.ok){
          const detail = (await rep.text()).slice(0, 300);
          res.writeHead(502, {'Content-Type':'application/json; charset=utf-8'});
          res.end(JSON.stringify({ erreur: 'API Anthropic : ' + rep.status, detail }));
          return;
        }

        const data = await rep.json();
        const texte = (data.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();

        res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({ texte }));
      }catch(e){
        res.writeHead(400, {'Content-Type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({ erreur: String(e.message || e) }));
      }
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('Introuvable');
});

server.listen(PORT, () => {
  console.log('échecs dune — serveur en écoute sur le port ' + PORT);
  if(!CLE) console.log('ATTENTION : la variable ANTHROPIC_API_KEY est absente, le coach ne répondra pas.');
});
