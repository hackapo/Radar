const http = require('http');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ============================================================
// 🔧 CONFIGURAÇÃO DO FIREBASE
// Lê do arquivo local OU da variável de ambiente (Render/Railway)
// ============================================================
let serviceAccount;
if (process.env.FIREBASE_CREDENTIALS) {
    serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    console.log("✅ Firebase carregado da variável de ambiente!");
} else {
    serviceAccount = require('./radar-26442-firebase-adminsdk-fbsvc-9623596b84.json');
    console.log("✅ Firebase carregado do arquivo local!");
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

// ============================================================
// 💾 PERSISTÊNCIA DE TOKENS EM ARQUIVO JSON
// ============================================================
const TOKENS_FILE = process.env.RENDER
    ? '/etc/secrets/tokens.json'
    : path.join(__dirname, 'tokens.json');

function carregarTokens() {
    try {
        if (fs.existsSync(TOKENS_FILE)) {
            const dados = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
            const set = new Set(dados);
            console.log(`📂 ${set.size} token(s) carregado(s) do arquivo tokens.json`);
            return set;
        }
    } catch (err) {
        console.error('❌ Erro ao carregar tokens.json:', err.message);
    }
    return new Set();
}

function salvarTokens() {
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(Array.from(userTokens), null, 2), 'utf-8');
        console.log(`💾 tokens.json salvo com ${userTokens.size} token(s).`);
    } catch (err) {
        console.error('❌ Erro ao salvar tokens.json:', err.message);
    }
}

let userTokens = carregarTokens();
let clientes = [];
let cacheJogos = new Map();
let gameStates = new Map();


// ============================================================
// FUNÇÃO: Enviar Push Notification via FCM
// ============================================================
async function sendFCMNotification(token, title, body, iconUrl, clickActionUrl, dataPayload) {
    const message = {
        notification: { title, body },
        webpush: {
            headers: { Urgency: 'high' },
            notification: {
                icon: iconUrl,
                badge: '/badge.png',
                data: dataPayload,
                actions: [{ action: 'view-game', title: 'Ver Jogo' }]
            },
            fcm_options: { link: clickActionUrl }
        },
        token,
    };

    try {
        const response = await admin.messaging().send(message);
        console.log(`📲 Notificação enviada! Token: ${token.substring(0, 20)}... | Resposta: ${response}`);
    } catch (error) {
        console.error(`❌ Erro ao enviar para token: ${token.substring(0, 20)}...`, error.code);

        if (error.code === 'app/invalid-credential') {
            console.error('🔑 CREDENCIAL DO FIREBASE INVÁLIDA! Atualize a variável FIREBASE_CREDENTIALS no Render.');
            return;
        }

        const codigosTokenInvalido = [
            'messaging/invalid-registration-token',
            'messaging/registration-token-not-registered',
            'messaging/invalid-argument',
        ];

        if (codigosTokenInvalido.includes(error.code)) {
            console.log(`🗑️ Token inválido removido: ${token.substring(0, 20)}...`);
            userTokens.delete(token);
            salvarTokens();
        }
    }
}


// ============================================================
// FUNÇÃO: Detectar mudanças e disparar notificação
// ============================================================
function processarAtualizacaoJogo(jogoData) {
    const idJogo = jogoData.idJogo;
    const prev = gameStates.get(idJogo);

    const houveMudanca = !prev ||
        prev.acrescimoHT  !== jogoData.acrescimoHT  ||
        prev.acrescimoFT  !== jogoData.acrescimoFT  ||
        prev.vermelhoCasa !== jogoData.vermelhoCasa  ||
        prev.vermelhoFora !== jogoData.vermelhoFora;

    if (!houveMudanca) return;

    gameStates.set(idJogo, jogoData);

    if (userTokens.size === 0) {
        console.log("⚠️ Nenhum token registrado. Notificação não enviada.");
        return;
    }

    const title = `⚽ ${jogoData.timeCasa} ${jogoData.golCasa} x ${jogoData.golFora} ${jogoData.timeFora}`;

    let bodyParts = [];
    if (jogoData.acrescimoHT >= 5) bodyParts.push(`⏱️ HT: +${jogoData.acrescimoHT} min`);
    if (jogoData.acrescimoFT >= 7) bodyParts.push(`⏱️ FT: +${jogoData.acrescimoFT} min`);
    if (jogoData.vermelhoCasa > 0) bodyParts.push(`🟥 ${jogoData.timeCasa}: ${jogoData.vermelhoCasa} vermelho(s)`);
    if (jogoData.vermelhoFora > 0) bodyParts.push(`🟥 ${jogoData.timeFora}: ${jogoData.vermelhoFora} vermelho(s)`);
    const body = bodyParts.join(' | ') || 'Atualização no jogo';

    const iconUrl   = `https://www.radarfutebol.com/images/times/${jogoData.idTimeCasa}.webp`;
    const clickUrl  = `https://www.radarfutebol.com/`;
    const extraData = { gameId: idJogo };

    console.log(`\n🔔 Disparando notificação:`);
    console.log(`   Título: ${title}`);
    console.log(`   Corpo:  ${body}`);
    console.log(`   Tokens: ${userTokens.size}`);

    userTokens.forEach(token => {
        sendFCMNotification(token, title, body, iconUrl, clickUrl, extraData);
    });
}


