const http = require('http');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ============================================================
// 🔧 CONFIGURAÇÃO DO FIREBASE
// ============================================================
const serviceAccount = require('./radar-26442-firebase-adminsdk-fbsvc-9623596b84.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

console.log("✅ Firebase Admin SDK inicializado com sucesso!");

// ============================================================
// 💾 PERSISTÊNCIA DE TOKENS EM ARQUIVO JSON
// ============================================================
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

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

// Carrega tokens salvos ao iniciar
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
        if (
            error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered'
        ) {
            console.log(`🗑️ Removendo token inválido e salvando arquivo.`);
            userTokens.delete(token);
            salvarTokens(); // Salva após remover token inválido
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
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // --- SSE: envia jogos em tempo real para o frontend ---
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

    // --- Registrar token FCM e salvar em arquivo ---
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
                        salvarTokens(); // Salva no arquivo apenas se for token novo
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

    // --- 🧪 ROTA DE TESTE: dispara notificação com jogo REAL do cache ---
    if (req.url.startsWith('/testar-notificacao') && req.method === 'GET') {
        if (cacheJogos.size === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                message: '⚠️ Nenhum jogo no cache ainda. Aguarde os dados chegarem do RadarFutebol.'
            }));
            return;
        }

        if (userTokens.size === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                message: '⚠️ Nenhum token registrado. Abra o index.html e clique em Ativar Alertas primeiro.'
            }));
            return;
        }

        // Pega o primeiro jogo real que está no cache
        const jogoReal = Array.from(cacheJogos.values())[0];

        // Deleta estado anterior para forçar o disparo
        gameStates.delete(jogoReal.idJogo);

        // Roda a função real com o jogo real
        processarAtualizacaoJogo(jogoReal);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            message: '✅ processarAtualizacaoJogo() rodou com jogo REAL!',
            tokensRegistrados: userTokens.size,
            jogoUsado: jogoReal
        }));
        return;
    }

    // --- Ver tokens salvos ---
    if (req.url === '/tokens' && req.method === 'GET') {
        const lista = Array.from(userTokens);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            total: lista.length,
            tokens: lista.map(t => t.substring(0, 20) + '...')  // Mostra só os primeiros 20 chars por segurança
        }));
        return;
    }

    // --- Rota não encontrada ---
    res.writeHead(404);
    res.end('Not found');

}).listen(3000, () => console.log("🚀 Servidor rodando em http://localhost:3000"));


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
                    "authorization": "Bearer 7iJiOxOgVW9m26XxKwerD4Zo81HgnsAeOZ2gf7Ks",
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

                            const temVermelho = (jogo.cartaoVermelhoTimeCasa > 0 || jogo.cartaoVermelhoTimeFora > 0);
                            const htAlto      = (jogo.previsaoAcrescimo1Tempo >= 5);
                            const ftAlto      = (jogo.previsaoAcrescimo2Tempo >= 7);

                            if (!temVermelho && !htAlto && !ftAlto) return;

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