// ============================================================
// SERVIDOR HTTP
// ============================================================
const STATIC_FILES = {
    '/':                         { file: 'index.html',               mime: 'text/html' },
    '/index.html':               { file: 'index.html',               mime: 'text/html' },
    '/config.js':                { file: 'config.js',                mime: 'application/javascript' },
    '/firebase-messaging-sw.js': { file: 'firebase-messaging-sw.js', mime: 'application/javascript' },
};

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // --- Arquivos estáticos ---
    if (STATIC_FILES[req.url] && req.method === 'GET') {
        const { file, mime } = STATIC_FILES[req.url];
        const filePath = path.join(__dirname, file);
        if (fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': mime });
            fs.createReadStream(filePath).pipe(res);
        } else {
            res.writeHead(404);
            res.end(`Arquivo ${file} não encontrado.`);
        }
        return;
    }

    // --- SSE ---
    if (req.url === '/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        clientes.push(res);

        cacheJogos.forEach((jogo) => {
            res.write(`data: ${JSON.stringify(jogo)}\n\n`);
        });

        req.on('close', () => {
            clientes = clientes.filter(c => c !== res);
        });

        return;
    }

    // --- Registrar token FCM ---
    if (req.url === '/register-token' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { token } = JSON.parse(body);
                if (token) {
                    const isNovo = !userTokens.has(token);
                    userTokens.add(token);
                    if (isNovo) {
                        salvarTokens();
                        console.log(`✅ Novo token FCM registrado! Total: ${userTokens.size}`);
                    } else {
                        console.log(`ℹ️ Token já existia. Total: ${userTokens.size}`);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Token registrado com sucesso!' }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Token inválido ou ausente.' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'JSON inválido.' }));
            }
        });
        return;
    }

    // --- 🧪 Teste com jogo REAL ---
    if (req.url.startsWith('/testar-notificacao') && req.method === 'GET') {
        if (cacheJogos.size === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: '⚠️ Nenhum jogo no cache ainda.' }));
            return;
        }
        if (userTokens.size === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: '⚠️ Nenhum token registrado.' }));
            return;
        }

        const jogoReal = Array.from(cacheJogos.values())[0];
        gameStates.delete(jogoReal.idJogo);
        processarAtualizacaoJogo(jogoReal);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            message: '✅ Notificação disparada com jogo REAL!',
            tokensRegistrados: userTokens.size,
            jogoUsado: jogoReal
        }));
        return;
    }

    // --- Ver tokens ---
    if (req.url === '/tokens' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            total: userTokens.size,
            tokens: Array.from(userTokens).map(t => t.substring(0, 20) + '...')
        }));
        return;
    }

    res.writeHead(404);
    res.end('Not found');

}).listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));


// ============================================================
// CONEXÃO SSE COM RADARFUTEBOL
// ============================================================
async function conectarSSE() {
    try {
        console.log("📡 Conectando ao RadarFutebol SSE...");

        const fetchResponse = await fetch(
            "https://www.radarfutebol.com/sse/home?campoBusca=&somLigado=false&mostrarApenasJogosLive=true&mostrarApenasJogosFavoritos=false&countJogosMostrar=25&mostrarFiltroAcrescimo=false&filtroAcrescimoHt=1&filtroAcrescimoFt=1&filtroAcrescimoHtOperador=%3E%3D&filtroAcrescimoFtOperador=%3E%3D&filtroAcrescimoCondicao=ou&mostrarApenasJogosOraculo=false&mostrarApenasJogosBetfair=false&mostrarApenasJogosOver=false&mostrarApenasJogosLayCs=false&favoritoVencendo=false&favoritoPerdendo=false&casaVencendo=false&visitanteVencendo=false&empatado=false&filtroAlertas=false&filtroDiferencaXg=false&ordemInicio=false",
            {
                headers: {
                    "accept": "*/*",
                    "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
                    "authorization": `Bearer ${process.env.RADAR_TOKEN}`,
                    "cache-control": "no-cache",
                    "pragma": "no-cache",
                    "priority": "u=1, i",
                    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                    "Referer": "https://www.radarfutebol.com/"
                },
                method: "GET"
            }
        );

        if (!fetchResponse.ok) {
            console.log("❌ Erro na requisição:", fetchResponse.status, fetchResponse.statusText);
            return;
        }

        console.log("✅ Conexão SSE estabelecida! Recebendo dados em tempo real...");

        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        for await (const chunk of fetchResponse.body) {
            buffer += decoder.decode(chunk, { stream: true });

            let linhas = buffer.split(/\r?\n/);
            buffer = linhas.pop();

            for (let linha of linhas) {
                linha = linha.trim();
                if (!linha.startsWith('data:')) continue;

                try {
                    const jsonStr = linha.substring(5).trim();
                    if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) continue;

                    const dados = JSON.parse(jsonStr);
                    if (!dados.campeonatos) continue;

                    console.log("\n=== 📦 PACOTE RECEBIDO ===");
                    const idsNoPacote = new Set();

                    dados.campeonatos.forEach(campeonato => {
                        if (!campeonato.eventos) return;

                        Object.values(campeonato.eventos).forEach(jogo => {
                            if (jogo.status === 'notstarted') return;

                            //const temVermelho = (jogo.cartaoVermelhoTimeCasa > 0 || jogo.cartaoVermelhoTimeFora > 0);
                            //const htAlto      = (jogo.previsaoAcrescimo1Tempo >= 5);
                            //const ftAlto      = (jogo.previsaoAcrescimo2Tempo >= 7);

                            //if (!temVermelho && !htAlto && !ftAlto) return;

                            let status = jogo.status === 'inprogress' ? jogo.tempoAtual : jogo.status;
                            if (status === 'Halftime') status = 'Intervalo';

                            const idJogo = `${jogo.timeCasa}-${jogo.timeFora}`.replace(/\s+/g, '');
                            idsNoPacote.add(idJogo);

                            const jogoData = {
                                idJogo,
                                status,
                                timeCasa:     jogo.timeCasa,
                                timeFora:     jogo.timeFora,
                                idTimeCasa:   jogo.idTimeCasa,
                                idTimeFora:   jogo.idTimeFora,
                                golCasa:      jogo.golTimeCasaFt,
                                golFora:      jogo.golTimeForaFt,
                                vermelhoCasa: jogo.cartaoVermelhoTimeCasa,
                                vermelhoFora: jogo.cartaoVermelhoTimeFora,
                                acrescimoHT:  jogo.previsaoAcrescimo1Tempo,
                                acrescimoFT:  jogo.previsaoAcrescimo2Tempo,
                                atualizadoEm: new Date().toLocaleTimeString('pt-BR')
                            };

                            cacheJogos.set(idJogo, jogoData);
                            clientes.forEach(c => c.write(`data: ${JSON.stringify(jogoData)}\n\n`));
                            processarAtualizacaoJogo(jogoData);
                        });
                    });

                    for (const idNoCache of cacheJogos.keys()) {
                        if (!idsNoPacote.has(idNoCache)) {
                            console.log(`[REMOVIDO] ${idNoCache}`);
                            cacheJogos.delete(idNoCache);
                            gameStates.delete(idNoCache);
                            clientes.forEach(c =>
                                c.write(`data: ${JSON.stringify({ idRemover: idNoCache })}\n\n`)
                            );
                        }
                    }

                } catch (err) {
                    console.log("[DEBUG] Erro ao processar linha:", err.message);
                }
            }
        }

    } catch (error) {
        console.error("❌ Erro na conexão, reconectando em 5s...", error.message);
        setTimeout(conectarSSE, 5000);
    }
}

conectarSSE();
